// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	configureCliForAgent,
	resolveAgentSelections
} from '../cli/agentSelector';
import { AgentInfo, getSupportedAgents } from '../utils/agentCatalog';

suite('CLI agent selector', () => {
	let directory: string;

	setup(async () => {
		directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'debugmcp-selector-'));
	});

	teardown(async () => {
		await fs.promises.rm(directory, { recursive: true, force: true });
	});

	test('uses the same agent catalog as the extension popup', () => {
		const agents = getSupportedAgents();
		assert.deepStrictEqual(
			agents.map(agent => agent.id),
			['cline', 'roo', 'copilot', 'copilot-cli', 'cursor', 'antigravity', 'claude-code', 'codex']
		);
		assert.deepStrictEqual(
			resolveAgentSelections(['4', 'codex'], agents).map(agent => agent.id),
			['copilot-cli', 'codex']
		);
	});

	test('writes an exclusive stdio entry for a selected JSON agent', async () => {
		const agent: AgentInfo = {
			id: 'test',
			name: 'test',
			displayName: 'Test Agent',
			configPath: path.join(directory, 'mcp.json'),
			configFormat: 'json',
			mcpServerFieldName: 'mcpServers'
		};
		await fs.promises.writeFile(agent.configPath, JSON.stringify({
			mcpServers: {
				debugmcp: { type: 'http', url: 'http://localhost:3001/mcp' },
				other: { command: 'other' }
			}
		}), 'utf8');

		await configureCliForAgent(agent, 'node', ['debugmcp.js', 'serve', '--stdio']);
		const config = JSON.parse(await fs.promises.readFile(agent.configPath, 'utf8'));
		assert.deepStrictEqual(config.mcpServers.debugmcp, {
			type: 'stdio',
			command: 'node',
			args: ['debugmcp.js', 'serve', '--stdio']
		});
		assert.deepStrictEqual(config.mcpServers.other, { command: 'other' });
	});

	test('replaces a Codex URL with command and args', async () => {
		const configPath = path.join(directory, 'config.toml');
		await fs.promises.writeFile(configPath,
			'[mcp_servers.debugmcp]\nurl = "http://localhost:3001/mcp"\n\n[other]\nvalue = true\n',
			'utf8'
		);
		await configureCliForAgent({
			id: 'codex',
			name: 'codex',
			displayName: 'Codex',
			configPath,
			configFormat: 'toml'
		}, 'node', ['debugmcp.js', 'serve', '--stdio']);
		const content = await fs.promises.readFile(configPath, 'utf8');
		assert.match(content, /command = "node"/);
		assert.match(content, /args = \["debugmcp.js", "serve", "--stdio"\]/);
		assert.doesNotMatch(content, /url\s*=/);
		assert.match(content, /\[other\]\nvalue = true/);
	});
});
