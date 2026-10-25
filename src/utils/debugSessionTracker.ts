// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { logger } from './logger';
import { DebugOutputBuffer } from './debugOutputBuffer';

interface ISessionExecutionState {
	defaultPaused?: boolean;
	threads: Map<number, boolean>;
	unscopedStop: boolean;
	revision: number;
	stopSequence?: number;
	defaultStopSequence?: number;
	threadStopSequences: Map<number, number>;
	pendingResumes: Map<number, IResumeRequest>;
}

interface IResumeRequest {
	command: string;
	threadId?: number;
	singleThread: boolean;
	revision: number;
}

const RESUME_COMMANDS = new Set([
	'continue', 'next', 'stepIn', 'stepOut', 'stepBack', 'reverseContinue', 'goto', 'restartFrame'
]);

type DebugTrackerApi = Pick<typeof vscode.debug,
	'registerDebugAdapterTrackerFactory' | 'onDidTerminateDebugSession'>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Observes standard DAP execution events without requesting or selecting frames.
 * Unobserved sessions remain unknown so existing sessions can use the UI fallback.
 */
export class DebugSessionTracker implements vscode.Disposable {
	private readonly sessions = new Map<string, ISessionExecutionState>();
	private readonly endedSessions = new WeakSet<vscode.DebugSession>();
	private readonly subscriptions: vscode.Disposable[];
	private revision = 0;
	private disposed = false;

	constructor(api: DebugTrackerApi = vscode.debug, public readonly output = new DebugOutputBuffer()) {
		this.subscriptions = [
			api.registerDebugAdapterTrackerFactory('*', {
				createDebugAdapterTracker: session => {
					if (this.disposed) {
						return undefined;
					}
					const state: ISessionExecutionState = {
						threads: new Map(),
						threadStopSequences: new Map(),
						pendingResumes: new Map(),
						unscopedStop: false,
						revision: ++this.revision
					};
					this.sessions.set(session.id, state);
					this.output.startSession(session.id);
					this.endedSessions.delete(session);
					const end = () => {
						if (this.sessions.get(session.id) === state) {
							this.endSession(session);
						}
					};
					return {
						onWillReceiveMessage: (message: unknown) => {
							if (this.sessions.get(session.id) === state) {
								this.observeRequest(state, message);
							}
						},
						onDidSendMessage: (message: unknown) => {
							if (this.sessions.get(session.id) === state) {
								this.observe(session, state, message);
							}
						},
						onWillStopSession: end,
						onExit: end
					};
				}
			}),
			api.onDidTerminateDebugSession(session => this.endSession(session))
		];
	}

	public getPausedState(sessionId: string, threadId?: number): boolean | undefined {
		const state = this.sessions.get(sessionId);
		if (!state) {
			return undefined;
		}
		if (threadId !== undefined) {
			return state.threads.get(threadId) ?? (state.unscopedStop ? true : state.defaultPaused);
		}
		if (state.defaultPaused === true || state.unscopedStop ||
			[...state.threads.values()].some(paused => paused)) {
			return true;
		}
		return state.defaultPaused ?? (state.threads.size > 0 ? false : undefined);
	}

	/** Detect an execution transition during an asynchronous snapshot lookup. */
	public getRevision(sessionId: string): number | undefined {
		return this.sessions.get(sessionId)?.revision;
	}

	/** Only a stopped event advances this marker, not a resume or a UI refresh. */
	public getStopSequence(sessionId: string, threadId?: number): number | undefined {
		const state = this.sessions.get(sessionId);
		if (!state || this.getPausedState(sessionId, threadId) !== true) {
			return undefined;
		}
		if (threadId === undefined) {
			return state.stopSequence;
		}
		const sequence = Math.max(
			state.threadStopSequences.get(threadId) ?? 0,
			state.defaultStopSequence ?? 0
		);
		return sequence === 0 ? undefined : sequence;
	}

	public hasSessionEnded(session: vscode.DebugSession): boolean {
		return this.endedSessions.has(session);
	}

	public dispose(): void {
		this.disposed = true;
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.sessions.clear();
		this.output.clear();
	}

	private endSession(session: vscode.DebugSession): void {
		this.sessions.delete(session.id);
		// Do not retain terminated sessions, but reject a lagging active UI session.
		this.endedSessions.add(session);
	}

	private observe(session: vscode.DebugSession, state: ISessionExecutionState, message: unknown): void {
		if (!isRecord(message)) {
			return;
		}
		if (message.type === 'response') {
			this.observeResponse(state, message);
			return;
		}
		if (message.type !== 'event') {
			return;
		}
		if (message.event === 'output') {
			this.output.append(session.id, message.body);
			return;
		}
		if (message.event === 'exited' || message.event === 'terminated') {
			if (message.body === undefined || isRecord(message.body)) {
				this.endSession(session);
			}
			return;
		}
		if (message.event !== 'stopped' && message.event !== 'continued') {
			return;
		}
		const body = message.body;
		const flag = message.event === 'stopped' ? 'allThreadsStopped' : 'allThreadsContinued';
		if (!isRecord(body) ||
			(body.threadId !== undefined &&
				(typeof body.threadId !== 'number' || !Number.isInteger(body.threadId) || body.threadId < 0)) ||
			(body[flag] !== undefined && typeof body[flag] !== 'boolean')) {
			logger.warn(`Ignoring malformed DAP ${message.event} event.`);
			return;
		}
		const threadId = typeof body.threadId === 'number' ? body.threadId : undefined;
		if (message.event === 'continued' && body.allThreadsContinued === false && threadId === undefined) {
			logger.warn('Ignoring thread-specific DAP continued event without a thread ID.');
			return;
		}
		state.revision = ++this.revision;
		if (message.event === 'stopped') {
			state.stopSequence = state.revision;
			if (body.allThreadsStopped === true) {
				state.defaultPaused = true;
				state.threads.clear();
				state.unscopedStop = false;
				state.defaultStopSequence = state.stopSequence;
				state.threadStopSequences.clear();
			} else if (threadId !== undefined) {
				state.threads.set(threadId, true);
				state.threadStopSequences.set(threadId, state.stopSequence);
			} else {
				state.unscopedStop = true;
				state.defaultStopSequence = state.stopSequence;
			}
		} else if (body.allThreadsContinued !== false) {
			// DAP defaults an omitted allThreadsContinued to all threads running.
			state.defaultPaused = false;
			state.threads.clear();
			state.unscopedStop = false;
			state.defaultStopSequence = undefined;
			state.threadStopSequences.clear();
		} else if (threadId !== undefined) {
			state.threads.set(threadId, false);
		}
	}

	private observeRequest(state: ISessionExecutionState, message: unknown): void {
		if (!isRecord(message) || message.type !== 'request' || typeof message.command !== 'string' ||
			!RESUME_COMMANDS.has(message.command)) {
			return;
		}
		const args = message.arguments;
		if (typeof message.seq !== 'number' || !Number.isSafeInteger(message.seq) ||
			!isRecord(args) ||
			(args.threadId !== undefined &&
				(typeof args.threadId !== 'number' || !Number.isInteger(args.threadId) || args.threadId < 0)) ||
			(args.singleThread !== undefined && typeof args.singleThread !== 'boolean')) {
			logger.warn('Ignoring malformed DAP resume request.');
			return;
		}
		if (state.pendingResumes.size >= 256) {
			state.pendingResumes.delete(state.pendingResumes.keys().next().value!);
			logger.warn('Discarding oldest pending DAP resume request at tracking limit.');
		}
		state.pendingResumes.set(message.seq, {
			command: message.command,
			threadId: typeof args.threadId === 'number' ? args.threadId : undefined,
			singleThread: args.singleThread === true,
			revision: state.revision
		});
	}

	private observeResponse(state: ISessionExecutionState, message: Record<string, unknown>): void {
		if (typeof message.request_seq !== 'number') {
			return;
		}
		const request = state.pendingResumes.get(message.request_seq);
		if (!request) {
			return;
		}
		state.pendingResumes.delete(message.request_seq);
		if (message.success !== true || message.command !== request.command) {
			return;
		}
		const body = message.body;
		if (body !== undefined && !isRecord(body)) {
			logger.warn('Ignoring malformed DAP resume response.');
			return;
		}
		if (request.command === 'continue' && body?.allThreadsContinued !== undefined &&
			typeof body.allThreadsContinued !== 'boolean') {
			logger.warn('Ignoring malformed DAP continue response.');
			return;
		}
		const allThreads = request.command === 'continue'
			? body?.allThreadsContinued !== false
			: !request.singleThread;
		// A stop may arrive before the response. Never overwrite a newer stop.
		if ((state.defaultStopSequence ?? 0) > request.revision) {
			return;
		}
		if (allThreads) {
			state.defaultPaused = false;
			state.unscopedStop = false;
			state.defaultStopSequence = undefined;
			for (const threadId of state.threads.keys()) {
				if ((state.threadStopSequences.get(threadId) ?? 0) <= request.revision) {
					state.threads.delete(threadId);
					state.threadStopSequences.delete(threadId);
				}
			}
		} else if (request.threadId !== undefined) {
			if ((state.threadStopSequences.get(request.threadId) ?? 0) > request.revision) {
				return;
			}
			state.threads.set(request.threadId, false);
		} else {
			logger.warn('Ignoring thread-specific DAP resume response without a request thread ID.');
			return;
		}
		state.revision = ++this.revision;
	}
}
