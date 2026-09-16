// Copyright (c) Microsoft Corporation.

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DebugState, StackFrame } from '../debugState';
import { DebugBreakpoint, DebugConfiguration, DebugSessionInfo } from '../debugTypes';
import {
	IDebuggingExecutor,
	TestDebugDispatch,
	VariableChildrenOptions
} from '../debuggingExecutor';
import { CliDebugConfiguration } from './cliConfigurationManager';
import { DapClient } from './dapClient';

type SessionState = 'none' | 'starting' | 'running' | 'stopped' | 'terminated';
type ReadyState = 'stopped' | 'terminated' | 'timeout' | 'no-session' | 'attached';

export class CliDebuggingExecutor implements IDebuggingExecutor {
	private readonly events = new EventEmitter();
	private readonly breakpoints: DebugBreakpoint[] = [];
	private client?: DapClient;
	private state: SessionState = 'none';
	private session?: DebugSessionInfo;
	private threadId?: number;
	private frameId?: number;
	private capabilities: Record<string, unknown> = {};
	private initialized = false;

	public async startDebugging(
		workingDirectory: string,
		config: string | DebugConfiguration
	): Promise<boolean> {
		if (typeof config === 'string') {
			throw new Error(
				`The standalone CLI cannot resolve configuration '${config}'. ` +
				'Configure an adapter with that name instead.'
			);
		}
		const cliConfig = config as CliDebugConfiguration;
		if (!cliConfig.adapter?.command) {
			throw new Error('The selected CLI debug configuration has no adapter command.');
		}
		if (this.client && this.state !== 'terminated') {
			throw new Error('A debug session is already active. Stop it before starting another.');
		}

		this.state = 'starting';
		this.threadId = undefined;
		this.frameId = undefined;
		this.initialized = false;
		this.session = {
			id: randomUUID(),
			name: cliConfig.name ?? cliConfig.adapterName,
			type: cliConfig.type ?? cliConfig.adapter.type,
			request: cliConfig.request
		};
		this.emitState();

		const client = new DapClient(
			cliConfig.adapter.command,
			cliConfig.adapter.args ?? [],
			workingDirectory
		);
		this.client = client;
		this.registerClientEvents(client);

		try {
			const initializedEvent = client.waitForEvent('initialized', 30_000);
			this.capabilities = await client.request('initialize', {
				clientID: 'debugmcp',
				clientName: 'DebugMCP CLI',
				adapterID: cliConfig.type ?? cliConfig.adapter.type,
				pathFormat: 'path',
				linesStartAt1: true,
				columnsStartAt1: true,
				supportsRunInTerminalRequest: true,
				supportsVariableType: true,
				supportsVariablePaging: true
			});

			const { adapter: _adapter, adapterName: _adapterName, ...launchArguments } = cliConfig;
			const launch = client.request(cliConfig.request, launchArguments);
			await initializedEvent;
			this.initialized = true;
			await this.syncAllBreakpoints();
			if (this.capabilities.supportsConfigurationDoneRequest === true) {
				await client.request('configurationDone');
			}
			await launch;
			if (this.state === 'starting') {
				this.state = 'running';
				this.emitState();
			}
			return true;
		} catch (error) {
			await client.close();
			this.state = 'terminated';
			this.emitState();
			throw new Error(`Failed to start standalone debug session: ${error}`);
		}
	}

	public async debugTestAtCursor(_fileFullPath: string, testName: string): Promise<TestDebugDispatch> {
		throw new Error(
			`Standalone test discovery is not available for '${testName}'. ` +
				'Register an adapter whose launch configuration starts the required test runner.'
		);
	}

	public async stopDebugging(): Promise<void> {
		const client = this.requireClient();
		try {
			await client.request('disconnect', {
				restart: false,
				terminateDebuggee: true
			});
		} finally {
			await client.close();
			this.client = undefined;
			this.state = 'terminated';
			this.threadId = undefined;
			this.frameId = undefined;
			this.emitState();
		}
	}

	public async stepOver(): Promise<void> {
		await this.runThreadCommand('next');
	}

	public async stepInto(): Promise<void> {
		await this.runThreadCommand('stepIn');
	}

	public async stepOut(): Promise<void> {
		await this.runThreadCommand('stepOut');
	}

	public async continue(): Promise<void> {
		await this.runThreadCommand('continue');
	}

	public async pause(): Promise<void> {
		await this.requireClient().request('pause', { threadId: await this.resolveThreadId() });
	}

	public async restart(): Promise<void> {
		if (!this.capabilities.supportsRestartRequest) {
			throw new Error('The configured debug adapter does not support the DAP restart request.');
		}
		await this.requireClient().request('restart');
	}

	public async addBreakpoint(
		fileFullPath: string,
		line: number,
		condition?: string,
		logMessage?: string
	): Promise<void> {
		if (!this.breakpoints.some(item => item.fileFullPath === fileFullPath && item.line === line)) {
			this.breakpoints.push({ fileFullPath, line, condition, logMessage });
		}
		if (this.initialized) {
			await this.syncBreakpoints(fileFullPath);
		}
	}

	public async removeBreakpoint(fileFullPath: string, line: number): Promise<void> {
		const index = this.breakpoints.findIndex(
			item => item.fileFullPath === fileFullPath && item.line === line);
		if (index >= 0) {
			this.breakpoints.splice(index, 1);
		}
		if (this.initialized) {
			await this.syncBreakpoints(fileFullPath);
		}
	}

	public getBreakpoints(): readonly DebugBreakpoint[] {
		return this.breakpoints;
	}

	public async clearAllBreakpoints(): Promise<void> {
		const files = [...new Set(this.breakpoints.map(item => item.fileFullPath))];
		this.breakpoints.length = 0;
		if (this.initialized) {
			await Promise.all(files.map(file => this.syncBreakpoints(file)));
		}
	}

	public async getCurrentDebugState(numNextLines = 3): Promise<DebugState> {
		const result = new DebugState();
		result.sessionActive = this.state !== 'none' && this.state !== 'terminated';
		result.updateConfigurationName(this.session?.name ?? null);
		result.updateBreakpoints(this.breakpoints.map(item => {
			const suffix = item.condition ? ` [when: ${item.condition}]` : '';
			return `${path.basename(item.fileFullPath)}:${item.line}${suffix}`;
		}));

		if (!result.sessionActive || this.state !== 'stopped' || this.threadId === undefined) {
			return result;
		}

		const response = await this.requireClient().request('stackTrace', {
			threadId: this.threadId,
			startFrame: 0,
			levels: 50
		});
		const frames = Array.isArray(response?.stackFrames) ? response.stackFrames : [];
		if (frames.length === 0) {
			return result;
		}
		const current = frames[0];
		this.frameId = current.id;
		result.updateContext(current.id, this.threadId);
		result.updateFrameName(current.name ?? null);
		result.updateStackTrace(frames.map((frame: any): StackFrame => ({
			name: frame.name ?? 'unknown',
			source: frame.source?.path ?? frame.source?.name,
			line: frame.line,
			column: frame.column
		})));

		if (typeof current.source?.path === 'string' && typeof current.line === 'number') {
			await this.populateSource(result, current.source.path, current.line, numNextLines);
		}
		return result;
	}

	public async getVariables(
		frameId: number,
		scope: 'local' | 'global' | 'all' = 'all'
	): Promise<any> {
		const client = this.requireClient();
		const response = await client.request('scopes', { frameId });
		const scopes = (response?.scopes ?? []).filter((item: any) => {
			if (scope === 'all') {
				return true;
			}
			return String(item.name).toLowerCase().includes(scope);
		});
		for (const item of scopes) {
			try {
				const variables = await client.request('variables', {
					variablesReference: item.variablesReference
				});
				item.variables = variables?.variables ?? [];
			} catch (error) {
				item.variables = [];
				item.error = error;
			}
		}
		return { scopes };
	}

	public async getVariableChildren(
		variablesReference: number,
		options: VariableChildrenOptions = {}
	): Promise<any[]> {
		const client = this.requireClient();
		if (options.indexedVariables && options.indexedVariables > 0) {
			const indexed = await client.request('variables', {
				variablesReference,
				filter: 'indexed',
				start: 0,
				count: options.indexedVariables
			});
			const named = await client.request('variables', {
				variablesReference,
				filter: 'named'
			});
			return [...(indexed?.variables ?? []), ...(named?.variables ?? [])];
		}
		const response = await client.request('variables', { variablesReference });
		return response?.variables ?? [];
	}

	public async evaluateExpression(expression: string, frameId: number): Promise<any> {
		return this.requireClient().request('evaluate', {
			expression,
			frameId,
			context: 'repl'
		});
	}

	public async hasActiveSession(): Promise<boolean> {
		return this.state !== 'none' && this.state !== 'terminated';
	}

	public getActiveSession(): DebugSessionInfo | undefined {
		return this.session;
	}

	public getActiveFrameId(): number | undefined {
		return this.state === 'stopped' ? this.frameId : undefined;
	}

	public async waitForDebugSessionReady(
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<ReadyState> {
		const immediate = this.readyState();
		if (immediate) {
			return immediate;
		}
		return new Promise(resolve => {
			const finish = (value: ReadyState) => {
				clearTimeout(timer);
				this.events.off('state', onState);
				signal?.removeEventListener('abort', onAbort);
				resolve(value);
			};
			const onState = () => {
				const ready = this.readyState();
				if (ready) {
					finish(ready);
				}
			};
			const onAbort = () => finish('no-session');
			const timer = setTimeout(
				() => finish(this.state === 'none' ? 'no-session' : 'timeout'),
				timeoutMs
			);
			this.events.on('state', onState);
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	}

	private registerClientEvents(client: DapClient): void {
		client.on('stopped', body => {
			this.threadId = typeof body.threadId === 'number' ? body.threadId : this.threadId;
			this.frameId = undefined;
			this.state = 'stopped';
			this.emitState();
		});
		client.on('continued', () => {
			this.frameId = undefined;
			this.state = 'running';
			this.emitState();
		});
		const terminated = () => {
			this.state = 'terminated';
			this.threadId = undefined;
			this.frameId = undefined;
			this.emitState();
		};
		client.on('terminated', terminated);
		client.on('exited', terminated);
		client.on('exit', terminated);
		client.on('thread', body => {
			if (body.reason === 'started' && typeof body.threadId === 'number' && this.threadId === undefined) {
				this.threadId = body.threadId;
			}
		});
	}

	private readyState(): ReadyState | undefined {
		if (this.state === 'stopped') {
			return 'stopped';
		}
		if (this.state === 'terminated') {
			return 'terminated';
		}
		if (this.session?.request === 'attach' && this.state === 'running') {
			return 'attached';
		}
		return undefined;
	}

	private emitState(): void {
		this.events.emit('state');
	}

	private requireClient(): DapClient {
		if (!this.client || this.state === 'none' || this.state === 'terminated') {
			throw new Error('No active standalone debug session.');
		}
		return this.client;
	}

	private async resolveThreadId(): Promise<number> {
		if (this.threadId !== undefined) {
			return this.threadId;
		}
		const response = await this.requireClient().request('threads');
		const firstThread = Array.isArray(response?.threads) ? response.threads[0] : undefined;
		if (typeof firstThread?.id !== 'number') {
			throw new Error('The debug adapter has not reported an active thread.');
		}
		this.threadId = firstThread.id;
		return firstThread.id;
	}

	private async runThreadCommand(command: 'next' | 'stepIn' | 'stepOut' | 'continue'): Promise<void> {
		const threadId = await this.resolveThreadId();
		const previousState = this.state;
		this.state = 'running';
		this.frameId = undefined;
		this.emitState();
		const settle = this.waitForNavigationSettle(command === 'continue' ? 500 : 30_000);
		try {
			await this.requireClient().request(command, { threadId });
		} catch (error) {
			settle.cancel();
			this.state = previousState;
			this.emitState();
			throw error;
		}
		await settle.promise;
	}

	private waitForNavigationSettle(timeoutMs: number): {
		promise: Promise<void>;
		cancel: () => void;
	} {
		let finish: () => void = () => {};
		const promise = new Promise<void>(resolve => {
			const onState = () => {
				if (this.state === 'stopped' || this.state === 'terminated') {
					finish();
				}
			};
			const timer = setTimeout(() => finish(), timeoutMs);
			finish = () => {
				clearTimeout(timer);
				this.events.off('state', onState);
				resolve();
			};
			this.events.on('state', onState);
		});
		return { promise, cancel: () => finish() };
	}

	private async syncAllBreakpoints(): Promise<void> {
		const files = [...new Set(this.breakpoints.map(item => item.fileFullPath))];
		for (const file of files) {
			await this.syncBreakpoints(file);
		}
	}

	private async syncBreakpoints(fileFullPath: string): Promise<void> {
		const sourceBreakpoints = this.breakpoints.filter(item => item.fileFullPath === fileFullPath);
		const response = await this.requireClient().request('setBreakpoints', {
			source: { path: fileFullPath, name: path.basename(fileFullPath) },
			breakpoints: sourceBreakpoints.map(item => ({
				line: item.line,
				condition: item.condition,
				logMessage: item.logMessage
			})),
			sourceModified: false
		});
		const resolved = response?.breakpoints ?? [];
		sourceBreakpoints.forEach((item, index) => {
			item.verified = resolved[index]?.verified;
			item.message = resolved[index]?.message;
		});
	}

	private async populateSource(
		state: DebugState,
		fileFullPath: string,
		line: number,
		numNextLines: number
	): Promise<void> {
		try {
			const content = await fs.promises.readFile(fileFullPath, 'utf8');
			const lines = content.split(/\r?\n/);
			const index = Math.max(0, Math.min(line - 1, lines.length - 1));
			const nextLines = lines
				.slice(index + 1)
				.map(value => value.trim())
				.filter(Boolean)
				.slice(0, numNextLines);
			state.updateLocation(
				fileFullPath,
				path.basename(fileFullPath),
				line,
				lines[index]?.trim() ?? '',
				nextLines
			);
		} catch {
			// Adapter-provided source paths may refer to unavailable library sources.
		}
	}
}
