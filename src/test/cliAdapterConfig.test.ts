// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliConfigurationManager } from '../cli/cliConfigurationManager';
import {
	AdapterConfigFile,
	getProjectConfigPath,
	loadAdapters,
	writeAdapterConfig
} from '../cli/adapterConfig';

suite('CLI adapter configuration', () => {
	let workspace: string;
	let originalAppData: string | undefined;
	let appData: string;

	setup(async () => {
		workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'debugmcp-cli-project-'));
		appData = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'debugmcp-cli-user-'));
		originalAppData = process.env.APPDATA;
		process.env.APPDATA = appData;
	});

	teardown(async () => {
		if (originalAppData === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = originalAppData;
		}
		await fs.promises.rm(workspace, { recursive: true, force: true });
		await fs.promises.rm(appData, { recursive: true, force: true });
	});

	test('starts with no configured adapters', async () => {
		assert.deepStrictEqual(await loadAdapters(workspace), {});
		await assert.rejects(
			() => new CliConfigurationManager().getDebugConfig(
				workspace,
				path.join(workspace, 'app.py')
			),
			/No debug adapter is configured/
		);
	});

	test('resolves an explicitly registered project adapter', async () => {
		const config: AdapterConfigFile = {
			version: 1,
			adapters: {
				python: {
					command: 'python',
					args: ['-m', 'debugpy.adapter'],
					type: 'python',
					extensions: ['.py']
				}
			}
		};
		await writeAdapterConfig(getProjectConfigPath(workspace), config);

		const resolved = await new CliConfigurationManager().getDebugConfig(
			workspace,
			path.join(workspace, 'app.py')
		);
		assert.strictEqual(resolved.adapterName, 'python');
		assert.strictEqual(resolved.adapter.command, 'python');
		assert.strictEqual(resolved.program, path.join(workspace, 'app.py'));
	});

	test('expands a compiled adapter launch target', async () => {
		await writeAdapterConfig(getProjectConfigPath(workspace), {
			version: 1,
			adapters: {
				csharp: {
					command: 'vsdbg',
					type: 'coreclr',
					extensions: ['.cs'],
					launch: {
						program: '${workspaceFolder}\\bin\\Calculator.exe',
						sourceFileMap: {
							'/source': '${fileDirname}'
						}
					}
				}
			}
		});

		const source = path.join(workspace, 'Calculator.cs');
		const resolved = await new CliConfigurationManager().getDebugConfig(workspace, source);
		assert.strictEqual(resolved.program, path.join(workspace, 'bin', 'Calculator.exe'));
		assert.deepStrictEqual(resolved.sourceFileMap, {
			'/source': workspace
		});
	});

	test('requires a name when multiple adapters claim an extension', async () => {
		await writeAdapterConfig(getProjectConfigPath(workspace), {
			version: 1,
			adapters: {
				pythonA: { command: 'python-a', type: 'python', extensions: ['.py'] },
				pythonB: { command: 'python-b', type: 'python', extensions: ['.py'] }
			}
		});

		const manager = new CliConfigurationManager();
		await assert.rejects(
			() => manager.getDebugConfig(workspace, path.join(workspace, 'app.py')),
			/Multiple debug adapters match/
		);
		const resolved = await manager.getDebugConfig(
			workspace,
			path.join(workspace, 'app.py'),
			'pythonB'
		);
		assert.strictEqual(resolved.adapterName, 'pythonB');
	});
});
