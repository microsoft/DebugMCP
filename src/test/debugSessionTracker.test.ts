// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import { DebuggingExecutor } from '../debuggingExecutor';
import { DebugSessionTracker } from '../utils/debugSessionTracker';

function createSession(id = 'issue-157'): vscode.DebugSession {
	return {
		id,
		name: id,
		type: 'cortex-debug',
		configuration: { name: id, type: 'cortex-debug', request: 'launch' },
		workspaceFolder: undefined,
		customRequest: async () => ({ stackFrames: [], totalFrames: 0 }),
		getDebugProtocolBreakpoint: async () => undefined
	};
}

class TrackerFixture implements vscode.Disposable {
	public readonly terminated = new vscode.EventEmitter<vscode.DebugSession>();
	public readonly tracker: DebugSessionTracker;
	public factory?: vscode.DebugAdapterTrackerFactory;
	public registrations = 0;

	constructor() {
		this.tracker = new DebugSessionTracker({
			registerDebugAdapterTrackerFactory: (type, factory) => {
				assert.equal(type, '*');
				this.factory = factory;
				this.registrations++;
				return new vscode.Disposable(() => { this.registrations--; });
			},
			onDidTerminateDebugSession: listener => {
				this.registrations++;
				const subscription = this.terminated.event(listener);
				return new vscode.Disposable(() => {
					this.registrations--;
					subscription.dispose();
				});
			}
		});
	}

	public async attach(session: vscode.DebugSession): Promise<vscode.DebugAdapterTracker> {
		const adapter = await this.factory?.createDebugAdapterTracker(session);
		assert.ok(adapter);
		return adapter;
	}

	public dispose(): void {
		this.tracker.dispose();
		this.terminated.dispose();
	}
}

function send(adapter: vscode.DebugAdapterTracker, event: string, body?: unknown): void {
	adapter.onDidSendMessage?.({ type: 'event', event, body });
}

suite('DAP execution tracking (#157)', () => {
	let fixture: TrackerFixture;
	let session: vscode.DebugSession;
	let adapter: vscode.DebugAdapterTracker;

	setup(async () => {
		fixture = new TrackerFixture();
		session = createSession();
		adapter = await fixture.attach(session);
	});
	teardown(() => fixture.dispose());

	test('unobserved and pre-existing sessions remain unknown', () => {
		assert.equal(fixture.tracker.getPausedState(session.id), undefined);
		assert.equal(fixture.tracker.getPausedState('pre-existing', 0), undefined);
	});

	test('a stopped thread with ID zero is recorded without requesting frames', () => {
		send(adapter, 'stopped', { reason: 'breakpoint', threadId: 0 });
		assert.equal(fixture.tracker.getPausedState(session.id, 0), true);
		assert.equal(fixture.tracker.getPausedState(session.id), true);
		assert.equal(fixture.tracker.getPausedState(session.id, 1), undefined);
	});

	test('a stop without a thread remains observable', () => {
		send(adapter, 'continued', { threadId: 0 });
		send(adapter, 'stopped', { reason: 'pause' });
		assert.equal(fixture.tracker.getPausedState(session.id), true);
		assert.equal(fixture.tracker.getPausedState(session.id, 0), true);
	});

	test('partial thread transitions do not resume other stopped threads', () => {
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		send(adapter, 'stopped', { reason: 'pause', threadId: 1, allThreadsStopped: false });
		send(adapter, 'continued', { threadId: 0, allThreadsContinued: false });
		assert.equal(fixture.tracker.getPausedState(session.id, 0), false);
		assert.equal(fixture.tracker.getPausedState(session.id, 1), true);
		assert.equal(fixture.tracker.getPausedState(session.id), true);
		send(adapter, 'continued', { threadId: 1, allThreadsContinued: false });
		assert.equal(fixture.tracker.getPausedState(session.id), false);
	});

	test('partial continue overrides an all-thread stop for only that thread', () => {
		send(adapter, 'stopped', { reason: 'pause', allThreadsStopped: true });
		send(adapter, 'continued', { threadId: 0, allThreadsContinued: false });
		assert.equal(fixture.tracker.getPausedState(session.id, 0), false);
		assert.equal(fixture.tracker.getPausedState(session.id, 1), true);
		assert.equal(fixture.tracker.getPausedState(session.id), true);
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		assert.equal(fixture.tracker.getPausedState(session.id, 0), true);
	});

	for (const allThreadsContinued of [undefined, true]) {
		test(`continued defaults clear every stopped thread (${allThreadsContinued})`, () => {
			send(adapter, 'stopped', { reason: 'pause', allThreadsStopped: true });
			send(adapter, 'continued', { threadId: 0, allThreadsContinued });
			assert.equal(fixture.tracker.getPausedState(session.id, 0), false);
			assert.equal(fixture.tracker.getPausedState(session.id, 1), false);
			send(adapter, 'stopped', { reason: 'pause', threadId: 1 });
			assert.equal(fixture.tracker.getPausedState(session.id, 0), false);
			assert.equal(fixture.tracker.getPausedState(session.id, 1), true);
		});
	}

	test('execution state never leaks across sessions', async () => {
		const other = createSession('other');
		const otherAdapter = await fixture.attach(other);
		send(adapter, 'stopped', { reason: 'pause', allThreadsStopped: true });
		send(otherAdapter, 'continued', { threadId: 0 });
		assert.equal(fixture.tracker.getPausedState(session.id), true);
		assert.equal(fixture.tracker.getPausedState(other.id), false);
		fixture.terminated.fire(session);
		assert.equal(fixture.tracker.getPausedState(session.id), undefined);
		assert.equal(fixture.tracker.getPausedState(other.id), false);
	});

	for (const end of ['exited', 'terminated', 'adapter stop', 'adapter exit', 'session termination']) {
		test(`${end} clears records and ignores late adapter events`, () => {
			send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
			if (end === 'adapter stop') {
				adapter.onWillStopSession?.();
			} else if (end === 'adapter exit') {
				adapter.onExit?.(0, undefined);
			} else if (end === 'session termination') {
				fixture.terminated.fire(session);
			} else {
				send(adapter, end, {});
			}
			send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
			assert.equal(fixture.tracker.getPausedState(session.id), undefined);
			assert.equal(fixture.tracker.getRevision(session.id), undefined);
			assert.equal(fixture.tracker.hasSessionEnded(session), true);
		});
	}

	test('fresh adapter registration does not inherit stopped state or old callbacks', async () => {
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		const replacement = await fixture.attach(session);
		adapter.onWillStopSession?.();
		send(adapter, 'continued', { threadId: 0 });
		assert.equal(fixture.tracker.getPausedState(session.id), undefined);
		send(replacement, 'stopped', { reason: 'pause', threadId: 0 });
		assert.equal(fixture.tracker.getPausedState(session.id), true);
	});

	test('ignores malformed messages and custom events', () => {
		for (const message of [
			null, [], 'stopped', { type: 'response', event: 'stopped', body: {} },
			{ type: 'event', event: 'custom-stop', body: {} },
			{ type: 'event', event: 'stopped', body: null },
			{ type: 'event', event: 'stopped', body: [] },
			{ type: 'event', event: 'stopped', body: { threadId: '0' } },
			{ type: 'event', event: 'stopped', body: { threadId: -1 } },
			{ type: 'event', event: 'stopped', body: { allThreadsStopped: 'true' } },
			{ type: 'event', event: 'continued', body: { allThreadsContinued: false } }
		]) {
			adapter.onDidSendMessage?.(message);
		}
		assert.equal(fixture.tracker.getPausedState(session.id), undefined);
	});

	test('disposal unregisters listeners and clears all execution records', () => {
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		fixture.tracker.dispose();
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		assert.equal(fixture.registrations, 0);
		assert.equal(fixture.tracker.getPausedState(session.id), undefined);
		assert.equal(fixture.factory?.createDebugAdapterTracker(session), undefined);
	});
});

suite('VS Code observed execution snapshots (#157)', () => {
	let fixture: TrackerFixture;
	let session: vscode.DebugSession;
	let adapter: vscode.DebugAdapterTracker;
	let executor: DebuggingExecutor;
	let activeSession: vscode.DebugSession | undefined;
	let item: vscode.DebugStackFrame | vscode.DebugThread | undefined;
	let sessionDescriptor: PropertyDescriptor;
	let itemDescriptor: PropertyDescriptor;
	let requests: number;
	let duringStack: (() => void) | undefined;
	let sourcePath: string | undefined;

	setup(async () => {
		fixture = new TrackerFixture();
		session = createSession();
		requests = 0;
		duringStack = undefined;
		sourcePath = undefined;
		session.customRequest = async command => {
			assert.equal(command, 'stackTrace');
			requests++;
			duringStack?.();
			return sourcePath
				? { stackFrames: [{ id: 0, name: 'main', line: 1, source: { path: sourcePath } }] }
				: { stackFrames: [], totalFrames: 0 };
		};
		adapter = await fixture.attach(session);
		executor = new DebuggingExecutor(fixture.tracker);
		activeSession = session;
		item = undefined;
		sessionDescriptor = Object.getOwnPropertyDescriptor(vscode.debug, 'activeDebugSession')!;
		itemDescriptor = Object.getOwnPropertyDescriptor(vscode.debug, 'activeStackItem')!;
		Object.defineProperty(vscode.debug, 'activeDebugSession', { configurable: true, get: () => activeSession });
		Object.defineProperty(vscode.debug, 'activeStackItem', { configurable: true, get: () => item });
	});

	teardown(() => {
		Object.defineProperty(vscode.debug, 'activeDebugSession', sessionDescriptor);
		Object.defineProperty(vscode.debug, 'activeStackItem', itemDescriptor);
		fixture.dispose();
	});

	test('an observed frameless stop is paused without issuing stack requests', async () => {
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		const state = await executor.getCurrentDebugState();
		assert.equal(state.paused, true);
		assert.equal(state.isPaused(), true);
		assert.equal(state.frameId, null);
		assert.equal(state.threadId, null);
		assert.equal(requests, 0);
	});

	test('a selected thread is not paused until a stopped event is observed', async () => {
		item = { session, threadId: 0 };
		assert.equal((await executor.getCurrentDebugState()).isPaused(), false);
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		assert.equal((await executor.getCurrentDebugState()).isPaused(), true);
		assert.equal(requests, 0);
	});

	test('empty stack responses preserve an observed stop and real zero-valued context', async () => {
		item = { session, threadId: 0, frameId: 0 };
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		const state = await executor.getCurrentDebugState();
		assert.equal(state.isPaused(), true);
		assert.equal(state.frameId, 0);
		assert.equal(state.threadId, 0);
		assert.deepEqual(state.stackTrace, []);
	});

	test('continued state suppresses stale UI frames and their DAP requests', async () => {
		item = { session, threadId: 0, frameId: 0 };
		send(adapter, 'continued', { threadId: 0 });
		const state = await executor.getCurrentDebugState();
		assert.equal(state.paused, false);
		assert.equal(state.hasValidContext(), false);
		assert.equal(executor.getActiveFrameId(), undefined);
		assert.equal(requests, 0);
	});

	test('clearing a frame does not erase an observed stopped state', async () => {
		item = { session, threadId: 0, frameId: 0 };
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		duringStack = () => { item = undefined; };
		const state = await executor.getCurrentDebugState();
		assert.equal(state.isPaused(), true);
		assert.equal(state.hasValidContext(), false);
	});

	test('a continued event during stack lookup overrides an unchanged UI frame', async () => {
		item = { session, threadId: 0, frameId: 0 };
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		duringStack = () => send(adapter, 'continued', { threadId: 0 });
		const state = await executor.getCurrentDebugState();
		assert.equal(state.paused, false);
		assert.equal(state.frameId, null);
	});

	test('a resume and new stop discard old frame data even when IDs are reused', async () => {
		item = { session, threadId: 0, frameId: 0 };
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		duringStack = () => {
			send(adapter, 'continued', { threadId: 0 });
			send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		};
		const state = await executor.getCurrentDebugState();
		assert.equal(state.isPaused(), true);
		assert.equal(state.frameId, null);
	});

	test('termination during lookup suppresses a lagging active UI session', async () => {
		item = { session, threadId: 0, frameId: 0 };
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		duringStack = () => send(adapter, 'terminated');
		const state = await executor.getCurrentDebugState();
		assert.equal(state.sessionActive, false);
		assert.equal(state.isPaused(), false);
		assert.equal(state.frameId, null);
		assert.equal((await executor.getCurrentDebugState()).sessionActive, false);
	});

	test('session changes cannot carry old frame data into another session', async () => {
		item = { session, threadId: 0, frameId: 0 };
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		const other = createSession('other');
		const otherAdapter = await fixture.attach(other);
		send(otherAdapter, 'continued', { threadId: 0 });
		duringStack = () => { activeSession = other; };
		const state = await executor.getCurrentDebugState();
		assert.equal(state.configurationName, 'other');
		assert.equal(state.paused, false);
		assert.equal(state.frameId, null);
	});

	test('a continue during asynchronous source lookup discards location and frame data', async () => {
		item = { session, threadId: 0, frameId: 0 };
		sourcePath = __filename;
		send(adapter, 'stopped', { reason: 'pause', threadId: 0 });
		const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'openTextDocument')!;
		const open = vscode.workspace.openTextDocument;
		Object.defineProperty(vscode.workspace, 'openTextDocument', {
			configurable: true,
			value: async () => {
				send(adapter, 'continued', { threadId: 0 });
				return open(__filename);
			}
		});
		try {
			const state = await executor.getCurrentDebugState();
			assert.equal(state.paused, false);
			assert.equal(state.frameId, null);
			assert.equal(state.fileFullPath, null);
		} finally {
			Object.defineProperty(vscode.workspace, 'openTextDocument', descriptor);
		}
	});
});
