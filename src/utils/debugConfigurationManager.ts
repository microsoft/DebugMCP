// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as jsonc from 'jsonc-parser';

/**
 * Interface for configuration management operations
 */
export interface IDebugConfigurationManager {
    getDebugConfig(
        workingDirectory: string, 
        fileFullPath: string, 
        configurationName?: string,
        testName?: string
    ): Promise<vscode.DebugConfiguration>;
    detectLanguageFromFilePath(fileFullPath: string): string;
}

/**
 * Responsible for managing debug configurations and workspace detection
 */
export class DebugConfigurationManager implements IDebugConfigurationManager {
	private static readonly AUTO_LAUNCH_CONFIG = 'Default Configuration';

    /**
     * Get or create a debug configuration for the given parameters
     */
    public async getDebugConfig(
        workingDirectory: string,
        fileFullPath: string,
        configurationName?: string,
        testName?: string
    ): Promise<vscode.DebugConfiguration> {
        if (!configurationName || configurationName.trim() === '' || configurationName === DebugConfigurationManager.AUTO_LAUNCH_CONFIG) {
            return this.createDefaultDebugConfig(fileFullPath, workingDirectory, testName);
        }

        try {
            const launchConfigurations = await this.getLaunchConfigurations(workingDirectory);
            const namedConfiguration = launchConfigurations.find(config => config?.name === configurationName);
            if (namedConfiguration) {
                return {
                    ...namedConfiguration,
                    name: `DebugMCP Launch (${namedConfiguration.name || 'Workspace Configuration'})`
                };
            }
        } catch (launchJsonError) {
            console.log('Could not read or parse launch.json:', launchJsonError);
        }

        // Fallback: always return a default configuration if nothing else matched
        return this.createDefaultDebugConfig(fileFullPath, workingDirectory, testName);
    }

    private async getLaunchConfigurations(workingDirectory: string): Promise<any[]> {
        const launchJsonPath = vscode.Uri.joinPath(vscode.Uri.file(workingDirectory), '.vscode', 'launch.json');
        const launchJsonDoc = await vscode.workspace.openTextDocument(launchJsonPath);
        const launchJsonContent = launchJsonDoc.getText();
        const launchConfig = jsonc.parse(launchJsonContent);

        if (launchConfig.configurations && Array.isArray(launchConfig.configurations)) {
            return launchConfig.configurations;
        }

        return [];
    }

    public static getAutoLaunchConfigName(): string {
        return DebugConfigurationManager.AUTO_LAUNCH_CONFIG;
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
            '.csproj': 'coreclr',
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
    ): Promise<vscode.DebugConfiguration> {
        const detectedLanguage = this.detectLanguageFromFilePath(fileFullPath);
        const cwd = path.dirname(fileFullPath);
        
        // Build test-specific configurations based on language
        if (testName && detectedLanguage !== 'coreclr') {
            return await this.createTestDebugConfig(detectedLanguage, fileFullPath, cwd, testName);
        }

        const configs: { [key: string]: vscode.DebugConfiguration } = {
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
     * Validate if a workspace has the necessary setup for debugging
     */
    public validateWorkspace(workspaceFolder: vscode.WorkspaceFolder): boolean {
        try {
            // Basic validation - workspace folder exists
            return workspaceFolder && workspaceFolder.uri && workspaceFolder.uri.fsPath.length > 0;
        } catch (error) {
            console.log('Workspace validation error:', error);
            return false;
        }
    }

    /**
     * Get available configurations from launch.json
     */
    public async getAvailableConfigurations(workspaceFolder: vscode.WorkspaceFolder): Promise<string[]> {
        try {
            const launchJsonPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');
            const launchJsonDoc = await vscode.workspace.openTextDocument(launchJsonPath);
            const launchJsonContent = launchJsonDoc.getText();
            
            // Parse JSONC (JSON with comments and trailing commas)
            const launchConfig = jsonc.parse(launchJsonContent);
            
            if (launchConfig.configurations && Array.isArray(launchConfig.configurations)) {
                return launchConfig.configurations.map((config: any) => config.name || 'Unnamed Configuration');
            }
            
            return [];
        } catch (error) {
            console.log('Could not read available configurations:', error);
            return [];
        }
    }

    /**
     * Check if launch.json exists in the workspace
     */
    public async hasLaunchJson(workspaceFolder: vscode.WorkspaceFolder): Promise<boolean> {
        try {
            const launchJsonPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');
            await vscode.workspace.openTextDocument(launchJsonPath);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Extract the class name from a Python test file
     * Assumes only one test class per file
     */
    private async extractPythonClassName(fileFullPath: string): Promise<string | null> {
        try {
            const content = await fs.promises.readFile(fileFullPath, 'utf8');
            // Match Python class definition: class ClassName or class ClassName(BaseClass)
            // Looks for classes starting with capital letter (test classes typically follow this pattern)
            const classMatch = content.match(/class\s+([A-Z][a-zA-Z0-9_]*)/);
            return classMatch ? classMatch[1] : null;
        } catch (error) {
            console.log('Error extracting class name from Python file:', error);
            return null;
        }
    }

    /**
     * Format Python test name by auto-detecting class name if needed
     * Supports both class-based tests and standalone test functions
     */
    private async formatPythonTestName(fileFullPath: string, testName: string): Promise<string> {
        const moduleName = path.basename(fileFullPath, '.py');
        
        // If testName already contains a dot, assume it's in ClassName.method format
        if (testName.includes('.')) {
            return `${moduleName}.${testName}`;
        }
        
        // Otherwise, try to extract the class name from the file
        const className = await this.extractPythonClassName(fileFullPath);
        if (className) {
            // Found a class, format as module.ClassName.testMethod
            return `${moduleName}.${className}.${testName}`;
        }
        
        // No class found, assume it's a standalone test function
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
    ): Promise<vscode.DebugConfiguration> {
        const fileName = path.basename(fileFullPath);

        switch (language) {
            case 'python':
                // Auto-detect class name and format test name appropriately
                const formattedTestName = await this.formatPythonTestName(fileFullPath, testName);
                
                return {
                    type: 'python',
                    request: 'launch',
                    name: `DebugMCP Python Test: ${testName}`,
                    module: 'unittest',
                    args: [
                        formattedTestName,
                        '-v'
                    ],
                    console: 'integratedTerminal',
                    cwd: cwd,
                    env: {},
                    stopOnEntry: false,
                    justMyCode: false,
                    purpose: ['debug-test']
                };

            case 'node':
                // Support for Jest, Mocha, and other Node.js test frameworks
                // Try to detect which test framework based on common patterns
                const isJest = fileName.includes('.test.') || fileName.includes('.spec.');
                
                if (isJest) {
                    // Jest configuration
                    return {
                        type: 'pwa-node',
                        request: 'launch',
                        name: `DebugMCP Jest Test: ${testName}`,
                        program: '${workspaceFolder}/node_modules/.bin/jest',
                        args: [
                            '--testNamePattern', testName,
                            '--runInBand',
                            fileFullPath
                        ],
                        console: 'integratedTerminal',
                        cwd: cwd,
                        env: {},
                        stopOnEntry: false
                    };
                } else {
                    // Mocha configuration
                    return {
                        type: 'pwa-node',
                        request: 'launch',
                        name: `DebugMCP Mocha Test: ${testName}`,
                        program: '${workspaceFolder}/node_modules/.bin/mocha',
                        args: [
                            '--grep', testName,
                            fileFullPath
                        ],
                        console: 'integratedTerminal',
                        cwd: cwd,
                        env: {},
                        stopOnEntry: false
                    };
                }

            case 'java':
                // JUnit test configuration
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

            case 'coreclr':
                // .NET test configuration (supports xUnit, NUnit, MSTest)
                return {
                    type: 'coreclr',
                    request: 'launch',
                    name: `DebugMCP .NET Test: ${testName}`,
                    program: 'dotnet',
                    args: [
                        'test',
                        '--filter', `FullyQualifiedName~${testName}`,
                        '--no-build'
                    ],
                    console: 'integratedTerminal',
                    cwd: cwd,
                    stopAtEntry: false
                };

            default:
                // For unsupported languages, fall back to running the entire file
                // but include a warning in the name
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
