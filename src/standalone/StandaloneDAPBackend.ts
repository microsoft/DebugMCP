// Copyright (c) Microsoft Corporation.

import * as fs from 'fs';
import * as path from 'path';
import { IDebugBackend } from '../core/IDebugBackend';
import { DebugState } from '../debugState';
import {
	DebugConfiguration,
	Breakpoint,
	SourceBreakpoint,
	Uri,
	ProgramOutput,
	GetOutputOptions,
	StoppedEventData,
	TerminatedEventData,
	OutputEventData,
	Disposable,
	createSourceBreakpoint,
	isSourceBreakpoint,
} from '../core/types';
import { DebugAdapterManager, AdapterProcess } from './DebugAdapterManager';
import { DebugStateTracker, FrameInfo } from './DebugStateTracker';
import { ConfigLoader } from './ConfigLoader';
import { DAPClient } from './DAPClient';

/**
 * Callback wrapper for disposable pattern
 */
interface CallbackEntry<T> {
	callback: (data: T) => void;
	id: number;
}

/**
 * StandaloneDAPBackend implements IDebugBackend using direct DAP communication.
 * 
 * This backend:
 * - Spawns debug adapter processes (e.g., debugpy) via DebugAdapterManager
 * - Communicates using the Debug Adapter Protocol via DAPClient
 * - Tracks session state via DebugStateTracker
 * - Manages breakpoints locally and syncs them with the adapter
 */
export class StandaloneDAPBackend implements IDebugBackend {
	private adapterManager: DebugAdapterManager;
	private configLoader: ConfigLoader;
	private stateTracker: DebugStateTracker;

	// Breakpoint management
	private breakpoints: Map<string, SourceBreakpoint[]> = new Map(); // path -> breakpoints

	// Event callbacks
	private callbackId = 0;
	private stoppedCallbacks: CallbackEntry<StoppedEventData>[] = [];
	private terminatedCallbacks: CallbackEntry<TerminatedEventData>[] = [];
	private outputCallbacks: CallbackEntry<OutputEventData>[] = [];

	// Session state
	private currentConfig: DebugConfiguration | null = null;
	private currentWorkingDirectory: string | null = null;

	/**
	 * Create a new StandaloneDAPBackend
	 * @param configLoader Configuration loader for adapter settings
	 * @param requestTimeout Timeout for DAP requests in milliseconds
	 */
	constructor(configLoader: ConfigLoader, requestTimeout: number = 30000) {
		this.configLoader = configLoader;
		this.adapterManager = new DebugAdapterManager(configLoader, requestTimeout);
		this.stateTracker = new DebugStateTracker();

		this.setupAdapterManagerEvents();
	}

	/**
	 * Set up event forwarding from DebugAdapterManager
	 */
	private setupAdapterManagerEvents(): void {
		// Handle stopped event
		this.adapterManager.on('stopped', async (body: any) => {
			const data: StoppedEventData = {
				reason: body.reason || 'unknown',
				description: body.description,
				threadId: body.threadId,
				allThreadsStopped: body.allThreadsStopped,
			};
			this.stateTracker.handleStopped(data);

			// Fetch stack trace to update frame info
			await this.updateCurrentFrameInfo();

			// Notify callbacks
			for (const entry of this.stoppedCallbacks) {
				try {
					entry.callback(data);
				} catch (err) {
					console.error('Error in stopped callback:', err);
				}
			}
		});

		// Handle terminated event
		this.adapterManager.on('terminated', (body: any) => {
			const data: TerminatedEventData = {
				restart: body?.restart,
			};
			this.stateTracker.handleTerminated(data);

			// Notify callbacks
			for (const entry of this.terminatedCallbacks) {
				try {
					entry.callback(data);
				} catch (err) {
					console.error('Error in terminated callback:', err);
				}
			}
		});

		// Handle output event
		this.adapterManager.on('output', (body: any) => {
			const data: OutputEventData = {
				category: body.category,
				output: body.output || '',
			};
			this.stateTracker.handleOutput(data);

			// Notify callbacks
			for (const entry of this.outputCallbacks) {
				try {
					entry.callback(data);
				} catch (err) {
					console.error('Error in output callback:', err);
				}
			}
		});

		// Handle adapter exit
		this.adapterManager.on('adapterExited', () => {
			this.stateTracker.setState('terminated');
		});
	}

	/**
	 * Update current frame info from the debug adapter
	 */
	private async updateCurrentFrameInfo(): Promise<void> {
		const client = this.adapterManager.getClient();
		if (!client) {
			return;
		}

		const threadId = this.stateTracker.getCurrentThreadId();
		if (threadId === null) {
			return;
		}

		try {
			// Get stack trace
			const stackResponse = await client.stackTrace({
				threadId,
				startFrame: 0,
				levels: 1,
			});

			if (stackResponse.body?.stackFrames?.length > 0) {
				const frame = stackResponse.body.stackFrames[0];
				const frameInfo: FrameInfo = {
					id: frame.id,
					name: frame.name,
					line: frame.line,
					column: frame.column || 1,
					source: frame.source ? {
						path: frame.source.path,
						name: frame.source.name,
					} : undefined,
				};
				this.stateTracker.updateCurrentFrame(frameInfo);
			}
		} catch (err) {
			console.error('Failed to get stack trace:', err);
		}
	}

	// ============================================================
	// Debug Session Control
	// ============================================================

	/**
	 * Start a debugging session
	 */
	public async startDebugging(
		workingDirectory: string,
		config: DebugConfiguration,
		_sessionId?: string
	): Promise<boolean> {
		// Stop any existing session
		if (this.adapterManager.hasActiveAdapter()) {
			await this.stopDebugging();
		}

		// Reset state
		this.stateTracker.setState('initializing');
		this.currentConfig = config;
		this.currentWorkingDirectory = workingDirectory;

		try {
			// Start the adapter
			const adapterType = config.type;
			await this.adapterManager.startAdapter(adapterType);

			// Initialize the adapter
			await this.adapterManager.initializeAdapter(adapterType);

			// Send launch or attach request
			// Note: Some adapters (like debugpy) send the 'initialized' event AFTER launch,
			// and the launch response may not come until the session completes or stops.
			// So we send launch without awaiting, then wait for initialized, then configurationDone.
			const client = this.adapterManager.getClient()!;
			
			// Set up promise for initialized event BEFORE sending launch
			const initializedPromise = this.waitForInitialized();

			// Send launch/attach without blocking
			const launchPromise = config.request === 'attach'
				? client.attach(config)
				: client.launch({
					...config,
					cwd: workingDirectory,
				});
			
			// Handle launch errors in background
			launchPromise.catch(err => {
				console.error('Launch request error:', err);
			});

			// Wait for initialized event (may have already fired, or will fire after launch)
			await initializedPromise;

			// Set breakpoints after initialized
			await this.syncAllBreakpoints();

			// Send configurationDone - this signals the adapter to start running
			await client.configurationDone();

			this.stateTracker.setState('running');
			return true;
		} catch (err) {
			console.error('Failed to start debugging:', err);
			this.stateTracker.setState('terminated');
			await this.adapterManager.stopAdapter();
			return false;
		}
	}

	/**
	 * Wait for the adapter to send the initialized event
	 */
	private async waitForInitialized(timeout: number = 10000): Promise<void> {
		const adapter = this.adapterManager.getActiveAdapter();
		if (!adapter) {
			throw new Error('No active adapter');
		}

		if (adapter.initialized) {
			return;
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error('Timeout waiting for initialized event'));
			}, timeout);

			this.adapterManager.once('initialized', () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	/**
	 * Stop the debugging session
	 */
	public async stopDebugging(_sessionId?: string): Promise<void> {
		await this.adapterManager.stopAdapter();
		this.stateTracker.setState('inactive');
		this.currentConfig = null;
		this.currentWorkingDirectory = null;
	}

	/**
	 * Check if there's an active debug session
	 */
	public async hasActiveSession(_sessionId?: string): Promise<boolean> {
		return this.adapterManager.hasActiveAdapter() && this.stateTracker.isActive();
	}

	// ============================================================
	// Execution Control
	// ============================================================

	/**
	 * Get the current thread ID, ensuring we have one
	 */
	private async ensureThreadId(): Promise<number> {
		let threadId = this.stateTracker.getCurrentThreadId();
		if (threadId !== null) {
			return threadId;
		}

		// Try to get threads from the adapter
		const client = this.adapterManager.getClient();
		if (!client) {
			throw new Error('No active debug session');
		}

		const threadsResponse = await client.threads();
		const threads = threadsResponse.body?.threads || [];
		if (threads.length === 0) {
			throw new Error('No threads available');
		}

		// Use the first thread
		const newThreadId: number = threads[0].id;
		this.stateTracker.setCurrentThreadId(newThreadId);
		this.stateTracker.updateThreads(threads);
		return newThreadId;
	}

	/**
	 * Execute step over command
	 */
	public async stepOver(_sessionId?: string): Promise<void> {
		const client = this.adapterManager.getClient();
		if (!client) {
			throw new Error('No active debug session');
		}

		const threadId = await this.ensureThreadId();
		this.stateTracker.handleContinued(threadId);
		await client.next({ threadId });
	}

	/**
	 * Execute step into command
	 */
	public async stepInto(_sessionId?: string): Promise<void> {
		const client = this.adapterManager.getClient();
		if (!client) {
			throw new Error('No active debug session');
		}

		const threadId = await this.ensureThreadId();
		this.stateTracker.handleContinued(threadId);
		await client.stepIn({ threadId });
	}

	/**
	 * Execute step out command
	 */
	public async stepOut(_sessionId?: string): Promise<void> {
		const client = this.adapterManager.getClient();
		if (!client) {
			throw new Error('No active debug session');
		}

		const threadId = await this.ensureThreadId();
		this.stateTracker.handleContinued(threadId);
		await client.stepOut({ threadId });
	}

	/**
	 * Continue execution
	 */
	public async continue(_sessionId?: string): Promise<void> {
		const client = this.adapterManager.getClient();
		if (!client) {
			throw new Error('No active debug session');
		}

		const threadId = await this.ensureThreadId();
		this.stateTracker.handleContinued(threadId);
		await client.continue({ threadId });
	}

	/**
	 * Restart the debug session
	 */
	public async restart(_sessionId?: string): Promise<void> {
		const client = this.adapterManager.getClient();
		if (!client || !this.currentConfig || !this.currentWorkingDirectory) {
			throw new Error('No active debug session to restart');
		}

		// Try disconnect with restart flag
		try {
			await client.disconnect({ restart: true });
		} catch (err) {
			// Ignore disconnect errors
		}

		// Restart the session
		await this.startDebugging(this.currentWorkingDirectory, this.currentConfig);
	}

	// ============================================================
	// Breakpoints
	// ============================================================

	/**
	 * Add a breakpoint at the specified location
	 */
	public async addBreakpoint(uri: Uri, line: number, _sessionId?: string): Promise<void> {
		const filePath = uri.fsPath;
		const bp = createSourceBreakpoint(filePath, line);

		// Add to local storage
		const fileBreakpoints = this.breakpoints.get(filePath) || [];
		// Check if breakpoint already exists
		if (!fileBreakpoints.some(b => b.line === line)) {
			fileBreakpoints.push(bp);
			this.breakpoints.set(filePath, fileBreakpoints);
		}

		// Sync with adapter if session is active
		if (this.adapterManager.hasActiveAdapter()) {
			await this.syncBreakpointsForFile(filePath);
		}
	}

	/**
	 * Remove a breakpoint from the specified location
	 */
	public async removeBreakpoint(uri: Uri, line: number, _sessionId?: string): Promise<void> {
		const filePath = uri.fsPath;
		const fileBreakpoints = this.breakpoints.get(filePath) || [];

		// Remove from local storage
		const filtered = fileBreakpoints.filter(bp => bp.line !== line);
		if (filtered.length > 0) {
			this.breakpoints.set(filePath, filtered);
		} else {
			this.breakpoints.delete(filePath);
		}

		// Sync with adapter if session is active
		if (this.adapterManager.hasActiveAdapter()) {
			await this.syncBreakpointsForFile(filePath);
		}
	}

	/**
	 * Get all active breakpoints
	 */
	public getBreakpoints(_sessionId?: string): readonly Breakpoint[] {
		const allBreakpoints: Breakpoint[] = [];
		for (const fileBreakpoints of this.breakpoints.values()) {
			allBreakpoints.push(...fileBreakpoints);
		}
		return allBreakpoints;
	}

	/**
	 * Clear all breakpoints
	 */
	public clearAllBreakpoints(_sessionId?: string): void {
		const files = Array.from(this.breakpoints.keys());
		this.breakpoints.clear();

		// Sync with adapter if session is active
		if (this.adapterManager.hasActiveAdapter()) {
			for (const filePath of files) {
				this.syncBreakpointsForFile(filePath).catch(err => {
					console.error(`Failed to clear breakpoints for ${filePath}:`, err);
				});
			}
		}
	}

	/**
	 * Sync breakpoints for a specific file with the adapter
	 */
	private async syncBreakpointsForFile(filePath: string): Promise<void> {
		const client = this.adapterManager.getClient();
		if (!client) {
			return;
		}

		const fileBreakpoints = this.breakpoints.get(filePath) || [];
		const breakpointArgs = fileBreakpoints.map(bp => ({
			line: bp.line,
			column: bp.column,
			condition: bp.condition,
			hitCondition: bp.hitCondition,
			logMessage: bp.logMessage,
		}));

		await client.setBreakpoints({
			source: { path: filePath },
			breakpoints: breakpointArgs,
		});
	}

	/**
	 * Sync all breakpoints with the adapter
	 */
	private async syncAllBreakpoints(): Promise<void> {
		for (const filePath of this.breakpoints.keys()) {
			await this.syncBreakpointsForFile(filePath);
		}
	}

	// ============================================================
	// State & Inspection
	// ============================================================

	/**
	 * Get the current debug state
	 */
	public async getCurrentDebugState(numNextLines: number, _sessionId?: string): Promise<DebugState> {
		const state = new DebugState();

		if (!this.stateTracker.isActive()) {
			return state;
		}

		state.sessionActive = true;

		const frame = this.stateTracker.getCurrentFrame();
		if (frame) {
			state.frameId = frame.id;
			state.frameName = frame.name;
			state.currentLine = frame.line;

			if (frame.source?.path) {
				state.fileFullPath = frame.source.path;
				state.fileName = path.basename(frame.source.path);

				// Read file contents to get current line and next lines
				try {
					const contents = await this.readFileContents(frame.source.path);
					const lines = contents.split('\n');
					const lineIndex = frame.line - 1; // Convert to 0-based index

					if (lineIndex >= 0 && lineIndex < lines.length) {
						state.currentLineContent = lines[lineIndex];

						// Get next lines
						const nextLines: string[] = [];
						for (let i = 1; i <= numNextLines && lineIndex + i < lines.length; i++) {
							nextLines.push(lines[lineIndex + i]);
						}
						state.nextLines = nextLines;
					}
				} catch (err) {
					console.error('Failed to read file for debug state:', err);
				}
			}
		}

		const threadId = this.stateTracker.getCurrentThreadId();
		if (threadId !== null) {
			state.threadId = threadId;
		}

		return state;
	}

	/**
	 * Get the active frame ID
	 */
	public async getActiveFrameId(_sessionId?: string): Promise<number | undefined> {
		return this.stateTracker.getCurrentFrameId() ?? undefined;
	}

	/**
	 * Get variables from the current debug context
	 */
	public async getVariables(
		frameId: number,
		scope?: 'local' | 'global' | 'all',
		_sessionId?: string
	): Promise<any> {
		const client = this.adapterManager.getClient();
		if (!client) {
			throw new Error('No active debug session');
		}

		// Get scopes for the frame
		const scopesResponse = await client.scopes({ frameId });
		const scopes = scopesResponse.body?.scopes || [];

		// Filter scopes based on requested scope
		let targetScopes = scopes;
		if (scope === 'local') {
			targetScopes = scopes.filter((s: any) =>
				s.name.toLowerCase().includes('local') ||
				s.name.toLowerCase() === 'locals'
			);
		} else if (scope === 'global') {
			targetScopes = scopes.filter((s: any) =>
				s.name.toLowerCase().includes('global') ||
				s.name.toLowerCase() === 'globals'
			);
		}

		// Get variables for each scope
		const result: any = {};
		for (const s of targetScopes) {
			const varsResponse = await client.variables({
				variablesReference: s.variablesReference,
			});
			result[s.name] = varsResponse.body?.variables || [];
		}

		return result;
	}

	/**
	 * Evaluate an expression in the current debug context
	 */
	public async evaluateExpression(
		expression: string,
		frameId: number,
		_sessionId?: string
	): Promise<any> {
		const client = this.adapterManager.getClient();
		if (!client) {
			throw new Error('No active debug session');
		}

		const response = await client.evaluate({
			expression,
			frameId,
			context: 'repl',
		});

		return {
			result: response.body?.result,
			type: response.body?.type,
			variablesReference: response.body?.variablesReference,
		};
	}

	// ============================================================
	// File Access
	// ============================================================

	/**
	 * Read file contents
	 */
	public async readFileContents(filePath: string): Promise<string> {
		return fs.promises.readFile(filePath, 'utf8');
	}

	// ============================================================
	// Output
	// ============================================================

	/**
	 * Get recent program output
	 */
	public async getRecentOutput(
		options?: GetOutputOptions,
		_sessionId?: string
	): Promise<ProgramOutput> {
		return this.stateTracker.getRecentOutput(options);
	}

	// ============================================================
	// Events
	// ============================================================

	/**
	 * Register a callback for stopped events
	 */
	public onStopped(callback: (data: StoppedEventData) => void): Disposable {
		const id = ++this.callbackId;
		this.stoppedCallbacks.push({ callback, id });
		return {
			dispose: () => {
				this.stoppedCallbacks = this.stoppedCallbacks.filter(c => c.id !== id);
			},
		};
	}

	/**
	 * Register a callback for terminated events
	 */
	public onTerminated(callback: (data: TerminatedEventData) => void): Disposable {
		const id = ++this.callbackId;
		this.terminatedCallbacks.push({ callback, id });
		return {
			dispose: () => {
				this.terminatedCallbacks = this.terminatedCallbacks.filter(c => c.id !== id);
			},
		};
	}

	/**
	 * Register a callback for output events
	 */
	public onOutput(callback: (data: OutputEventData) => void): Disposable {
		const id = ++this.callbackId;
		this.outputCallbacks.push({ callback, id });
		return {
			dispose: () => {
				this.outputCallbacks = this.outputCallbacks.filter(c => c.id !== id);
			},
		};
	}

	// ============================================================
	// Cleanup
	// ============================================================

	/**
	 * Dispose of resources
	 */
	public async dispose(): Promise<void> {
		await this.stopDebugging();
		this.stoppedCallbacks = [];
		this.terminatedCallbacks = [];
		this.outputCallbacks = [];
		this.breakpoints.clear();
	}
}
