// Copyright (c) Microsoft Corporation.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { AgentInfo, getSupportedAgents } from '../utils/agentCatalog';
import { selectCopilotDebugMcpHost } from './copilotMcpConfig';

export async function selectAgentsInteractively(): Promise<AgentInfo[]> {
	const agents = getSupportedAgents();
	if (!stdin.isTTY || !stdout.isTTY) {
		throw new Error(
			'Agent selection requires an interactive terminal. ' +
			'Use one or more --agent <id> options in non-interactive environments.'
		);
	}
	stdout.write('Choose AI agents to configure with the standalone DebugMCP CLI:\n\n');
	agents.forEach((agent, index) => {
		stdout.write(`  ${index + 1}. ${agent.displayName} (${agent.id})\n`);
	});
	const prompt = createInterface({ input: stdin, output: stdout });
	try {
		const answer = await prompt.question('\nEnter numbers or IDs separated by commas: ');
		return resolveAgentSelections(answer.split(',').map(value => value.trim()), agents);
	} finally {
		prompt.close();
	}
}

export function resolveAgentSelections(
	selections: string[],
	agents = getSupportedAgents()
): AgentInfo[] {
	const selected = selections
		.filter(Boolean)
		.map(selection => {
			const number = Number(selection);
			const agent = Number.isInteger(number) && number >= 1 && number <= agents.length
				? agents[number - 1]
				: agents.find(candidate => candidate.id === selection);
			if (!agent) {
				throw new Error(
					`Unknown agent '${selection}'. Valid IDs: ${agents.map(candidate => candidate.id).join(', ')}`
				);
			}
			return agent;
		});
	if (selected.length === 0) {
		throw new Error('Select at least one agent.');
	}
	return [...new Map(selected.map(agent => [agent.id, agent])).values()];
}

export async function configureCliForAgent(
	agent: AgentInfo,
	command: string,
	args: string[]
): Promise<void> {
	if (agent.id === 'copilot-cli') {
		await selectCopilotDebugMcpHost(agent.configPath, {
			type: 'stdio',
			command,
			args,
			tools: ['*']
		});
		return;
	}
	if (agent.configFormat === 'json') {
		await upsertJsonStdioServer(agent, command, args);
		return;
	}
	await upsertCodexStdioServer(agent.configPath, command, args);
}

async function upsertJsonStdioServer(
	agent: Extract<AgentInfo, { configFormat: 'json' }>,
	command: string,
	args: string[]
): Promise<void> {
	let config: Record<string, any> = {};
	try {
		config = JSON.parse(await fs.promises.readFile(agent.configPath, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new Error(`Cannot read ${agent.configPath}: ${error}`);
		}
	}
	if (!config[agent.mcpServerFieldName] ||
		typeof config[agent.mcpServerFieldName] !== 'object' ||
		Array.isArray(config[agent.mcpServerFieldName])) {
		config[agent.mcpServerFieldName] = {};
	}
	config[agent.mcpServerFieldName].debugmcp = {
		type: 'stdio',
		command,
		args
	};
	await writeAtomic(agent.configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function upsertCodexStdioServer(
	configPath: string,
	command: string,
	args: string[]
): Promise<void> {
	let content = '';
	try {
		content = await fs.promises.readFile(configPath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new Error(`Cannot read ${configPath}: ${error}`);
		}
	}
	const normalized = content.replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	const header = '[mcp_servers.debugmcp]';
	const start = lines.findIndex(line => line.trim() === header);
	const escapedCommand = escapeToml(command);
	const renderedArgs = args.map(arg => `"${escapeToml(arg)}"`).join(', ');
	const fields = [`command = "${escapedCommand}"`, `args = [${renderedArgs}]`];
	if (start < 0) {
		const separator = normalized.length === 0 ? '' : normalized.endsWith('\n') ? '\n' : '\n\n';
		content = `${normalized}${separator}${header}\n${fields.join('\n')}\n`;
	} else {
		let end = start + 1;
		while (end < lines.length && !/^\s*\[/.test(lines[end])) {
			end++;
		}
		const retained = lines.slice(start + 1, end)
			.filter(line => !/^\s*(?:url|command|args)\s*=/.test(line));
		lines.splice(start + 1, end - start - 1, ...fields, ...retained);
		content = lines.join('\n');
	}
	await writeAtomic(configPath, content);
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	await fs.promises.writeFile(temporaryPath, content, 'utf8');
	await fs.promises.rename(temporaryPath, filePath);
}

function escapeToml(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
