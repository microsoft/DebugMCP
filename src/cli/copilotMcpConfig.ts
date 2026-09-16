// Copyright (c) Microsoft Corporation.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CopilotStdioMcpServer {
	type: 'stdio';
	command: string;
	args: string[];
	tools: string[];
}

export interface CopilotHttpMcpServer {
	type: 'http';
	url: string;
	tools: string[];
}

export type CopilotDebugMcpServer = CopilotStdioMcpServer | CopilotHttpMcpServer;

interface CopilotMcpConfig {
	mcpServers?: Record<string, unknown>;
	[key: string]: unknown;
}

export function getCopilotMcpConfigPath(): string {
	const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
	return path.join(copilotHome, 'mcp-config.json');
}

export async function selectCopilotDebugMcpHost(
	configPath: string,
	server: CopilotDebugMcpServer
): Promise<void> {
	validateServer(server);
	let config: CopilotMcpConfig = {};
	try {
		const content = await fs.promises.readFile(configPath, 'utf8');
		config = JSON.parse(content) as CopilotMcpConfig;
		if (!config || typeof config !== 'object' || Array.isArray(config)) {
			throw new Error('root value must be an object');
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new Error(`Cannot update Copilot MCP configuration at ${configPath}: ${error}`);
		}
	}

	if (!config.mcpServers || typeof config.mcpServers !== 'object' ||
		Array.isArray(config.mcpServers)) {
		config.mcpServers = {};
	}

	// One canonical name is the exclusivity mechanism: selecting either host
	// replaces the complete entry, so URL and command transports cannot coexist.
	config.mcpServers.debugmcp = server;
	await writeJsonAtomic(configPath, config);
	await enableCopilotDebugMcpServer(path.join(path.dirname(configPath), 'settings.json'));
}

export async function isCopilotDebugMcpServerDisabled(configPath: string): Promise<boolean> {
	const settingsPath = path.join(path.dirname(configPath), 'settings.json');
	try {
		const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')) as {
			disabledMcpServers?: unknown;
		};
		return Array.isArray(settings.disabledMcpServers) &&
			settings.disabledMcpServers.includes('debugmcp');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw new Error(`Cannot read Copilot settings at ${settingsPath}: ${error}`);
	}
}

async function enableCopilotDebugMcpServer(settingsPath: string): Promise<void> {
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return;
		}
		throw new Error(`Cannot update Copilot settings at ${settingsPath}: ${error}`);
	}
	if (!Array.isArray(settings.disabledMcpServers) ||
		!settings.disabledMcpServers.includes('debugmcp')) {
		return;
	}
	settings.disabledMcpServers = settings.disabledMcpServers.filter(
		name => name !== 'debugmcp'
	);
	await writeJsonAtomic(settingsPath, settings);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
	await fs.promises.rename(temporaryPath, filePath);
}

export async function readCopilotDebugMcpHost(
	configPath: string
): Promise<CopilotDebugMcpServer | undefined> {
	try {
		const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8')) as CopilotMcpConfig;
		const server = config.mcpServers?.debugmcp as CopilotDebugMcpServer | undefined;
		if (server) {
			validateServer(server);
		}
		return server;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw new Error(`Cannot read Copilot MCP configuration at ${configPath}: ${error}`);
	}
}

function validateServer(server: CopilotDebugMcpServer): void {
	if (server.type === 'stdio') {
		if (!server.command || !Array.isArray(server.args) || 'url' in server) {
			throw new Error('A CLI DebugMCP registration requires command/args and cannot contain url.');
		}
		return;
	}
	if (server.type === 'http') {
		if (!server.url || 'command' in server || 'args' in server) {
			throw new Error('A VS Code DebugMCP registration requires url and cannot contain command/args.');
		}
		return;
	}
	throw new Error(`Unsupported DebugMCP MCP transport '${(server as { type?: string }).type}'.`);
}
