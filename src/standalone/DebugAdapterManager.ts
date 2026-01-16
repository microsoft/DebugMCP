// Copyright (c) Microsoft Corporation.

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { DAPClient } from './DAPClient';
import { AdapterConfig, ConfigLoader } from './ConfigLoader';

/**
 * Information about a running adapter process
 */
export interface AdapterProcess {
	/** The child process */
	process: ChildProcess;
	/** DAP client for communication */
	client: DAPClient;
	/** Adapter type (e.g., 'python') */
	type: string;
	/** Whether the adapter has been initialized */
	initialized: boolean;
}

/**
 * DebugAdapterManager spawns and manages debug adapter processes.
 * 
 * It handles:
 * - Spawning adapter processes based on configuration
 * - Creating DAP clients for communication
 * - Process lifecycle management
 * - Adapter crash detection and cleanup
 */
export class DebugAdapterManager extends EventEmitter {
	private configLoader: ConfigLoader;
	private activeAdapter: AdapterProcess | null = null;
	private requestTimeout: number;

	/**
	 * Create a new DebugAdapterManager
	 * @param configLoader Configuration loader for adapter settings
	 * @param requestTimeout Timeout for DAP requests in milliseconds
	 */
	constructor(configLoader: ConfigLoader, requestTimeout: number = 30000) {
		super();
		this.configLoader = configLoader;
		this.requestTimeout = requestTimeout;
	}

	/**
	 * Start a debug adapter for the given type
	 * @param adapterType The adapter type (e.g., 'python')
	 * @returns The adapter process with DAP client
	 */
	public async startAdapter(adapterType: string): Promise<AdapterProcess> {
		// Check if we already have an active adapter
		if (this.activeAdapter) {
			throw new Error('An adapter is already running. Stop it first.');
		}

		// Get adapter configuration
		const adapterConfig = this.configLoader.getAdapterConfig(adapterType);
		if (!adapterConfig) {
			throw new Error(
				`No adapter configuration found for type "${adapterType}". ` +
				`Available adapters: ${this.configLoader.getAdapterNames().join(', ')}`
			);
		}

		// Spawn the adapter process
		const process = this.spawnAdapter(adapterConfig);

		// Create DAP client
		const client = new DAPClient(process.stdout!, process.stdin!, this.requestTimeout);

		// Set up event forwarding
		this.setupClientEvents(client);

		// Create adapter info
		const adapter: AdapterProcess = {
			process,
			client,
			type: adapterType,
			initialized: false
		};

		// Set up process exit handling
		process.on('exit', (code, signal) => {
			this.handleAdapterExit(adapter, code, signal);
		});

		process.on('error', (err) => {
			this.handleAdapterError(adapter, err);
		});

		this.activeAdapter = adapter;
		this.emit('adapterStarted', adapterType);

		return adapter;
	}

	/**
	 * Spawn the adapter process
	 */
	private spawnAdapter(config: AdapterConfig): ChildProcess {
		const options: import('child_process').SpawnOptions = {
			cwd: config.cwd || process.cwd(),
			env: {
				...process.env,
				...config.env
			},
			stdio: ['pipe', 'pipe', 'pipe']
		};

		const proc = spawn(config.command, config.args, options);

		// Log stderr for debugging (but don't throw errors for it)
		if (proc.stderr) {
			proc.stderr.on('data', (data: Buffer) => {
				const message = data.toString();
				console.error(`[Adapter stderr]: ${message}`);
				this.emit('adapterStderr', message);
			});
		}

		return proc;
	}

	/**
	 * Set up event forwarding from DAP client
	 */
	private setupClientEvents(client: DAPClient): void {
		// Forward all DAP events
		client.on('event', (event) => {
			this.emit('dapEvent', event);
		});

		// Forward specific events for convenience
		client.on('event:stopped', (body) => {
			this.emit('stopped', body);
		});

		client.on('event:terminated', (body) => {
			this.emit('terminated', body);
		});

		client.on('event:output', (body) => {
			this.emit('output', body);
		});

		client.on('event:initialized', () => {
			if (this.activeAdapter) {
				this.activeAdapter.initialized = true;
			}
			this.emit('initialized');
		});

		client.on('error', (err) => {
			this.emit('clientError', err);
		});

		client.on('close', () => {
			this.emit('clientClosed');
		});
	}

	/**
	 * Handle adapter process exit
	 */
	private handleAdapterExit(
		adapter: AdapterProcess,
		code: number | null,
		signal: string | null
	): void {
		if (adapter === this.activeAdapter) {
			this.activeAdapter = null;
		}

		// Close the client
		adapter.client.close();

		this.emit('adapterExited', {
			type: adapter.type,
			code,
			signal
		});

		// If unexpected exit (non-zero code), emit error event
		if (code !== 0 && code !== null) {
			this.emit('adapterCrashed', {
				type: adapter.type,
				code,
				signal
			});
		}
	}

	/**
	 * Handle adapter process error
	 */
	private handleAdapterError(adapter: AdapterProcess, err: Error): void {
		this.emit('adapterError', {
			type: adapter.type,
			error: err
		});
	}

	/**
	 * Stop the active adapter
	 */
	public async stopAdapter(): Promise<void> {
		if (!this.activeAdapter) {
			return;
		}

		const adapter = this.activeAdapter;

		try {
			// Try to send disconnect request first
			if (!adapter.client.isClosed()) {
				await adapter.client.disconnect({ terminateDebuggee: true });
			}
		} catch (err) {
			// Ignore errors during disconnect
			console.log('Error during disconnect:', err);
		}

		// Close the client
		adapter.client.close();

		// Kill the process if still running
		if (adapter.process.exitCode === null) {
			adapter.process.kill('SIGTERM');

			// Give it a moment to terminate gracefully
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					if (adapter.process.exitCode === null) {
						adapter.process.kill('SIGKILL');
					}
					resolve();
				}, 2000);

				adapter.process.once('exit', () => {
					clearTimeout(timeout);
					resolve();
				});
			});
		}

		this.activeAdapter = null;
	}

	/**
	 * Get the active adapter
	 */
	public getActiveAdapter(): AdapterProcess | null {
		return this.activeAdapter;
	}

	/**
	 * Check if an adapter is currently active
	 */
	public hasActiveAdapter(): boolean {
		return this.activeAdapter !== null;
	}

	/**
	 * Get the DAP client for the active adapter
	 */
	public getClient(): DAPClient | null {
		return this.activeAdapter?.client || null;
	}

	/**
	 * Initialize the adapter with standard DAP handshake
	 * @param adapterID The adapter ID for initialization
	 */
	public async initializeAdapter(adapterID: string = 'debugmcp'): Promise<void> {
		if (!this.activeAdapter) {
			throw new Error('No active adapter to initialize');
		}

		const client = this.activeAdapter.client;

		// Send initialize request
		await client.initialize({
			clientID: 'debugmcp',
			clientName: 'DebugMCP Standalone',
			adapterID,
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: 'path',
			supportsVariableType: true,
			supportsVariablePaging: false,
			supportsRunInTerminalRequest: false,
			supportsMemoryReferences: false,
			supportsProgressReporting: false,
			supportsInvalidatedEvent: false
		});
	}
}
