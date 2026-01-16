// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IDebugConfigurationManager } from '../core/IDebugConfigurationManager';
import { DebugConfiguration } from '../core/types';

/**
 * VS Code implementation of IDebugConfigurationManager.
 * 
 * This manager reads debug configurations from VS Code's launch.json
 * and uses VS Code's quick pick UI for user prompts.
 */
export class VSCodeConfigurationManager implements IDebugConfigurationManager {
	private static readonly AUTO_LAUNCH_CONFIG = 'Default Configuration';

	/**
	 * Get or create a debug configuration for the given parameters
	 */
	public async getDebugConfig(
		workingDirectory: string,
		fileFullPath: string,
		configurationName?: string,
		testName?: string
	): Promise<DebugConfiguration> {
		if (configurationName === VSCodeConfigurationManager.AUTO_LAUNCH_CONFIG) {
			return this.createDefaultDebugConfig(fileFullPath, workingDirectory, testName);
		}

		try {
			// Look for launch.json in .vscode folder
			const launchJsonPath = vscode.Uri.joinPath(
				vscode.Uri.file(workingDirectory),
				'.vscode',
				'launch.json'
			);
			const launchJsonDoc = await vscode.workspace.openTextDocument(launchJsonPath);
			const launchJsonContent = launchJsonDoc.getText();

			// Parse the JSON (removing comments and trailing commas first)
			let cleanJson = launchJsonContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
			cleanJson = cleanJson.replace(/,(\s*[}\]])/g, '$1');
			const launchConfig = JSON.parse(cleanJson);

			if (launchConfig.configurations &&
				Array.isArray(launchConfig.configurations) &&
				launchConfig.configurations.length > 0) {
				// If a specific configuration name is provided, find it
				if (configurationName) {
					const namedConfig = launchConfig.configurations.find(
						(config: any) => config.name === configurationName
					);
					if (namedConfig) {
						return {
							...namedConfig,
							name: `DebugMCP Launch (${configurationName})`
						} as DebugConfiguration;
					}
					console.log(`No configuration named '${configurationName}' found in launch.json`);
				}
			}
		} catch (launchJsonError) {
			console.log('Could not read or parse launch.json:', launchJsonError);
		}

		// Fallback: always return a default configuration if nothing else matched
		return this.createDefaultDebugConfig(fileFullPath, workingDirectory, testName);
	}

	/**
	 * Prompt user to select a debug configuration
	 */
	public async promptForConfiguration(workingDirectory: string): Promise<string | undefined> {
		try {
			// Look for launch.json in .vscode folder
			const launchJsonPath = vscode.Uri.joinPath(
				vscode.Uri.file(workingDirectory),
				'.vscode',
				'launch.json'
			);

			let configurations: any[] = [];

			try {
				const launchJsonDoc = await vscode.workspace.openTextDocument(launchJsonPath);
				const launchJsonContent = launchJsonDoc.getText();

				// Parse the JSON (removing comments and trailing commas first)
				let cleanJson = launchJsonContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
				cleanJson = cleanJson.replace(/,(\s*[}\]])/g, '$1');
				const launchConfig = JSON.parse(cleanJson);

				if (launchConfig.configurations && Array.isArray(launchConfig.configurations)) {
					configurations = launchConfig.configurations;
				}
			} catch (launchJsonError) {
				console.log('Could not read or parse launch.json:', launchJsonError);
			}

			// Always show popup now - even when no configurations exist
			const configOptions: vscode.QuickPickItem[] = [];

			// Add existing configurations if any
			if (configurations.length > 0) {
				configOptions.push(...configurations.map(config => ({
					label: config.name || 'Unnamed Configuration',
					description: config.type ? `Type: ${config.type}` : '',
					detail: config.request ? `Request: ${config.request}` : ''
				})));
			}

			// Add AUTO_LAUNCH_CONFIG at the end
			configOptions.push({
				label: VSCodeConfigurationManager.AUTO_LAUNCH_CONFIG,
				description: 'Use auto-detected default configuration (beta)',
				detail: 'DebugMCP will create a default configuration based on file extension. ' +
					'This is a heuristic and may not always work as expected.'
			});

			// Show quick pick to user
			const selected = await vscode.window.showQuickPick(configOptions, {
				placeHolder: 'Select a debug configuration to use',
				title: 'Choose Debug Configuration'
			});

			if (!selected) {
				// User cancelled the selection
				throw new Error('Debug configuration selection cancelled by user');
			}

			return selected.label;
		} catch (error) {
			console.log('Error prompting for configuration:', error);
			throw error;
		}
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

		return languageMap[extension] || 'python'; // Default to python if unknown
	}

	/**
	 * Create a default debug configuration based on file type
	 */
	private async createDefaultDebugConfig(
		fileFullPath: string,
		workingDirectory: string,
		testName?: string
	): Promise<DebugConfiguration> {
		const detectedLanguage = this.detectLanguageFromFilePath(fileFullPath);
		const cwd = path.dirname(fileFullPath);

		// Build test-specific configurations based on language
		if (testName && detectedLanguage !== 'coreclr') {
			return await this.createTestDebugConfig(detectedLanguage, fileFullPath, cwd, testName);
		}

		const configs: { [key: string]: DebugConfiguration } = {
			python: {
				type: 'python',
				request: 'launch',
				name: 'DebugMCP Python Launch',
				program: fileFullPath,
				console: 'integratedTerminal',
				cwd: cwd,
				env: {},
				stopOnEntry: false
			},
			node: {
				type: 'pwa-node',
				request: 'launch',
				name: 'DebugMCP Node.js Launch',
				program: fileFullPath,
				console: 'integratedTerminal',
				cwd: cwd,
				env: {},
				stopOnEntry: false
			},
			java: {
				type: 'java',
				request: 'launch',
				name: 'DebugMCP Java Launch',
				mainClass: path.basename(fileFullPath, path.extname(fileFullPath)),
				console: 'integratedTerminal',
				cwd: cwd
			},
			coreclr: {
				type: 'coreclr',
				request: 'launch',
				name: 'DebugMCP .NET Launch',
				program: fileFullPath,
				console: 'integratedTerminal',
				cwd: cwd,
				stopAtEntry: false
			},
			cppdbg: {
				type: 'cppdbg',
				request: 'launch',
				name: 'DebugMCP C++ Launch',
				program: fileFullPath.replace(/\.(cpp|cc|c)$/, '.exe'),
				cwd: cwd,
				console: 'integratedTerminal'
			},
			go: {
				type: 'go',
				request: 'launch',
				name: 'DebugMCP Go Launch',
				mode: 'debug',
				program: fileFullPath,
				cwd: cwd
			}
		};

		return configs[detectedLanguage] || configs.python; // Fallback to Python if unknown
	}

	/**
	 * Extract the class name from a Python test file
	 */
	private async extractPythonClassName(fileFullPath: string): Promise<string | null> {
		try {
			const content = await fs.promises.readFile(fileFullPath, 'utf8');
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

		if (testName.includes('.')) {
			return `${moduleName}.${testName}`;
		}

		const className = await this.extractPythonClassName(fileFullPath);
		if (className) {
			return `${moduleName}.${className}.${testName}`;
		}

		return `${moduleName}.${testName}`;
	}

	/**
	 * Create a debug configuration specifically for running tests
	 */
	private async createTestDebugConfig(
		language: string,
		fileFullPath: string,
		cwd: string,
		testName: string
	): Promise<DebugConfiguration> {
		const fileName = path.basename(fileFullPath);

		switch (language) {
			case 'python': {
				const formattedTestName = await this.formatPythonTestName(fileFullPath, testName);

				return {
					type: 'python',
					request: 'launch',
					name: `DebugMCP Python Test: ${testName}`,
					module: 'unittest',
					args: [formattedTestName, '-v'],
					console: 'integratedTerminal',
					cwd: cwd,
					env: {},
					stopOnEntry: false,
					justMyCode: false,
					purpose: ['debug-test']
				};
			}

			case 'node': {
				const isJest = fileName.includes('.test.') || fileName.includes('.spec.');

				if (isJest) {
					return {
						type: 'pwa-node',
						request: 'launch',
						name: `DebugMCP Jest Test: ${testName}`,
						program: '${workspaceFolder}/node_modules/.bin/jest',
						args: ['--testNamePattern', testName, '--runInBand', fileFullPath],
						console: 'integratedTerminal',
						cwd: cwd,
						env: {},
						stopOnEntry: false
					};
				} else {
					return {
						type: 'pwa-node',
						request: 'launch',
						name: `DebugMCP Mocha Test: ${testName}`,
						program: '${workspaceFolder}/node_modules/.bin/mocha',
						args: ['--grep', testName, fileFullPath],
						console: 'integratedTerminal',
						cwd: cwd,
						env: {},
						stopOnEntry: false
					};
				}
			}

			case 'java': {
				const className = path.basename(fileFullPath, path.extname(fileFullPath));
				return {
					type: 'java',
					request: 'launch',
					name: `DebugMCP JUnit Test: ${testName}`,
					mainClass: className,
					args: ['--tests', `${className}.${testName}`],
					console: 'integratedTerminal',
					cwd: cwd
				};
			}

			case 'coreclr': {
				return {
					type: 'coreclr',
					request: 'launch',
					name: `DebugMCP .NET Test: ${testName}`,
					program: 'dotnet',
					args: ['test', '--filter', `FullyQualifiedName~${testName}`, '--no-build'],
					console: 'integratedTerminal',
					cwd: cwd,
					stopAtEntry: false
				};
			}

			default: {
				return {
					type: language,
					request: 'launch',
					name: `DebugMCP Launch (test filtering not supported for ${language})`,
					program: fileFullPath,
					console: 'integratedTerminal',
					cwd: cwd,
					stopOnEntry: false
				};
			}
		}
	}

	/**
	 * Get the auto launch configuration name
	 */
	public static getAutoLaunchConfigName(): string {
		return VSCodeConfigurationManager.AUTO_LAUNCH_CONFIG;
	}
}
