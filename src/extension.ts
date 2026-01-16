// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { DebugMCPServer } from './debugMCPServer';
import { VSCodeDebugBackend, VSCodeConfigurationManager } from './vscode';
import { AgentConfigurationManager } from './utils/agentConfigurationManager';
import { logger } from './utils/logger';

let mcpServer: DebugMCPServer | null = null;
let agentConfigManager: AgentConfigurationManager | null = null;

export async function activate(context: vscode.ExtensionContext) {
    // Initialize logging first
    logger.info('DebugMCP extension is now active!');
    // Log system info (VS Code specific - these are no-ops in standalone)
    logger.info(`VS Code Version: ${vscode.version}`);
    logger.info(`Platform: ${process.platform}`);
    logger.info(`Architecture: ${process.arch}`);
    logger.info(`Node.js Version: ${process.version}`);

    const config = vscode.workspace.getConfiguration('debugmcp');
    const timeoutInSeconds = config.get<number>('timeoutInSeconds', 180);
    const serverPort = config.get<number>('serverPort', 3001);

    logger.info(`Using timeoutInSeconds: ${timeoutInSeconds} seconds`);
    logger.info(`Using serverPort: ${serverPort}`);

    // Initialize Agent Configuration Manager
    agentConfigManager = new AgentConfigurationManager(context, timeoutInSeconds, serverPort);

    // Initialize MCP Server
    try {
        logger.info('Starting MCP server initialization...');
        
        // Create VS Code specific backend and configuration manager
        const backend = new VSCodeDebugBackend();
        const configManager = new VSCodeConfigurationManager();
        
        mcpServer = new DebugMCPServer(serverPort, timeoutInSeconds, backend, configManager);
        await mcpServer.initialize();
        await mcpServer.start();
        
        const endpoint = mcpServer.getEndpoint();
        logger.info(`DebugMCP server running at: ${endpoint}`);
        vscode.window.showInformationMessage(`DebugMCP server running on ${endpoint}`);
    } catch (error) {
        logger.error('Failed to initialize MCP server', error);
        vscode.window.showErrorMessage(`Failed to initialize MCP server: ${error}`);
    }

    // Register commands
    registerCommands(context);

    // Show post-install popup if needed (with slight delay to allow VS Code to fully load)
    setTimeout(async () => {
        try {
            if (agentConfigManager && await agentConfigManager.shouldShowPopup()) {
                await agentConfigManager.showAgentSelectionPopup();
            }
        } catch (error) {
            logger.error('Error showing post-install popup', error);
        }
    }, 2000);

    logger.info('DebugMCP extension activated successfully');
}

/**
 * Register extension commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    // Command to manually configure DebugMCP for agents
    const configureAgentsCommand = vscode.commands.registerCommand(
        'debugmcp.configureAgents',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.showManualConfiguration();
            }
        }
    );

    // Command to show agent selection popup again
    const showPopupCommand = vscode.commands.registerCommand(
        'debugmcp.showAgentSelectionPopup',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.showAgentSelectionPopup();
            }
        }
    );

    // Command to reset popup state (for development/testing)
    const resetPopupCommand = vscode.commands.registerCommand(
        'debugmcp.resetPopupState',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.resetPopupState();
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
    logger.info('DebugMCP extension deactivating...');
    
    // Clean up MCP server
    if (mcpServer) {
        mcpServer.stop().catch(error => {
            logger.error('Error stopping MCP server', error);
        });
        mcpServer = null;
    }
    
    logger.info('DebugMCP extension deactivated');
}
