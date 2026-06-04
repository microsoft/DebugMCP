// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface BaseAgentInfo {
    id: string;
    name: string;
    displayName: string;
    configPath: string;
    configFormat: 'json' | 'toml';
}

export interface JsonAgentInfo extends BaseAgentInfo {
    configFormat: 'json';
    mcpServerFieldName: string; 
}

export interface TomlAgentInfo extends BaseAgentInfo {
    configFormat: 'toml';
}

export type AgentInfo = JsonAgentInfo | TomlAgentInfo;

export interface MCPServerConfig {
    type: string;
    url: string;
    autoApprove?: string[];
    disabled?: boolean;
    timeout?: number;
    tools?: string[];
}

export function upsertCodexDebugMCPConfig(configContent: string, mcpServerUrl: string): string {
    const normalizedConfigContent = configContent.replace(/\r\n/g, '\n');
    const lines = normalizedConfigContent.split('\n');
    const escapedUrl = escapeTomlString(mcpServerUrl);
    const debugMCPSectionIndex = lines.findIndex(line => isCodexDebugMCPSectionHeader(line));

    if (debugMCPSectionIndex === -1) {
        const separator = normalizedConfigContent.length === 0
            ? ''
            : normalizedConfigContent.endsWith('\n') ? '\n' : '\n\n';

        return `${normalizedConfigContent}${separator}[mcp_servers.debugmcp]\nurl = "${escapedUrl}"\n`;
    }

    const nextSectionIndex = findNextTomlSectionIndex(lines, debugMCPSectionIndex + 1);
    const debugMCPSectionEndIndex = nextSectionIndex === -1 ? lines.length : nextSectionIndex;

    for (let index = debugMCPSectionIndex + 1; index < debugMCPSectionEndIndex; index++) {
        const urlMatch = lines[index].match(/^(\s*)url\s*=.*$/);
        if (urlMatch) {
            lines[index] = `${urlMatch[1]}url = "${escapedUrl}"`;
            return lines.join('\n');
        }
    }

    lines.splice(debugMCPSectionIndex + 1, 0, `url = "${escapedUrl}"`);
    return lines.join('\n');
}

function escapeTomlString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findNextTomlSectionIndex(lines: string[], startIndex: number): number {
    for (let index = startIndex; index < lines.length; index++) {
        if (isTomlSectionHeader(lines[index])) {
            return index;
        }
    }

    return -1;
}

function isTomlSectionHeader(line: string): boolean {
    return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line);
}

function isCodexDebugMCPSectionHeader(line: string): boolean {
    return /^\s*\[mcp_servers\.debugmcp\]\s*(?:#.*)?$/.test(line);
}

export class AgentConfigurationManager {
    private context: vscode.ExtensionContext;
    private readonly POPUP_SHOWN_KEY = 'debugmcp.popupShown';
    private readonly timeoutInSeconds: number;
    private readonly serverPort: number;
    

    constructor(context: vscode.ExtensionContext, timeoutInSeconds: number, serverPort: number) {
        this.context = context;
        this.timeoutInSeconds = timeoutInSeconds;
        this.serverPort = serverPort;
    }

    /**
     * Check if we should show the post-install popup
     */
    public async shouldShowPopup(): Promise<boolean> {
        // Suppress popup if we are in Antigravity or it's already been shown
        if (process.env.ANTIGRAVITY_ENV === 'true' || process.env.GEMINI_HOME) {
            return false;
        }
        const popupShown = this.context.globalState.get<boolean>(this.POPUP_SHOWN_KEY, false);
        return !popupShown;
    }

    /**
     * Show the agent selection popup
     */
    public async showAgentSelectionPopup(): Promise<void> {
        try {
            const agents = await this.getSupportedAgents();

            // Show selection popup for all agents
            await this.showAgentSelectionDialog(agents);
            
        } catch (error) {
            console.error('Error showing agent selection popup:', error);
            vscode.window.showErrorMessage(`Failed to show agent selection popup: ${error}`);
        }
    }

    /**
     * Reset popup state (for testing/debugging)
     */
    public async resetPopupState(): Promise<void> {
        await this.context.globalState.update(this.POPUP_SHOWN_KEY, false);
    }

    /**
     * Show manual configuration options via command palette
     */
    public async showManualConfiguration(): Promise<void> {
        const agents = await this.getSupportedAgents();

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

    /**
     * Get cross-platform configuration base path
     */
    private getConfigBasePath(): string {
        const platform = os.platform();
        const userHome = os.homedir();
        
        switch (platform) {
            case 'win32': // Windows
                return process.env.APPDATA || path.join(userHome, 'AppData', 'Roaming');
            case 'darwin': // MacOS
                return path.join(userHome, 'Library', 'Application Support');
            case 'linux': // Linux
                return process.env.XDG_CONFIG_HOME || path.join(userHome, '.config');
            default:
                // Fallback to Windows-style for unknown platforms
                console.warn(`Unknown platform: ${platform}, using Windows config path`);
                return process.env.APPDATA || path.join(userHome, 'AppData', 'Roaming');
        }
    }

    private getCodexConfigPath(): string {
        const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
        return path.join(codexHome, 'config.toml');
    }

    private getCopilotCliConfigPath(): string {
        const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
        return path.join(copilotHome, 'mcp-config.json');
    }

    /**
     * Get the personal skills directory for a given agent. By convention we
     * place skills alongside the agent's MCP config file (i.e. in a `skills/`
     * sibling of the config file's parent directory). This matches harnesses
     * like Copilot CLI (`~/.copilot/skills/`) and gives a sensible default
     * for the other supported agents.
     */
    private getSkillsDirForAgent(agent: AgentInfo): string {
        return path.join(path.dirname(agent.configPath), 'skills');
    }

    /**
     * Path to the debugmcp skill bundled with the extension.
     */
    private getBundledSkillPath(): string {
        return path.join(this.context.extensionPath, 'skills', 'really-debug');
    }

    /**
     * Copy the bundled debugmcp skill into the agent's personal skills
     * directory. This is best-effort: if the bundled skill is missing or the
     * copy fails, we log a warning but do not fail the MCP configuration.
     */
    private async registerDebugMCPSkill(agent: AgentInfo): Promise<string | null> {
        const bundledSkillPath = this.getBundledSkillPath();

        if (!fs.existsSync(bundledSkillPath)) {
            console.warn(`Bundled debugmcp skill not found at ${bundledSkillPath}; skipping skill registration for ${agent.name}`);
            return null;
        }

        const skillsDir = this.getSkillsDirForAgent(agent);
        const destination = path.join(skillsDir, 'really-debug');

        try {
            await fs.promises.mkdir(skillsDir, { recursive: true });
            await fs.promises.cp(bundledSkillPath, destination, { recursive: true, force: true });
            console.log(`Successfully registered debugmcp skill for ${agent.name} at ${destination}`);

            // Back-compat cleanup: earlier 1.2.0 builds installed the skill at
            // `<skillsDir>/debug`. Remove the stale copy if it's still around so
            // users don't end up with two competing entries.
            const legacyDestination = path.join(skillsDir, 'debug');
            if (fs.existsSync(legacyDestination)) {
                try {
                    await fs.promises.rm(legacyDestination, { recursive: true, force: true });
                    console.log(`Removed legacy debugmcp skill at ${legacyDestination}`);
                } catch (cleanupError) {
                    console.warn(`Failed to remove legacy debugmcp skill at ${legacyDestination}:`, cleanupError);
                }
            }

            return destination;
        } catch (error) {
            console.warn(`Failed to register debugmcp skill for ${agent.name} at ${destination}:`, error);
            return null;
        }
    }

    /**
     * Get list of supported agents
     */
    private async getSupportedAgents(): Promise<AgentInfo[]> {
        const configBasePath = this.getConfigBasePath();
        const platform = os.platform();
        
        console.log(`Detected platform: ${platform}, using config base path: ${configBasePath}`);
        
        const agents: AgentInfo[] = [
            {
                id: 'cline',
                name: 'cline',
                displayName: 'Cline',
                configPath: path.join(configBasePath, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            },
            {
                id: 'roo',
                name: 'roo',
                displayName: 'Roo Code',
                configPath: path.join(configBasePath, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            },
            {
                id: 'copilot',
                name: 'copilot',
                displayName: 'GitHub Copilot',
                configPath: path.join(configBasePath, 'Code', 'User', 'mcp.json'),
                configFormat: 'json',
                mcpServerFieldName: 'servers'
            },
            {
                id: 'copilot-cli',
                name: 'copilot-cli',
                displayName: 'GitHub Copilot CLI',
                configPath: this.getCopilotCliConfigPath(),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            },
            {
                id: 'cursor',
                name: 'cursor',
                displayName: 'Cursor',
                configPath: path.join(configBasePath, 'Cursor', 'User', 'globalStorage', 'cursor.mcp', 'settings', 'mcp_settings.json'),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            },
            {
                id: 'antigravity',
                name: 'antigravity',
                displayName: 'Antigravity',
                configPath: path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
                configFormat: 'json',
                mcpServerFieldName: 'mcpServers'
            },
            {
                id: 'codex',
                name: 'codex',
                displayName: 'Codex',
                configPath: this.getCodexConfigPath(),
                configFormat: 'toml'
            }
        ];

        return agents;
    }

    /**
     * Get DebugMCP server configuration with current port and timeout settings
     */
    private getDebugMCPConfig(agent?: AgentInfo): MCPServerConfig {
        if (agent?.id === 'copilot-cli') {
            return {
            	type: 'http',
            	url: this.getMCPServerUrl(),
            	tools: ['*']
            };
        }

        return {
            autoApprove: [],
            disabled: false,
            timeout: this.timeoutInSeconds,
            type: "streamableHttp",
            url: this.getMCPServerUrl()
        };
    }

    private getMCPServerUrl(): string {
        return `http://localhost:${this.serverPort}/mcp`;
    }

    /**
     * Migrate existing SSE configurations to streamableHttp
     * This should be called on extension activation to ensure backward compatibility
     */
    public async migrateExistingConfigurations(): Promise<void> {
        const agents = await this.getSupportedAgents();
        let migrationCount = 0;

        for (const agent of agents) {
            try {
                if (!fs.existsSync(agent.configPath)) {
                    continue;
                }

                const configContent = await fs.promises.readFile(agent.configPath, 'utf8');

                if (agent.configFormat === 'toml') {
                    if (this.shouldMigrateCodexConfig(configContent)) {
                        await fs.promises.writeFile(
                            agent.configPath,
                            upsertCodexDebugMCPConfig(configContent, this.getMCPServerUrl()),
                            'utf8'
                        );

                        migrationCount++;
                        console.log(`Successfully migrated ${agent.displayName} configuration`);
                    }

                    // Back-compat: existing Codex users had only the MCP server registered.
                    // If DebugMCP is configured, also ensure the bundled skill is installed.
                    if (this.hasCodexDebugMCPSection(configContent)) {
                        await this.ensureSkillRegistered(agent);
                    }

                    continue;
                }

                let config: any;
                
                try {
                    config = JSON.parse(configContent);
                } catch {
                    continue; // Skip if config can't be parsed
                }

                const fieldName = agent.mcpServerFieldName;
                const debugmcpConfig = config[fieldName]?.debugmcp;

                if (!debugmcpConfig) {
                    continue; // DebugMCP not configured for this agent
                }

                // Check if it's using the old SSE configuration
                const needsMigration = agent.id === 'copilot-cli'
                    ? debugmcpConfig.type !== 'http' || (debugmcpConfig.url && debugmcpConfig.url.endsWith('/sse'))
                    : debugmcpConfig.type === 'sse' ||
                    debugmcpConfig.type === 'http' ||
                    (debugmcpConfig.url && debugmcpConfig.url.endsWith('/sse'));

                if (needsMigration) {
                    console.log(`Migrating DebugMCP configuration for ${agent.displayName} from SSE to streamableHttp`);
                    
                    // Update to new configuration
                    config[fieldName].debugmcp = this.getDebugMCPConfig(agent);
                    
                    // Preserve any custom autoApprove settings
                    if (config[fieldName].debugmcp.autoApprove && debugmcpConfig.autoApprove && Array.isArray(debugmcpConfig.autoApprove)) {
                        config[fieldName].debugmcp.autoApprove = debugmcpConfig.autoApprove;
                    }
                    
                    // Write the migrated config
                    await fs.promises.writeFile(
                        agent.configPath,
                        JSON.stringify(config, null, 2),
                        'utf8'
                    );
                    
                    migrationCount++;
                    console.log(`Successfully migrated ${agent.displayName} configuration`);
                }

                // Back-compat: existing users had only the MCP server registered.
                // If DebugMCP is configured, also ensure the bundled skill is installed.
                await this.ensureSkillRegistered(agent);
            } catch (error) {
                console.error(`Error migrating config for ${agent.name}:`, error);
                // Continue with other agents even if one fails
            }
        }

        if (migrationCount > 0) {
            vscode.window.showInformationMessage(
                `DebugMCP: Migrated ${migrationCount} agent configuration(s) to use the new transport protocol.`
            );
        }
    }

    /**
     * Ensure the bundled debugmcp skill is installed in the agent's personal
     * skills directory. Safe to call on every activation — `registerDebugMCPSkill`
     * uses `fs.cp` with `force: true`, so it will refresh stale copies but is a
     * no-op when the destination already matches.
     */
    private async ensureSkillRegistered(agent: AgentInfo): Promise<void> {
        try {
            await this.registerDebugMCPSkill(agent);
        } catch (error) {
            console.warn(`Failed to ensure skill registration for ${agent.name}:`, error);
        }
    }

    private hasCodexDebugMCPSection(configContent: string): boolean {
        const lines = configContent.replace(/\r\n/g, '\n').split('\n');
        return lines.some(line => isCodexDebugMCPSectionHeader(line));
    }

    private shouldMigrateCodexConfig(configContent: string): boolean {
        const normalizedConfigContent = configContent.replace(/\r\n/g, '\n');
        const lines = normalizedConfigContent.split('\n');
        const debugMCPSectionIndex = lines.findIndex(line => isCodexDebugMCPSectionHeader(line));

        if (debugMCPSectionIndex === -1) {
            return false;
        }

        const nextSectionIndex = findNextTomlSectionIndex(lines, debugMCPSectionIndex + 1);
        const debugMCPSectionEndIndex = nextSectionIndex === -1 ? lines.length : nextSectionIndex;

        for (let index = debugMCPSectionIndex + 1; index < debugMCPSectionEndIndex; index++) {
            if (/^\s*url\s*=.*\/sse["']?\s*(?:#.*)?$/.test(lines[index])) {
                return true;
            }
        }

        return false;
    }

    /**
     * Add DebugMCP server configuration to the specified agent's config
     */
    private async addDebugMCPToAgent(agent: AgentInfo): Promise<{ success: boolean; skillPath: string | null }> {
        try {
            // Ensure the config directory exists
            const configDir = path.dirname(agent.configPath);
            if (!fs.existsSync(configDir)) {
                await fs.promises.mkdir(configDir, { recursive: true });
            }

            if (agent.configFormat === 'toml') {
                const configContent = fs.existsSync(agent.configPath)
                    ? await fs.promises.readFile(agent.configPath, 'utf8')
                    : '';

                await fs.promises.writeFile(
                    agent.configPath,
                    upsertCodexDebugMCPConfig(configContent, this.getMCPServerUrl()),
                    'utf8'
                );

                console.log(`Successfully added DebugMCP configuration to ${agent.name}`);
                const skillPath = await this.registerDebugMCPSkill(agent);
                return { success: true, skillPath };
            }

            let config: any = {};
            
            // Read existing config if it exists
            if (fs.existsSync(agent.configPath)) {
                const configContent = await fs.promises.readFile(agent.configPath, 'utf8');
                try {
                    config = JSON.parse(configContent);
                } catch (parseError) {
                    console.warn(`Failed to parse existing config for ${agent.name}, creating new config`);
                    config = {};
                }
            }

            // Ensure the correct MCP servers object exists for this agent
            const fieldName = agent.mcpServerFieldName;
            if (!config[fieldName]) {
                config[fieldName] = {};
            }

            // Add or update DebugMCP configuration with current settings
            config[fieldName].debugmcp = this.getDebugMCPConfig(agent);

            // Write the updated config back to file
            await fs.promises.writeFile(
                agent.configPath, 
                JSON.stringify(config, null, 2), 
                'utf8'
            );

            console.log(`Successfully added DebugMCP configuration to ${agent.name}`);
            const skillPath = await this.registerDebugMCPSkill(agent);
            return { success: true, skillPath };
        } catch (error) {
            console.error(`Error adding DebugMCP to ${agent.name}:`, error);
            vscode.window.showErrorMessage(`Failed to configure DebugMCP for ${agent.displayName}: ${error}`);
            return { success: false, skillPath: null };
        }
    }

    /** Show the actual agent selection dialog */
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


        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'DebugMCP Setup - Choose AI Agent to Configure';
        quickPick.placeholder = 'Select an AI agent to configure with DebugMCP';
        quickPick.items = items;
        quickPick.canSelectMany = true;
        quickPick.ignoreFocusOut = true;

        quickPick.onDidAccept(async () => {
            const selectedItems = quickPick.selectedItems;
            quickPick.hide();

            // Configure all selected agents
            for (const selectedItem of selectedItems) {
                if (selectedItem && selectedItem.label.includes('Configure')) {
                    // User selected an agent to configure
                    const agentDisplayName = selectedItem.detail;
                    const agent = agents.find(a => a.displayName === agentDisplayName);
                    
                    if (agent) {
                        await this.configureAgent(agent);
                    }
                }
            }
            
            // Mark popup as shown after user interacts with it
            await this.context.globalState.update(this.POPUP_SHOWN_KEY, true);
        });

        quickPick.onDidHide(() => quickPick.dispose());
        quickPick.show();
    }

    /**
     * Configure a specific agent with DebugMCP
     */
    private async configureAgent(agent: AgentInfo): Promise<void> {
        try {
            const { success, skillPath } = await this.addDebugMCPToAgent(agent);

            if (success) {
                const openConfigButton = 'Open MCP Config';
                const openSkillButton = 'Open Skill';
                const buttons: string[] = [openConfigButton];
                if (skillPath) {
                    buttons.push(openSkillButton);
                }

                const result = await vscode.window.showInformationMessage(
                    `✅ DebugMCP successfully configured for ${agent.displayName}`,
                    ...buttons
                );

                if (result === openConfigButton) {
                    const configUri = vscode.Uri.file(agent.configPath);
                    await vscode.commands.executeCommand('vscode.open', configUri);
                } else if (result === openSkillButton && skillPath) {
                    // Open the skill's SKILL.md entry point
                    const skillEntry = path.join(skillPath, 'SKILL.md');
                    const target = fs.existsSync(skillEntry) ? skillEntry : skillPath;
                    const skillUri = vscode.Uri.file(target);
                    await vscode.commands.executeCommand('vscode.open', skillUri);
                }
            }
        } catch (error) {
            console.error(`Error configuring ${agent.name}:`, error);
            vscode.window.showErrorMessage(`Failed to configure ${agent.displayName}: ${error}`);
        }
    }
}
