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
import { withTimeout } from './utils/withTimeout';
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
    // Overall backstop (ms) around every tool call so a wedged adapter or
    // unresponsive worker can't leave an MCP request pending forever. Kept
    // above the handler's own timeout so it only trips when truly stuck.
    private toolBackstopMs: number;
    // Per-MCP-session handler factory. A fresh handler per session lets each
    // agent session keep its own routing target (repo/window) when proxying.
    private handlerFactory: () => IDebuggingHandler;
    // Active Streamable-HTTP transports keyed by MCP session id. The transport
    // is created on `initialize` and reused for that session's subsequent
    // POST (requests), GET (server->client SSE stream), and DELETE (teardown).
    private transports: Record<string, StreamableHTTPServerTransport> = {};

    constructor(
        port: number,
        timeoutInSeconds: number,
        host: string | string[] = ['127.0.0.1', '::1'],
        handlerFactory?: () => IDebuggingHandler
    ) {
        if (handlerFactory) {
            this.handlerFactory = handlerFactory;
        } else {
            // Default (single-window) behaviour: debug in this very window.
            const executor = new DebuggingExecutor();
            const configManager = new ConfigurationManager();
            const handler = new DebuggingHandler(executor, configManager, timeoutInSeconds);
            this.handlerFactory = () => handler;
        }
        this.port = port;
        this.hosts = Array.isArray(host) ? host : [host];
        this.toolBackstopMs = timeoutInSeconds * 1000 + 30_000;
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
        this.setupTools(server, this.handlerFactory());
        return server;
    }

    /**
     * Run a tool's handler with an overall backstop timeout so a wedged adapter
     * or unresponsive worker can't hang the MCP request. Last line of defense.
     */
    private async runTool(
        toolName: string,
        run: () => Promise<string>
    ): Promise<{ content: { type: 'text'; text: string }[] }> {
        const result = await withTimeout(
            run(),
            this.toolBackstopMs,
            () => new Error(
                `Tool "${toolName}" did not complete within ${Math.round(this.toolBackstopMs / 1000)}s and was aborted. ` +
                'The debug adapter or target VS Code window may be unresponsive. Try stop_debugging and retry, or reload the window.'
            )
        );
        return { content: [{ type: 'text' as const, text: result }] };
    }

    /**
     * Setup MCP tools that delegate to the debugging handler.
     *
     * Tool descriptions are intentionally terse and behavioral. Procedural
     * guidance (when to use which tool, how to perform root-cause analysis,
     * language-specific quirks) lives in the companion Agent Skill at
     * `skills/debug-live/SKILL.md`.
     */
    private setupTools(server: McpServer, debuggingHandler: IDebuggingHandler) {
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
        }, async (args: { fileFullPath: string; workingDirectory: string; testName?: string; configurationName?: string }) =>
            this.runTool('start_debugging', () => debuggingHandler.handleStartDebugging(args)));

        // Stop debugging tool
        server.registerTool('stop_debugging', {
            description: 'Stop the current debug session',
        }, async () => this.runTool('stop_debugging', () => debuggingHandler.handleStopDebugging()));

        // Step over tool
        server.registerTool('step_over', {
            description: 'Execute the current line of code without diving into it.',
        }, async () => this.runTool('step_over', () => debuggingHandler.handleStepOver()));

        // Step into tool
        server.registerTool('step_into', {
            description: 'Dive into the current line of code.',
        }, async () => this.runTool('step_into', () => debuggingHandler.handleStepInto()));

        // Step out tool
        server.registerTool('step_out', {
            description: 'Step out of the current function',
        }, async () => this.runTool('step_out', () => debuggingHandler.handleStepOut()));

        // Continue execution tool
        server.registerTool('continue_execution', {
            description: 'Resume program execution until the next breakpoint is hit or the program completes.',
        }, async () => this.runTool('continue_execution', () => debuggingHandler.handleContinue()));

        // Pause execution tool
        server.registerTool('pause_execution', {
            description: 'Interrupt a running program and stop at its current location, even when no breakpoint is set. Useful for busy loops or embedded/bare-metal targets running freely — then inspect variables or step from where it stopped.',
        }, async () => this.runTool('pause_execution', () => debuggingHandler.handlePause()));

        // Restart debugging tool
        server.registerTool('restart_debugging', {
            description: 'Restart the debug session from the beginning with the same configuration.',
        }, async () => this.runTool('restart_debugging', () => debuggingHandler.handleRestart()));

        // Add breakpoint tool
        server.registerTool('add_breakpoint', {
            description: 'Set a breakpoint to pause execution at a critical line of code. Essential for debugging: pause before potential errors, examine state at decision points, or verify code paths. Breakpoints let you inspect variables and control flow at exact moments. Provide an optional condition to create a conditional breakpoint that only pauses when the expression evaluates to true (e.g. "i == 5" or "user.id === null").',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                line: z.number().int().describe('Line number (1-based) where the breakpoint should be set'),
                condition: z.string().optional().describe('Optional condition expression. When provided, execution only pauses if this expression evaluates to true at the breakpoint location.'),
            },
        }, async (args: { fileFullPath: string; line: number; condition?: string }) =>
            this.runTool('add_breakpoint', () => debuggingHandler.handleAddBreakpoint(args)));

        // Add logpoint tool
        server.registerTool('add_logpoint', {
            description: 'Add a logpoint: a breakpoint that logs a message instead of pausing execution. Ideal for tracing values across many iterations or hot paths without stopping, or where a hard pause would distort timing. Embed expressions in curly braces to interpolate runtime values, e.g. "user id={user.id}, count={items.length}". Provide an optional condition to only log when it evaluates to true.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                line: z.number().int().describe('Line number (1-based) where the logpoint should be set'),
                logMessage: z.string().describe('Message to log when the line is reached. Wrap expressions in {curly braces} to interpolate runtime values.'),
                condition: z.string().optional().describe('Optional condition expression. When provided, the message is only logged if this expression evaluates to true.'),
            },
        }, async (args: { fileFullPath: string; line: number; logMessage: string; condition?: string }) =>
            this.runTool('add_logpoint', () => debuggingHandler.handleAddLogpoint(args)));

        // Remove breakpoint tool
        server.registerTool('remove_breakpoint', {
            description: 'Remove a breakpoint that is no longer needed.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                line: z.number().describe('Line number (1-based)'),
            },
        }, async (args: { fileFullPath: string; line: number }) =>
            this.runTool('remove_breakpoint', () => debuggingHandler.handleRemoveBreakpoint(args)));

        // Clear all breakpoints tool
        server.registerTool('clear_all_breakpoints', {
            description: 'Clear all breakpoints at once. Use this after verifying the root cause to clean up before moving on to the next task.',
        }, async () => this.runTool('clear_all_breakpoints', () => debuggingHandler.handleClearAllBreakpoints()));

        // List breakpoints tool
        server.registerTool('list_breakpoints', {
            description: 'View all currently set breakpoints across all files.',
        }, async () => this.runTool('list_breakpoints', () => debuggingHandler.handleListBreakpoints()));

        // Get variables tool
        server.registerTool('get_variables_values', {
            description: 'Inspect all variable values at the current execution point. This is your window into program state - see what data looks like at runtime, verify assumptions, identify unexpected values, and understand why code behaves as it does.',
            inputSchema: {
                scope: z.enum(['local', 'global', 'all']).optional().describe("Variable scope: 'local', 'global', or 'all'"),
            },
        }, async (args: { scope?: 'local' | 'global' | 'all' }) =>
            this.runTool('get_variables_values', () => debuggingHandler.handleGetVariables(args)));

        // Evaluate expression tool
        server.registerTool('evaluate_expression', {
            description: 'Powerful runtime expression evaluator: Test hypotheses, check computed values, call methods, or inspect object properties in the live debug context. Goes beyond simple variable inspection - evaluate any valid expression in the target language.',
            inputSchema: {
                expression: z.string().describe('Expression to evaluate in the current programming language context'),
            },
        }, async (args: { expression: string }) =>
            this.runTool('evaluate_expression', () => debuggingHandler.handleEvaluateExpression(args)));
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
     * Try to become the router by binding the public port.
     * Returns `true` if this window owns the port, `false` if another already does.
     */
    async start(): Promise<boolean> {
        // If the port is already served, another window is the router.
        const isRunning = await this.isServerRunning();
        if (isRunning) {
            logger.info(`DebugMCP router already owned by another window on port ${this.port}`);
            return false;
        }
        if (this.httpServers.length > 0) {
            // We already bound the port on a previous call — nothing to do.
            return true;
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
                const bound = await new Promise<boolean>((resolve, reject) => {
                    const server = app.listen(this.port, host, () => {
                        this.httpServers.push(server);
                        resolve(true);
                    });
                    server.on('error', (err: NodeJS.ErrnoException) => {
                        if (err.code === 'EADDRINUSE') {
                            // Already bound another loopback family (dual-stack) -> soft-skip.
                            // Nothing bound yet -> another window won the port; yield to retry as worker.
                            if (this.httpServers.length > 0) {
                                logger.warn(`Skipping bind on ${host}:${this.port} (already covered by another loopback bind)`);
                                resolve(true);
                            } else {
                                logger.info(`Another window won the DebugMCP router port ${this.port}; staying worker-only`);
                                resolve(false);
                            }
                            return;
                        }
                        reject(err);
                    });
                });
                if (!bound && this.httpServers.length === 0) {
                    // Lost the race before binding anything — not the router.
                    return false;
                }
            }

            logger.info(`DebugMCP router started successfully on ${this.hosts.join(', ')}:${this.port}`);
            return true;

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
     * Get a debugging handler instance (for testing purposes). Builds one via
     * the same per-session factory the MCP layer uses.
     */
    getDebuggingHandler(): IDebuggingHandler {
        return this.handlerFactory();
    }

    /**
     * Check if the server is initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }
}