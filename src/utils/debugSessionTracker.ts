// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { logger } from './logger';

interface ISessionExecutionState {
	defaultPaused?: boolean;
	threads: Map<number, boolean>;
	unscopedStop: boolean;
	revision: number;
}

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

	constructor(api: DebugTrackerApi = vscode.debug) {
		this.subscriptions = [
			api.registerDebugAdapterTrackerFactory('*', {
				createDebugAdapterTracker: session => {
					if (this.disposed) {
						return undefined;
					}
					const state: ISessionExecutionState = {
						threads: new Map(),
						unscopedStop: false,
						revision: ++this.revision
					};
					this.sessions.set(session.id, state);
					this.endedSessions.delete(session);
					const end = () => {
						if (this.sessions.get(session.id) === state) {
							this.endSession(session);
						}
					};
					return {
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

	public hasSessionEnded(session: vscode.DebugSession): boolean {
		return this.endedSessions.has(session);
	}

	public dispose(): void {
		this.disposed = true;
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.sessions.clear();
	}

	private endSession(session: vscode.DebugSession): void {
		this.sessions.delete(session.id);
		// Do not retain terminated sessions, but reject a lagging active UI session.
		this.endedSessions.add(session);
	}

	private observe(session: vscode.DebugSession, state: ISessionExecutionState, message: unknown): void {
		if (!isRecord(message) || message.type !== 'event') {
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
			if (body.allThreadsStopped === true) {
				state.defaultPaused = true;
				state.threads.clear();
				state.unscopedStop = false;
			} else if (threadId !== undefined) {
				state.threads.set(threadId, true);
			} else {
				state.unscopedStop = true;
			}
		} else if (body.allThreadsContinued !== false) {
			// DAP defaults an omitted allThreadsContinued to all threads running.
			state.defaultPaused = false;
			state.threads.clear();
			state.unscopedStop = false;
		} else if (threadId !== undefined) {
			state.threads.set(threadId, false);
		}
	}
}
