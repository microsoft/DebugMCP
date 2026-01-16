// Copyright (c) Microsoft Corporation.

import * as fs from 'fs';
import * as path from 'path';
import { IDebugConfigurationManager } from '../core/IDebugConfigurationManager';
import { DebugConfiguration } from '../core/types';

/**
 * Configuration for a debug adapter
 */
export interface AdapterConfig {
	/** Command to run the adapter (e.g., 'python', 'node') */
	command: string;
	/** Arguments to pass to the command */
	args: string[];
	/** Working directory for the adapter process */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
}

/**
 * Default configuration for debug sessions
 */
export interface DefaultConfig {
	/** Debug adapter type */
	type: string;
	/** Request type: 'launch' or 'attach' */
	request: 'launch' | 'attach';
	/** Console type */
	console?: 'integratedTerminal' | 'externalTerminal' | 'internalConsole';
	/** Python-specific: debug only user code */
	justMyCode?: boolean;
	/** Additional default properties */
	[key: string]: unknown;
}

/**
 * Full configuration file structure
 */
export interface StandaloneConfig {
	/** Server port */
	port?: number;
	/** Debug adapter configurations by language */
	adapters: Record<string, AdapterConfig>;
	/** Default configuration values by language */
	defaults?: Record<string, DefaultConfig>;
	/** Timeout for debug operations in seconds */
	timeout?: number;
}

/**
 * ConfigLoader loads and validates the debugmcp.config.json configuration file.
 * It implements IDebugConfigurationManager for standalone mode.
 */
export class ConfigLoader implements IDebugConfigurationManager {
	private config: StandaloneConfig | null = null;
	private configPath: string;
	private workspaceFolder: string;

	/**
	 * Create a new ConfigLoader
	 * @param configPath Path to the configuration file
	 */
	constructor(configPath: string) {
		this.configPath = configPath;
		this.workspaceFolder = path.dirname(configPath);
	}

	/**
	 * Load and parse the configuration file
	 */
	public async load(): Promise<StandaloneConfig> {
		if (this.config) {
			return this.config;
		}

		try {
			const content = await fs.promises.readFile(this.configPath, 'utf8');
			const rawConfig = JSON.parse(content);

			// Validate and expand variables
			this.config = this.validateAndExpand(rawConfig);
			return this.config;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new Error(`Configuration file not found: ${this.configPath}`);
			}
			throw new Error(`Failed to load configuration: ${error}`);
		}
	}

	/**
	 * Validate configuration and expand variables
	 */
	private validateAndExpand(raw: any): StandaloneConfig {
		// Validate required fields
		if (!raw.adapters || typeof raw.adapters !== 'object') {
			throw new Error('Configuration must include "adapters" object');
		}

		// Expand variables in the configuration
		const expanded = this.expandVariables(raw);

		// Validate adapter configs
		for (const [name, adapter] of Object.entries(expanded.adapters as Record<string, any>)) {
			if (!adapter.command || typeof adapter.command !== 'string') {
				throw new Error(`Adapter "${name}" must have a "command" string`);
			}
			if (adapter.args && !Array.isArray(adapter.args)) {
				throw new Error(`Adapter "${name}" args must be an array`);
			}
			// Set default args if not provided
			if (!adapter.args) {
				adapter.args = [];
			}
		}

		return expanded as StandaloneConfig;
	}

	/**
	 * Expand variables in a value
	 * Supported variables:
	 * - ${workspaceFolder} - Directory containing the config file
	 * - ${env:VAR_NAME} - Environment variable value
	 */
	private expandVariables(obj: any): any {
		if (typeof obj === 'string') {
			return this.expandString(obj);
		}
		if (Array.isArray(obj)) {
			return obj.map(item => this.expandVariables(item));
		}
		if (obj && typeof obj === 'object') {
			const result: any = {};
			for (const [key, value] of Object.entries(obj)) {
				result[key] = this.expandVariables(value);
			}
			return result;
		}
		return obj;
	}

	/**
	 * Expand variables in a string
	 */
	private expandString(str: string): string {
		// Replace ${workspaceFolder}
		str = str.replace(/\$\{workspaceFolder\}/g, this.workspaceFolder);

		// Replace ${env:VAR_NAME}
		str = str.replace(/\$\{env:([^}]+)\}/g, (_match, varName) => {
			return process.env[varName] || '';
		});

		return str;
	}

	/**
	 * Get adapter configuration for a language
	 */
	public getAdapterConfig(language: string): AdapterConfig | undefined {
		if (!this.config) {
			throw new Error('Configuration not loaded. Call load() first.');
		}
		return this.config.adapters[language];
	}

	/**
	 * Get all configured adapter names
	 */
	public getAdapterNames(): string[] {
		if (!this.config) {
			throw new Error('Configuration not loaded. Call load() first.');
		}
		return Object.keys(this.config.adapters);
	}

	/**
	 * Get server port from config
	 */
	public getPort(): number {
		return this.config?.port || 3001;
	}

	/**
	 * Get timeout from config
	 */
	public getTimeout(): number {
		return this.config?.timeout || 180;
	}

	// ============================================================
	// IDebugConfigurationManager implementation
	// ============================================================

	/**
	 * Get or create a debug configuration for the given parameters
	 */
	public async getDebugConfig(
		workingDirectory: string,
		fileFullPath: string,
		_configurationName?: string,
		testName?: string
	): Promise<DebugConfiguration> {
		if (!this.config) {
			await this.load();
		}

		const language = this.detectLanguageFromFilePath(fileFullPath);
		const defaults: Partial<DefaultConfig> = this.config?.defaults?.[language] || {};

		// If testName is provided, create test-specific configuration
		if (testName) {
			return this.createTestDebugConfig(language, fileFullPath, workingDirectory, testName, defaults);
		}

		// Build the standard launch configuration
		const config: DebugConfiguration = {
			type: defaults.type || language,
			request: defaults.request || 'launch',
			name: `Standalone Debug: ${path.basename(fileFullPath)}`,
			program: fileFullPath,
			cwd: workingDirectory,
			console: defaults.console || 'integratedTerminal',
			...defaults,
		};

		return config;
	}

	/**
	 * Create a debug configuration specifically for running tests
	 */
	private async createTestDebugConfig(
		language: string,
		fileFullPath: string,
		workingDirectory: string,
		testName: string,
		defaults: Partial<DefaultConfig>
	): Promise<DebugConfiguration> {
		const fileName = path.basename(fileFullPath);

		switch (language) {
			case 'python':
				// Auto-detect class name and format test name appropriately
				const formattedTestName = await this.formatPythonTestName(fileFullPath, testName);

				return {
					type: 'python',  // Use 'python' to match adapter registration
					request: 'launch',
					name: `Standalone Test: ${testName}`,
					module: 'pytest',
					args: [
						fileFullPath,
						'-k', testName,
						'-v',
						'--no-header',
						'-s'  // Don't capture stdout, helps with debugging
					],
					cwd: workingDirectory,
					console: defaults.console || 'internalConsole',
					justMyCode: defaults.justMyCode !== undefined ? defaults.justMyCode : true,
					stopOnEntry: false,
				};

			case 'node':
				// Support for Jest and Mocha test frameworks
				const isJest = fileName.includes('.test.') || fileName.includes('.spec.');

				if (isJest) {
					return {
						type: 'node',
						request: 'launch',
						name: `Standalone Jest Test: ${testName}`,
						program: path.join(workingDirectory, 'node_modules/.bin/jest'),
						args: [
							'--testNamePattern', testName,
							'--runInBand',
							fileFullPath
						],
						cwd: workingDirectory,
						console: defaults.console || 'internalConsole',
						stopOnEntry: false,
					};
				} else {
					return {
						type: 'node',
						request: 'launch',
						name: `Standalone Mocha Test: ${testName}`,
						program: path.join(workingDirectory, 'node_modules/.bin/mocha'),
						args: [
							'--grep', testName,
							fileFullPath
						],
						cwd: workingDirectory,
						console: defaults.console || 'internalConsole',
						stopOnEntry: false,
					};
				}

			default:
				// For unsupported languages, fall back to running the entire file
				return {
					type: defaults.type || language,
					request: 'launch',
					name: `Standalone Debug (test filtering not supported for ${language}): ${testName}`,
					program: fileFullPath,
					cwd: workingDirectory,
					console: defaults.console || 'internalConsole',
					stopOnEntry: false,
					...defaults,
				};
		}
	}

	/**
	 * Extract the class name from a Python test file
	 */
	private async extractPythonClassName(fileFullPath: string): Promise<string | null> {
		try {
			const content = await fs.promises.readFile(fileFullPath, 'utf8');
			// Match Python class definition starting with capital letter
			const classMatch = content.match(/class\s+([A-Z][a-zA-Z0-9_]*)/);
			return classMatch ? classMatch[1] : null;
		} catch (error) {
			console.log('Error extracting class name from Python file:', error);
			return null;
		}
	}

	/**
	 * Format Python test name by auto-detecting class name if needed
	 */
	private async formatPythonTestName(fileFullPath: string, testName: string): Promise<string> {
		const moduleName = path.basename(fileFullPath, '.py');

		// If testName already contains a dot, assume it's already qualified
		if (testName.includes('.')) {
			return `${moduleName}.${testName}`;
		}

		// Try to extract the class name from the file
		const className = await this.extractPythonClassName(fileFullPath);
		if (className) {
			return `${moduleName}.${className}.${testName}`;
		}

		// No class found, assume it's a standalone test function
		return `${moduleName}.${testName}`;
	}

	/**
	 * Prompt for configuration (in standalone mode, returns undefined to use defaults)
	 */
	public async promptForConfiguration(_workingDirectory: string): Promise<string | undefined> {
		// In standalone mode, we don't prompt - we use the config file
		return undefined;
	}

	/**
	 * Detect programming language from file extension
	 */
	public detectLanguageFromFilePath(fileFullPath: string): string {
		const extension = path.extname(fileFullPath).toLowerCase();

		const languageMap: { [key: string]: string } = {
			'.py': 'python',
			'.js': 'node',
			'.ts': 'node',
			'.jsx': 'node',
			'.tsx': 'node',
			'.java': 'java',
			'.cs': 'coreclr',
			'.cpp': 'cppdbg',
			'.cc': 'cppdbg',
			'.c': 'cppdbg',
			'.go': 'go',
			'.rs': 'lldb',
			'.php': 'php',
			'.rb': 'ruby'
		};

		return languageMap[extension] || 'python';
	}

	/**
	 * Get the workspace folder path
	 */
	public getWorkspaceFolder(): string {
		return this.workspaceFolder;
	}

	/**
	 * Create a default configuration file
	 */
	public static createDefaultConfig(workspaceFolder: string): StandaloneConfig {
		return {
			port: 3001,
			adapters: {
				python: {
					command: 'python',
					args: ['-m', 'debugpy.adapter'],
					cwd: '${workspaceFolder}'
				}
			},
			defaults: {
				python: {
					type: 'python',
					request: 'launch',
					console: 'integratedTerminal'
				}
			},
			timeout: 180
		};
	}

	/**
	 * Write a default configuration file
	 */
	public static async writeDefaultConfig(configPath: string): Promise<void> {
		const workspaceFolder = path.dirname(configPath);
		const config = ConfigLoader.createDefaultConfig(workspaceFolder);
		const content = JSON.stringify(config, null, 2);
		await fs.promises.writeFile(configPath, content, 'utf8');
	}
}
