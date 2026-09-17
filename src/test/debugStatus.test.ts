// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { DebugState } from '../debugState';
import { DebuggingExecutor } from '../debuggingExecutor';
import { DebuggingHandler } from '../debuggingHandler';
import { DebugConfigurationManager } from '../utils/debugConfigurationManager';

function runningState(): DebugState {
	const state = new DebugState();
	state.sessionActive = true;
	return state;
}

function pausedState(frameId = 0, threadId = 1, withSource = false): DebugState {
	const state = runningState();
	state.updateContext(frameId, threadId);
	state.updateFrameName('main');
	if (withSource) {
		state.updateLocation(__filename, path.basename(__filename), 1, '', []);
	}
	return state;
}

class SnapshotExecutor extends DebuggingExecutor {
	public reads = 0;
	public pauseCalls = 0;
	public pauseError?: Error;

	constructor(private readonly states: DebugState[]) {
		super();
	}

	public override async hasActiveSession(): Promise<boolean> {
		return this.states[0].sessionActive;
	}

	public override getActiveSession() {
		return this.states[0].sessionActive
			? { id: 'session', name: 'test', type: 'cortex-debug' }
			: undefined;
	}

	public override async getCurrentDebugState(): Promise<DebugState> {
		return this.states[Math.min(this.reads++, this.states.length - 1)].clone();
	}

	public override async pause(): Promise<void> {
		this.pauseCalls++;
		if (this.pauseError) {
			throw this.pauseError;
		}
	}

	public override async stepOver(): Promise<void> {}
	public override async continue(): Promise<void> {}
}

function handler(executor: DebuggingExecutor, timeout = 0.3): DebuggingHandler {
	return new DebuggingHandler(executor, new DebugConfigurationManager(), timeout);
}

suite('Debug status and idempotent pause (#157)', () => {
	test('an observed stopped event is paused even with no frames', async () => {
		const state = runningState();
		state.paused = true;
		const executor = new SnapshotExecutor([state]);
		const result = JSON.parse(await handler(executor).handleGetDebugStatus({ waitForPauseSeconds: 60 }));
		assert.equal(result.status, 'paused');
		assert.equal(result.state.frameId, null);
		assert.equal(executor.reads, 1);
	});

	test('an observed running state overrides stale frame context', async () => {
		const state = pausedState();
		state.paused = false;
		const result = JSON.parse(await handler(new SnapshotExecutor([state])).handleGetDebugStatus());
		assert.equal(result.status, 'running');
		assert.equal(result.paused, false);
	});

	test('pause skips dispatch for a stopped target with an empty stack', async () => {
		const state = runningState();
		state.paused = true;
		const executor = new SnapshotExecutor([state]);
		const result = JSON.parse(await handler(executor).handlePause());
		assert.equal(result.frameId, null);
		assert.equal(executor.pauseCalls, 0);
		assert.equal(executor.reads, 1);
	});

	test('pause still dispatches after a continued event with a stale UI frame', async () => {
		const state = pausedState();
		state.paused = false;
		const stopped = runningState();
		stopped.paused = true;
		const executor = new SnapshotExecutor([state, stopped]);
		await handler(executor).handlePause();
		assert.equal(executor.pauseCalls, 1);
		assert.equal(executor.reads, 2);
	});

	test('a pause wait settles on an observed stopped event without a frame', async () => {
		const stopped = runningState();
		stopped.paused = true;
		const executor = new SnapshotExecutor([runningState(), stopped]);
		const result = JSON.parse(await handler(executor).handleGetDebugStatus({ waitForPauseSeconds: 60 }));
		assert.equal(result.status, 'paused');
		assert.equal(executor.reads, 2);
	});

	test('a source-less frame with ID zero is paused and does not consume the requested wait', async () => {
		const executor = new SnapshotExecutor([pausedState()]);
		const result = JSON.parse(await handler(executor).handleGetDebugStatus({ waitForPauseSeconds: 60 }));
		assert.equal(result.status, 'paused');
		assert.equal(result.paused, true);
		assert.equal(result.state.frameId, 0);
		assert.equal(result.state.fileName, null);
		assert.equal(executor.reads, 1);
	});

	test('a status wait ends when a source-less frame arrives', async () => {
		const executor = new SnapshotExecutor([runningState(), pausedState()]);
		const result = JSON.parse(await handler(executor).handleGetDebugStatus({ waitForPauseSeconds: 60 }));
		assert.equal(result.status, 'paused');
		assert.equal(executor.reads, 2);
	});

	test('a thread without a frame does not imply paused', async () => {
		const state = runningState();
		state.threadId = 1;
		const result = JSON.parse(await handler(new SnapshotExecutor([state])).handleGetDebugStatus());
		assert.equal(result.status, 'running');
		assert.equal(result.paused, false);
	});

	test('source information without an execution context does not imply paused', async () => {
		const state = runningState();
		state.updateLocation(__filename, path.basename(__filename), 1, '', []);
		const result = JSON.parse(await handler(new SnapshotExecutor([state])).handleGetDebugStatus());
		assert.equal(result.status, 'running');
		assert.equal(result.paused, false);
	});

	for (const withSource of [false, true]) {
		test(`pause is a no-op when already paused (readable source: ${withSource})`, async () => {
			const executor = new SnapshotExecutor([pausedState(0, 1, withSource)]);
			const result = JSON.parse(await handler(executor).handlePause());
			assert.equal(result.frameId, 0);
			assert.equal(executor.pauseCalls, 0);
			assert.equal(executor.reads, 1);
		});
	}

	test('pause interrupts a running session and waits for a source-less stop', async () => {
		const executor = new SnapshotExecutor([runningState(), runningState(), pausedState()]);
		const result = JSON.parse(await handler(executor).handlePause());
		assert.equal(result.frameId, 0);
		assert.equal(executor.pauseCalls, 1);
		assert.equal(executor.reads, 3);
	});

	test('pause returns when the session terminates while waiting', async () => {
		const executor = new SnapshotExecutor([runningState(), new DebugState()]);
		const result = JSON.parse(await handler(executor).handlePause());
		assert.equal(result.sessionActive, false);
		assert.equal(executor.pauseCalls, 1);
	});

	test('pause without an active session is an explicit error', async () => {
		const executor = new SnapshotExecutor([new DebugState()]);
		await assert.rejects(handler(executor).handlePause(), /Debug session is not ready/);
		assert.equal(executor.pauseCalls, 0);
	});

	test('pause dispatch errors propagate', async () => {
		const executor = new SnapshotExecutor([runningState()]);
		executor.pauseError = new Error('adapter rejected pause');
		await assert.rejects(handler(executor).handlePause(), /adapter rejected pause/);
	});

	test('pause waiting remains bounded when the adapter never stops', async () => {
		const executor = new SnapshotExecutor([runningState()]);
		const started = Date.now();
		const result = JSON.parse(await handler(executor).handlePause());
		assert.equal(result.frameId, null);
		assert.equal(executor.pauseCalls, 1);
		assert.ok(Date.now() - started >= 200);
		assert.ok(Date.now() - started < 2000);
	});

	test('continue does not treat an unchanged source-less stop as resumed', async () => {
		const executor = new SnapshotExecutor([pausedState()]);
		const started = Date.now();
		await handler(executor).handleContinue();
		assert.ok(Date.now() - started >= 200);
	});

	test('continue completes when a source-less stopped session resumes', async () => {
		const executor = new SnapshotExecutor([pausedState(), runningState()]);
		const result = JSON.parse(await handler(executor).handleContinue());
		assert.equal(result.frameId, null);
		assert.equal(executor.reads, 2);
	});

	for (const [name, next] of [
		['frame', pausedState(1)],
		['thread', pausedState(0, 2)],
		['source availability', pausedState(0, 1, true)]
	] as const) {
		test(`stepping detects ${name} changes from a source-less stop`, async () => {
			const executor = new SnapshotExecutor([pausedState(), next]);
			const result = JSON.parse(await handler(executor).handleStepOver());
			assert.equal(result.frameId, next.frameId);
			assert.equal(result.threadId, next.threadId);
			assert.equal(executor.reads, 2);
		});
	}

	test('stepping waits through the transient running state before another source-less stop', async () => {
		const executor = new SnapshotExecutor([pausedState(), runningState(), pausedState(1)]);
		const result = JSON.parse(await handler(executor).handleStepOver());
		assert.equal(result.frameId, 1);
		assert.equal(executor.reads, 3);
	});
});

suite('VS Code executor source-independent status (#157)', () => {
	let sessionDescriptor: PropertyDescriptor;
	let stackDescriptor: PropertyDescriptor;
	let session: vscode.DebugSession;
	let stackItem: vscode.DebugStackFrame | vscode.DebugThread | undefined;
	let source: { path?: string; name?: string; sourceReference?: number } | undefined;
	let rejectStackTrace: boolean;
	let duringStackTrace: (() => void) | undefined;
	let active: boolean;

	setup(() => {
		sessionDescriptor = Object.getOwnPropertyDescriptor(vscode.debug, 'activeDebugSession')!;
		stackDescriptor = Object.getOwnPropertyDescriptor(vscode.debug, 'activeStackItem')!;
		source = undefined;
		rejectStackTrace = false;
		duringStackTrace = undefined;
		active = true;
		session = {
			id: 'issue-157',
			name: 'Cortex test',
			type: 'cortex-debug',
			configuration: { type: 'cortex-debug', request: 'launch', name: 'Cortex test' },
			workspaceFolder: undefined,
			customRequest: async (command: string) => {
				assert.equal(command, 'stackTrace');
				duringStackTrace?.();
				if (rejectStackTrace) {
					throw new Error('stack unavailable');
				}
				return { stackFrames: [{ id: 0, name: 'main', line: 1, column: 1, source }] };
			},
			getDebugProtocolBreakpoint: async () => undefined
		};
		stackItem = { frameId: 0, threadId: 1, session };
		Object.defineProperty(vscode.debug, 'activeDebugSession', { configurable: true, get: () => active ? session : undefined });
		Object.defineProperty(vscode.debug, 'activeStackItem', { configurable: true, get: () => stackItem });
	});

	teardown(() => {
		Object.defineProperty(vscode.debug, 'activeDebugSession', sessionDescriptor);
		Object.defineProperty(vscode.debug, 'activeStackItem', stackDescriptor);
	});

	for (const scenario of ['missing source', 'sourceReference only', 'unreadable source path', 'stack request failed']) {
		test(`${scenario} preserves paused status from the real executor`, async () => {
			if (scenario === 'sourceReference only') {
				source = { name: 'generated.c', sourceReference: 1 };
			} else if (scenario === 'unreadable source path') {
				source = { path: path.join(__dirname, 'nonexistent-issue157', 'firmware.c') };
			} else if (scenario === 'stack request failed') {
				rejectStackTrace = true;
			}
			const result = JSON.parse(await handler(new DebuggingExecutor()).handleGetDebugStatus());
			assert.equal(result.status, 'paused');
			assert.equal(result.state.frameId, 0);
			assert.equal(result.state.threadId, 1);
			assert.equal(result.state.fileName, null);
		});
	}

	test('readable source still supplies the actual line and frame', async () => {
		source = { path: __filename };
		const result = JSON.parse(await handler(new DebuggingExecutor()).handleGetDebugStatus());
		assert.equal(result.status, 'paused');
		assert.equal(result.state.currentLine, 1);
		assert.equal(result.state.frameId, 0);
	});

	test('a selected thread is not mistaken for a stopped frame', async () => {
		stackItem = { threadId: 1, session };
		const result = JSON.parse(await handler(new DebuggingExecutor()).handleGetDebugStatus());
		assert.equal(result.status, 'running');
	});

	test('resuming during a stack request does not return a stale paused context', async () => {
		duringStackTrace = () => { stackItem = { threadId: 1, session }; };
		rejectStackTrace = true;
		const state = await new DebuggingExecutor().getCurrentDebugState();
		assert.equal(state.sessionActive, true);
		assert.equal(state.hasValidContext(), false);
		assert.equal(state.threadId, null);
	});

	test('termination during a stack request clears the stopped snapshot', async () => {
		duringStackTrace = () => { active = false; stackItem = undefined; };
		const result = JSON.parse(await handler(new DebuggingExecutor()).handleGetDebugStatus());
		assert.equal(result.status, 'no-session');
		assert.equal(result.paused, false);
	});
});
