import * as vscode from 'vscode';
import { IDebuggingExecutor } from './DebuggingExecutor';
import { IDebugConfigurationManager } from './utils/DebugConfigurationManager';
import { DebugState } from './DebugState';

/**
 * Interface for debugging handler operations
 */
export interface IDebuggingHandler {
    handleStartDebugging(args: { fileFullPath: string; workingDirectory?: string; configurationName?: string }): Promise<string>;
    handleStopDebugging(): Promise<string>;
    handleStepOver(): Promise<string>;
    handleStepInto(): Promise<string>;
    handleStepOut(): Promise<string>;
    handleContinue(): Promise<string>;
    handleRestart(): Promise<string>;
    handleAddBreakpoint(args: { fileFullPath: string; line: string }): Promise<string>;
    handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string>;
    handleListBreakpoints(): Promise<string>;
    handleGetVariables(args: { scope?: 'local' | 'global' | 'all' }): Promise<string>;
    handleEvaluateExpression(args: { expression: string }): Promise<string>;
}

/**
 * Handles debugging operations using the executor and configuration manager
 */
export class DebuggingHandler implements IDebuggingHandler {
    private readonly numNextLines: number = 3;

    constructor(
        private readonly executor: IDebuggingExecutor,
        private readonly configManager: IDebugConfigurationManager
    ) {}

    /**
     * Start a debugging session
     */
    public async handleStartDebugging(args: { 
        fileFullPath: string; 
        workingDirectory?: string; 
        configurationName?: string; 
    }): Promise<string> {
        const { fileFullPath, workingDirectory } = args;
        
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }
            
            let selectedConfigName = await this.configManager.promptForConfiguration(workspaceFolder);
            
            // Get debug configuration from launch.json or create default
            const debugConfig = await this.configManager.getDebugConfig(
                workspaceFolder, 
                fileFullPath, 
                workingDirectory, 
                selectedConfigName
            );

            const started = await this.executor.startDebugging(workspaceFolder, debugConfig);
            if (started) {
                // return also the current state
                const configInfo = selectedConfigName ? ` using configuration '${selectedConfigName}'` : ' with default configuration';
                const currentState = await this.executor.getCurrentDebugState(this.numNextLines);
                return `Debug session started successfully for: ${fileFullPath}${configInfo}. Current state: ${this.formatDebugState(currentState)}`;
            } else {
                throw new Error('Failed to start debug session. Make sure the appropriate language extension is installed.');
            }
        } catch (error) {
            throw new Error(`Error starting debug session: ${error}`);
        }
    }

    /**
     * Stop the current debugging session
     */
    public async handleStopDebugging(): Promise<string> {
        try {
            if (!this.executor.hasActiveSession()) {
                return 'No active debug session to stop';
            }

            const breakpointCount = this.executor.getBreakpoints().length;
            await this.executor.stopDebugging();

            // Clear breakpoints option
            let baseMessage = '';
            if (breakpointCount > 0) {
                this.executor.clearAllBreakpoints();
                baseMessage = `Debug session stopped successfully. Cleared ${breakpointCount} breakpoint(s).`;
            } else {
                baseMessage = 'Debug session stopped successfully';
            }

            // Add drill-down reminder
            return baseMessage + '\n\n' + this.getRootCauseAnalysisCheckpointMessage();
        } catch (error) {
            throw new Error(`Error stopping debug session: ${error}`);
        }
    }

    /**
     * Execute step over command(s)
     */
    public async handleStepOver(args?: { steps?: number }): Promise<string> {
        try {
            if (!this.executor.hasActiveSession()) {
                throw new Error('No active debug session');
            }

            await this.executor.stepOver();
            
            // Get the current debug state
            const debugState = await this.executor.getCurrentDebugState(this.numNextLines);
            
            // Format the debug state as a string
            return this.formatDebugState(debugState);
        } catch (error) {
            throw new Error(`Error executing step over: ${error}`);
        }
    }

    /**
     * Execute step into command
     */
    public async handleStepInto(): Promise<string> {
        try {
            if (!this.executor.hasActiveSession()) {
                throw new Error('No active debug session');
            }

            await this.executor.stepInto();
            
            // Get the current debug state
            const debugState = await this.executor.getCurrentDebugState(this.numNextLines);
            
            // Format the debug state as a string
            return this.formatDebugState(debugState);
        } catch (error) {
            throw new Error(`Error executing step into: ${error}`);
        }
    }

    /**
     * Execute step out command
     */
    public async handleStepOut(): Promise<string> {
        try {
            if (!this.executor.hasActiveSession()) {
                throw new Error('No active debug session');
            }

            await this.executor.stepOut();
            
            // Get the current debug state
            const debugState = await this.executor.getCurrentDebugState(this.numNextLines);
            
            // Format the debug state as a string
            return this.formatDebugState(debugState);
        } catch (error) {
            throw new Error(`Error executing step out: ${error}`);
        }
    }

    /**
     * Continue execution
     */
    public async handleContinue(): Promise<string> {
        try {
            if (!this.executor.hasActiveSession()) {
                throw new Error('No active debug session');
            }

            await this.executor.continue();
            
            // Get the current debug state
            const debugState = await this.executor.getCurrentDebugState(this.numNextLines);
            
            let result = this.formatDebugState(debugState);
            
            // If session ended (no location info), add drill-down reminder
            if (!debugState.sessionActive || !debugState.hasLocationInfo()) {
                result += '\n\n' + this.getRootCauseAnalysisCheckpointMessage();
            }
            
            return result;
        } catch (error) {
            throw new Error(`Error executing continue: ${error}`);
        }
    }

    /**
     * Restart the debugging session
     */
    public async handleRestart(): Promise<string> {
        try {
            if (!this.executor.hasActiveSession()) {
                throw new Error('No active debug session to restart');
            }

            await this.executor.restart();
            return 'Debug session restarted successfully';
        } catch (error) {
            throw new Error(`Error restarting debug session: ${error}`);
        }
    }

    /**
     * Add a breakpoint at specified location
     */
    public async handleAddBreakpoint(args: { fileFullPath: string; line: string }): Promise<string> {
        const { fileFullPath, line } = args;
        
        try {
            // Find the line number containing the line content
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fileFullPath));
            const text = document.getText();
            const lines = text.split(/\r?\n/);
            const matchingLineNumbers: number[] = [];
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(line)) {
                    matchingLineNumbers.push(i + 1); // Convert to 1-based line numbers
                }
            }
            
            if (matchingLineNumbers.length === 0) {
                throw new Error(`Could not find any lines containing: ${line}`);
            }
            
            const uri = vscode.Uri.file(fileFullPath);
            
            // Add breakpoints to all matching lines
            for (const lineNumber of matchingLineNumbers) {
                await this.executor.addBreakpoint(uri, lineNumber);
            }
            
            if (matchingLineNumbers.length === 1) {
                return `Breakpoint added at ${fileFullPath}:${matchingLineNumbers[0]}`;
            } else {
                const linesList = matchingLineNumbers.join(', ');
                return `Breakpoints added at ${matchingLineNumbers.length} locations in ${fileFullPath}: lines ${linesList}`;
            }
        } catch (error) {
            throw new Error(`Error adding breakpoint: ${error}`);
        }
    }

    /**
     * Remove a breakpoint from specified location
     */
    public async handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string> {
        const { fileFullPath, line } = args;
        
        try {
            const uri = vscode.Uri.file(fileFullPath);
            
            // Check if breakpoint exists at this location
            const breakpoints = this.executor.getBreakpoints();
            const existingBreakpoint = breakpoints.find(bp => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    return bp.location.uri.toString() === uri.toString() && 
                           bp.location.range.start.line === line - 1;
                }
                return false;
            });
            
            if (!existingBreakpoint) {
                return `No breakpoint found at ${fileFullPath}:${line}`;
            }
            
            await this.executor.removeBreakpoint(uri, line);
            return `Breakpoint removed from ${fileFullPath}:${line}`;
        } catch (error) {
            throw new Error(`Error removing breakpoint: ${error}`);
        }
    }

    /**
     * List all active breakpoints
     */
    public async handleListBreakpoints(): Promise<string> {
        try {
            const breakpoints = this.executor.getBreakpoints();
            
            if (breakpoints.length === 0) {
                return 'No breakpoints currently set';
            }

            let breakpointList = 'Active Breakpoints:\n';
            breakpoints.forEach((bp, index) => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    const fileName = bp.location.uri.fsPath.split(/[/\\]/).pop();
                    const line = bp.location.range.start.line + 1;
                    breakpointList += `${index + 1}. ${fileName}:${line}\n`;
                } else if (bp instanceof vscode.FunctionBreakpoint) {
                    breakpointList += `${index + 1}. Function: ${bp.functionName}\n`;
                }
            });

            return breakpointList;
        } catch (error) {
            throw new Error(`Error listing breakpoints: ${error}`);
        }
    }

    /**
     * Get variables from current debug context
     */
    public async handleGetVariables(args: { scope?: 'local' | 'global' | 'all' }): Promise<string> {
        const { scope = 'all' } = args;
        
        try {
            if (!this.executor.hasActiveSession()) {
                throw new Error('No active debug session. Start debugging first.');
            }

            const activeStackItem = vscode.debug.activeStackItem;
            if (!activeStackItem || !('frameId' in activeStackItem)) {
                throw new Error('No active stack frame. Make sure execution is paused at a breakpoint.');
            }

            const variablesData = await this.executor.getVariables(activeStackItem.frameId, scope);
            
            if (!variablesData.scopes || variablesData.scopes.length === 0) {
                return 'No variable scopes available at current execution point.';
            }

            let variablesInfo = 'Variables:\n==========\n\n';

            for (const scopeItem of variablesData.scopes) {
                variablesInfo += `${scopeItem.name}:\n`;
                
                if (scopeItem.error) {
                    variablesInfo += `  Error retrieving variables: ${scopeItem.error}\n`;
                } else if (scopeItem.variables && scopeItem.variables.length > 0) {
                    for (const variable of scopeItem.variables) {
                        variablesInfo += `  ${variable.name}: ${variable.value}`;
                        if (variable.type) {
                            variablesInfo += ` (${variable.type})`;
                        }
                        variablesInfo += '\n';
                    }
                } else {
                    variablesInfo += '  No variables in this scope\n';
                }
                
                variablesInfo += '\n';
            }

            return variablesInfo;
        } catch (error) {
            throw new Error(`Error getting variables: ${error}`);
        }
    }

    /**
     * Evaluate an expression in current debug context
     */
    public async handleEvaluateExpression(args: { expression: string }): Promise<string> {
        const { expression } = args;
        
        try {
            if (!this.executor.hasActiveSession()) {
                throw new Error('No active debug session. Start debugging first.');
            }

            const activeStackItem = vscode.debug.activeStackItem;
            if (!activeStackItem || !('frameId' in activeStackItem)) {
                throw new Error('No active stack frame. Make sure execution is paused at a breakpoint.');
            }

            const response = await this.executor.evaluateExpression(expression, activeStackItem.frameId);

            if (response && response.result !== undefined) {
                let resultText = `Expression: ${expression}\n`;
                resultText += `Result: ${response.result}`;
                if (response.type) {
                    resultText += ` (${response.type})`;
                }

                return resultText;
            } else {
                throw new Error('Failed to evaluate expression');
            }
        } catch (error) {
            throw new Error(`Error evaluating expression: ${error}`);
        }
    }

    /**
     * Format debug state as a readable string
     */
    private formatDebugState(state: DebugState): string {
        if (!state.sessionActive) {
            return 'Debug session is not active';
        }

        let output = 'Debug State:\n==========\n\n';
        
        if (state.hasFrameName()) {
            output += `Frame: ${state.frameName}\n`;
        }
        
        if (state.hasLocationInfo()) {
            output += `File: ${state.fileName}\n`;
            output += `Line: ${state.currentLine}\n`;        
            
            output += `${state.currentLine}: ${state.currentLineContent}\n`;
            
            // Show next few lines for context
            // if (state.nextLines && state.nextLines.length > 0) {
            //     output += '\nNext lines:\n';
            //     state.nextLines.forEach((line, index) => {
            //         const lineNumber = (state.currentLine || 0) + index + 1;
            //         output += `   ${lineNumber}: ${line}\n`;
            //     });
            // }
        } else {
            output += 'No location information available. The session might have stopped or ended\n';
        }
                
        return output;
    }
    
    /**
     * Get current debug state
     */
    public async getCurrentDebugState(): Promise<DebugState> {
        return await this.executor.getCurrentDebugState(this.numNextLines);
    }

    /**
     * Check if debugging session is active
     */
    public isDebuggingActive(): boolean {
        return this.executor.hasActiveSession();
    }

    /**
     * Get the universal drill-down reminder message
     */
    private getRootCauseAnalysisCheckpointMessage(): string {
        return `⚠️ **ROOT CAUSE ANALYSIS CHECKPOINT**

Before concluding your debugging session:

❓ **CRITICAL QUESTION:** Have you found the ROOT CAUSE or just a SYMPTOM?

🔍 **If you only identified WHERE it went wrong:**
- Variable is null/undefined
- Function returned unexpected value  
- Error occurred at specific line
- Condition evaluated incorrectly

➡️ **You likely found a SYMPTOM - Continue debugging!**

ROOT CAUSE means understanding WHY the issue occurred in the first place, for example due to:
- Incorrect variable initialization
- Logic error in function implementation
- Missing error handling
- Faulty assumptions in conditions

REQUIRED NEXT STEPS:
1. Use 'add_breakpoint' to set breakpoints at investigation points
2. Use 'start_debugging' to trace from the beginning
3. Investigate WHY the issue occurred, not just WHAT happened
4. Repite the process as necessary until the ROOT CAUSE is identified`;
    }
}
