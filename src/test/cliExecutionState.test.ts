// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert/strict';
import { CliDebuggingExecutor } from '../cli/cliDebuggingExecutor';

suite('CLI explicit execution snapshots (#157)', () => {
	test('reports a stopped session with no selected thread as paused', async () => {
		const executor = new CliDebuggingExecutor();
		executor['state'] = 'stopped';
		const state = await executor.getCurrentDebugState();
		assert.equal(state.isPaused(), true);
		assert.equal(state.frameId, null);
		assert.equal(state.threadId, null);
	});

	test('an empty stack preserves paused status and clears a previously cached frame', async () => {
		const executor = new CliDebuggingExecutor();
		executor['state'] = 'stopped';
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
		assert.equal(state.frameId, null);
		assert.equal(executor.getActiveFrameId(), undefined);
	});

	test('running state never supplies a stale stopped frame', async () => {
		const executor = new CliDebuggingExecutor();
		executor['state'] = 'running';
		executor['frameId'] = 0;
		const state = await executor.getCurrentDebugState();
		assert.equal(state.sessionActive, true);
		assert.equal(state.paused, false);
		assert.equal(state.frameId, null);
		assert.equal(executor.getActiveFrameId(), undefined);
	});

	for (const transition of ['continued', 'terminated', 'restopped']) {
		test(`${transition} during stack lookup discards stale response frames`, async () => {
			const executor = new CliDebuggingExecutor();
			executor['state'] = 'stopped';
			executor['threadId'] = 0;
			Object.defineProperty(executor, 'client', {
				value: {
					request: async () => {
						executor['state'] = transition === 'terminated' ? 'terminated' : 'running';
						executor['emitState']();
						if (transition === 'restopped') {
							executor['state'] = 'stopped';
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
			assert.equal(executor.getActiveFrameId(), undefined);
		});
	}
});
