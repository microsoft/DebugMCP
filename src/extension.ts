// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { DebugMCPServer } from './debugMCPServer';
import { DebuggingExecutor, ConfigurationManager, DebuggingHandler } from '.';
import { ControlServer } from './controlServer';
import { RoutingDebuggingHandler } from './routingDebuggingHandler';
import { WorkspaceRegistry } from './utils/workspaceRegistry';
import { AgentConfigurationManager } from './utils/agentConfigurationManager';
import { logger, LogLevel } from './utils/logger';

let mcpServer: DebugMCPServer | null = null;
let agentConfigManager: AgentConfigurationManager | null = null;
let controlServer: ControlServer | null = null;
let registry: WorkspaceRegistry | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let routerRetryTimer: NodeJS.Timeout | null = null;

/** Interval (ms) for registry heartbeat and router-takeover retries. */
const HEARTBEAT_INTERVAL_MS = 15_000;
const ROUTER_RETRY_INTERVAL_MS = 5_000;

export async function activate(context: vscode.ExtensionContext) {
    // Initialize logging first
    logger.info('DebugMCP extension is now active!');
    logger.logSystemInfo();
    logger.logEnvironment();

    const config = vscode.workspace.getConfiguration('debugmcp');
    const timeoutInSeconds = config.get<number>('timeoutInSeconds', 180);
    const serverPort = config.get<number>('serverPort', 3001);
    const bindHostSetting = config.get<string | string[]>('bindHost', ['127.0.0.1', '::1']);
    const bindHosts = Array.isArray(bindHostSetting) ? bindHostSetting : [bindHostSetting];

    logger.info(`Using timeoutInSeconds: ${timeoutInSeconds} seconds`);
    logger.info(`Using serverPort: ${serverPort}`);
    logger.info(`Using bindHost: ${bindHosts.join(', ')}`);
    const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
    const nonLoopback = bindHosts.filter(h => !loopbackHosts.has(h));
    if (nonLoopback.length > 0) {
        logger.warn(
            `DebugMCP is bound to '${nonLoopback.join(', ')}' instead of loopback. ` +
            `This exposes the unauthenticated debugger to other hosts on the network. ` +
            `Set 'debugmcp.bindHost' back to the default loopback unless you fully trust the network.`
        );
    }

    // Initialize Agent Configuration Manager
    agentConfigManager = new AgentConfigurationManager(context, timeoutInSeconds, serverPort);

    // Migrate existing SSE configurations to streamableHttp (for backward compatibility)
    try {
        await agentConfigManager.migrateExistingConfigurations();
    } catch (error) {
        logger.error('Error migrating existing configurations', error);
    }

    // Initialize MCP Server
    try {
        logger.info('Starting MCP server initialization...');

        // Every window runs a local debug stack + loopback control server and
        // advertises its workspace folders. The window that wins the public port
        // becomes the router and proxies each session to the control server of
        // the window owning the requested workspace.
        const executor = new DebuggingExecutor();
        const configManager = new ConfigurationManager();
        const localHandler = new DebuggingHandler(executor, configManager, timeoutInSeconds);
        const controlToken = randomUUID();

        controlServer = new ControlServer(localHandler, controlToken);
        const controlPort = await controlServer.start();

        registry = new WorkspaceRegistry();
        const registerSelf = () => {
            registry?.register({
                controlPort,
                controlToken,
                workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
                name: vscode.workspace.name ?? 'unknown'
            });
        };
        registerSelf();
        heartbeatTimer = setInterval(() => registry?.heartbeat(), HEARTBEAT_INTERVAL_MS);
        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => registerSelf())
        );

        mcpServer = new DebugMCPServer(
            serverPort,
            timeoutInSeconds,
            bindHosts,
            () => new RoutingDebuggingHandler(registry!, timeoutInSeconds)
        );
        await mcpServer.initialize();

        const isRouter = await mcpServer.start();
        if (isRouter) {
            const endpoint = mcpServer.getEndpoint();
            logger.info(`DebugMCP router running at: ${endpoint}`);

            const hasShownRunningMessage = context.globalState.get<boolean>('serverRunningMessageShown', false);
            if (!hasShownRunningMessage) {
                vscode.window.showInformationMessage(`DebugMCP server running on ${endpoint}`);
                await context.globalState.update('serverRunningMessageShown', true);
            }
        } else {
            // Another window is the router. Keep retrying so this window can take
            // over if that window later closes and frees the port.
            logger.info('DebugMCP running as a worker window; another window owns the router port.');
            routerRetryTimer = setInterval(async () => {
                try {
                    if (mcpServer && await mcpServer.start()) {
                        logger.info('This window has taken over as the DebugMCP router.');
                        if (routerRetryTimer) {
                            clearInterval(routerRetryTimer);
                            routerRetryTimer = null;
                        }
                    }
                } catch (error) {
                    logger.error('Router takeover attempt failed', error);
                }
            }, ROUTER_RETRY_INTERVAL_MS);
        }
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

    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (routerRetryTimer) {
        clearInterval(routerRetryTimer);
        routerRetryTimer = null;
    }

    // Remove this window from the shared registry so other windows stop routing to it.
    if (registry) {
        registry.unregister();
        registry = null;
    }

    // Stop the per-window control server.
    if (controlServer) {
        controlServer.stop().catch(error => {
            logger.error('Error stopping control server', error);
        });
        controlServer = null;
    }

    // Clean up MCP server (only bound in the router window).
    if (mcpServer) {
        mcpServer.stop().catch(error => {
            logger.error('Error stopping MCP server', error);
        });
        mcpServer = null;
    }
    
    logger.info('DebugMCP extension deactivated');
}
