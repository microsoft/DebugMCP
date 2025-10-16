import * as vscode from 'vscode';
import { DebugState } from './DebugState';

/**
 * Interface for debugging execution operations
 */
export interface IDebuggingExecutor {
    startDebugging(workspaceFolder: vscode.WorkspaceFolder, config: vscode.DebugConfiguration): Promise<boolean>;
    stopDebugging(session?: vscode.DebugSession): Promise<void>;
    stepOver(): Promise<void>;
    stepInto(): Promise<void>;
    stepOut(): Promise<void>;
    continue(): Promise<void>;
    restart(): Promise<void>;
    addBreakpoint(uri: vscode.Uri, line: number): Promise<void>;
    removeBreakpoint(uri: vscode.Uri, line: number): Promise<void>;
    getCurrentDebugState(numNextLines: number): Promise<DebugState>;
    getVariables(frameId: number, scope?: 'local' | 'global' | 'all'): Promise<any>;
    evaluateExpression(expression: string, frameId: number): Promise<any>;
    getBreakpoints(): readonly vscode.Breakpoint[];
    clearAllBreakpoints(): void;
    hasActiveSession(): boolean;
    getActiveSession(): vscode.DebugSession | undefined;
}

/**
 * Responsible for executing VS Code debugging commands and managing debug sessions
 */
export class DebuggingExecutor implements IDebuggingExecutor {
    private readonly executionDelay: number = 300; // ms to wait for debugger updates

    /**
     * Start a debugging session
     */
    public async startDebugging(
        workspaceFolder: vscode.WorkspaceFolder, 
        config: vscode.DebugConfiguration
    ): Promise<boolean> {
        try {
            if (config.type === 'coreclr') {
                // Open the specific test file instead of the workspace folder
                const testFileUri = vscode.Uri.file(config.program);
                await vscode.commands.executeCommand('vscode.open', testFileUri);
                // TODO: await doesn't work, consider adding a delay
                vscode.commands.executeCommand('testing.debugCurrentFile');
                await new Promise(resolve => setTimeout(resolve, this.executionDelay * 100));
                return true;
            }
            return await vscode.debug.startDebugging(workspaceFolder, config);
        } catch (error) {
            throw new Error(`Failed to start debugging: ${error}`);
        }
    }

    /**
     * Stop the debugging session
     */
    public async stopDebugging(session?: vscode.DebugSession): Promise<void> {
        try {
            const activeSession = session || vscode.debug.activeDebugSession;
            if (activeSession) {
                await vscode.debug.stopDebugging(activeSession);
            }
        } catch (error) {
            throw new Error(`Failed to stop debugging: ${error}`);
        }
    }

    /**
     * Execute step over command
     */
    public async stepOver(): Promise<void> {
        try {
            await this.executeDebugCommand('workbench.action.debug.stepOver');
        } catch (error) {
            throw new Error(`Failed to step over: ${error}`);
        }
    }

    /**
     * Execute step into command
     */
    public async stepInto(): Promise<void> {
        try {
            await this.executeDebugCommand('workbench.action.debug.stepInto');
        } catch (error) {
            throw new Error(`Failed to step into: ${error}`);
        }
    }

    /**
     * Execute step out command
     */
    public async stepOut(): Promise<void> {
        try {
            await this.executeDebugCommand('workbench.action.debug.stepOut');
        } catch (error) {
            throw new Error(`Failed to step out: ${error}`);
        }
    }

    /**
     * Execute continue command
     */
    public async continue(): Promise<void> {
        try {
            await this.executeDebugCommand('workbench.action.debug.continue');
        } catch (error) {
            throw new Error(`Failed to continue: ${error}`);
        }
    }

    /**
     * Execute restart command
     */
    public async restart(): Promise<void> {
        try {
            await this.executeDebugCommand('workbench.action.debug.restart');
        } catch (error) {
            throw new Error(`Failed to restart: ${error}`);
        }
    }

    /**
     * Add a breakpoint at specified location
     */
    public async addBreakpoint(uri: vscode.Uri, line: number): Promise<void> {
        try {
            const breakpoint = new vscode.SourceBreakpoint(
                new vscode.Location(uri, new vscode.Position(line - 1, 0))
            );
            vscode.debug.addBreakpoints([breakpoint]);
        } catch (error) {
            throw new Error(`Failed to add breakpoint: ${error}`);
        }
    }

    /**
     * Remove a breakpoint from specified location
     */
    public async removeBreakpoint(uri: vscode.Uri, line: number): Promise<void> {
        try {
            const breakpoints = vscode.debug.breakpoints.filter(bp => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    return bp.location.uri.toString() === uri.toString() && 
                           bp.location.range.start.line === line - 1;
                }
                return false;
            });
            
            if (breakpoints.length > 0) {
                vscode.debug.removeBreakpoints(breakpoints);
            }
        } catch (error) {
            throw new Error(`Failed to remove breakpoint: ${error}`);
        }
    }

    /**
     * Get current debugging state
     */
    public async getCurrentDebugState(numNextLines: number = 3): Promise<DebugState> {
        const state = new DebugState();
        
        try {
            const activeSession = vscode.debug.activeDebugSession;
            if (activeSession) {
                state.sessionActive = true;
                
                const activeStackItem = vscode.debug.activeStackItem;
                if (activeStackItem && 'frameId' in activeStackItem) {
                    state.updateContext(activeStackItem.frameId, activeStackItem.threadId);
                    
                    // Extract frame name from stack frame
                    await this.extractFrameName(activeSession, activeStackItem.frameId, state);
                    
                    // Get the active editor
                    const activeEditor = vscode.window.activeTextEditor;
                    if (activeEditor) {
                        const fileName = activeEditor.document.fileName.split(/[/\\]/).pop() || '';
                        const currentLine = activeEditor.selection.active.line + 1; // 1-based line number
                        const currentLineContent = activeEditor.document.lineAt(activeEditor.selection.active.line).text.trim();
                        
                        // Get next lines
                        const nextLines = [];
                        for (let i = 1; i <= numNextLines; i++) {
                            if (activeEditor.selection.active.line + i < activeEditor.document.lineCount) {
                                nextLines.push(activeEditor.document.lineAt(activeEditor.selection.active.line + i).text.trim());
                            }
                        }
                        
                        state.updateLocation(
                            activeEditor.document.fileName,
                            fileName,
                            currentLine,
                            currentLineContent,
                            nextLines
                        );
                    }
                }
            }
        } catch (error) {
            console.log('Unable to get debug state:', error);
        }
        
        return state;
    }

    /**
     * Extract frame name from the current stack frame
     */
    private async extractFrameName(session: vscode.DebugSession, frameId: number, state: DebugState): Promise<void> {
        try {
            // Get stack trace to extract frame name
            const stackTraceResponse = await session.customRequest('stackTrace', {
                threadId: state.threadId,
                startFrame: 0,
                levels: 1
            });

            if (stackTraceResponse?.stackFrames && stackTraceResponse.stackFrames.length > 0) {
                const currentFrame = stackTraceResponse.stackFrames[0];
                state.updateFrameName(currentFrame.name || null);
            }
        } catch (error) {
            console.log('Unable to extract frame name:', error);
            // Set empty frame name on error
            state.updateFrameName(null);
        }
    }

    /**
     * Get variables from the current debug context
     */
    public async getVariables(frameId: number, scope?: 'local' | 'global' | 'all'): Promise<any> {
        try {
            const activeSession = vscode.debug.activeDebugSession;
            if (!activeSession) {
                throw new Error('No active debug session');
            }

            const response = await activeSession.customRequest('scopes', { frameId });
            
            if (!response || !response.scopes || response.scopes.length === 0) {
                return { scopes: [] };
            }

            const filteredScopes = response.scopes.filter((scopeItem: any) => {
                if (scope === 'all') {return true;}
                const scopeName = scopeItem.name.toLowerCase();
                if (scope === 'local') {return scopeName.includes('local');}
                if (scope === 'global') {return scopeName.includes('global');}
                return true;
            });

            // Get variables for each scope
            for (const scopeItem of filteredScopes) {
                try {
                    const variablesResponse = await activeSession.customRequest('variables', {
                        variablesReference: scopeItem.variablesReference
                    });
                    scopeItem.variables = variablesResponse.variables || [];
                } catch (scopeError) {
                    scopeItem.variables = [];
                    scopeItem.error = scopeError;
                }
            }

            return { scopes: filteredScopes };
        } catch (error) {
            throw new Error(`Failed to get variables: ${error}`);
        }
    }

    /**
     * Evaluate an expression in the current debug context
     */
    public async evaluateExpression(expression: string, frameId: number): Promise<any> {
        try {
            const activeSession = vscode.debug.activeDebugSession;
            if (!activeSession) {
                throw new Error('No active debug session');
            }

            const response = await activeSession.customRequest('evaluate', {
                expression: expression,
                frameId: frameId,
                context: 'repl'
            });

            return response;
        } catch (error) {
            throw new Error(`Failed to evaluate expression: ${error}`);
        }
    }

    /**
     * Execute a debug command and wait for the debugger to update
     */
    private async executeDebugCommand(command: string): Promise<void> {
        const activeSession = vscode.debug.activeDebugSession;
        if (!activeSession) {
            throw new Error('No active debug session');
        }

        await vscode.commands.executeCommand(command);
        
        // Wait for debugger to update position
        await new Promise(resolve => setTimeout(resolve, this.executionDelay));
    }

    /**
     * Get all active breakpoints
     */
    public getBreakpoints(): readonly vscode.Breakpoint[] {
        return vscode.debug.breakpoints;
    }

    /**
     * Clear all breakpoints
     */
    public clearAllBreakpoints(): void {
        const breakpoints = vscode.debug.breakpoints;
        if (breakpoints.length > 0) {
            vscode.debug.removeBreakpoints(breakpoints);
        }
    }

    /**
     * Check if there's an active debug session
     */
    public hasActiveSession(): boolean {
        return vscode.debug.activeDebugSession !== undefined;
    }

    /**
     * Get the active debug session
     */
    public getActiveSession(): vscode.DebugSession | undefined {
        return vscode.debug.activeDebugSession;
    }
}
