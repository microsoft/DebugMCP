import * as vscode from 'vscode';
import { DebugMCPServer } from './DebugMCPServer';
import { PopupManager } from './utils/PopupManager';

let mcpServer: DebugMCPServer | null = null;
let popupManager: PopupManager | null = null;

export async function activate(context: vscode.ExtensionContext) {
    console.log('DebugMCP extension is now active!');

    // Initialize Popup Manager
    popupManager = new PopupManager(context);

    // Initialize MCP Server
    try {
        mcpServer = new DebugMCPServer();
        await mcpServer.initialize();
        await mcpServer.start();
        
        const endpoint = mcpServer.getEndpoint();
        console.log(`DebugMCP server running at: ${endpoint}`);
        vscode.window.showInformationMessage(`DebugMCP server running on ${endpoint}`);
    } catch (error) {
        console.error('Failed to initialize MCP server:', error);
        vscode.window.showErrorMessage(`Failed to initialize MCP server: ${error}`);
    }

    // Register commands
    registerCommands(context);

    // Show post-install popup if needed (with slight delay to allow VS Code to fully load)
    setTimeout(async () => {
        try {
            if (popupManager && await popupManager.shouldShowPopup()) {
                await popupManager.showAgentSelectionPopup();
            }
        } catch (error) {
            console.error('Error showing post-install popup:', error);
        }
    }, 2000);

    console.log('DebugMCP extension activated successfully');
}

/**
 * Register extension commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    // Command to manually configure DebugMCP for agents
    const configureAgentsCommand = vscode.commands.registerCommand(
        'debugmcp.configureAgents',
        async () => {
            if (popupManager) {
                await popupManager.showManualConfiguration();
            }
        }
    );

    // Command to show agent selection popup again
    const showPopupCommand = vscode.commands.registerCommand(
        'debugmcp.showAgentSelectionPopup',
        async () => {
            if (popupManager) {
                await popupManager.showAgentSelectionPopup();
            }
        }
    );

    // Command to reset popup state (for development/testing)
    const resetPopupCommand = vscode.commands.registerCommand(
        'debugmcp.resetPopupState',
        async () => {
            if (popupManager) {
                await popupManager.resetPopupState();
                vscode.window.showInformationMessage('DebugMCP popup state has been reset.');
            }
        }
    );

    context.subscriptions.push(
        configureAgentsCommand,
        showPopupCommand,
        resetPopupCommand
    );
}

export async function deactivate() {
    // Clean up MCP server
    if (mcpServer) {
        mcpServer.stop().catch(error => {
            console.error('Error stopping MCP server:', error);
        });
        mcpServer = null;
    }
    console.log('DebugMCP extension deactivated');
}
