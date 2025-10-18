import * as vscode from 'vscode';
import { AgentConfigurationManager, AgentInfo } from './AgentConfigurationManager';

export class PopupManager {
    private context: vscode.ExtensionContext;
    private agentConfigManager: AgentConfigurationManager;
    private readonly POPUP_SHOWN_KEY = 'debugmcp.popupShown';
    private readonly SKIP_POPUP_KEY = 'debugmcp.skipPopup';

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.agentConfigManager = new AgentConfigurationManager();
    }

    /**
     * Check if we should show the post-install popup
     */
    async shouldShowPopup(): Promise<boolean> {
        // Check if user chose to skip popup permanently
        const skipPopup = this.context.globalState.get<boolean>(this.SKIP_POPUP_KEY, false);
        if (skipPopup) {
            return false;
        }

        // Always show popup on every activation (unless user chose "Don't show again")
        return true;
    }

    /**
     * Show the agent selection popup
     */
    async showAgentSelectionPopup(): Promise<void> {
        try {
            const agents = await this.agentConfigManager.getSupportedAgents();

            // Show selection popup for all agents
            await this.showAgentSelectionDialog(agents);
            
        } catch (error) {
            console.error('Error showing agent selection popup:', error);
            vscode.window.showErrorMessage(`Failed to show agent selection popup: ${error}`);
        }
    }

    /**
     * Show the actual agent selection dialog
     */
    private async showAgentSelectionDialog(agents: AgentInfo[]): Promise<void> {
        const items: vscode.QuickPickItem[] = [];

        // Add all agents as selectable items
        agents.forEach(agent => {
            items.push({
                label: `$(add) Configure ${agent.displayName}`,
                description: 'Add DebugMCP server to this agent',
                detail: agent.displayName,
                picked: false
            });
        });

        items.push({
            label: `$(circle-slash) Don't show again`,
            description: 'Skip setup and don\'t show this popup again',
            detail: 'You can still configure DebugMCP manually later',
            picked: false
        });

        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'DebugMCP Setup - Choose AI Agent to Configure';
        quickPick.placeholder = 'Select an AI agent to configure with DebugMCP';
        quickPick.items = items;
        quickPick.canSelectMany = true;
        quickPick.ignoreFocusOut = true;

        quickPick.onDidAccept(async () => {
            const selectedItem = quickPick.selectedItems[0];
            quickPick.hide();

            if (selectedItem) {
                if (selectedItem.label.includes('Skip for now')) {
                    // User chose to skip
                    return;
                } else if (selectedItem.label.includes('Don\'t show again')) {
                    // User chose to not show again
                    await this.context.globalState.update(this.SKIP_POPUP_KEY, true);
                    return;
                } else if (selectedItem.label.includes('Configure')) {
                    // User selected an agent to configure
                    const agentDisplayName = selectedItem.detail;
                    const agent = agents.find(a => a.displayName === agentDisplayName);
                    
                    if (agent) {
                        await this.configureAgent(agent);
                    }
                }
            }
        });

        quickPick.onDidHide(() => quickPick.dispose());
        quickPick.show();
    }

    /**
     * Configure a specific agent with DebugMCP
     */
    private async configureAgent(agent: AgentInfo): Promise<void> {
        try {
            
            const success = await this.agentConfigManager.addDebugMCPToAgent(agent);
            
            if (success) {
                const restartMessage = await vscode.window.showInformationMessage(
                    `✅ DebugMCP has been configured for ${agent.displayName}!`,
                    'Open Config File',
                    'Got it'
                );

                if (restartMessage === 'Open Config File') {
                    // Open the config file to show what was added
                    const doc = await vscode.workspace.openTextDocument(agent.configPath);
                    await vscode.window.showTextDocument(doc);
                }
            }
        } catch (error) {
            console.error(`Error configuring ${agent.name}:`, error);
            vscode.window.showErrorMessage(`Failed to configure ${agent.displayName}: ${error}`);
        }
    }

    /**
     * Reset popup state (for testing/debugging)
     */
    async resetPopupState(): Promise<void> {
        await this.context.globalState.update(this.POPUP_SHOWN_KEY, false);
        await this.context.globalState.update(this.SKIP_POPUP_KEY, false);
    }

    /**
     * Show manual configuration options via command palette
     */
    async showManualConfiguration(): Promise<void> {
        const agents = await this.agentConfigManager.getSupportedAgents();

        const items: vscode.QuickPickItem[] = agents.map(agent => ({
            label: agent.displayName,
            description: 'Configure DebugMCP for this agent',
            detail: `Add DebugMCP server configuration to ${agent.displayName}`
        }));

        const selected = await vscode.window.showQuickPick(items, {
            title: 'Configure DebugMCP for AI Agent', 
            placeHolder: 'Select an AI agent to configure with DebugMCP'
        });

        if (selected) {
            const agent = agents.find(a => a.displayName === selected.label);
            if (agent) {
                await this.configureAgent(agent);
            }
        }
    }
}
