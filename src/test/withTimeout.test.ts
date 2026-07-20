// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import { withTimeout } from '../utils/withTimeout';

/**
 * Regression tests for the shared timeout primitive that bounds every DAP
 * request (DebuggingExecutor.dapRequest) and every MCP tool call
 * (DebugMCPServer.runTool). These guard the "server stuck when a tool hangs"
 * fix: a hung operation must reject with the caller's error instead of
 * pending forever, and a fast operation must pass through untouched.
 */
suite('withTimeout', () => {
	test('resolves with the work value when it settles in time', async () => {
		const value = await withTimeout(
			Promise.resolve('ok'),
			1000,
			() => new Error('should not fire')
		);
		assert.strictEqual(value, 'ok');
	});

	test('propagates a rejection from the work promise (not the timeout error)', async () => {
		await assert.rejects(
			withTimeout(
				Promise.reject(new Error('work failed')),
				1000,
				() => new Error('timeout error')
			),
			/work failed/
		);
	});

	test('rejects with the onTimeout error when work never settles', async () => {
		const start = Date.now();
		await assert.rejects(
			withTimeout(
				new Promise<string>(() => { /* never settles */ }),
				50,
				() => new Error('adapter unresponsive')
			),
			/adapter unresponsive/
		);
		const elapsed = Date.now() - start;
		assert.ok(elapsed >= 40, `should wait for the ~50ms timeout, only took ${elapsed}ms`);
		assert.ok(elapsed < 1000, `timeout should fire promptly, took ${elapsed}ms`);
	});

	test('clears the timer so a late-but-eventual work result still wins', async () => {
		// Work resolves before the (long) timeout; the timer must be cleared so
		// it neither delays the result nor rejects afterwards.
		const work = new Promise<string>(resolve => setTimeout(() => resolve('late-ok'), 20));
		const value = await withTimeout(work, 5000, () => new Error('should not fire'));
		assert.strictEqual(value, 'late-ok');
		// Give any stray timer a chance to (wrongly) fire; nothing should throw.
		await new Promise(resolve => setTimeout(resolve, 30));
	});
});
