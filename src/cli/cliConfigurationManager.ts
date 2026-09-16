// Copyright (c) Microsoft Corporation.

import * as path from 'node:path';
import { DebugConfiguration } from '../debugTypes';
import { IDebugConfigurationManager } from '../utils/debugConfigurationManager';
import { AdapterRegistration, loadAdapters } from './adapterConfig';

export interface CliDebugConfiguration extends DebugConfiguration {
	adapterName: string;
	adapter: AdapterRegistration;
	request: 'launch' | 'attach';
}

export class CliConfigurationManager implements IDebugConfigurationManager {
	public async getDebugConfig(
		workingDirectory: string,
		fileFullPath: string,
		configurationName?: string
	): Promise<CliDebugConfiguration> {
		const adapters = await loadAdapters(workingDirectory);
		const extension = path.extname(fileFullPath).toLowerCase();
		const matches = Object.entries(adapters).filter(([name, adapter]) =>
			configurationName
				? name === configurationName
				: adapter.extensions.map(item => item.toLowerCase()).includes(extension));

		if (matches.length === 0) {
			const selector = configurationName
				? `named '${configurationName}'`
				: `for '${extension || fileFullPath}' files`;
			throw new Error(
				`No debug adapter is configured ${selector}. ` +
				`Run "debugmcp adapter add <name> --command <executable> --type <dap-type> ` +
				`--extensions ${extension || '.ext'}" in ${workingDirectory}.`
			);
		}
		if (matches.length > 1) {
			throw new Error(
				`Multiple debug adapters match '${extension}': ${matches.map(([name]) => name).join(', ')}. ` +
				'Pass configurationName with the adapter name.'
			);
		}

		const [adapterName, adapter] = matches[0];
		const launch = expandLaunchConfiguration(
			adapter.launch ?? {},
			workingDirectory,
			fileFullPath
		);
		return {
			...launch,
			name: adapterName,
			type: adapter.type,
			request: (launch.request === 'attach' ? 'attach' : 'launch'),
			program: typeof launch.program === 'string' ? launch.program : fileFullPath,
			cwd: typeof launch.cwd === 'string' ? launch.cwd : workingDirectory,
			adapterName,
			adapter
		};
	}

	public detectLanguageFromFilePath(fileFullPath: string): string {
		return path.extname(fileFullPath).toLowerCase();
	}
}

function expandLaunchConfiguration(
	launch: Record<string, unknown>,
	workingDirectory: string,
	fileFullPath: string
): Record<string, unknown> {
	const replacements: Record<string, string> = {
		'${workspaceFolder}': workingDirectory,
		'${file}': fileFullPath,
		'${fileDirname}': path.dirname(fileFullPath),
		'${fileBasenameNoExtension}': path.basename(fileFullPath, path.extname(fileFullPath))
	};

	const expand = (value: unknown): unknown => {
		if (typeof value === 'string') {
			return Object.entries(replacements).reduce(
				(result, [token, replacement]) => result.replaceAll(token, replacement),
				value
			);
		}
		if (Array.isArray(value)) {
			return value.map(expand);
		}
		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value).map(([key, child]) => [key, expand(child)])
			);
		}
		return value;
	};

	return expand(launch) as Record<string, unknown>;
}
