// Copyright (c) Microsoft Corporation.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AdapterRegistration {
	command: string;
	args?: string[];
	extensions: string[];
	type: string;
	transport?: 'stdio';
	launch?: Record<string, unknown>;
}

export interface AdapterConfigFile {
	version: 1;
	adapters: Record<string, AdapterRegistration>;
}

const emptyConfig = (): AdapterConfigFile => ({ version: 1, adapters: {} });

export function getProjectConfigPath(workingDirectory: string): string {
	return path.join(workingDirectory, '.debugmcp.json');
}

export function getUserConfigPath(): string {
	const configHome = process.platform === 'win32'
		? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
		: process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
	return path.join(configHome, 'debugmcp', 'config.json');
}

export async function readAdapterConfig(filePath: string): Promise<AdapterConfigFile> {
	try {
		const content = await fs.promises.readFile(filePath, 'utf8');
		const parsed: unknown = JSON.parse(content);
		if (!parsed || typeof parsed !== 'object' || (parsed as AdapterConfigFile).version !== 1) {
			throw new Error('expected an object with version: 1');
		}
		const adapters = (parsed as AdapterConfigFile).adapters;
		if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) {
			throw new Error('expected an adapters object');
		}
		for (const [name, adapter] of Object.entries(adapters)) {
			validateAdapter(name, adapter);
		}
		return parsed as AdapterConfigFile;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return emptyConfig();
		}
		throw new Error(`Invalid DebugMCP adapter configuration at ${filePath}: ${error}`);
	}
}

export async function writeAdapterConfig(filePath: string, config: AdapterConfigFile): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	await fs.promises.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
	await fs.promises.rename(temporaryPath, filePath);
}

export async function loadAdapters(
	workingDirectory: string
): Promise<Record<string, AdapterRegistration>> {
	const user = await readAdapterConfig(getUserConfigPath());
	const project = await readAdapterConfig(getProjectConfigPath(workingDirectory));
	return { ...user.adapters, ...project.adapters };
}

export function validateAdapter(name: string, adapter: AdapterRegistration): void {
	if (!name.trim()) {
		throw new Error('adapter name cannot be empty');
	}
	if (!adapter || typeof adapter !== 'object') {
		throw new Error(`adapter '${name}' must be an object`);
	}
	if (typeof adapter.command !== 'string' || !adapter.command.trim()) {
		throw new Error(`adapter '${name}' requires a non-empty command`);
	}
	if (!Array.isArray(adapter.extensions) ||
		adapter.extensions.length === 0 ||
		adapter.extensions.some(extension => typeof extension !== 'string' || !extension.startsWith('.'))) {
		throw new Error(`adapter '${name}' requires extensions such as [".py"]`);
	}
	if (typeof adapter.type !== 'string' || !adapter.type.trim()) {
		throw new Error(`adapter '${name}' requires a DAP type`);
	}
	if (adapter.transport && adapter.transport !== 'stdio') {
		throw new Error(`adapter '${name}' uses unsupported transport '${adapter.transport}'; only stdio is supported`);
	}
	if (adapter.args && (!Array.isArray(adapter.args) || adapter.args.some(arg => typeof arg !== 'string'))) {
		throw new Error(`adapter '${name}' args must be an array of strings`);
	}
}
