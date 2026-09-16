// Copyright (c) Microsoft Corporation.

import * as os from 'node:os';
import * as path from 'node:path';

export interface BaseAgentInfo {
	id: string;
	name: string;
	displayName: string;
	configPath: string;
	configFormat: 'json' | 'toml';
}

export interface JsonAgentInfo extends BaseAgentInfo {
	configFormat: 'json';
	mcpServerFieldName: string;
}

export interface TomlAgentInfo extends BaseAgentInfo {
	configFormat: 'toml';
}

export type AgentInfo = JsonAgentInfo | TomlAgentInfo;

export function getSupportedAgents(): AgentInfo[] {
	const configBasePath = getConfigBasePath();
	return [
		{
			id: 'cline',
			name: 'cline',
			displayName: 'Cline',
			configPath: path.join(configBasePath, 'Code', 'User', 'globalStorage',
				'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
			configFormat: 'json',
			mcpServerFieldName: 'mcpServers'
		},
		{
			id: 'roo',
			name: 'roo',
			displayName: 'Roo Code',
			configPath: path.join(configBasePath, 'Code', 'User', 'globalStorage',
				'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
			configFormat: 'json',
			mcpServerFieldName: 'mcpServers'
		},
		{
			id: 'copilot',
			name: 'copilot',
			displayName: 'GitHub Copilot',
			configPath: path.join(configBasePath, 'Code', 'User', 'mcp.json'),
			configFormat: 'json',
			mcpServerFieldName: 'servers'
		},
		{
			id: 'copilot-cli',
			name: 'copilot-cli',
			displayName: 'GitHub Copilot CLI',
			configPath: path.join(
				process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'),
				'mcp-config.json'
			),
			configFormat: 'json',
			mcpServerFieldName: 'mcpServers'
		},
		{
			id: 'cursor',
			name: 'cursor',
			displayName: 'Cursor',
			configPath: path.join(configBasePath, 'Cursor', 'User', 'globalStorage',
				'cursor.mcp', 'settings', 'mcp_settings.json'),
			configFormat: 'json',
			mcpServerFieldName: 'mcpServers'
		},
		{
			id: 'antigravity',
			name: 'antigravity',
			displayName: 'Antigravity',
			configPath: path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
			configFormat: 'json',
			mcpServerFieldName: 'mcpServers'
		},
		{
			id: 'claude-code',
			name: 'claude-code',
			displayName: 'Claude Code',
			configPath: path.join(os.homedir(), '.claude.json'),
			configFormat: 'json',
			mcpServerFieldName: 'mcpServers'
		},
		{
			id: 'codex',
			name: 'codex',
			displayName: 'Codex',
			configPath: path.join(
				process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
				'config.toml'
			),
			configFormat: 'toml'
		}
	];
}

function getConfigBasePath(): string {
	const userHome = os.homedir();
	switch (process.platform) {
		case 'win32':
			return process.env.APPDATA || path.join(userHome, 'AppData', 'Roaming');
		case 'darwin':
			return path.join(userHome, 'Library', 'Application Support');
		case 'linux':
			return process.env.XDG_CONFIG_HOME || path.join(userHome, '.config');
		default:
			return process.env.APPDATA || path.join(userHome, 'AppData', 'Roaming');
	}
}
