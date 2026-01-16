// Copyright (c) Microsoft Corporation.

import { DebugConfiguration } from './types';

/**
 * Interface for debug configuration management operations.
 * 
 * This abstraction allows different implementations:
 * - VSCodeConfigurationManager: Reads from launch.json, prompts user via VS Code UI
 * - ConfigLoader (standalone): Reads from debugmcp.config.json
 */
export interface IDebugConfigurationManager {
	/**
	 * Get or create a debug configuration for the given parameters
	 * @param workingDirectory Working directory for the debug session
	 * @param fileFullPath Full path to the file being debugged
	 * @param configurationName Optional name of a specific configuration to use
	 * @param testName Optional test name for test debugging
	 */
	getDebugConfig(
		workingDirectory: string,
		fileFullPath: string,
		configurationName?: string,
		testName?: string
	): Promise<DebugConfiguration>;

	/**
	 * Prompt user to select a debug configuration.
	 * In VS Code mode, this shows a quick pick dialog.
	 * In standalone mode, this may read from config or return undefined.
	 * @param workingDirectory Working directory to look for configurations
	 * @returns Selected configuration name, or undefined if auto-detect should be used
	 */
	promptForConfiguration(workingDirectory: string): Promise<string | undefined>;

	/**
	 * Detect programming language from file extension
	 * @param fileFullPath Full path to the file
	 * @returns Language identifier (e.g., 'python', 'node', 'java')
	 */
	detectLanguageFromFilePath(fileFullPath: string): string;
}
