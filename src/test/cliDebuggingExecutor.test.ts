// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliDebuggingExecutor } from '../cli/cliDebuggingExecutor';
import { CliDebugConfiguration } from '../cli/cliConfigurationManager';

suite('CLI debugging executor', () => {
	let directory: string;

	setup(async () => {
		directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'debugmcp-executor-'));
	});

	teardown(async () => {
		await fs.promises.rm(directory, { recursive: true, force: true });
	});

	test('performs a DAP launch and reports the stopped source frame', async () => {
		const sourcePath = path.join(directory, 'app.fake');
		const adapterPath = path.join(directory, 'adapter.js');
		await fs.promises.writeFile(sourcePath, 'first();\nsecond();\nthird();\nfourth();\n', 'utf8');
		await fs.promises.writeFile(adapterPath, `
let buffer = Buffer.alloc(0);
let sequence = 1;
let currentLine = 2;
function send(message) {
	const payload = Buffer.from(JSON.stringify({ seq: sequence++, ...message }));
	process.stdout.write('Content-Length: ' + payload.length + '\\r\\n\\r\\n');
	process.stdout.write(payload);
}
function respond(request, body = {}) {
	send({ type: 'response', request_seq: request.seq, command: request.command, success: true, body });
}
function handle(request) {
	switch (request.command) {
		case 'initialize':
			respond(request, { supportsConfigurationDoneRequest: true });
			break;
		case 'launch':
			respond(request);
			send({ type: 'event', event: 'initialized', body: {} });
			break;
		case 'configurationDone':
			respond(request);
			send({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 7 } });
			break;
		case 'stackTrace':
			respond(request, { stackFrames: [{
				id: 11,
				name: 'main',
				line: currentLine,
				column: 1,
				source: { name: 'app.fake', path: ${JSON.stringify(sourcePath)} }
			}] });
			break;
		case 'next':
			respond(request);
			send({ type: 'event', event: 'continued', body: { threadId: 7 } });
			currentLine = 3;
			send({ type: 'event', event: 'stopped', body: { reason: 'step', threadId: 7 } });
			break;
		case 'continue':
			respond(request);
			send({ type: 'event', event: 'continued', body: { threadId: 7 } });
			currentLine = 4;
			setTimeout(() => send({
				type: 'event',
				event: 'stopped',
				body: { reason: 'breakpoint', threadId: 7 }
			}), 50);
			break;
		case 'disconnect':
			respond(request);
			setTimeout(() => process.exit(0), 20);
			break;
		default:
			respond(request);
	}
}
process.stdin.on('data', chunk => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
		if (headerEnd < 0) return;
		const header = buffer.subarray(0, headerEnd).toString('ascii');
		const length = Number(/Content-Length:\\s*(\\d+)/i.exec(header)[1]);
		const start = headerEnd + 4;
		if (buffer.length < start + length) return;
		const request = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
		buffer = buffer.subarray(start + length);
		handle(request);
	}
});
`, 'utf8');

		const executor = new CliDebuggingExecutor();
		const config: CliDebugConfiguration = {
			name: 'fake',
			type: 'fake',
			request: 'launch',
			program: sourcePath,
			adapterName: 'fake',
			adapter: {
				command: process.execPath,
				args: [adapterPath],
				type: 'fake',
				extensions: ['.fake']
			}
		};

		const ready = executor.waitForDebugSessionReady(5_000);
		assert.strictEqual(await executor.startDebugging(directory, config), true);
		assert.strictEqual(await ready, 'stopped');
		const state = await executor.getCurrentDebugState();
		assert.strictEqual(state.currentLine, 2);
		assert.strictEqual(state.currentLineContent, 'second();');
		assert.strictEqual(state.frameName, 'main');

		await executor.stepOver();
		const steppedState = await executor.getCurrentDebugState();
		assert.strictEqual(steppedState.currentLine, 3);
		assert.strictEqual(executor.getActiveFrameId(), 11);
		await executor.continue();
		const continuedState = await executor.getCurrentDebugState();
		assert.strictEqual(continuedState.currentLine, 4);
		await executor.stopDebugging();
	});
});
