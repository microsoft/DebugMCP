import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Interface for configuration management operations
 */
export interface IDebugConfigurationManager {
    getDebugConfig(
        workspaceFolder: vscode.WorkspaceFolder, 
        fileFullPath: string, 
        workingDirectory?: string, 
        configurationName?: string
    ): Promise<vscode.DebugConfiguration>;
    promptForConfiguration(workspaceFolder: vscode.WorkspaceFolder): Promise<string | undefined>;
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
        workspaceFolder: vscode.WorkspaceFolder,
        fileFullPath: string,
        workingDirectory?: string,
        configurationName?: string
    ): Promise<vscode.DebugConfiguration> {
        if (configurationName === DebugConfigurationManager.AUTO_LAUNCH_CONFIG) {
            return this.createDefaultDebugConfig(fileFullPath, workingDirectory, workspaceFolder);
        }

        try {
            // Look for launch.json in .vscode folder
            const launchJsonPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');
            const launchJsonDoc = await vscode.workspace.openTextDocument(launchJsonPath);
            const launchJsonContent = launchJsonDoc.getText();
            
            // Parse the JSON (removing comments first)
            const cleanJson = launchJsonContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
            const launchConfig = JSON.parse(cleanJson);
            
            if (launchConfig.configurations && Array.isArray(launchConfig.configurations) && launchConfig.configurations.length > 0) {
                // If a specific configuration name is provided, find it
                if (configurationName) {
                    const namedConfig = launchConfig.configurations.find((config: any) => 
                        config.name === configurationName
                    );
                    if (namedConfig) {
                        return {
                            ...namedConfig,
                            program: fileFullPath, // Override program to our specific file
                            cwd: workingDirectory || namedConfig.cwd || workspaceFolder.uri.fsPath,
                            name: `DebugMCP Launch (${configurationName})`
                        };
                    }
                    console.log(`No configuration named '${configurationName}' found in launch.json`);
                }
            }
        } catch (launchJsonError) {
            console.log('Could not read or parse launch.json:', launchJsonError);
        }

        // Fallback: always return a default configuration if nothing else matched
        return this.createDefaultDebugConfig(fileFullPath, workingDirectory, workspaceFolder);
    }

    /**
     * Prompt user to select a debug configuration
     */
    public async promptForConfiguration(workspaceFolder: vscode.WorkspaceFolder): Promise<string | undefined> {
        try {
            // Look for launch.json in .vscode folder
            const launchJsonPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');
            
            let configurations: any[] = [];
            
            try {
                const launchJsonDoc = await vscode.workspace.openTextDocument(launchJsonPath);
                const launchJsonContent = launchJsonDoc.getText();
                
                // Parse the JSON (removing comments first)
                const cleanJson = launchJsonContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
                const launchConfig = JSON.parse(cleanJson);
                
                if (launchConfig.configurations && Array.isArray(launchConfig.configurations)) {
                    configurations = launchConfig.configurations;
                }
            } catch (launchJsonError) {
                console.log('Could not read or parse launch.json:', launchJsonError);
            }
            
            if (configurations.length === 0) {
                // No configurations available, will use default
                return undefined;
            }
            
            // Create configuration options for user selection
            const configOptions: vscode.QuickPickItem[] = [
                {
                    label: DebugConfigurationManager.AUTO_LAUNCH_CONFIG,
                    description: 'Use auto-detected default configuration',
                    detail: 'DebugMCP will create a default configuration based on file extension'
                },
                ...configurations.map(config => ({
                    label: config.name || 'Unnamed Configuration',
                    description: config.type ? `Type: ${config.type}` : '',
                    detail: config.request ? `Request: ${config.request}` : ''
                }))
            ];
            
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
    private createDefaultDebugConfig(
        fileFullPath: string, 
        workingDirectory: string | undefined, 
        workspaceFolder: vscode.WorkspaceFolder
    ): vscode.DebugConfiguration {
        const detectedLanguage = this.detectLanguageFromFilePath(fileFullPath);
        
        const configs: { [key: string]: vscode.DebugConfiguration } = {
            python: {
                type: 'python',
                request: 'launch',
                name: 'DebugMCP Python Launch',
                program: fileFullPath,
                console: 'integratedTerminal',
                cwd: workingDirectory || workspaceFolder.uri.fsPath,
                env: {},
                stopOnEntry: false
            },
            node: {
                type: 'pwa-node',
                request: 'launch',
                name: 'DebugMCP Node.js Launch',
                program: fileFullPath,
                console: 'integratedTerminal',
                cwd: workingDirectory || workspaceFolder.uri.fsPath,
                env: {},
                stopOnEntry: false
            },
            java: {
                type: 'java',
                request: 'launch',
                name: 'DebugMCP Java Launch',
                mainClass: path.basename(fileFullPath, path.extname(fileFullPath)),
                console: 'integratedTerminal',
                cwd: workingDirectory || workspaceFolder.uri.fsPath
            },
            coreclr: {
                type: 'coreclr',
                request: 'launch',
                name: 'DebugMCP .NET Launch',
                program: fileFullPath,
                console: 'integratedTerminal',
                cwd: workingDirectory || workspaceFolder.uri.fsPath,
                stopAtEntry: false
            },
            cppdbg: {
                type: 'cppdbg',
                request: 'launch',
                name: 'DebugMCP C++ Launch',
                program: fileFullPath.replace(/\.(cpp|cc|c)$/, ''),
                cwd: workingDirectory || workspaceFolder.uri.fsPath,
                console: 'integratedTerminal'
            },
            go: {
                type: 'go',
                request: 'launch',
                name: 'DebugMCP Go Launch',
                mode: 'debug',
                program: fileFullPath,
                cwd: workingDirectory || workspaceFolder.uri.fsPath
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
            
            // Parse the JSON (removing comments first)
            const cleanJson = launchJsonContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
            const launchConfig = JSON.parse(cleanJson);
            
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
     * Get the auto launch configuration name
     */
    public static getAutoLaunchConfigName(): string {
        return DebugConfigurationManager.AUTO_LAUNCH_CONFIG;
    }
}
