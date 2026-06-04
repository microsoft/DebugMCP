// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import {
    DebuggingExecutor,
    ConfigurationManager,
    DebuggingHandler,
    IDebuggingHandler
} from '.';
import { logger } from './utils/logger';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Main MCP server class that exposes debugging functionality as tools and resources.
 * Uses the official @modelcontextprotocol/sdk with SSE transport over express.
 */
/**
 * Allow-list of host names that are considered loopback.
 * Used to validate the Host and Origin headers on incoming requests
 * to defend against DNS-rebinding-style attacks even when the
 * server is bound to a non-loopback interface.
 */
const LOOPBACK_HOSTNAMES = new Set<string>([
    'localhost',
    '127.0.0.1',
    '[::1]',
    '::1'
]);

/**
 * Split a Host header value into its hostname and optional port parts,
 * stripping surrounding brackets for IPv6 literals.
 */
function parseHostHeader(hostHeader: string): { hostname: string; port: string | undefined } {
    const trimmed = hostHeader.trim().toLowerCase();
    // IPv6 literal in brackets, optionally with :port suffix
    if (trimmed.startsWith('[')) {
        const closingBracketIndex = trimmed.indexOf(']');
        if (closingBracketIndex === -1) {
            return { hostname: trimmed, port: undefined }; // malformed — let caller reject
        }
        const hostname = trimmed.substring(0, closingBracketIndex + 1);
        const rest = trimmed.substring(closingBracketIndex + 1);
        const port = rest.startsWith(':') ? rest.substring(1) : undefined;
        return { hostname, port };
    }
    // IPv4 or DNS name with optional :port
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
        return { hostname: trimmed, port: undefined };
    }
    return { hostname: trimmed.substring(0, colonIndex), port: trimmed.substring(colonIndex + 1) };
}

/**
 * Returns true when the given Host header value names a loopback address.
 * If expectedPort is provided, any port suffix in the header must match it
 * (an absent port is allowed). This prevents requests aimed at a different
 * port (e.g. Host: localhost:99999) from satisfying the allow-list.
 */
export function isLoopbackHost(hostHeader: string | undefined, expectedPort?: number): boolean {
    if (!hostHeader) {
        return false;
    }
    const { hostname, port } = parseHostHeader(hostHeader);
    if (!LOOPBACK_HOSTNAMES.has(hostname)) {
        return false;
    }
    if (expectedPort !== undefined && port !== undefined && port !== String(expectedPort)) {
        return false;
    }
    return true;
}

/**
 * Returns true when the given Origin header value names a loopback address.
 * A missing Origin is allowed (most non-browser HTTP clients omit it).
 */
export function isLoopbackOrigin(originHeader: string | undefined): boolean {
    if (!originHeader) {
        return true;
    }
    try {
        const url = new URL(originHeader);
        // Strip brackets from IPv6 literal for set lookup
        const hostname = url.hostname.toLowerCase();
        return LOOPBACK_HOSTNAMES.has(hostname) || LOOPBACK_HOSTNAMES.has(`[${hostname}]`);
    } catch {
        return false;
    }
}

export class DebugMCPServer {
    private httpServers: http.Server[] = [];
    private port: number;
    private hosts: string[];
    private initialized: boolean = false;
    private debuggingHandler: IDebuggingHandler;

    constructor(port: number, timeoutInSeconds: number, host: string | string[] = ['127.0.0.1', '::1']) {
        // Initialize the debugging components with dependency injection
        const executor = new DebuggingExecutor();
        const configManager = new ConfigurationManager();
        this.debuggingHandler = new DebuggingHandler(executor, configManager, timeoutInSeconds);
        this.port = port;
        this.hosts = Array.isArray(host) ? host : [host];
    }

    /**
     * Initialize the MCP server factory.
     *
     * NOTE: We no longer hold a singleton McpServer here. The stateless
     * StreamableHTTPServerTransport requires a fresh McpServer per request
     * (calling .connect() twice on the same server throws "Already connected
     * to a transport"). The /mcp handler builds one on demand via
     * createMcpServer().
     */
    async initialize() {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
    }

    /**
     * Build a fresh McpServer with all tools and resources registered.
     * Called once per incoming MCP request.
     */
    private createMcpServer(): McpServer {
        const server = new McpServer({
            name: 'debugmcp',
            version: '1.0.0',
        });
        this.setupTools(server);
        this.setupResources(server);
        return server;
    }

    /**
     * Setup MCP tools that delegate to the debugging handler
     */
    private setupTools(server: McpServer) {
        // Get debug instructions tool (for clients that don't support MCP resources like GitHub Copilot)
        server.registerTool('get_debug_instructions', {
            description: 'Get the debugging guide with step-by-step instructions for effective debugging. ' +
                'Returns comprehensive guidance including breakpoint strategies, root cause analysis framework, ' +
                'and best practices. Call this before starting a debug session.',
        }, async () => {
            const content = await this.loadMarkdownFile('agent-resources/debug_instructions.md');
            return { content: [{ type: 'text' as const, text: content }] };
        });

        // Start debugging tool
        server.registerTool('start_debugging', {
            description: 'IMPORTANT DEBUGGING TOOL - Start a debug session for a code file' +
                '\n\nUSE THIS WHEN:' +
                '\n• Any bug, error, or unexpected behavior occurs' +
                '\n• Asked to debug a unit test' +
                '\n• Variables have wrong/null values' +
                '\n• Functions return incorrect results' +
                '\n• Code behaves differently than expected' +
                '\n• User reports "it doesn\'t work"' +
                '\n\n⚠️ CRITICAL: Before using this tool, first call get_debug_instructions or read debugmcp://docs/debug_instructions resource!',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the source code file to debug'),
                workingDirectory: z.string().describe('Working directory for the debug session'),
                testName: z.string().optional().describe(
                    'Name of a specific test name to debug. ' +
                    'Only provide this when debugging a single test method. ' +
                    'Leave empty to debug the entire file or test class.'
                ),
                configurationName: z.string().optional().describe(
                    'Optional debug configuration name from launch.json. ' +
                    'If omitted, DebugMCP uses its default generated configuration.'
                ),
            },
        }, async (args: { fileFullPath: string; workingDirectory: string; testName?: string; configurationName?: string }) => {
            const result = await this.debuggingHandler.handleStartDebugging(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Stop debugging tool
        server.registerTool('stop_debugging', {
            description: 'Stop the current debug session',
        }, async () => {
            const result = await this.debuggingHandler.handleStopDebugging();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step over tool
        server.registerTool('step_over', {
            description: 'Execute the current line of code without diving into it.',
        }, async () => {
            const result = await this.debuggingHandler.handleStepOver();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step into tool
        server.registerTool('step_into', {
            description: 'Dive into the current line of code.',
        }, async () => {
            const result = await this.debuggingHandler.handleStepInto();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step out tool
        server.registerTool('step_out', {
            description: 'Step out of the current function',
        }, async () => {
            const result = await this.debuggingHandler.handleStepOut();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Continue execution tool
        server.registerTool('continue_execution', {
            description: 'Resume program execution until the next breakpoint is hit or the program completes.',
        }, async () => {
            const result = await this.debuggingHandler.handleContinue();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Restart debugging tool
        server.registerTool('restart_debugging', {
            description: 'Restart the debug session from the beginning with the same configuration.',
        }, async () => {
            const result = await this.debuggingHandler.handleRestart();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Add breakpoint tool
        server.registerTool('add_breakpoint', {
            description: 'Set a breakpoint to pause execution at a critical line of code. Essential for debugging: pause before potential errors, examine state at decision points, or verify code paths. Breakpoints let you inspect variables and control flow at exact moments.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                lineContent: z.string().describe('Line content'),
            },
        }, async (args: { fileFullPath: string; lineContent: string }) => {
            const result = await this.debuggingHandler.handleAddBreakpoint(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Remove breakpoint tool
        server.registerTool('remove_breakpoint', {
            description: 'Remove a breakpoint that is no longer needed.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                line: z.number().describe('Line number (1-based)'),
            },
        }, async (args: { fileFullPath: string; line: number }) => {
            const result = await this.debuggingHandler.handleRemoveBreakpoint(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Clear all breakpoints tool
        server.registerTool('clear_all_breakpoints', {
            description: 'Clear all breakpoints at once. Use this after verifying the root cause to clean up before moving on to the next task.',
        }, async () => {
            const result = await this.debuggingHandler.handleClearAllBreakpoints();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // List breakpoints tool
        server.registerTool('list_breakpoints', {
            description: 'View all currently set breakpoints across all files.',
        }, async () => {
            const result = await this.debuggingHandler.handleListBreakpoints();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get variables tool
        server.registerTool('get_variables_values', {
            description: 'Inspect all variable values at the current execution point. This is your window into program state - see what data looks like at runtime, verify assumptions, identify unexpected values, and understand why code behaves as it does.',
            inputSchema: {
                scope: z.enum(['local', 'global', 'all']).optional().describe("Variable scope: 'local', 'global', or 'all'"),
            },
        }, async (args: { scope?: 'local' | 'global' | 'all' }) => {
            const result = await this.debuggingHandler.handleGetVariables(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Evaluate expression tool
        server.registerTool('evaluate_expression', {
            description: 'Powerful runtime expression evaluator: Test hypotheses, check computed values, call methods, or inspect object properties in the live debug context. Goes beyond simple variable inspection - evaluate any valid expression in the target language.',
            inputSchema: {
                expression: z.string().describe('Expression to evaluate in the current programming language context'),
            },
        }, async (args: { expression: string }) => {
            const result = await this.debuggingHandler.handleEvaluateExpression(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });
    }

    /**
     * Setup MCP resources for documentation
     */
    private setupResources(server: McpServer) {
        // Add MCP resources for debugging documentation
        server.registerResource('Debugging Instructions Guide', 'debugmcp://docs/debug_instructions', {
            description: 'Step-by-step instructions for debugging with DebugMCP',
            mimeType: 'text/markdown',
        }, async (uri: URL) => {
            const content = await this.loadMarkdownFile('agent-resources/debug_instructions.md');
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'text/markdown',
                    text: content,
                }]
            };
        });

        // Add language-specific resources
        const languages = ['python', 'javascript', 'java', 'csharp'];
        const languageTitles: Record<string, string> = {
            'python': 'Python Debugging Tips',
            'javascript': 'JavaScript Debugging Tips',
            'java': 'Java Debugging Tips',
            'csharp': 'C# Debugging Tips'
        };

        languages.forEach(language => {
            server.registerResource(
                languageTitles[language],
                `debugmcp://docs/troubleshooting/${language}`,
                {
                    description: `Debugging tips specific to ${language}`,
                    mimeType: 'text/markdown',
                },
                async (uri: URL) => {
                    const content = await this.loadMarkdownFile(`agent-resources/troubleshooting/${language}.md`);
                    return {
                        contents: [{
                            uri: uri.href,
                            mimeType: 'text/markdown',
                            text: content,
                        }]
                    };
                }
            );
        });
    }

    /**
     * Load content from a Markdown file in the docs directory
     */
    private async loadMarkdownFile(relativePath: string): Promise<string> {
        try {
            // Get the extension's installation directory
            const extensionPath = __dirname; // This points to the compiled extension's directory
            const docsPath = path.join(extensionPath, '..', 'docs', relativePath);

            console.log(`Loading markdown file from: ${docsPath}`);

            // Read the file content
            const content = await fs.promises.readFile(docsPath, 'utf8');
            console.log(`Successfully loaded ${relativePath}, content length: ${content.length}`);

            return content;
        } catch (error) {
            console.error(`Failed to load ${relativePath}:`, error);
            return `Error loading documentation from ${relativePath}: ${error}`;
        }
    }

    /**
     * Check if the server is already running
     */
    private async isServerRunning(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const request = http.request({
                hostname: 'localhost',
                port: this.port,
                path: '/',
                method: 'GET',
                timeout: 1000
            }, () => {
                resolve(true); // Server is responding
            });

            request.on('error', () => {
                resolve(false); // Server is not running
            });

            request.on('timeout', () => {
                request.destroy();
                resolve(false); // Server is not responding
            });

            request.end();
        });
    }

    /**
     * Start the MCP server with SSE transport over HTTP
     */
    async start(): Promise<void> {
        // First check if server is already running
        const isRunning = await this.isServerRunning();
        if (isRunning) {
            logger.info(`DebugMCP server is already running on port ${this.port}`);
            return;
        }

        try {
            logger.info(`Starting DebugMCP server on ${this.hosts.join(', ')}:${this.port}...`);

            // Dynamically import express (ES module)
            const expressModule = await import('express');
            const express = expressModule.default;
            const app = express();

            // Reject requests whose Host or Origin header is not loopback.
            // Defends against DNS-rebinding attacks: a malicious page that resolves
            // its domain to 127.0.0.1 will still send Host/Origin = attacker.example,
            // which we reject before any MCP handler runs.
            app.use((req: any, res: any, next: any) => {
                if (!isLoopbackHost(req.headers['host'], this.port)) {
                    logger.warn(`Rejecting request with non-loopback or wrong-port Host header: ${req.headers['host']}`);
                    res.status(403).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32000,
                            message: 'Forbidden: Host header is not a loopback address on the expected port'
                        },
                        id: null
                    });
                    return;
                }
                if (!isLoopbackOrigin(req.headers['origin'])) {
                    logger.warn(`Rejecting request with non-loopback Origin header: ${req.headers['origin']}`);
                    res.status(403).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32000,
                            message: 'Forbidden: Origin header is not a loopback address'
                        },
                        id: null
                    });
                    return;
                }
                next();
            });

            // Parse JSON body for incoming requests
            app.use(express.json());

            // Return JSON instead of HTML for malformed request bodies.
            app.use((error: any, _req: any, res: any, next: any) => {
                if (error && error.type === 'entity.parse.failed') {
                    res.status(400).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32700,
                            message: 'Parse error: invalid JSON body'
                        }
                    });
                    return;
                }
                next(error);
            });

            // Streamable HTTP endpoint — handles MCP protocol messages.
            // A fresh McpServer + transport pair is built per request because
            // StreamableHTTPServerTransport in stateless mode (sessionIdGenerator: undefined)
            // owns its connection; reusing a single McpServer across requests
            // throws "Already connected to a transport" on the second call.
            app.post('/mcp', async (req: any, res: any) => {
                logger.info('New MCP request received');

                const server = this.createMcpServer();
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined, // Stateless mode - no session management
                });
                res.on('close', () => {
                    transport.close();
                    server.close();
                    logger.info('MCP transport closed');
                });

                try {
                    await server.connect(transport);
                    await transport.handleRequest(req, res, req.body);
                } catch (error) {
                    logger.error('Error while handling MCP request', error);
                    if (!res.headersSent) {
                        res.status(500).json({
                            jsonrpc: '2.0',
                            error: {
                                code: -32603,
                                message: 'Internal MCP server error'
                            }
                        });

                        app.get('/mcp', async (_req: any, res: any) => {
                            res.status(405).json({
                                jsonrpc: '2.0',
                                error: {
                                    code: -32000,
                                    message: 'Method not allowed. Use POST /mcp.'
                                },
                                id: null
                            });
                        });

                        app.delete('/mcp', async (_req: any, res: any) => {
                            res.status(405).json({
                                jsonrpc: '2.0',
                                error: {
                                    code: -32000,
                                    message: 'Method not allowed. Use POST /mcp.'
                                },
                                id: null
                            });
                        });
                    }
                }
            });

            // Legacy SSE endpoint for backward compatibility
            // Redirects to the new /mcp endpoint with appropriate headers
            app.get('/sse', async (req: any, res: any) => {
                res.status(410).json({ 
                    error: 'SSE endpoint deprecated', 
                    message: 'Please use POST /mcp endpoint instead',
                    newEndpoint: '/mcp'
                });
            });

            // Start HTTP server(s), bound to each configured host (loopback IPv4 + IPv6 by default).
            // Binding to '127.0.0.1' alone does not cover clients that resolve `localhost` to `::1`
            // (common on IPv6-preferred systems), so we listen on both loopback families explicitly.
            for (const host of this.hosts) {
                await new Promise<void>((resolve, reject) => {
                    const server = app.listen(this.port, host, () => {
                        this.httpServers.push(server);
                        resolve();
                    });
                    server.on('error', (err: NodeJS.ErrnoException) => {
                        // EADDRINUSE on the IPv6 loopback is expected on some platforms (e.g. Linux
                        // with net.ipv6.bindv6only=0) where the IPv4 bind already covers IPv6 via
                        // dual-stack mapping. Treat as a soft warning instead of a hard failure.
                        if (err.code === 'EADDRINUSE' && this.httpServers.length > 0) {
                            logger.warn(`Skipping bind on ${host}:${this.port} (already covered by another loopback bind)`);
                            resolve();
                            return;
                        }
                        reject(err);
                    });
                });
            }

            logger.info(`DebugMCP server started successfully on ${this.hosts.join(', ')}:${this.port}`);

        } catch (error) {
            logger.error(`Failed to start DebugMCP server`, error);
            throw new Error(`Failed to start DebugMCP server: ${error}`);
        }
    }

    /**
     * Stop the MCP server
     */
    async stop() {
        // Close all HTTP servers
        if (this.httpServers.length > 0) {
            await Promise.all(this.httpServers.map(server =>
                new Promise<void>((resolve) => server.close(() => resolve()))
            ));
            this.httpServers = [];
        }

        logger.info('DebugMCP server stopped');
    }

    /**
     * Get the server endpoint
     */
    getEndpoint(): string {
        return `http://localhost:${this.port}`;
    }

    /**
     * Get the debugging handler (for testing purposes)
     */
    getDebuggingHandler(): IDebuggingHandler {
        return this.debuggingHandler;
    }

    /**
     * Check if the server is initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }
}