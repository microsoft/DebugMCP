// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert/strict';
import { CliDebuggingExecutor } from '../cli/cliDebuggingExecutor';

suite('CLI explicit execution snapshots (#157)', () => {
	test('reports a stopped session with no selected thread as paused', async () => {
		const executor = new CliDebuggingExecutor();
		executor['state'] = 'stopped';
		executor['stopSequence'] = 1;
		const state = await executor.getCurrentDebugState();
		assert.equal(state.isPaused(), true);
		assert.equal(state.stopSequence, 1);
		assert.equal(state.frameId, null);
		assert.equal(state.threadId, null);
	});

	test('an empty stack preserves paused status and clears a previously cached frame', async () => {
		const executor = new CliDebuggingExecutor();
		executor['state'] = 'stopped';
		executor['stopSequence'] = 2;
		executor['threadId'] = 0;
		executor['frameId'] = 9;
		Object.defineProperty(executor, 'client', {
			value: {
				request: async (command: string, args: { threadId: number }) => {
					assert.equal(command, 'stackTrace');
					assert.equal(args.threadId, 0);
					return { stackFrames: [], totalFrames: 0 };
				}
			}
		});
		const state = await executor.getCurrentDebugState();
		assert.equal(state.paused, true);
		assert.equal(state.stopSequence, 2);
		assert.equal(state.frameId, null);
		assert.equal(executor.getActiveFrameId(), undefined);
	});

	test('running state never supplies a stale stopped frame', async () => {
		const executor = new CliDebuggingExecutor();
		executor['state'] = 'running';
		executor['stopSequence'] = 1;
		executor['frameId'] = 0;
		const state = await executor.getCurrentDebugState();
		assert.equal(state.sessionActive, true);
		assert.equal(state.paused, false);
		assert.equal(state.stopSequence, null);
		assert.equal(state.frameId, null);
		assert.equal(executor.getActiveFrameId(), undefined);
	});

	for (const transition of ['continued', 'terminated', 'restopped']) {
		test(`${transition} during stack lookup discards stale response frames`, async () => {
			const executor = new CliDebuggingExecutor();
			executor['state'] = 'stopped';
			executor['stopSequence'] = 1;
			executor['threadId'] = 0;
			Object.defineProperty(executor, 'client', {
				value: {
					request: async () => {
						executor['state'] = transition === 'terminated' ? 'terminated' : 'running';
						executor['emitState']();
						if (transition === 'restopped') {
							executor['state'] = 'stopped';
							executor['stopSequence']++;
							executor['emitState']();
						}
						return { stackFrames: [{ id: 0, name: 'main' }] };
					}
				}
			});
			const state = await executor.getCurrentDebugState();
			assert.equal(state.sessionActive, transition !== 'terminated');
			assert.equal(state.paused, transition === 'restopped');
			assert.equal(state.frameId, null);
			assert.equal(state.stopSequence, transition === 'restopped' ? 2 : null);
			assert.equal(executor.getActiveFrameId(), undefined);
		});
	}
});
