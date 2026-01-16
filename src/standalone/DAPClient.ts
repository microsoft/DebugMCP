// Copyright (c) Microsoft Corporation.

import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

/**
 * DAP Protocol Message Types
 */

/** Base protocol message */
export interface ProtocolMessage {
	seq: number;
	type: 'request' | 'response' | 'event';
}

/** Request message sent to the debug adapter */
export interface DAPRequest extends ProtocolMessage {
	type: 'request';
	command: string;
	arguments?: any;
}

/** Response message received from the debug adapter */
export interface DAPResponse extends ProtocolMessage {
	type: 'response';
	request_seq: number;
	success: boolean;
	command: string;
	message?: string;
	body?: any;
}

/** Event message received from the debug adapter */
export interface DAPEvent extends ProtocolMessage {
	type: 'event';
	event: string;
	body?: any;
}

/** Union of all DAP message types */
export type DAPMessage = DAPRequest | DAPResponse | DAPEvent;

/**
 * Pending request tracker
 */
interface PendingRequest {
	resolve: (response: DAPResponse) => void;
	reject: (error: Error) => void;
	command: string;
	timer: NodeJS.Timeout;
}

/**
 * DAPClient handles DAP protocol communication over stdio streams.
 * 
 * The Debug Adapter Protocol uses a simple message format:
 * - Header: "Content-Length: <length>\r\n\r\n"
 * - Body: JSON-encoded message
 * 
 * This client handles:
 * - Sending requests and awaiting responses
 * - Receiving and dispatching events
 * - Message sequencing
 * - Request timeouts
 */
export class DAPClient extends EventEmitter {
	private inputStream: Readable;
	private outputStream: Writable;
	private sequenceNumber: number = 1;
	private pendingRequests: Map<number, PendingRequest> = new Map();
	private buffer: Buffer = Buffer.alloc(0);
	private contentLength: number = -1;
	private requestTimeout: number;
	private closed: boolean = false;

	/**
	 * Create a new DAP client
	 * @param inputStream Stream to read DAP messages from (adapter's stdout)
	 * @param outputStream Stream to write DAP messages to (adapter's stdin)
	 * @param requestTimeout Timeout for requests in milliseconds (default 30000)
	 */
	constructor(
		inputStream: Readable,
		outputStream: Writable,
		requestTimeout: number = 30000
	) {
		super();
		this.inputStream = inputStream;
		this.outputStream = outputStream;
		this.requestTimeout = requestTimeout;

		// Set up input stream handling
		this.inputStream.on('data', (data: Buffer) => this.handleData(data));
		this.inputStream.on('end', () => this.handleStreamEnd());
		this.inputStream.on('error', (err) => this.handleStreamError(err));
	}

	/**
	 * Send a DAP request and wait for response
	 * @param command The DAP command name
	 * @param args Optional arguments for the command
	 * @returns Promise resolving to the response
	 */
	public async sendRequest<T = any>(command: string, args?: any): Promise<DAPResponse & { body: T }> {
		if (this.closed) {
			throw new Error('DAP client is closed');
		}

		const seq = this.sequenceNumber++;
		const request: DAPRequest = {
			seq,
			type: 'request',
			command,
			arguments: args
		};

		return new Promise((resolve, reject) => {
			// Set up timeout
			const timer = setTimeout(() => {
				const pending = this.pendingRequests.get(seq);
				if (pending) {
					this.pendingRequests.delete(seq);
					reject(new Error(`DAP request '${command}' timed out after ${this.requestTimeout}ms`));
				}
			}, this.requestTimeout);

			// Track the pending request
			this.pendingRequests.set(seq, {
				resolve: resolve as (response: DAPResponse) => void,
				reject,
				command,
				timer
			});

			// Send the request
			this.sendMessage(request);
		});
	}

	/**
	 * Send a raw DAP message
	 */
	private sendMessage(message: DAPMessage): void {
		const json = JSON.stringify(message);
		const contentLength = Buffer.byteLength(json, 'utf8');
		const header = `Content-Length: ${contentLength}\r\n\r\n`;

		this.outputStream.write(header + json, 'utf8');
	}

	/**
	 * Handle incoming data from the input stream
	 */
	private handleData(data: Buffer): void {
		// Append new data to buffer
		this.buffer = Buffer.concat([this.buffer, data]);

		// Process all complete messages in the buffer
		while (this.processBuffer()) {
			// Continue processing until no more complete messages
		}
	}

	/**
	 * Process the buffer and extract any complete messages
	 * @returns true if a message was processed, false otherwise
	 */
	private processBuffer(): boolean {
		// If we don't know the content length yet, try to parse the header
		if (this.contentLength === -1) {
			const headerEnd = this.findHeaderEnd();
			if (headerEnd === -1) {
				return false; // Header not complete yet
			}

			const headerStr = this.buffer.slice(0, headerEnd).toString('utf8');
			const match = headerStr.match(/Content-Length:\s*(\d+)/i);
			if (!match) {
				// Invalid header, skip to next potential header
				this.buffer = this.buffer.slice(headerEnd + 4);
				return true;
			}

			this.contentLength = parseInt(match[1], 10);
			this.buffer = this.buffer.slice(headerEnd + 4); // Skip header + \r\n\r\n
		}

		// Check if we have the complete body
		if (this.buffer.length < this.contentLength) {
			return false; // Body not complete yet
		}

		// Extract and parse the message body
		const body = this.buffer.slice(0, this.contentLength).toString('utf8');
		this.buffer = this.buffer.slice(this.contentLength);
		this.contentLength = -1;

		try {
			const message: DAPMessage = JSON.parse(body);
			this.handleMessage(message);
		} catch (err) {
			this.emit('error', new Error(`Failed to parse DAP message: ${err}`));
		}

		return true;
	}

	/**
	 * Find the end of the header section (\r\n\r\n)
	 */
	private findHeaderEnd(): number {
		const separator = Buffer.from('\r\n\r\n');
		for (let i = 0; i <= this.buffer.length - 4; i++) {
			if (this.buffer[i] === separator[0] &&
				this.buffer[i + 1] === separator[1] &&
				this.buffer[i + 2] === separator[2] &&
				this.buffer[i + 3] === separator[3]) {
				return i;
			}
		}
		return -1;
	}

	/**
	 * Handle a parsed DAP message
	 */
	private handleMessage(message: DAPMessage): void {
		switch (message.type) {
			case 'response':
				this.handleResponse(message as DAPResponse);
				break;
			case 'event':
				this.handleEvent(message as DAPEvent);
				break;
			case 'request':
				// Reverse requests from adapter (rare, but possible)
				this.emit('reverseRequest', message);
				break;
		}
	}

	/**
	 * Handle a response message
	 */
	private handleResponse(response: DAPResponse): void {
		const pending = this.pendingRequests.get(response.request_seq);
		if (pending) {
			clearTimeout(pending.timer);
			this.pendingRequests.delete(response.request_seq);

			if (response.success) {
				pending.resolve(response);
			} else {
				pending.reject(new Error(
					response.message || `DAP request '${pending.command}' failed`
				));
			}
		} else {
			// Orphan response - this can happen if the request timed out
			this.emit('orphanResponse', response);
		}
	}

	/**
	 * Handle an event message
	 */
	private handleEvent(event: DAPEvent): void {
		// Emit both generic and specific events
		this.emit('event', event);
		this.emit(`event:${event.event}`, event.body);
	}

	/**
	 * Handle stream end
	 */
	private handleStreamEnd(): void {
		this.close();
		this.emit('close');
	}

	/**
	 * Handle stream error
	 */
	private handleStreamError(err: Error): void {
		this.emit('error', err);
		this.close();
	}

	/**
	 * Close the client and reject all pending requests
	 */
	public close(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;

		// Reject all pending requests
		for (const [seq, pending] of this.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(new Error('DAP client closed'));
		}
		this.pendingRequests.clear();
	}

	/**
	 * Check if the client is closed
	 */
	public isClosed(): boolean {
		return this.closed;
	}

	// ============================================================
	// Convenience methods for common DAP requests
	// ============================================================

	/**
	 * Send initialize request
	 */
	public async initialize(args: {
		clientID?: string;
		clientName?: string;
		adapterID: string;
		locale?: string;
		linesStartAt1?: boolean;
		columnsStartAt1?: boolean;
		pathFormat?: 'path' | 'uri';
		supportsVariableType?: boolean;
		supportsVariablePaging?: boolean;
		supportsRunInTerminalRequest?: boolean;
		supportsMemoryReferences?: boolean;
		supportsProgressReporting?: boolean;
		supportsInvalidatedEvent?: boolean;
	}): Promise<DAPResponse> {
		return this.sendRequest('initialize', args);
	}

	/**
	 * Send launch request
	 */
	public async launch(args: any): Promise<DAPResponse> {
		return this.sendRequest('launch', args);
	}

	/**
	 * Send attach request
	 */
	public async attach(args: any): Promise<DAPResponse> {
		return this.sendRequest('attach', args);
	}

	/**
	 * Send disconnect request
	 */
	public async disconnect(args?: {
		restart?: boolean;
		terminateDebuggee?: boolean;
	}): Promise<DAPResponse> {
		return this.sendRequest('disconnect', args);
	}

	/**
	 * Send terminate request
	 */
	public async terminate(args?: { restart?: boolean }): Promise<DAPResponse> {
		return this.sendRequest('terminate', args);
	}

	/**
	 * Send setBreakpoints request
	 */
	public async setBreakpoints(args: {
		source: { path?: string; name?: string; sourceReference?: number };
		breakpoints?: Array<{
			line: number;
			column?: number;
			condition?: string;
			hitCondition?: string;
			logMessage?: string;
		}>;
		lines?: number[];
		sourceModified?: boolean;
	}): Promise<DAPResponse> {
		return this.sendRequest('setBreakpoints', args);
	}

	/**
	 * Send setFunctionBreakpoints request
	 */
	public async setFunctionBreakpoints(args: {
		breakpoints: Array<{
			name: string;
			condition?: string;
			hitCondition?: string;
		}>;
	}): Promise<DAPResponse> {
		return this.sendRequest('setFunctionBreakpoints', args);
	}

	/**
	 * Send configurationDone request
	 */
	public async configurationDone(): Promise<DAPResponse> {
		return this.sendRequest('configurationDone');
	}

	/**
	 * Send continue request
	 */
	public async continue(args: {
		threadId: number;
		singleThread?: boolean;
	}): Promise<DAPResponse> {
		return this.sendRequest('continue', args);
	}

	/**
	 * Send next (step over) request
	 */
	public async next(args: {
		threadId: number;
		singleThread?: boolean;
		granularity?: 'statement' | 'line' | 'instruction';
	}): Promise<DAPResponse> {
		return this.sendRequest('next', args);
	}

	/**
	 * Send stepIn request
	 */
	public async stepIn(args: {
		threadId: number;
		singleThread?: boolean;
		targetId?: number;
		granularity?: 'statement' | 'line' | 'instruction';
	}): Promise<DAPResponse> {
		return this.sendRequest('stepIn', args);
	}

	/**
	 * Send stepOut request
	 */
	public async stepOut(args: {
		threadId: number;
		singleThread?: boolean;
		granularity?: 'statement' | 'line' | 'instruction';
	}): Promise<DAPResponse> {
		return this.sendRequest('stepOut', args);
	}

	/**
	 * Send pause request
	 */
	public async pause(args: { threadId: number }): Promise<DAPResponse> {
		return this.sendRequest('pause', args);
	}

	/**
	 * Send stackTrace request
	 */
	public async stackTrace(args: {
		threadId: number;
		startFrame?: number;
		levels?: number;
		format?: any;
	}): Promise<DAPResponse> {
		return this.sendRequest('stackTrace', args);
	}

	/**
	 * Send scopes request
	 */
	public async scopes(args: { frameId: number }): Promise<DAPResponse> {
		return this.sendRequest('scopes', args);
	}

	/**
	 * Send variables request
	 */
	public async variables(args: {
		variablesReference: number;
		filter?: 'indexed' | 'named';
		start?: number;
		count?: number;
		format?: any;
	}): Promise<DAPResponse> {
		return this.sendRequest('variables', args);
	}

	/**
	 * Send evaluate request
	 */
	public async evaluate(args: {
		expression: string;
		frameId?: number;
		context?: 'watch' | 'repl' | 'hover' | 'clipboard';
		format?: any;
	}): Promise<DAPResponse> {
		return this.sendRequest('evaluate', args);
	}

	/**
	 * Send threads request
	 */
	public async threads(): Promise<DAPResponse> {
		return this.sendRequest('threads');
	}

	/**
	 * Send source request
	 */
	public async source(args: {
		source?: { path?: string; sourceReference?: number };
		sourceReference: number;
	}): Promise<DAPResponse> {
		return this.sendRequest('source', args);
	}
}
