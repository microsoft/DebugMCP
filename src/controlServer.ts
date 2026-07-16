// Copyright (c) Microsoft Corporation.

import * as http from 'http';
import { IDebuggingHandler } from './debuggingHandler';
import { logger } from './utils/logger';

/**
 * Per-window loopback HTTP server that runs debug operations against this
 * window's local DebuggingHandler. The router window forwards each MCP tool
 * call here so debugging happens in the window that owns the workspace.
 *
 * Bound to 127.0.0.1 and gated by a per-window token read from the registry.
 */
export class ControlServer {
	private server: http.Server | undefined;
	private boundPort = 0;

	constructor(
		private readonly handler: IDebuggingHandler,
		private readonly token: string
	) {}

	/** The ephemeral loopback port chosen by the OS, or 0 before start(). */
	public getPort(): number {
		return this.boundPort;
	}

	/** Start listening on an ephemeral loopback port. Resolves with the port. */
	public async start(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const server = http.createServer((req, res) => this.onRequest(req, res));
			server.on('error', reject);
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				this.boundPort = typeof address === 'object' && address ? address.port : 0;
				this.server = server;
				logger.info(`DebugMCP control server listening on 127.0.0.1:${this.boundPort}`);
				resolve(this.boundPort);
			});
		});
	}

	/** Stop listening. */
	public async stop(): Promise<void> {
		if (this.server) {
			await new Promise<void>((resolve) => this.server!.close(() => resolve()));
			this.server = undefined;
		}
	}

	private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (req.method !== 'POST' || req.url !== '/op') {
			res.writeHead(404).end();
			return;
		}
		if (req.headers['x-debugmcp-token'] !== this.token) {
			res.writeHead(403).end();
			return;
		}

		let body = '';
		req.on('data', (chunk) => {
			body += chunk;
		});
		req.on('end', async () => {
			try {
				const { op, args } = JSON.parse(body || '{}') as { op: string; args?: unknown };
				const result = await this.dispatch(op, args ?? {});
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ result }));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: message }));
			}
		});
	}

	/** Map a control op name onto the local debugging handler. */
	private dispatch(op: string, args: any): Promise<string> {
		switch (op) {
			case 'handleStartDebugging':
				return this.handler.handleStartDebugging(args);
			case 'handleStopDebugging':
				return this.handler.handleStopDebugging();
			case 'handleStepOver':
				return this.handler.handleStepOver();
			case 'handleStepInto':
				return this.handler.handleStepInto();
			case 'handleStepOut':
				return this.handler.handleStepOut();
			case 'handleContinue':
				return this.handler.handleContinue();
			case 'handleRestart':
				return this.handler.handleRestart();
			case 'handleAddBreakpoint':
				return this.handler.handleAddBreakpoint(args);
			case 'handleRemoveBreakpoint':
				return this.handler.handleRemoveBreakpoint(args);
			case 'handleClearAllBreakpoints':
				return this.handler.handleClearAllBreakpoints();
			case 'handleListBreakpoints':
				return this.handler.handleListBreakpoints();
			case 'handleGetVariables':
				return this.handler.handleGetVariables(args);
			case 'handleEvaluateExpression':
				return this.handler.handleEvaluateExpression(args);
			default:
				return Promise.reject(new Error(`Unknown control op: ${op}`));
		}
	}
}
