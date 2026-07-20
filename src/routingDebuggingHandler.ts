// Copyright (c) Microsoft Corporation.

import * as http from 'http';
import { IDebuggingHandler } from './debuggingHandler';
import { WorkspaceRegistry, WindowRegistration } from './utils/workspaceRegistry';
import { logger } from './utils/logger';

/**
 * Router-window handler (one instance per MCP session) that forwards every
 * operation to the ControlServer of the window owning the requested workspace.
 *
 * The target is resolved from a path hint (`workingDirectory`/`fileFullPath`)
 * and cached for the session so later hint-less calls (step/continue/inspect)
 * reach the same window. Per-session instances let concurrent agent sessions
 * drive debuggers in different repos at once.
 */
export class RoutingDebuggingHandler implements IDebuggingHandler {
	private target: WindowRegistration | undefined;

	// Bound the router->worker round-trip so a hung worker can't hang the
	// forward forever. Kept above the worker's own timeout to avoid preempting
	// slow-but-progressing operations. `forwardTimeoutMs` can be passed
	// explicitly (mainly for tests) to override the derived value.
	private readonly forwardTimeoutMs: number;

	constructor(
		private readonly registry: WorkspaceRegistry,
		timeoutInSeconds: number = 180,
		forwardTimeoutMs?: number
	) {
		this.forwardTimeoutMs = forwardTimeoutMs ?? timeoutInSeconds * 1000 + 15_000;
	}

	/**
	 * Resolve (and cache) the target from an optional path hint; a hint always
	 * re-resolves, otherwise the cached target is reused.
	 */
	private resolveTarget(pathHint?: string): WindowRegistration {
		if (pathHint) {
			const found = this.registry.findByPath(pathHint);
			const candidates = this.registry
				.list()
				.map((w) => `pid=${w.pid} port=${w.controlPort} folders=[${w.workspaceFolders.join(', ') || 'none'}]`)
				.join(' | ');
			logger.info(
				`Routing hint "${pathHint}" -> ${found ? `pid=${found.pid} port=${found.controlPort}` : 'no match'}. ` +
					`Registered windows: ${candidates || '(none)'}`
			);
			if (found) {
				this.target = found;
			}
		}
		if (!this.target) {
			throw new Error(this.noTargetMessage(pathHint));
		}
		return this.target;
	}

	private noTargetMessage(pathHint?: string): string {
		const windows = this.registry.list();
		const openList = windows
			.map((w) => (w.workspaceFolders.length ? w.workspaceFolders.join(', ') : '(no folder)'))
			.join('; ');
		if (pathHint) {
			return (
				`DebugMCP could not find an open VS Code window whose workspace contains "${pathHint}". ` +
				(openList
					? `Open the correct folder in VS Code. Currently registered workspaces: ${openList}.`
					: 'No DebugMCP-enabled VS Code windows are currently registered.')
			);
		}
		return (
			'DebugMCP has no active debug target for this session. ' +
			'Call start_debugging (or add_breakpoint) with a file path first so DebugMCP can route to the right VS Code window.'
		);
	}

	private async forward(op: string, args: unknown, pathHint?: string): Promise<string> {
		const target = this.resolveTarget(pathHint);
		try {
			return await this.post(target, op, args);
		} catch (error) {
			// Failed round-trip usually means the window closed; drop the cache
			// so the next path-bearing call re-resolves.
			this.target = undefined;
			throw error;
		}
	}

	private post(target: WindowRegistration, op: string, args: unknown): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const payload = JSON.stringify({ op, args });
			let settled = false;
			const req = http.request(
				{
					hostname: '127.0.0.1',
					port: target.controlPort,
					path: '/op',
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': Buffer.byteLength(payload),
						'x-debugmcp-token': target.controlToken
					}
				},
				(res) => {
					let body = '';
					res.on('data', (chunk) => {
						body += chunk;
					});
					res.on('end', () => {
						if (settled) {
							return;
						}
						settled = true;
						try {
							const parsed = JSON.parse(body || '{}') as { result?: string; error?: string };
							if (res.statusCode === 200 && typeof parsed.result === 'string') {
								resolve(parsed.result);
							} else {
								reject(new Error(parsed.error || `Window control server returned HTTP ${res.statusCode}`));
							}
						} catch {
							reject(new Error(`Invalid response from window control server: ${body}`));
						}
					});
				}
			);
			// Abort if the worker accepts the connection but never responds;
			// otherwise the forward (and its MCP request) would hang forever.
			req.setTimeout(this.forwardTimeoutMs, () => {
				if (settled) {
					return;
				}
				settled = true;
				logger.warn(
					`Control server for window pid ${target.pid} did not respond within ${this.forwardTimeoutMs}ms; aborting.`
				);
				req.destroy();
				reject(
					new Error(
						`The VS Code window (pid ${target.pid}) hosting this workspace did not respond within ` +
							`${Math.round(this.forwardTimeoutMs / 1000)}s. Its debugger may be unresponsive. ` +
							'Try stop_debugging and retry, or reload that window.'
					)
				);
			});
			req.on('error', (err) => {
				if (settled) {
					return;
				}
				settled = true;
				logger.warn(`Failed to reach control server for window pid ${target.pid}: ${err.message}`);
				reject(
					new Error(
						`Failed to reach the VS Code window (pid ${target.pid}) hosting this workspace. ` +
							'It may have been closed. Re-run start_debugging in the intended window.'
					)
				);
			});
			req.write(payload);
			req.end();
		});
	}

	public handleStartDebugging(args: {
		fileFullPath: string;
		workingDirectory: string;
		testName?: string;
		configurationName?: string;
	}): Promise<string> {
		return this.forward('handleStartDebugging', args, args.workingDirectory || args.fileFullPath);
	}

	public handleStopDebugging(): Promise<string> {
		return this.forward('handleStopDebugging', {});
	}

	public handleStepOver(): Promise<string> {
		return this.forward('handleStepOver', {});
	}

	public handleStepInto(): Promise<string> {
		return this.forward('handleStepInto', {});
	}

	public handleStepOut(): Promise<string> {
		return this.forward('handleStepOut', {});
	}

	public handleContinue(): Promise<string> {
		return this.forward('handleContinue', {});
	}

	public handlePause(): Promise<string> {
		return this.forward('handlePause', {});
	}

	public handleRestart(): Promise<string> {
		return this.forward('handleRestart', {});
	}

	public handleAddBreakpoint(args: { fileFullPath: string; line: number; condition?: string }): Promise<string> {
		return this.forward('handleAddBreakpoint', args, args.fileFullPath);
	}

	public handleAddLogpoint(args: { fileFullPath: string; line: number; logMessage: string; condition?: string }): Promise<string> {
		return this.forward('handleAddLogpoint', args, args.fileFullPath);
	}

	public handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string> {
		return this.forward('handleRemoveBreakpoint', args, args.fileFullPath);
	}

	public handleClearAllBreakpoints(): Promise<string> {
		return this.forward('handleClearAllBreakpoints', {});
	}

	public handleListBreakpoints(): Promise<string> {
		return this.forward('handleListBreakpoints', {});
	}

	public handleGetVariables(args: { scope?: 'local' | 'global' | 'all' }): Promise<string> {
		return this.forward('handleGetVariables', args);
	}

	public handleEvaluateExpression(args: { expression: string }): Promise<string> {
		return this.forward('handleEvaluateExpression', args);
	}
}
