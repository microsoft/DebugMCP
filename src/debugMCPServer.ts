// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { z } from 'zod';
import * as http from 'http';
import { randomUUID } from 'node:crypto';
import {
    DebuggingExecutor,
    ConfigurationManager,
    DebuggingHandler,
    IDebuggingHandler
} from '.';
import { logger } from './utils/logger';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * Main MCP server class that exposes debugging functionality as tools.
 *
 * Tools only. Procedural workflow guidance (when to debug, how to perform
 * root-cause analysis, language-specific quirks) lives in the companion
 * Agent Skill at `skills/debug-live/` — the MCP surface itself only describes
 * what each tool does, not how to use them together.
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
    // Active Streamable-HTTP transports keyed by MCP session id. The transport
    // is created on `initialize` and reused for that session's subsequent
    // POST (requests), GET (server->client SSE stream), and DELETE (teardown).
    private transports: Record<string, StreamableHTTPServerTransport> = {};

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
     * NOTE: We no longer hold a singleton McpServer here. In stateful session
     * mode each `initialize` request gets its own transport + McpServer pair
     * (calling .connect() twice on the same server throws "Already connected
     * to a transport"). The POST /mcp handler builds one per session via
     * createMcpServer() and keeps it in `this.transports` for the session's
     * lifetime.
     */
    async initialize() {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
    }

    /**
     * Build a fresh McpServer with all tools registered.
     * Called once per session, when an `initialize` request opens it.
     */
    private createMcpServer(): McpServer {
        const server = new McpServer({
            name: 'debugmcp',
            version: '1.0.0',
        }, {
            // Surfaced to clients at `initialize`. Points agents at the
            // `debug-live` Agent Skill, which the extension installs into the
            // standard skills directories for harnesses that load skills.
            instructions: 'These tools drive the VS Code debugger to investigate bugs, failing tests, ' +
                'wrong/null values and other "it doesn\'t work" reports by stepping through code. ' +
                'The companion "debug-live" Agent Skill describes the full interactive workflow: ' +
                'when to set breakpoints, how to step and inspect state, and how to do root-cause analysis.',
        });
        this.setupTools(server);
        return server;
    }

    /**
     * Setup MCP tools that delegate to the debugging handler.
     *
     * Tool descriptions are intentionally terse and behavioral. Procedural
     * guidance (when to use which tool, how to perform root-cause analysis,
     * language-specific quirks) lives in the companion Agent Skill at
     * `skills/debug-live/SKILL.md`.
     */
    private setupTools(server: McpServer) {
        // Start debugging tool
        server.registerTool('start_debugging', {
            description: 'Start a VS Code debug session for a source file, optionally for a single test method. ' +
                'Use when investigating bugs, failing tests, wrong/null variable values, unexpected runtime behavior, ' +
                'or any "it doesn\'t work" report. See the "debug-live" skill for the full investigation workflow.',
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

        // Pause execution tool
        server.registerTool('pause_execution', {
            description: 'Interrupt a running program and stop at its current location, even when no breakpoint is set. Useful for busy loops or embedded/bare-metal targets running freely — then inspect variables or step from where it stopped.',
        }, async () => {
            const result = await this.debuggingHandler.handlePause();
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
            description: 'Set a breakpoint to pause execution at a critical line of code. Essential for debugging: pause before potential errors, examine state at decision points, or verify code paths. Breakpoints let you inspect variables and control flow at exact moments. Provide an optional condition to create a conditional breakpoint that only pauses when the expression evaluates to true (e.g. "i == 5" or "user.id === null").',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                lineContent: z.string().describe('Line content'),
                condition: z.string().optional().describe('Optional condition expression. When provided, execution only pauses if this expression evaluates to true at the breakpoint location.'),
            },
        }, async (args: { fileFullPath: string; lineContent: string; condition?: string }) => {
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
            // A fresh McpServer + transport pair is built per session (on the
            // `initialize` request) and reused for that session's subsequent
            // requests; reusing one McpServer across sessions would throw
            // "Already connected to a transport" on the second connect().
            // POST /mcp — client→server JSON-RPC. An `initialize` request with no
            // session id creates a new session (transport + McpServer pair) and is
            // remembered by its generated session id; subsequent requests carrying
            // that `mcp-session-id` header reuse the same transport.
            //
            // NOTE: We run in *stateful* (session) mode rather than stateless.
            // Stateless mode (sessionIdGenerator: undefined) cannot serve the
            // server→client SSE stream that clients open via GET /mcp right after
            // initialize. Cursor's MCP client treats a failed stream open as a fatal
            // transport error and tombstones the connection after a few attempts,
            // leaving the server permanently flagged "errored" even though POST tool
            // calls still work. Session mode gives GET a real stream to attach to.
            app.post('/mcp', async (req: any, res: any) => {
                try {
                    const sessionId = req.headers['mcp-session-id'] as string | undefined;
                    let transport: StreamableHTTPServerTransport;

                    if (sessionId && this.transports[sessionId]) {
                        // Reuse the transport for an established session.
                        transport = this.transports[sessionId];
                    } else if (!sessionId && isInitializeRequest(req.body)) {
                        // Brand-new session: build a transport + server and register it
                        // once the SDK assigns a session id.
                        transport = new StreamableHTTPServerTransport({
                            sessionIdGenerator: () => randomUUID(),
                            onsessioninitialized: (sid: string) => {
                                this.transports[sid] = transport;
                                logger.info(`MCP session initialized: ${sid}`);
                            },
                        });
                        transport.onclose = () => {
                            const sid = transport.sessionId;
                            if (sid && this.transports[sid]) {
                                delete this.transports[sid];
                                logger.info(`MCP session closed: ${sid}`);
                            }
                        };
                        const server = this.createMcpServer();
                        await server.connect(transport);
                    } else {
                        // No session id and not an initialize request — invalid.
                        res.status(400).json({
                            jsonrpc: '2.0',
                            error: {
                                code: -32000,
                                message: 'Bad Request: no valid session ID provided'
                            },
                            id: null
                        });
                        return;
                    }

                    await transport.handleRequest(req, res, req.body);
                } catch (error) {
                    logger.error('Error while handling MCP request', error);
                    if (!res.headersSent) {
                        res.status(500).json({
                            jsonrpc: '2.0',
                            error: {
                                code: -32603,
                                message: 'Internal MCP server error'
                            },
                            id: null
                        });
                    }
                }
            });

            // GET /mcp opens the server→client SSE notification stream for an
            // existing session; DELETE /mcp terminates a session. Both require a
            // valid mcp-session-id and are delegated to that session's transport.
            // These MUST be registered at startup (a prior bug registered them
            // lazily inside the POST error handler, so GET /mcp returned a bare 404
            // under normal operation and clients reported the server as errored).
            const handleSessionRequest = async (req: any, res: any) => {
                const sessionId = req.headers['mcp-session-id'] as string | undefined;
                if (!sessionId || !this.transports[sessionId]) {
                    res.status(400).json({
                        jsonrpc: '2.0',
                        error: {
                            code: -32000,
                            message: 'Bad Request: invalid or missing session ID'
                        },
                        id: null
                    });
                    return;
                }
                await this.transports[sessionId].handleRequest(req, res);
            };
            app.get('/mcp', handleSessionRequest);
            app.delete('/mcp', handleSessionRequest);

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
        // Tear down any open MCP sessions (closes their SSE streams) first.
        for (const sessionId of Object.keys(this.transports)) {
            try {
                this.transports[sessionId].close();
            } catch (error) {
                logger.warn(`Error closing MCP session ${sessionId}`, error);
            }
        }
        this.transports = {};

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