// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
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
