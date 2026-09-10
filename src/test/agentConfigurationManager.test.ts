// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AgentConfigurationManager,
    JsonAgentInfo,
    upsertCodexDebugMCPConfig,
    upsertJsonDebugMCPConfigFile
} from '../utils/agentConfigurationManager';

suite('AgentConfigurationManager JSON configuration', () => {
    test('upsertJsonDebugMCPConfigFile should preserve an existing file if it contains malformed JSON', async () => {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'debugmcp-agent-config-'));
        const configPath = path.join(tempDir, 'mcp.json');
        const malformedConfig = '{\n  "servers": {\n    "other": true,\n';
        await fs.promises.writeFile(configPath, malformedConfig, 'utf8');

        try {
            await assert.rejects(
                upsertJsonDebugMCPConfigFile(configPath, 'servers', {
                    type: 'streamableHttp',
                    url: 'http://localhost:3001/mcp'
                }),
                SyntaxError
            );
            assert.strictEqual(await fs.promises.readFile(configPath, 'utf8'), malformedConfig);
        } finally {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    });
});

suite('AgentConfigurationManager Claude Code configuration', () => {
	const serverPort = 4317;
	const expectedEntry = { type: 'http', url: `http://localhost:${serverPort}/mcp` };
	const unrelatedConfig = {
		theme: 'dark',
		projects: {
			'/sample/project': {
				hasTrustDialogAccepted: true,
				mcpServers: {
					debugmcp: { type: 'http', url: 'http://localhost:9876/mcp' },
					projectServer: { command: 'sample', args: ['--project'] }
				}
			}
		}
	};
	const otherServer = { type: 'http', url: 'https://other.example/mcp' };
	const originalWriteFile = fs.promises.writeFile;
	const originalShowInformationMessage = vscode.window.showInformationMessage;
	let tempDir: string;
	let manager: AgentConfigurationManager;
	let supportedAgent: JsonAgentInfo;
	let agent: JsonAgentInfo;
	let writes: number;
	let notifications: string[];

	setup(async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'debugmcp-claude-config-'));
		manager = new AgentConfigurationManager({ extensionPath: tempDir } as vscode.ExtensionContext, 180, serverPort);
		const agents = await manager['getSupportedAgents']();
		const claudeCode = agents.find(candidate => candidate.id === 'claude-code');
		assert.ok(claudeCode && claudeCode.configFormat === 'json');
		supportedAgent = claudeCode;
		agent = { ...supportedAgent, configPath: path.join(tempDir, '.claude.json') };
		// Exercise the real setup and migration paths using only the temporary config.
		manager['getSupportedAgents'] = async () => [agent];
		manager['installDebugMCPSkill'] = async () => null;
		writes = 0;
		notifications = [];
		fs.promises.writeFile = async (...args: Parameters<typeof originalWriteFile>) => {
			if (args[0] === agent.configPath) {
				writes++;
			}
			return originalWriteFile(...args);
		};
		vscode.window.showInformationMessage = async (message: string) => {
			notifications.push(message);
			return undefined;
		};
	});

	teardown(async () => {
		fs.promises.writeFile = originalWriteFile;
		vscode.window.showInformationMessage = originalShowInformationMessage;
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	});

	test('uses the user-scoped Claude Code configuration location', () => {
		assert.strictEqual(supportedAgent.configPath, path.join(os.homedir(), '.claude.json'));
		assert.strictEqual(supportedAgent.mcpServerFieldName, 'mcpServers');
	});

	test('setup generates only the Claude Code HTTP fields using the configured port', async () => {
		const result = await manager['addDebugMCPToAgent'](agent);

		assert.strictEqual(result.success, true);
		assert.deepStrictEqual(JSON.parse(await fs.promises.readFile(agent.configPath, 'utf8')), {
			mcpServers: { debugmcp: expectedEntry }
		});
		assert.strictEqual(writes, 1);
	});

	for (const hasUserServers of [false, true]) {
		test(`setup preserves unrelated settings with ${hasUserServers ? 'existing' : 'no'} user-scoped servers`, async () => {
			const existingServers = hasUserServers ? { other: otherServer } : {};
			const initial = {
				...unrelatedConfig,
				...(hasUserServers ? { mcpServers: existingServers } : {})
			};
			await originalWriteFile(agent.configPath, JSON.stringify(initial), 'utf8');

			const result = await manager['addDebugMCPToAgent'](agent);

			assert.strictEqual(result.success, true);
			assert.deepStrictEqual(JSON.parse(await fs.promises.readFile(agent.configPath, 'utf8')), {
				...unrelatedConfig,
				mcpServers: { ...existingServers, debugmcp: expectedEntry }
			});
			assert.strictEqual(writes, 1);
		});
	}

	for (const type of ['http', 'streamable-http']) {
		for (const url of [expectedEntry.url, 'https://custom.example:4443/debug/mcp']) {
			test(`migration does not rewrite or notify for ${type} at ${url}`, async () => {
				const content = JSON.stringify({
					...unrelatedConfig,
					mcpServers: {
						other: otherServer,
						debugmcp: { type, url, headers: { 'X-Test': 'synthetic-value' } }
					}
				});
				await originalWriteFile(agent.configPath, content, 'utf8');

				for (let run = 0; run < 2; run++) {
					await manager.migrateExistingConfigurations();

					assert.strictEqual(await fs.promises.readFile(agent.configPath, 'utf8'), content);
					assert.strictEqual(writes, 0);
					assert.deepStrictEqual(notifications, []);
				}
			});
		}
	}

	for (const legacyEntry of [
		{ type: 'sse', url: 'http://localhost:3001/sse' },
		{ type: 'sse', url: 'http://localhost:3001/mcp' },
		{ type: 'http', url: 'http://localhost:3001/sse' },
		{ type: 'streamable-http', url: 'http://localhost:3001/sse' }
	]) {
		test(`migrates ${legacyEntry.type} at ${legacyEntry.url} only once and preserves unrelated settings`, async () => {
			await originalWriteFile(agent.configPath, JSON.stringify({
				...unrelatedConfig,
				mcpServers: { other: otherServer, debugmcp: legacyEntry }
			}), 'utf8');

			await manager.migrateExistingConfigurations();

			const migratedContent = await fs.promises.readFile(agent.configPath, 'utf8');
			assert.deepStrictEqual(JSON.parse(migratedContent), {
				...unrelatedConfig,
				mcpServers: { other: otherServer, debugmcp: expectedEntry }
			});
			assert.strictEqual(writes, 1);
			assert.deepStrictEqual(notifications, [
				'DebugMCP: Migrated 1 agent configuration(s) to use the new transport protocol.'
			]);

			await manager.migrateExistingConfigurations();

			assert.strictEqual(await fs.promises.readFile(agent.configPath, 'utf8'), migratedContent);
			assert.strictEqual(writes, 1);
			assert.strictEqual(notifications.length, 1);
		});
	}

	test('still leaves a valid Copilot CLI HTTP entry unchanged', async () => {
		agent = { ...agent, id: 'copilot-cli' };
		const content = JSON.stringify({ mcpServers: { debugmcp: { ...expectedEntry, tools: ['*'] } } });
		await originalWriteFile(agent.configPath, content, 'utf8');

		await manager.migrateExistingConfigurations();

		assert.strictEqual(await fs.promises.readFile(agent.configPath, 'utf8'), content);
		assert.strictEqual(writes, 0);
		assert.deepStrictEqual(notifications, []);
	});

	test('still migrates a Cline HTTP entry and preserves custom autoApprove settings', async () => {
		agent = { ...agent, id: 'cline' };
		const autoApprove = ['list_breakpoints'];
		await originalWriteFile(agent.configPath, JSON.stringify({
			mcpServers: { debugmcp: { ...expectedEntry, autoApprove } }
		}), 'utf8');

		await manager.migrateExistingConfigurations();
		await manager.migrateExistingConfigurations();

		assert.deepStrictEqual(JSON.parse(await fs.promises.readFile(agent.configPath, 'utf8')), {
			mcpServers: {
				debugmcp: { ...expectedEntry, type: 'streamableHttp', autoApprove, disabled: false, timeout: 180 }
			}
		});
		assert.strictEqual(writes, 1);
		assert.strictEqual(notifications.length, 1);
	});
});

suite('AgentConfigurationManager Codex TOML configuration', () => {
    const mcpServerUrl = 'http://localhost:3001/mcp';

    test('upsertCodexDebugMCPConfig should create config from empty content', () => {
        const result = upsertCodexDebugMCPConfig('', mcpServerUrl);

        assert.strictEqual(result, `[mcp_servers.debugmcp]
url = "${mcpServerUrl}"
`);
    });

    test('upsertCodexDebugMCPConfig should preserve unrelated TOML content', () => {
        const existingConfig = `model = "gpt-5.4"

[profiles.default]
sandbox = "workspace-write"
`;

        const result = upsertCodexDebugMCPConfig(existingConfig, mcpServerUrl);

        assert.strictEqual(result, `${existingConfig}
[mcp_servers.debugmcp]
url = "${mcpServerUrl}"
`);
    });

    test('upsertCodexDebugMCPConfig should update an existing DebugMCP URL', () => {
        const existingConfig = `[mcp_servers.debugmcp]
url = "http://localhost:3002/mcp"
`;

        const result = upsertCodexDebugMCPConfig(existingConfig, mcpServerUrl);

        assert.strictEqual(result, `[mcp_servers.debugmcp]
url = "${mcpServerUrl}"
`);
    });

    test('upsertCodexDebugMCPConfig should add URL to an existing DebugMCP section', () => {
        const existingConfig = `[mcp_servers.debugmcp]
tool_timeout_sec = 180

[mcp_servers.other]
url = "http://localhost:4000/mcp"
`;

        const result = upsertCodexDebugMCPConfig(existingConfig, mcpServerUrl);

        assert.strictEqual(result, `[mcp_servers.debugmcp]
url = "${mcpServerUrl}"
tool_timeout_sec = 180

[mcp_servers.other]
url = "http://localhost:4000/mcp"
`);
    });

    test('upsertCodexDebugMCPConfig should preserve unrelated MCP server sections', () => {
        const existingConfig = `[mcp_servers.other]
url = "http://localhost:4000/mcp"
`;

        const result = upsertCodexDebugMCPConfig(existingConfig, mcpServerUrl);

        assert.strictEqual(result, `${existingConfig}
[mcp_servers.debugmcp]
url = "${mcpServerUrl}"
`);
    });

    test('upsertCodexDebugMCPConfig should migrate an existing SSE URL', () => {
        const existingConfig = `[mcp_servers.debugmcp]
url = "http://localhost:3001/sse"
`;

        const result = upsertCodexDebugMCPConfig(existingConfig, mcpServerUrl);

        assert.strictEqual(result, `[mcp_servers.debugmcp]
url = "${mcpServerUrl}"
`);
    });
});
