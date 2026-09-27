// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliDebuggingExecutor } from '../cli/cliDebuggingExecutor';
import { CliDebugConfiguration } from '../cli/cliConfigurationManager';
import { DebuggingHandler } from '../debuggingHandler';
import { IDebugConfigurationManager } from '../utils/debugConfigurationManager';

suite('CLI debugging executor', () => {
	let directory: string;

	setup(async () => {
		directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'debugmcp-executor-'));
	});

	suite('CLI breakpoint lifecycle (#161)', () => {
		let sourcePath: string;
		let config: CliDebugConfiguration;
		let executor: CliDebuggingExecutor;

		setup(async () => {
			sourcePath = path.join(directory, 'app.fake');
			const adapterPath = path.join(directory, 'adapter.cjs');
			await fs.promises.writeFile(adapterPath, `
	let buffer = Buffer.alloc(0);
	let sequence = 1;
	let failConfiguration = false;
	let failDisconnect = false;
	const updates = [];
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
				failConfiguration = request.arguments.failConfiguration === true;
				failDisconnect = request.arguments.failDisconnect === true;
				respond(request);
				send({ type: 'event', event: 'initialized' });
				break;
			case 'configurationDone':
			case 'disconnect':
				if (request.command === 'configurationDone' ? failConfiguration : failDisconnect) {
					send({ type: 'response', request_seq: request.seq, command: request.command,
						success: false, message: request.command + ' rejected' });
				} else {
					respond(request);
				}
				break;
			case 'setBreakpoints':
				updates.push(request.arguments);
				respond(request, { breakpoints: request.arguments.breakpoints.map(bp => ({
					verified: true, line: bp.line
				})) });
				break;
			case 'recordedUpdates':
				respond(request, { updates });
				break;
			case 'finish':
				respond(request);
				if (request.arguments.event === 'exit') {
					setTimeout(() => process.exit(0), 10);
				} else {
					send({ type: 'event', event: request.arguments.event, body: { exitCode: 0 } });
				}
				break;
			default:
				throw new Error('Unexpected request: ' + request.command);
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
			config = {
				name: 'breakpoint lifecycle',
				type: 'fake',
				request: 'launch',
				adapterName: 'fake',
				adapter: { command: process.execPath, args: [adapterPath], type: 'fake', extensions: ['.fake'] }
			};
			executor = new CliDebuggingExecutor();
		});

		teardown(async () => {
			await executor.dispose();
		});

		async function recordedUpdates(): Promise<unknown> {
			const client = executor['client'];
			assert.ok(client);
			return (await client.request('recordedUpdates')).updates;
		}

		function update(lines: number[]): object {
			return {
				source: { path: sourcePath, name: 'app.fake' },
				breakpoints: lines.map(line => ({ line })),
				sourceModified: false
			};
		}

		for (const ending of ['stop', 'terminated', 'exited', 'exit', 'dispose', 'failed launch', 'failed disconnect']) {
			for (const operation of ['add', 'remove', 'clear']) {
				test(`${operation} breakpoints after ${ending} stays local and syncs on the next launch`, async () => {
					await executor.addBreakpoint(sourcePath, 1);
					await executor.addBreakpoint(sourcePath, 2);
					if (ending === 'failed launch') {
						await assert.rejects(
							() => executor.startDebugging(directory, { ...config, failConfiguration: true }),
							/configurationDone rejected/
						);
					} else {
						await executor.startDebugging(directory, { ...config, failDisconnect: ending === 'failed disconnect' });
						assert.deepStrictEqual(await recordedUpdates(), [update([1, 2])]);
						if (ending === 'stop') {
							await executor.stopDebugging();
						} else if (ending === 'failed disconnect') {
							await assert.rejects(() => executor.stopDebugging(), /disconnect rejected/);
						} else if (ending === 'dispose') {
							await executor.dispose();
						} else {
							const client = executor['client'];
							assert.ok(client);
							const ended = client.waitForEvent(ending, 2_000);
							await client.request('finish', { event: ending });
							await ended;
						}
					}

					assert.strictEqual((await executor.getCurrentDebugState()).sessionActive, false);
					if (operation === 'add') {
						await executor.addBreakpoint(sourcePath, 3);
					} else if (operation === 'remove') {
						await executor.removeBreakpoint(sourcePath, 1);
					} else {
						await executor.clearAllBreakpoints();
					}
					assert.strictEqual(executor['initialized'], false);
					const lines = operation === 'add' ? [1, 2, 3] : operation === 'remove' ? [2] : [];
					assert.deepStrictEqual(executor.getBreakpoints().map(bp => bp.line), lines);
					if (ending === 'terminated' || ending === 'exited') {
						assert.deepStrictEqual(await recordedUpdates(), [update([1, 2])], 'no offline DAP synchronization');
					}

					await executor.startDebugging(directory, config);
					assert.deepStrictEqual(await recordedUpdates(), lines.length ? [update(lines)] : []);
					await executor.addBreakpoint(sourcePath, 4);
					assert.deepStrictEqual(await recordedUpdates(),
						[...(lines.length ? [update(lines)] : []), update([...lines, 4])]);
				});
			}
		}

		test('all breakpoint edits still synchronize immediately in an active session', async () => {
			await executor.startDebugging(directory, config);
			await executor.addBreakpoint(sourcePath, 1, 'count > 2', 'count={count}');
			await executor.removeBreakpoint(sourcePath, 1);
			await executor.addBreakpoint(sourcePath, 2);
			await executor.clearAllBreakpoints();
			assert.deepStrictEqual(await recordedUpdates(), [
				{ ...update([]), breakpoints: [{ line: 1, condition: 'count > 2', logMessage: 'count={count}' }] },
				update([]), update([2]), update([])
			]);
		});
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
		case 'stepIn':
			respond(request);
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
		assert.notStrictEqual(steppedState.stopSequence, state.stopSequence);

		const handler = new DebuggingHandler(executor, {} as IDebugConfigurationManager, 3);
		for (const operation of ['handleStepOver', 'handleStepInto'] as const) {
			const started = Date.now();
			const repeatedStep = await handler[operation]();
			assert.strictEqual(repeatedStep, steppedState.toString());
			assert.ok(Date.now() - started < 2_000, 'unchanged CLI frames must not cause a second wait');
		}
		await executor.continue();
		const continuedState = await executor.getCurrentDebugState();
		assert.strictEqual(continuedState.currentLine, 4);
		await executor.stopDebugging();
	});

	test('reports launch rejection without waiting for initialized', async () => {
		const sourcePath = path.join(directory, 'app.fake');
		const adapterPath = path.join(directory, 'rejecting-adapter.js');
		await fs.promises.writeFile(sourcePath, 'run();\n', 'utf8');
		await fs.promises.writeFile(adapterPath, `
let buffer = Buffer.alloc(0);
let sequence = 1;
function send(message) {
	const payload = Buffer.from(JSON.stringify({ seq: sequence++, ...message }));
	process.stdout.write('Content-Length: ' + payload.length + '\\r\\n\\r\\n');
	process.stdout.write(payload);
}
process.stdin.on('data', chunk => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
		if (headerEnd < 0) return;
		const length = Number(/Content-Length:\\s*(\\d+)/i.exec(
			buffer.subarray(0, headerEnd).toString('ascii')
		)[1]);
		const start = headerEnd + 4;
		if (buffer.length < start + length) return;
		const request = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
		buffer = buffer.subarray(start + length);
		if (request.command === 'initialize') {
			send({
				type: 'response',
				request_seq: request.seq,
				command: request.command,
				success: true,
				body: {}
			});
		} else if (request.command === 'launch') {
			send({
				type: 'response',
				request_seq: request.seq,
				command: request.command,
				success: false,
				message: 'invalid launch target'
			});
		}
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
		const startedAt = Date.now();
		await assert.rejects(
			() => executor.startDebugging(directory, config),
			/invalid launch target/
		);
		assert.ok(Date.now() - startedAt < 5_000);
		await executor.dispose();
	});
});
