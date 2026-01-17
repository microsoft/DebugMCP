// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { IDebugConfigurationManager } from './utils/debugConfigurationManager';
import { DebugState } from './debugState';
import { IDebuggingExecutor } from './debuggingExecutor';
import { logger } from './utils/logger';

/**
 * Interface for debugging handler operations
 */
export interface IDebuggingHandler {
    handleStartDebugging(args: { fileFullPath: string; workingDirectory: string; testName?: string }): Promise<string>;
    handleStopDebugging(): Promise<string>;
    handleStepOver(): Promise<string>;
    handleStepInto(): Promise<string>;
    handleStepOut(): Promise<string>;
    handleContinue(): Promise<string>;
    handleRestart(): Promise<string>;
    handleAddBreakpoint(args: { fileFullPath: string; lineContent: string }): Promise<string>;
    handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string>;
    handleClearAllBreakpoints(): Promise<string>;
    handleListBreakpoints(): Promise<string>;
    handleGetVariables(args: { scope?: 'local' | 'global' | 'all' }): Promise<string>;
    handleEvaluateExpression(args: { expression: string }): Promise<string>;
}

/**
 * Handles debugging operations using the executor and configuration manager
 */
export class DebuggingHandler implements IDebuggingHandler {
    private readonly numNextLines: number = 3;
    private readonly executionDelay: number = 300; // ms to wait for debugger updates
    private readonly timeoutInSeconds: number;

    constructor(
        private readonly executor: IDebuggingExecutor,
        private readonly configManager: IDebugConfigurationManager,
        timeoutInSeconds: number
    ) {
        this.timeoutInSeconds = timeoutInSeconds;
    }

    /**
     * Start a debugging session
     */
    public async handleStartDebugging(args: { 
        fileFullPath: string; 
        workingDirectory: string;
        testName?: string;
    }): Promise<string> {
        const { fileFullPath, workingDirectory, testName } = args;
        
        try {            
            let selectedConfigName = await this.configManager.promptForConfiguration(workingDirectory);
            
            // Get debug configuration from launch.json or create default
            const debugConfig = await this.configManager.getDebugConfig(
                workingDirectory, 
                fileFullPath, 
                selectedConfigName,
                testName
            );

            const started = await this.executor.startDebugging(workingDirectory, debugConfig);
            if (started) {
                // Wait for debug session to become active using exponential backoff
                const sessionActive = await this.waitForActiveDebugSession();
                
                if (!sessionActive) {
                    throw new Error('Debug session started but failed to become active within timeout period');
                }
                
                // return also the current state
                const configInfo = selectedConfigName ? ` using configuration '${selectedConfigName}'` : ' with default configuration';
                const testInfo = testName ? ` (test: ${testName})` : '';
                const currentState = await this.executor.getCurrentDebugState(this.numNextLines);
                return `Debug session started successfully for: ${fileFullPath}${configInfo}${testInfo}. Current state: ${this.formatDebugState(currentState)}`;
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
            if (!(await this.executor.hasActiveSession())) {
                return 'No active debug session to stop';
            }

            await this.executor.stopDebugging();

            // Add drill-down reminder
            return 'Debug session stopped successfully\n\n' + this.getRootCauseAnalysisCheckpointMessage();
        } catch (error) {
            throw new Error(`Error stopping debug session: ${error}`);
        }
    }

    /**
     * Clear all breakpoints
     */
    public async handleClearAllBreakpoints(): Promise<string> {
        try {
            const breakpointCount = this.executor.getBreakpoints().length;
            
            if (breakpointCount === 0) {
                return 'No breakpoints to clear';
            }

            this.executor.clearAllBreakpoints();
            return `Successfully cleared ${breakpointCount} breakpoint(s)`;
        } catch (error) {
            throw new Error(`Error clearing breakpoints: ${error}`);
        }
    }

    /**
     * Execute step over command(s)
     */
    public async handleStepOver(args?: { steps?: number }): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Please wait for initialization to complete.');
            }

            // Get the state before executing the command
            const beforeState = await this.executor.getCurrentDebugState(this.numNextLines);

            await this.executor.stepOver();
            
            // Wait for debugger state to change
            const afterState = await this.waitForStateChange(beforeState);

            // Format the debug state as a string
            return this.formatDebugState(afterState);
        } catch (error) {
            throw new Error(`Error executing step over: ${error}`);
        }
    }

    /**
     * Execute step into command
     */
    public async handleStepInto(): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Please wait for initialization to complete.');
            }

            // Get the state before executing the command
            const beforeState = await this.executor.getCurrentDebugState(this.numNextLines);

            await this.executor.stepInto();
            
            // Wait for debugger state to change
            const afterState = await this.waitForStateChange(beforeState);
            
            // Format the debug state as a string
            return this.formatDebugState(afterState);
        } catch (error) {
            throw new Error(`Error executing step into: ${error}`);
        }
    }

    /**
     * Execute step out command
     */
    public async handleStepOut(): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Please wait for initialization to complete.');
            }

            // Get the state before executing the command
            const beforeState = await this.executor.getCurrentDebugState(this.numNextLines);

            await this.executor.stepOut();
            
            // Wait for debugger state to change
            const afterState = await this.waitForStateChange(beforeState);
            
            // Format the debug state as a string
            return this.formatDebugState(afterState);
        } catch (error) {
            throw new Error(`Error executing step out: ${error}`);
        }
    }

    /**
     * Continue execution
     */
    public async handleContinue(): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Please wait for initialization to complete.');
            }

            // Get the state before executing the command
            const beforeState = await this.executor.getCurrentDebugState(this.numNextLines);

            await this.executor.continue();
            
            // Wait for debugger state to change
            const afterState = await this.waitForStateChange(beforeState);
            
            let result = this.formatDebugState(afterState);

            
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
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('No active debug session to restart');
            }

            await this.executor.restart();
            
            // Wait for debugger to restart
            await new Promise(resolve => setTimeout(resolve, this.executionDelay));

            return 'Debug session restarted successfully';
        } catch (error) {
            throw new Error(`Error restarting debug session: ${error}`);
        }
    }

    /**
     * Add a breakpoint at specified location
     */
    public async handleAddBreakpoint(args: { fileFullPath: string; lineContent: string }): Promise<string> {
        const { fileFullPath, lineContent } = args;
        
        try {
            // Find the line number containing the line content
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fileFullPath));
            const text = document.getText();
            const lines = text.split(/\r?\n/);
            const matchingLineNumbers: number[] = [];
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(lineContent)) {
                    matchingLineNumbers.push(i + 1); // Convert to 1-based line numbers
                }
            }
            
            if (matchingLineNumbers.length === 0) {
                throw new Error(`Could not find any lines containing: ${lineContent}`);
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
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Start debugging first and ensure execution is paused.');
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
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Start debugging first and ensure execution is paused.');
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
    public async isDebuggingActive(): Promise<boolean> {
        return await this.executor.hasActiveSession();
    }

    /**
     * Wait for debug session to become active using exponential backoff starting from 1 second
     */
    private async waitForActiveDebugSession(): Promise<boolean> {
        const baseDelay = 1000; // Start with 1 second
        const maxDelay = 10000; // Cap at 10 seconds
        
        const startTime = Date.now();
        let attempt = 0;
        
        while (Date.now() - startTime < this.timeoutInSeconds * 1000) {
            if (await this.executor.hasActiveSession()) {
                logger.info('Debug session is now active!');
                return true;
            }
            
            logger.info(`[Attempt ${attempt + 1}] Waiting for debug session to become active...`);

            // Calculate delay using exponential backoff with jitter
            const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            const jitteredDelay = delay + Math.random() * 200; // Add up to 200ms jitter
            
            await new Promise(resolve => setTimeout(resolve, jitteredDelay));
            attempt++;
        }
        
        return false; // Timeout reached
    }

    /**
     * Wait for debugger state to change from the initial state using exponential backoff
     */
    private async waitForStateChange(beforeState: DebugState): Promise<DebugState> {
        const baseDelay = 1000; // Start with 1 second
        const maxDelay = 1000; // Cap at 1 second
        const startTime = Date.now();
        let attempt = 0;
                
        while (Date.now() - startTime < this.timeoutInSeconds * 1000) {
            const currentState = await this.executor.getCurrentDebugState(this.numNextLines);
            
            if (this.hasStateChanged(beforeState, currentState)) {
                return currentState;
            }
            
            // If session ended, return immediately
            if (!currentState.sessionActive) {
                return currentState;
            }
            
            logger.info(`[Attempt ${attempt + 1}] Waiting for debugger state to change...`);

            // Calculate delay using exponential backoff with jitter (same as waitForActiveDebugSession)
            const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            const jitteredDelay = delay + Math.random() * 200; // Add up to 200ms jitter

            await new Promise(resolve => setTimeout(resolve, jitteredDelay));
            attempt++;
        }
        
        // If we timeout, return the current state (might be unchanged)
        logger.info('State change detection timed out, returning current state');
        return await this.executor.getCurrentDebugState(this.numNextLines);
    }

    /**
     * Determine if the debugger state has meaningfully changed
     */
    private hasStateChanged(beforeState: DebugState, afterState: DebugState): boolean {
        if (beforeState.hasLocationInfo() && !afterState.hasLocationInfo() && afterState.sessionActive) {
            return false;
        }

        // If session status changed, that's a meaningful change
        if (beforeState.sessionActive !== afterState.sessionActive) {
            return true;
        }
        
        // If session is no longer active, that's a change
        if (!afterState.sessionActive) {
            return true;
        }
        
        // If either state lacks location info, compare what we can
        if (!beforeState.hasLocationInfo() || !afterState.hasLocationInfo()) {
            // If one has location info and the other doesn't, that's a change
            return beforeState.hasLocationInfo() !== afterState.hasLocationInfo();
        }
        
        // Compare file paths - if we moved to a different file, that's a change
        if (beforeState.fileFullPath !== afterState.fileFullPath) {
            return true;
        }
        
        // Compare line numbers - if we moved to a different line, that's a change
        if (beforeState.currentLine !== afterState.currentLine) {
            return true;
        }
        
        // Compare frame names - if we moved to a different function/method, that's a change
        if (beforeState.frameName !== afterState.frameName) {
            return true;
        }
        
        // Compare frame IDs - internal frame change
        if (beforeState.frameId !== afterState.frameId) {
            return true;
        }
        
        // If we get here, no meaningful change was detected
        return false;
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
4. Repeat the process as necessary until the ROOT CAUSE is identified`;
    }
}
