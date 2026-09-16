#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.

import { DebugMCPServer } from '../debugMCPServer';
import * as path from 'node:path';
import { DebuggingHandler } from '../debuggingHandler';
import { logger } from '../utils/logger';
import {
	AdapterRegistration,
	getProjectConfigPath,
	getUserConfigPath,
	loadAdapters,
	readAdapterConfig,
	validateAdapter,
	writeAdapterConfig
} from './adapterConfig';
import { CliConfigurationManager } from './cliConfigurationManager';
import { CliDebuggingExecutor } from './cliDebuggingExecutor';
import { DapClient } from './dapClient';
import {
	getCopilotMcpConfigPath,
	isCopilotDebugMcpServerDisabled,
	readCopilotDebugMcpHost,
} from './copilotMcpConfig';
import {
	configureCliForAgent,
	resolveAgentSelections,
	selectAgentsInteractively
} from './agentSelector';
import { getSupportedAgents } from '../utils/agentCatalog';
import { createShorthandAdapter } from './adapterShorthand';
import { ParsedOptions, parseOptions } from './cliOptions';

function first(options: ParsedOptions, name: string): string | undefined {
	return options.values[name]?.[0];
}

function flag(options: ParsedOptions, name: string): boolean {
	return Object.hasOwn(options.values, name);
}

function printHelp(): void {
	process.stdout.write(
		'DebugMCP standalone CLI\n\n' +
		'Usage:\n' +
		'  debugmcp serve [--stdio] [--port 3001] [--timeout 300]\n' +
		'  debugmcp adapter add python --command "python -m debugpy.adapter" [--user]\n' +
		'  debugmcp adapter add <name> --command <path> --type <dap-type> --extensions <.ext...> [--args <arg...>] [--user]\n' +
		'  debugmcp adapter list [--user]\n' +
		'  debugmcp adapter validate <name>\n' +
		'  debugmcp adapter remove <name> [--user]\n\n' +
		'  debugmcp configure [--agent <id>...]\n' +
		'  debugmcp status\n\n' +
		'No debug adapter is configured, selected, downloaded, or installed automatically.\n'
	);
}

async function printStatus(): Promise<void> {
	const configPath = getCopilotMcpConfigPath();
	const current = await readCopilotDebugMcpHost(configPath);
	if (!current) {
		process.stdout.write(`DebugMCP is not registered in ${configPath}\n`);
	} else if (current.type === 'stdio') {
		const disabled = await isCopilotDebugMcpServerDisabled(configPath);
		process.stdout.write(
			`Mode: standalone CLI\nEnabled: ${!disabled}\nTransport: stdio\n` +
			`Command: ${current.command} ${current.args.join(' ')}\n`
		);
	} else {
		process.stdout.write(
			`Mode: VS Code extension\nTransport: http\nURL: ${current.url}\n` +
			'Use the DebugMCP extension to manage this registration.\n'
		);
	}
}

async function configureAgents(args: string[]): Promise<void> {
	const options = parseOptions(args, ['agent']);
	const requestedAgents = options.values.agent ?? [];
	const agents = requestedAgents.length > 0
		? resolveAgentSelections(requestedAgents, getSupportedAgents())
		: await selectAgentsInteractively();
	const command = process.execPath;
	const serverArgs = [path.resolve(process.argv[1]), 'serve', '--stdio'];
	for (const agent of agents) {
		await configureCliForAgent(agent, command, serverArgs);
		process.stdout.write(
			`Configured ${agent.displayName} for the standalone DebugMCP CLI in ${agent.configPath}.\n`
		);
	}
	process.stdout.write('Restart the selected agents to load DebugMCP.\n');
}

async function runAdapterCommand(args: string[]): Promise<void> {
	const action = args[0];
	const options = parseOptions(
		args.slice(1),
		['user', 'command', 'type', 'extensions', 'args', 'launch']
	);
	const name = options.positionals[0];
	const cwd = process.cwd();
	const configPath = flag(options, 'user') ? getUserConfigPath() : getProjectConfigPath(cwd);

	if (action === 'list') {
		const adapters = flag(options, 'user')
			? (await readAdapterConfig(getUserConfigPath())).adapters
			: await loadAdapters(cwd);
		if (Object.keys(adapters).length === 0) {
			process.stdout.write('No debug adapters configured.\n');
			return;
		}
		for (const [adapterName, adapter] of Object.entries(adapters)) {
			process.stdout.write(
				`${adapterName}\t${adapter.type}\t${adapter.command} ${(adapter.args ?? []).join(' ')}\t${adapter.extensions.join(',')}\n`
			);
		}
		return;
	}

	if (!name) {
		throw new Error(`adapter ${action ?? '<action>'} requires an adapter name`);
	}

	if (action === 'add') {
		const commandValues = options.values.command ?? [];
		const type = first(options, 'type');
		const extensions = options.values.extensions ?? [];
		const usesExplicitMetadata = Boolean(type || extensions.length > 0);
		if (commandValues.length === 0) {
			throw new Error('adapter add requires --command');
		}
		if (usesExplicitMetadata && (!type || extensions.length === 0)) {
			throw new Error(
				'explicit adapter registration requires both --type and --extensions'
			);
		}
		const launchText = first(options, 'launch');
		let launch: Record<string, unknown> | undefined;
		if (launchText) {
			const parsed: unknown = JSON.parse(launchText);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new Error('--launch must be a JSON object');
			}
			launch = parsed as Record<string, unknown>;
		}
		const adapter: AdapterRegistration = usesExplicitMetadata
			? {
				command: commandValues[0],
				args: options.values.args ?? [],
				type: type!,
				extensions: extensions.flatMap(value => value.split(',')).map(value =>
					value.startsWith('.') ? value : `.${value}`),
				transport: 'stdio',
				launch
			}
			: {
				...createShorthandAdapter(name, commandValues, options.values.args),
				...(launch ? { launch } : {})
			};
		validateAdapter(name, adapter);
		const config = await readAdapterConfig(configPath);
		config.adapters[name] = adapter;
		await writeAdapterConfig(configPath, config);
		process.stdout.write(`Configured adapter '${name}' in ${configPath}\n`);
		return;
	}

	if (action === 'remove') {
		const config = await readAdapterConfig(configPath);
		if (!config.adapters[name]) {
			throw new Error(`adapter '${name}' is not configured in ${configPath}`);
		}
		delete config.adapters[name];
		await writeAdapterConfig(configPath, config);
		process.stdout.write(`Removed adapter '${name}' from ${configPath}\n`);
		return;
	}

	if (action === 'validate') {
		const adapters = await loadAdapters(cwd);
		const adapter = adapters[name];
		if (!adapter) {
			throw new Error(`adapter '${name}' is not configured`);
		}
		await validateAdapterProcess(name, adapter, cwd);
		process.stdout.write(`Adapter '${name}' started and completed the DAP initialize handshake.\n`);
		return;
	}

	throw new Error(`Unknown adapter action '${action ?? ''}'.`);
}

async function validateAdapterProcess(
	name: string,
	adapter: AdapterRegistration,
	cwd: string
): Promise<void> {
	validateAdapter(name, adapter);
	const client = new DapClient(adapter.command, adapter.args ?? [], cwd, 30_000);
	try {
		await client.request('initialize', {
			clientID: 'debugmcp-validator',
			adapterID: adapter.type,
			pathFormat: 'path',
			linesStartAt1: true,
			columnsStartAt1: true
		});
	} finally {
		await client.close();
	}
}

async function runServer(args: string[]): Promise<void> {
	const options = parseOptions(args, ['stdio', 'port', 'timeout']);
	const timeout = Number(first(options, 'timeout') ?? '300');
	const port = Number(first(options, 'port') ?? '3001');
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error('--timeout must be a positive number');
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('--port must be an integer from 1 to 65535');
	}

	const createHandler = () => new DebuggingHandler(
		new CliDebuggingExecutor(),
		new CliConfigurationManager(),
		timeout
	);
	const server = new DebugMCPServer(port, timeout, ['127.0.0.1', '::1'], createHandler);
	await server.initialize();
	if (flag(options, 'stdio')) {
		await server.startStdio();
		return;
	}
	const started = await server.start();
	if (!started) {
		throw new Error(`port ${port} is already in use`);
	}
	process.stdout.write(`DebugMCP CLI listening at ${server.getEndpoint()}\n`);
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		printHelp();
		return;
	}
	if (command === 'adapter') {
		await runAdapterCommand(args);
		return;
	}
	if (command === 'serve') {
		await runServer(args);
		return;
	}
	if (command === 'configure') {
		await configureAgents(args);
		return;
	}
	if (command === 'status') {
		await printStatus();
		return;
	}
	throw new Error(`Unknown command '${command}'. Run "debugmcp help".`);
}

void main().catch(error => {
	logger.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
