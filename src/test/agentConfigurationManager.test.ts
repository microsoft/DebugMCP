// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import { upsertCodexDebugMCPConfig } from '../utils/agentConfigurationManager';

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
