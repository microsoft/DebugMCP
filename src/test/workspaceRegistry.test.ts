// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceRegistry, WindowRegistration } from '../utils/workspaceRegistry';

/**
 * Unit tests for the shared multi-window registry: registration, listing,
 * pruning of dead/stale windows, and workspace -> window resolution.
 */
suite('WorkspaceRegistry', () => {
	let dir: string;

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debugmcp-registry-test-'));
	});

	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const folder = (name: string) => path.join(dir, name);

	function seed(pid: number, workspaceFolders: string[], controlPort: number): void {
		const reg = new WorkspaceRegistry(pid, dir);
		reg.register({ controlPort, controlToken: `token-${pid}`, workspaceFolders, name: `w${pid}` });
	}

	// Write a second live entry under a distinct filename (reuses this live pid
	// so list() keeps it) to simulate a second open window.
	function writeExtraEntry(fileName: string, workspaceFolders: string[], controlPort: number): void {
		const entry: WindowRegistration = {
			pid: process.pid,
			controlPort,
			controlToken: `t-${controlPort}`,
			workspaceFolders,
			name: fileName,
			updatedAt: Date.now()
		};
		fs.writeFileSync(path.join(dir, fileName), JSON.stringify(entry), 'utf8');
	}

	test('register then list returns the live entry', () => {
		const reg = new WorkspaceRegistry(process.pid, dir);
		reg.register({ controlPort: 1234, controlToken: 't', workspaceFolders: [folder('repoA')], name: 'A' });

		const entries = reg.list();
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].controlPort, 1234);
		assert.strictEqual(entries[0].pid, process.pid);
	});

	test('unregister removes the entry', () => {
		const reg = new WorkspaceRegistry(process.pid, dir);
		reg.register({ controlPort: 1, controlToken: 't', workspaceFolders: [], name: 'A' });
		reg.unregister();
		assert.strictEqual(reg.list().length, 0);
	});

	test('list prunes entries whose process is dead', () => {
		// A pid that is virtually certain not to exist.
		seed(2147483646, [folder('ghost')], 9999);
		const reg = new WorkspaceRegistry(process.pid, dir);
		assert.strictEqual(reg.list().length, 0);
		// The stale file should have been removed.
		assert.strictEqual(fs.readdirSync(dir).length, 0);
	});

	test('findByPath resolves a file inside a workspace folder', () => {
		seed(process.pid, [folder('repoA')], 5001);

		const reg = new WorkspaceRegistry(process.pid, dir);
		const found = reg.findByPath(path.join(folder('repoA'), 'src', 'main.py'));
		assert.ok(found);
		assert.strictEqual(found!.controlPort, 5001);
	});

	test('findByPath falls back only to a sole window that declares no folders', () => {
		writeExtraEntry('window-empty.json', [], 5001);
		const reg = new WorkspaceRegistry(process.pid, dir);
		const found = reg.findByPath(path.join(dir, 'unrelated', 'file.ts'));
		assert.ok(found, 'a sole no-folder window is used as fallback');
		assert.strictEqual(found!.controlPort, 5001);
	});

	test('findByPath does NOT guess a folder-bearing window for a path it does not contain', () => {
		// Regression: a single unrelated window must not capture a foreign path,
		// which previously opened files in the wrong workspace.
		seed(process.pid, [folder('repoA')], 5001);
		const reg = new WorkspaceRegistry(process.pid, dir);
		const found = reg.findByPath(path.join(dir, 'repoB', 'file.ts'));
		assert.strictEqual(found, undefined);
	});

	test('findByPath returns undefined when no folder matches and multiple windows are open', () => {
		seed(process.pid, [folder('repoA')], 5001);
		writeExtraEntry('window-extra.json', [folder('repoB')], 5002);

		const reg = new WorkspaceRegistry(process.pid, dir);
		const found = reg.findByPath(path.join(dir, 'repoC', 'file.ts'));
		assert.strictEqual(found, undefined);
	});

	test('findByPath picks the deepest matching folder across windows', () => {
		seed(process.pid, [folder('outer')], 6001);
		writeExtraEntry('window-extra.json', [path.join(folder('outer'), 'nested')], 6002);

		const reg = new WorkspaceRegistry(process.pid, dir);
		const found = reg.findByPath(path.join(folder('outer'), 'nested', 'deep', 'x.ts'));
		assert.ok(found);
		assert.strictEqual(found!.controlPort, 6002, 'should pick the deepest (nested) window');
	});
});
