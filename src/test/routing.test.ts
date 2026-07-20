// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ControlServer } from '../controlServer';
import { RoutingDebuggingHandler } from '../routingDebuggingHandler';
import { WorkspaceRegistry } from '../utils/workspaceRegistry';
import { IDebuggingHandler } from '../debuggingHandler';

/** Records every op it receives and echoes a tagged response. */
class RecordingHandler implements IDebuggingHandler {
	public calls: Array<{ op: string; args: unknown }> = [];
	constructor(private readonly tag: string) {}

	private record<T>(op: string, args: unknown): Promise<string> {
		this.calls.push({ op, args });
		return Promise.resolve(`${this.tag}:${op}`);
	}
	handleStartDebugging(args: any) { return this.record('start', args); }
	handleStopDebugging() { return this.record('stop', {}); }
	handleStepOver() { return this.record('stepOver', {}); }
	handleStepInto() { return this.record('stepInto', {}); }
	handleStepOut() { return this.record('stepOut', {}); }
	handleContinue() { return this.record('continue', {}); }
	handlePause() { return this.record('pause', {}); }
	handleRestart() { return this.record('restart', {}); }
	handleAddBreakpoint(args: any) { return this.record('addBp', args); }
	handleRemoveBreakpoint(args: any) { return this.record('removeBp', args); }
	handleClearAllBreakpoints() { return this.record('clearBp', {}); }
	handleListBreakpoints() { return this.record('listBp', {}); }
	handleGetVariables(args: any) { return this.record('vars', args); }
	handleEvaluateExpression(args: any) { return this.record('eval', args); }
}

suite('Multi-window routing', () => {
	let dir: string;
	const servers: ControlServer[] = [];

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debugmcp-routing-test-'));
	});

	teardown(async () => {
		await Promise.all(servers.splice(0).map(s => s.stop()));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	async function startWindow(
		fileName: string,
		workspaceFolders: string[],
		handler: RecordingHandler,
		token = 'secret'
	): Promise<void> {
		const server = new ControlServer(handler, token);
		servers.push(server);
		const port = await server.start();
		fs.writeFileSync(
			path.join(dir, fileName),
			JSON.stringify({
				pid: process.pid,
				controlPort: port,
				controlToken: token,
				workspaceFolders,
				name: fileName,
				updatedAt: Date.now()
			}),
			'utf8'
		);
	}

	test('routes start_debugging to the window owning the workingDirectory', async () => {
		const repoA = path.join(dir, 'repoA');
		const repoB = path.join(dir, 'repoB');
		const handlerA = new RecordingHandler('A');
		const handlerB = new RecordingHandler('B');
		await startWindow('a.json', [repoA], handlerA);
		await startWindow('b.json', [repoB], handlerB);

		const routing = new RoutingDebuggingHandler(new WorkspaceRegistry(process.pid, dir));
		const result = await routing.handleStartDebugging({
			fileFullPath: path.join(repoB, 'src', 'x.py'),
			workingDirectory: repoB
		});

		assert.strictEqual(result, 'B:start');
		assert.strictEqual(handlerB.calls.length, 1);
		assert.strictEqual(handlerA.calls.length, 0, 'the other window must not be touched');
	});

	test('remembers the target for hint-less follow-up calls (session affinity)', async () => {
		const repoA = path.join(dir, 'repoA');
		const handlerA = new RecordingHandler('A');
		await startWindow('a.json', [repoA], handlerA);

		const routing = new RoutingDebuggingHandler(new WorkspaceRegistry(process.pid, dir));
		await routing.handleStartDebugging({ fileFullPath: path.join(repoA, 'm.py'), workingDirectory: repoA });
		const stepped = await routing.handleStepOver();
		const vars = await routing.handleGetVariables({ scope: 'local' });

		assert.strictEqual(stepped, 'A:stepOver');
		assert.strictEqual(vars, 'A:vars');
		assert.deepStrictEqual(handlerA.calls.map(c => c.op), ['start', 'stepOver', 'vars']);
	});

	test('add_breakpoint routes by fileFullPath before any start_debugging', async () => {
		const repoA = path.join(dir, 'repoA');
		const repoB = path.join(dir, 'repoB');
		const handlerA = new RecordingHandler('A');
		const handlerB = new RecordingHandler('B');
		await startWindow('a.json', [repoA], handlerA);
		await startWindow('b.json', [repoB], handlerB);

		const routing = new RoutingDebuggingHandler(new WorkspaceRegistry(process.pid, dir));
		const result = await routing.handleAddBreakpoint({
			fileFullPath: path.join(repoA, 'src', 'y.py'),
			line: 1
		});

		assert.strictEqual(result, 'A:addBp');
		assert.strictEqual(handlerB.calls.length, 0);
	});

	test('throws a helpful error when no window owns the path', async () => {
		const repoA = path.join(dir, 'repoA');
		const repoB = path.join(dir, 'repoB');
		await startWindow('a.json', [repoA], new RecordingHandler('A'));
		await startWindow('b.json', [repoB], new RecordingHandler('B'));

		const routing = new RoutingDebuggingHandler(new WorkspaceRegistry(process.pid, dir));
		await assert.rejects(
			() => routing.handleStartDebugging({
				fileFullPath: path.join(dir, 'repoC', 'z.py'),
				workingDirectory: path.join(dir, 'repoC')
			}),
			/could not find an open VS Code window/i
		);
	});

	test('hint-less call without an established target throws', async () => {
		const routing = new RoutingDebuggingHandler(new WorkspaceRegistry(process.pid, dir));
		await assert.rejects(() => routing.handleStepOver(), /no active debug target/i);
	});

	test('control server rejects requests with a wrong token', async () => {
		const repoA = path.join(dir, 'repoA');
		await startWindow('a.json', [repoA], new RecordingHandler('A'), 'right-token');

		// Overwrite the registry entry with a bad token to simulate a mismatch.
		const file = path.join(dir, 'a.json');
		const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
		entry.controlToken = 'wrong-token';
		fs.writeFileSync(file, JSON.stringify(entry), 'utf8');

		const routing = new RoutingDebuggingHandler(new WorkspaceRegistry(process.pid, dir));
		await assert.rejects(
			() => routing.handleStartDebugging({ fileFullPath: path.join(repoA, 'm.py'), workingDirectory: repoA }),
			/HTTP 403/
		);
	});
});
