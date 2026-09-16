// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readCopilotDebugMcpHost,
	selectCopilotDebugMcpHost
} from '../cli/copilotMcpConfig';

suite('Copilot CLI DebugMCP host selection', () => {
	let directory: string;
	let configPath: string;

	setup(async () => {
		directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'debugmcp-host-'));
		configPath = path.join(directory, 'mcp-config.json');
		await fs.promises.writeFile(configPath, JSON.stringify({
			mcpServers: {
				other: { type: 'stdio', command: 'other', args: [] },
				debugmcp: { type: 'http', url: 'http://localhost:3001/mcp', tools: ['*'] }
			},
			unrelated: true
		}), 'utf8');
		await fs.promises.writeFile(path.join(directory, 'settings.json'), JSON.stringify({
			disabledMcpServers: ['other', 'debugmcp']
		}), 'utf8');
	});

	teardown(async () => {
		await fs.promises.rm(directory, { recursive: true, force: true });
	});

	test('selecting CLI replaces the complete VS Code registration', async () => {
		await selectCopilotDebugMcpHost(configPath, {
			type: 'stdio',
			command: 'node',
			args: ['debugmcp.js', 'serve', '--stdio'],
			tools: ['*']
		});
		const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
		assert.deepStrictEqual(config.mcpServers.debugmcp, {
			type: 'stdio',
			command: 'node',
			args: ['debugmcp.js', 'serve', '--stdio'],
			tools: ['*']
		});
		assert.deepStrictEqual(config.mcpServers.other, {
			type: 'stdio',
			command: 'other',
			args: []
		});
		assert.strictEqual(config.unrelated, true);
		assert.ok(!('url' in config.mcpServers.debugmcp));
		assert.deepStrictEqual(
			JSON.parse(await fs.promises.readFile(path.join(directory, 'settings.json'), 'utf8')),
			{ disabledMcpServers: ['other'] }
		);
	});

	test('selecting VS Code replaces the complete CLI registration', async () => {
		await selectCopilotDebugMcpHost(configPath, {
			type: 'stdio',
			command: 'node',
			args: ['debugmcp.js', 'serve', '--stdio'],
			tools: ['*']
		});
		await selectCopilotDebugMcpHost(configPath, {
			type: 'http',
			url: 'http://localhost:4317/mcp',
			tools: ['*']
		});
		assert.deepStrictEqual(await readCopilotDebugMcpHost(configPath), {
			type: 'http',
			url: 'http://localhost:4317/mcp',
			tools: ['*']
		});
	});

	test('rejects registrations that mix HTTP and stdio fields', async () => {
		await fs.promises.writeFile(configPath, JSON.stringify({
			mcpServers: {
				debugmcp: {
					type: 'stdio',
					command: 'node',
					args: [],
					tools: ['*'],
					url: 'http://localhost:3001/mcp'
				}
			}
		}), 'utf8');
		await assert.rejects(
			() => readCopilotDebugMcpHost(configPath),
			/cannot contain url/
		);
	});
});
