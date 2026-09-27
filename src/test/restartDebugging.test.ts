// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DebuggingHandler } from '../debuggingHandler';
import { CliDebuggingExecutor } from '../cli/cliDebuggingExecutor';
import { CliDebugConfiguration } from '../cli/cliConfigurationManager';
import { IDebugConfigurationManager } from '../utils/debugConfigurationManager';

suite('Restart completion (#160)', () => {
	function handler(restart: () => Promise<void>, active = true, timeout = 0.05): DebuggingHandler {
		const executor = new CliDebuggingExecutor();
		executor.hasActiveSession = async () => active;
		executor.restart = restart;
		return new DebuggingHandler(executor, {} as IDebugConfigurationManager, timeout);
	}

	test('does not dispatch without an active session', async () => {
		let called = false;
		const target = handler(async () => { called = true; }, false);
		await assert.rejects(() => target.handleRestart(), /No active debug session/);
		assert.equal(called, false);
	});

	test('preserves a restart rejection rather than returning success', async () => {
		const target = handler(async () => { throw new Error('GDB restart rejected'); });
		await assert.rejects(() => target.handleRestart(), /GDB restart rejected/);
	});

	test('an unacknowledged restart is bounded by the operation timeout', async () => {
		let release: () => void = () => {};
		const target = handler(() => new Promise<void>(resolve => { release = resolve; }));
		// Release the simulated adapter eventually so the unfixed test cannot hang.
		const timer = setTimeout(() => release(), 400);
		try {
			await assert.rejects(() => target.handleRestart(), /restart.*timed out/i);
		} finally {
			clearTimeout(timer);
			release();
		}
	});

	test('successful restart returns without a fixed settling delay', async () => {
		const target = handler(async () => {});
		const start = Date.now();
		assert.match(await target.handleRestart(), /restarted successfully/);
		assert.ok(Date.now() - start < 200, 'a successful acknowledgement needs no blind sleep');
	});

	test('waits for a delayed acknowledgement before returning success', async () => {
		let release: () => void = () => {};
		const target = handler(() => new Promise<void>(resolve => { release = resolve; }), true, 1);
		let settled = false;
		const result = target.handleRestart().then(value => { settled = true; return value; });
		try {
			await new Promise(resolve => setTimeout(resolve, 20));
			assert.equal(settled, false);
		} finally {
			release();
		}
		assert.match(await result, /restarted successfully/);
	});

	test('a late rejection after timeout does not become an unhandled rejection', async () => {
		let rejectRestart: (error: Error) => void = () => {};
		const target = handler(() => new Promise<void>((_resolve, reject) => { rejectRestart = reject; }));
		const timer = setTimeout(() => rejectRestart(new Error('late adapter error')), 400);
		try {
			await assert.rejects(() => target.handleRestart(), /restart.*timed out/i);
			rejectRestart(new Error('late adapter error'));
			await new Promise(resolve => setTimeout(resolve, 20));
		} finally {
			clearTimeout(timer);
			rejectRestart(new Error('cleanup'));
		}
	});
});

suite('Restart acknowledgement over DAP (#160)', () => {
	let directory: string;
	let executor: CliDebuggingExecutor;
	let config: CliDebugConfiguration;

	setup(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'debugmcp-restart-'));
		const adapterPath = path.join(directory, 'adapter.cjs');
		await fs.writeFile(adapterPath, `
let buffer = Buffer.alloc(0);
let seq = 1;
let mode;
function send(message) {
	const payload = Buffer.from(JSON.stringify({ seq: seq++, ...message }));
	process.stdout.write('Content-Length: ' + payload.length + '\\r\\n\\r\\n');
	process.stdout.write(payload);
}
function stopped() {
	send({ type: 'event', event: 'stopped', body: {
		reason: 'restart', threadId: 1, allThreadsStopped: true
	} });
}
function handle(request) {
	const response = { type: 'response', request_seq: request.seq, command: request.command, success: true };
	switch (request.command) {
		case 'initialize':
			send({ ...response, body: { supportsConfigurationDoneRequest: true, supportsRestartRequest: true } });
			break;
		case 'launch':
			mode = request.arguments.mode;
			send(response);
			send({ type: 'event', event: 'initialized' });
			break;
		case 'configurationDone':
			send(response);
			stopped();
			break;
		case 'restart':
			send({ type: 'event', event: 'continued', body: { threadId: 1, allThreadsContinued: true } });
			stopped();
			if (mode === 'success') send(response);
			if (mode === 'failure') send({ ...response, success: false, message: 'GDB restart rejected' });
			break;
		case 'stackTrace':
			send({ ...response, body: { stackFrames: [{ id: 4096, name: 'main', line: 2, column: 1 }] } });
			break;
		default:
			send(response);
	}
}
process.stdin.on('data', chunk => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
		if (headerEnd < 0) return;
		const length = Number(/Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))[1]);
		const start = headerEnd + 4;
		if (buffer.length < start + length) return;
		const request = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
		buffer = buffer.subarray(start + length);
		handle(request);
	}
});
`, 'utf8');
		executor = new CliDebuggingExecutor();
		config = {
			name: 'restart acknowledgement',
			type: 'fake',
			request: 'launch',
			adapterName: 'fake',
			adapter: { command: process.execPath, args: [adapterPath], type: 'fake', extensions: ['.fake'] }
		};
	});

	teardown(async () => {
		try {
			await executor.dispose();
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	for (const mode of ['success', 'failure', 'missing']) {
		test(`${mode} acknowledgement after a fresh stop`, async () => {
			await executor.startDebugging(directory, { ...config, mode });
			await executor.waitForDebugSessionReady(1_000);
			const before = await executor.getCurrentDebugState();
			assert.equal(before.isPaused(), true);
			const target = new DebuggingHandler(executor, {} as IDebugConfigurationManager, 0.1);
			if (mode === 'success') {
				assert.match(await target.handleRestart(), /restarted successfully/);
			} else {
				await assert.rejects(() => target.handleRestart(),
					mode === 'failure' ? /GDB restart rejected/ : /Restart timed out.*not been cancelled/);
			}
			const after = await executor.getCurrentDebugState();
			assert.equal(after.isPaused(), true);
			assert.notEqual(after.stopSequence, before.stopSequence);
		});
	}
});
