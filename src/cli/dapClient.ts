// Copyright (c) Microsoft Corporation.

import { EventEmitter } from 'node:events';
import { ChildProcess, spawn } from 'node:child_process';
import { logger } from '../utils/logger';

interface DapProtocolMessage {
	seq: number;
	type: 'request' | 'response' | 'event';
	command?: string;
	event?: string;
	request_seq?: number;
	success?: boolean;
	message?: string;
	arguments?: Record<string, unknown>;
	body?: any;
}

interface PendingRequest {
	resolve: (body: any) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class DapClient extends EventEmitter {
	private sequence = 1;
	private buffer = Buffer.alloc(0);
	private readonly pending = new Map<number, PendingRequest>();
	private readonly debuggees = new Set<ChildProcess>();
	private readonly adapter: ChildProcess;

	constructor(
		command: string,
		args: string[],
		cwd: string,
		private readonly requestTimeoutMs = 30_000
	) {
		super();
		this.adapter = spawn(command, args, {
			cwd,
			env: process.env,
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		});
		this.adapter.stdout?.on('data', chunk => this.acceptData(chunk));
		this.adapter.stderr?.on('data', chunk =>
			logger.warn(`debug adapter: ${String(chunk).trimEnd()}`));
		this.adapter.on('error', error => this.failAll(
			new Error(`Failed to start debug adapter '${command}': ${error.message}`)));
		this.adapter.on('exit', (code, signal) => {
			const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
			this.failAll(new Error(`Debug adapter exited with ${detail}`));
			this.emit('exit', { code, signal });
		});
	}

	public async request(command: string, args: Record<string, unknown> = {}): Promise<any> {
		const seq = this.sequence++;
		const response = new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error(`Debug adapter did not respond to '${command}' within ${this.requestTimeoutMs / 1000}s.`));
			}, this.requestTimeoutMs);
			this.pending.set(seq, { resolve, reject, timer });
		});
		this.send({ seq, type: 'request', command, arguments: args });
		return response;
	}

	public waitForEvent(
		event: string,
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<any> {
		return new Promise((resolve, reject) => {
			const finish = (error?: Error, body?: any) => {
				clearTimeout(timer);
				this.off(event, onEvent);
				signal?.removeEventListener('abort', onAbort);
				error ? reject(error) : resolve(body);
			};
			const onEvent = (body: any) => finish(undefined, body);
			const onAbort = () => finish(new Error(`Waiting for DAP event '${event}' was cancelled.`));
			const timer = setTimeout(
				() => finish(new Error(`Debug adapter did not send '${event}' within ${timeoutMs / 1000}s.`)),
				timeoutMs
			);
			this.once(event, onEvent);
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	}

	public dispose(): void {
		for (const debuggee of this.debuggees) {
			if (!debuggee.killed) {
				debuggee.kill();
			}
		}
		this.debuggees.clear();
		if (!this.adapter.killed) {
			this.adapter.kill();
		}
		this.failAll(new Error('Debug adapter connection closed.'));
	}

	public async close(timeoutMs = 2_000): Promise<void> {
		if (this.adapter.exitCode !== null || this.adapter.signalCode !== null) {
			return;
		}
		const exited = new Promise<void>(resolve => this.adapter.once('exit', () => resolve()));
		this.dispose();
		await Promise.race([
			exited,
			new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
		]);
	}

	private acceptData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) {
				return;
			}
			const header = this.buffer.subarray(0, headerEnd).toString('ascii');
			const lengthMatch = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
			if (!lengthMatch) {
				this.failAll(new Error('Debug adapter sent a DAP message without Content-Length.'));
				return;
			}
			const length = Number.parseInt(lengthMatch[1], 10);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) {
				return;
			}
			const payload = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
			this.buffer = this.buffer.subarray(bodyStart + length);
			try {
				this.handleMessage(JSON.parse(payload) as DapProtocolMessage);
			} catch (error) {
				this.failAll(new Error(`Debug adapter sent invalid JSON: ${error}`));
			}
		}
	}

	private handleMessage(message: DapProtocolMessage): void {
		if (message.type === 'response' && message.request_seq !== undefined) {
			const pending = this.pending.get(message.request_seq);
			if (!pending) {
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(message.request_seq);
			if (message.success === false) {
				pending.reject(new Error(message.message || `DAP request '${message.command}' failed.`));
			} else {
				pending.resolve(message.body);
			}
			return;
		}
		if (message.type === 'event' && message.event) {
			this.emit(message.event, message.body ?? {});
			return;
		}
		if (message.type === 'request' && message.command) {
			void this.handleReverseRequest(message);
		}
	}

	private async handleReverseRequest(request: DapProtocolMessage): Promise<void> {
		try {
			if (request.command !== 'runInTerminal') {
				throw new Error(`Unsupported debug adapter request '${request.command}'.`);
			}
			const args = request.arguments?.args;
			if (!Array.isArray(args) || args.length === 0 || args.some(arg => typeof arg !== 'string')) {
				throw new Error('runInTerminal did not provide a valid argument array.');
			}
			const env = request.arguments?.env;
			const child = spawn(args[0], args.slice(1), {
				cwd: typeof request.arguments?.cwd === 'string' ? request.arguments.cwd : undefined,
				env: env && typeof env === 'object'
					? { ...process.env, ...(env as Record<string, string>) }
					: process.env,
				shell: false,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true
			});
			this.debuggees.add(child);
			await new Promise<void>((resolve, reject) => {
				child.once('spawn', resolve);
				child.once('error', error => {
					this.debuggees.delete(child);
					reject(error);
				});
			});
			child.once('exit', () => this.debuggees.delete(child));
			child.stdout?.on('data', chunk => logger.info(`debuggee: ${String(chunk).trimEnd()}`));
			child.stderr?.on('data', chunk => logger.warn(`debuggee: ${String(chunk).trimEnd()}`));
			this.send({
				seq: this.sequence++,
				type: 'response',
				request_seq: request.seq,
				command: request.command,
				success: true,
				body: { processId: child.pid }
			});
		} catch (error) {
			this.send({
				seq: this.sequence++,
				type: 'response',
				request_seq: request.seq,
				command: request.command,
				success: false,
				message: error instanceof Error ? error.message : String(error)
			});
		}
	}

	private send(message: DapProtocolMessage): void {
		const payload = Buffer.from(JSON.stringify(message), 'utf8');
		this.adapter.stdin?.write(`Content-Length: ${payload.length}\r\n\r\n`);
		this.adapter.stdin?.write(payload);
	}

	private failAll(error: Error): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
	}
}
