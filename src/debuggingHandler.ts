// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { DebugConfigurationManager, IDebugConfigurationManager } from './utils/debugConfigurationManager';
import { DebugState } from './debugState';
import { IDebuggingExecutor } from './debuggingExecutor';
import { logger } from './utils/logger';
import { redactExpressionResult, redactVariableValue, REDACTION_NOTICE } from './utils/secretRedaction';

/**
 * Interface for debugging handler operations
 */
export interface IDebuggingHandler {
    handleStartDebugging(args: { fileFullPath: string; workingDirectory: string; testName?: string; configurationName?: string; noWait?: boolean }): Promise<string>;
    handleStopDebugging(): Promise<string>;
    handleStepOver(): Promise<string>;
    handleStepInto(): Promise<string>;
    handleStepOut(): Promise<string>;
    handleContinue(args?: { noWait?: boolean }): Promise<string>;
    handlePause(): Promise<string>;
    handleRestart(): Promise<string>;
    handleAddBreakpoint(args: { fileFullPath: string; line: number; condition?: string }): Promise<string>;
    handleAddLogpoint(args: { fileFullPath: string; line: number; logMessage: string; condition?: string }): Promise<string>;
    handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string>;
    handleClearAllBreakpoints(): Promise<string>;
    handleListBreakpoints(): Promise<string>;
    handleGetVariables(args: { variableNames: string[]; scope?: 'local' | 'global' | 'all' }): Promise<string>;
    handleListVariableNames(args?: { scope?: 'local' | 'global' | 'all' }): Promise<string>;
    handleEvaluateExpression(args: { expression: string }): Promise<string>;
    handleGetDebugState(): Promise<string>;
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
        configurationName?: string;
        noWait?: boolean;
    }): Promise<string> {
        const { fileFullPath, workingDirectory, testName, configurationName, noWait } = args;
        const hasExplicitConfig = !!configurationName &&
            configurationName.trim() !== '' &&
            configurationName !== DebugConfigurationManager.getAutoLaunchConfigName();
		
        try {
            logger.info(`handleStartDebugging: file=${fileFullPath} test=${testName ?? '<none>'} config=${configurationName ?? '<auto>'}`);

            // Start listening BEFORE we trigger the debug session, otherwise
            // `onDidStartDebugSession` / `onDidChangeActiveStackItem` can fire
            // during the trigger call (testing.debugAtCursor / vscode.debug.startDebugging
            // can resolve only after the session is already up) and we'd miss them.
            const readyPromise = this.executor.waitForDebugSessionReady(this.timeoutInSeconds * 1000);

            let started: boolean;
            let configDescription: string;
            let testRunComplete: Promise<void> | undefined;

            if (testName && !hasExplicitConfig) {
                // Route through VS Code's Testing API. This works for any language
                // whose extension registers a TestController and correctly handles
                // child-process attach for runners like `dotnet test`.
                const dispatch = await this.executor.debugTestAtCursor(fileFullPath, testName);
                started = dispatch.started;
                testRunComplete = dispatch.runComplete;
                configDescription = `testing.debugAtCursor (test: ${testName})`;
            } else {
                const debugConfig = await this.configManager.getDebugConfig(
                    workingDirectory,
                    fileFullPath,
                    configurationName
                );
                started = await this.executor.startDebugging(workingDirectory, debugConfig);
                const configName = typeof debugConfig === 'string' ? debugConfig : debugConfig.name;
                configDescription = configName ? `configuration '${configName}'` : 'default configuration';
            }

            if (started) {
                if (noWait) {
                    return `Debug session started (noWait=true) for: ${fileFullPath} using ${configDescription}. The session is running in the background.`;
                }

                // Race the readiness signal against the test run completion. For .NET
                // (and any runner where onDidTerminateDebugSession doesn't fire
                // reliably for parent/child sessions), the test-run-complete signal
                // is what tells us a clean run finished without ever pausing.
                const readyState = testRunComplete
                    ? await Promise.race([
                        readyPromise,
                        testRunComplete.then(() => 'terminated' as const)
                    ])
                    : await readyPromise;

                logger.info(`handleStartDebugging: readyState=${readyState}, fetching current state…`);
                const testInfo = testName ? ` (test: ${testName})` : '';
                const currentState = await this.executor.getCurrentDebugState(this.numNextLines);
                logger.info('handleStartDebugging: got current state, returning response');

                switch (readyState) {
                    case 'stopped':
                        return `Debug session stopped at breakpoint for: ${fileFullPath} using ${configDescription}${testInfo}. Current state: ${currentState.toString()}`;
                    case 'terminated':
                        return `Debug session for ${fileFullPath} ran to completion without stopping (no breakpoint hit). Using ${configDescription}${testInfo}. Final state: ${currentState.toString()}`;
                    case 'no-session':
                        throw new Error('Debug session failed to start within the timeout period. Make sure the appropriate language extension is installed and any required build step succeeded.');
                    case 'timeout':
                        return `Debug session is running but did not stop or terminate within the timeout for: ${fileFullPath} using ${configDescription}${testInfo}. Current state: ${currentState.toString()}`;
                }
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

            return afterState.toString();
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
            
            return afterState.toString();
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
            
            return afterState.toString();
        } catch (error) {
            throw new Error(`Error executing step out: ${error}`);
        }
    }

    /**
     * Continue execution
     */
    public async handleContinue(args?: { noWait?: boolean }): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Please wait for initialization to complete.');
            }

            // Get the state before executing the command
            const beforeState = await this.executor.getCurrentDebugState(this.numNextLines);

            await this.executor.continue();
            
            if (args?.noWait) {
                return "Execution continued (noWait=true). The program is running in the background.";
            }

            // Wait for debugger state to change
            const afterState = await this.waitForStateChange(beforeState);
            
            return afterState.toString();
        } catch (error) {
            throw new Error(`Error executing continue: ${error}`);
        }
    }

    /**
     * Pause execution — interrupt a running program so it stops at its current
     * location. Unlike a breakpoint, this works even when no breakpoint is set
     * (e.g. a busy loop or an embedded/bare-metal target that is running freely).
     */
    public async handlePause(): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Please wait for initialization to complete.');
            }

            // Get the state before executing the command
            const beforeState = await this.executor.getCurrentDebugState(this.numNextLines);

            await this.executor.pause();

            // Wait for the debugger to stop (pause raises a 'stopped' event)
            const afterState = await this.waitForStateChange(beforeState);

            return afterState.toString();
        } catch (error) {
            throw new Error(`Error executing pause: ${error}`);
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
     * Add a breakpoint at specified location. An optional condition makes it a
     * conditional breakpoint that only pauses when the expression is true.
     */
    public async handleAddBreakpoint(args: { fileFullPath: string; line: number; condition?: string }): Promise<string> {
        const { fileFullPath, line, condition } = args;

        try {
            if (!Number.isInteger(line) || line < 1) {
                throw new Error(`Invalid line number: ${line}. Provide a 1-based line number.`);
            }

            // Validate the line exists so we fail clearly instead of setting an
            // unbound breakpoint past the end of the file.
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fileFullPath));
            if (line > document.lineCount) {
                throw new Error(`Line ${line} is out of range: ${fileFullPath} has ${document.lineCount} lines.`);
            }

            const uri = vscode.Uri.file(fileFullPath);
            await this.executor.addBreakpoint(uri, line, condition);

            const conditionInfo = condition ? ` (condition: ${condition})` : '';
            return `Breakpoint added at ${fileFullPath}:${line}${conditionInfo}`;
        } catch (error) {
            throw new Error(`Error adding breakpoint: ${error}`);
        }
    }

    /**
     * Add a logpoint: a breakpoint that logs a message (with {expressions}
     * interpolated by the debug adapter) instead of pausing execution. An
     * optional condition only logs when the expression is true.
     */
    public async handleAddLogpoint(args: { fileFullPath: string; line: number; logMessage: string; condition?: string }): Promise<string> {
        const { fileFullPath, line, logMessage, condition } = args;

        try {
            if (!Number.isInteger(line) || line < 1) {
                throw new Error(`Invalid line number: ${line}. Provide a 1-based line number.`);
            }
            if (!logMessage) {
                throw new Error('A non-empty logMessage is required for a logpoint.');
            }

            // Validate the line exists so we fail clearly instead of setting an
            // unbound logpoint past the end of the file.
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fileFullPath));
            if (line > document.lineCount) {
                throw new Error(`Line ${line} is out of range: ${fileFullPath} has ${document.lineCount} lines.`);
            }

            const uri = vscode.Uri.file(fileFullPath);
            await this.executor.addBreakpoint(uri, line, condition, logMessage);

            const conditionInfo = condition ? ` (condition: ${condition})` : '';
            return `Logpoint added at ${fileFullPath}:${line}${conditionInfo}`;
        } catch (error) {
            throw new Error(`Error adding logpoint: ${error}`);
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
                    const conditionInfo = bp.condition ? ` (condition: ${bp.condition})` : '';
                    const kind = bp.logMessage ? `Logpoint` : `Breakpoint`;
                    const logInfo = bp.logMessage ? ` (log: ${bp.logMessage})` : '';
                    breakpointList += `${index + 1}. ${kind} ${fileName}:${line}${conditionInfo}${logInfo}\n`;
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
     * Maximum number of variable names accepted in a single request. Keeps the
     * tool a targeted lookup rather than a scope dump by another name.
     */
    private readonly maxRequestedVariables: number = 50;

    /**
     * Resolve the frame to inspect, failing with an actionable message when the
     * debugger is not paused.
     */
    private async requireActiveFrameId(): Promise<number> {
        if (!(await this.executor.hasActiveSession())) {
            throw new Error('Debug session is not ready. Start debugging first and ensure execution is paused.');
        }

        const activeStackItem = vscode.debug.activeStackItem;
        if (!activeStackItem || !('frameId' in activeStackItem)) {
            throw new Error('No active stack frame. Make sure execution is paused at a breakpoint.');
        }

        return activeStackItem.frameId;
    }

    /**
     * Validate the caller-supplied variable names. Explicit names are required:
     * returning every variable in scope hands the caller unrelated process
     * state it never asked for.
     */
    private normalizeRequestedNames(variableNames: string[] | undefined): string[] {
        if (!Array.isArray(variableNames) || variableNames.length === 0) {
            throw new Error(
                "'variableNames' is required: name the variables you want (e.g. ['user', 'response']). " +
                'Use list_variable_names to discover what is in scope without reading any values.'
            );
        }

        const names = variableNames
            .filter((name): name is string => typeof name === 'string')
            .map(name => name.trim())
            .filter(name => name.length > 0);

        if (names.length === 0) {
            throw new Error("'variableNames' contained no usable names.");
        }

        if (names.some(name => name === '*' || name.toLowerCase() === 'all')) {
            throw new Error(
                "Wildcards are not supported: name each variable explicitly, or call list_variable_names to see what is in scope."
            );
        }

        if (names.length > this.maxRequestedVariables) {
            throw new Error(
                `Too many variables requested (${names.length}, max ${this.maxRequestedVariables}). ` +
                'Inspect the ones relevant to your hypothesis instead of the whole scope.'
            );
        }

        return [...new Set(names)];
    }

    /**
     * The canonical name for a DAP variable: the one an agent can pass back to
     * `get_variables_values` or `evaluate_expression`.
     *
     * DAP splits these apart - `name` is for display and may carry an
     * adapter-specific decoration (C#/vsdbg reports `config [Dictionary]`),
     * while `evaluateName` is the real, evaluatable identifier. Prefer the
     * latter; fall back to `name` verbatim, never parsed.
     */
    private static canonicalVariableName(variable: any): string {
        const evaluateName = variable?.evaluateName;
        if (typeof evaluateName === 'string' && evaluateName.trim().length > 0) {
            return evaluateName.trim();
        }

        const rawName = variable?.name;
        return typeof rawName === 'string' ? rawName.trim() : rawName;
    }

    /**
     * Whether a DAP variable matches one of the requested names. Accepts the
     * canonical name and the display name, both compared exactly.
     */
    private static matchesRequestedName(variable: any, requestedNames: string[]): boolean {
        const rawName = variable?.name;
        if (typeof rawName === 'string' && requestedNames.includes(rawName)) {
            return true;
        }

        return requestedNames.includes(DebuggingHandler.canonicalVariableName(variable));
    }

    /**
     * List the variable names (and types) visible at the current execution
     * point, deliberately without any values, so an agent can discover what
     * exists and then request only the ones it needs.
     */
    public async handleListVariableNames(args: { scope?: 'local' | 'global' | 'all' } = {}): Promise<string> {
        const { scope = 'all' } = args;

        try {
            const frameId = await this.requireActiveFrameId();
            const variablesData = await this.executor.getVariables(frameId, scope);

            if (!variablesData.scopes || variablesData.scopes.length === 0) {
                return 'No variable scopes available at current execution point.';
            }

            let info = 'Variables in scope (names only - no values were read):\n';
            info += '=====================================================\n\n';

            for (const scopeItem of variablesData.scopes) {
                info += `${scopeItem.name}:\n`;

                if (scopeItem.error) {
                    info += `  Error retrieving variables: ${scopeItem.error}\n`;
                } else if (scopeItem.variables && scopeItem.variables.length > 0) {
                    for (const variable of scopeItem.variables) {
                        const name = DebuggingHandler.canonicalVariableName(variable);
                        info += `  ${name}${variable.type ? ` (${variable.type})` : ''}\n`;
                    }
                } else {
                    info += '  No variables in this scope\n';
                }

                info += '\n';
            }

            info += "Use get_variables_values with the names you need, e.g. { \"variableNames\": [\"user\"] }.\n";
            return info;
        } catch (error) {
            throw new Error(`Error listing variable names: ${error}`);
        }
    }

    /**
     * Get the values of specifically named variables in the current debug context.
     */
    public async handleGetVariables(args: { variableNames: string[]; scope?: 'local' | 'global' | 'all' }): Promise<string> {
        const { scope = 'all' } = args;
        const requestedNames = this.normalizeRequestedNames(args?.variableNames);

        try {
            const frameId = await this.requireActiveFrameId();
            const variablesData = await this.executor.getVariables(frameId, scope);
            
            if (!variablesData.scopes || variablesData.scopes.length === 0) {
                return 'No variable scopes available at current execution point.';
            }

            let variablesInfo = 'Variables:\n==========\n\n';
            let redactedAny = false;
            const foundNames = new Set<string>();

            for (const scopeItem of variablesData.scopes) {
                const matches = (scopeItem.variables || []).filter((variable: any) =>
                    DebuggingHandler.matchesRequestedName(variable, requestedNames));

                if (scopeItem.error) {
                    variablesInfo += `${scopeItem.name}:\n  Error retrieving variables: ${scopeItem.error}\n\n`;
                    continue;
                }

                if (matches.length === 0) {
                    continue;
                }

                variablesInfo += `${scopeItem.name}:\n`;
                for (const variable of matches) {
                    const name = DebuggingHandler.canonicalVariableName(variable);
                    foundNames.add(name);
                    if (typeof variable.name === 'string') {
                        // So a caller who asked by the raw adapter name is not
                        // then told that name was not found.
                        foundNames.add(variable.name);
                    }
                    const result = redactVariableValue(name, variable.value);
                    const value = result.value;
                    redactedAny = redactedAny || result.redacted;
                    variablesInfo += `  ${name}: ${value}`;
                    if (variable.type) {
                        variablesInfo += ` (${variable.type})`;
                    }
                    variablesInfo += '\n';
                }
                variablesInfo += '\n';
            }

            const missing = requestedNames.filter(name => !foundNames.has(name));
            if (foundNames.size === 0) {
                return `None of the requested variables (${requestedNames.join(', ')}) are visible at the current execution point. ` +
                    'Use list_variable_names to see what is in scope, or evaluate_expression for nested/computed values.\n';
            }
            if (missing.length > 0) {
                variablesInfo += `Not found in any scope: ${missing.join(', ')}. ` +
                    'They may be out of scope here, or nested inside an object - try evaluate_expression.\n';
            }

            if (redactedAny) {
                variablesInfo += `${REDACTION_NOTICE}\n`;
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
                const { value, redacted } = redactExpressionResult(expression, response.result);
                resultText += `Result: ${value}`;
                if (response.type) {
                    resultText += ` (${response.type})`;
                }
                if (redacted) {
                    resultText += `\n\n${REDACTION_NOTICE}`;
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
     * Get current debug state as string
     */
    public async handleGetDebugState(): Promise<string> {
        try {
            const state = await this.executor.getCurrentDebugState(this.numNextLines);
            return state.toString();
        } catch (error) {
            throw new Error(`Error getting debug state: ${error}`);
        }
    }

    /**
     * Get current debug state object
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
     * Wait for the debugger to reach a new stopped frame (or end the session)
     * after a step/continue, driven by VS Code debug events.
     *
     * The previous implementation polled `getCurrentDebugState` on a fixed ~1s
     * interval: it checked once immediately (almost always too early — the DAP
     * `stopped` event hasn't landed yet), then blind-slept ~1s before looking
     * again. That cost ~1s per step/continue even though the operation itself
     * completes in tens of milliseconds. There is no early-wakeup — a state
     * change 10ms into the sleep is ignored for the rest of the second.
     *
     * This version subscribes to the same events the start path already uses
     * (`onDidChangeActiveStackItem` for a new stopped frame, plus session
     * termination) so it reacts the instant the step lands. A fast-path check
     * covers the case where the step already completed before we got here, and
     * a timeout bounds the no-event/never-stops case.
     */
    private async waitForStateChange(beforeState: DebugState): Promise<DebugState> {
        const timeoutMs = this.timeoutInSeconds * 1000;
        const subscriptions: vscode.Disposable[] = [];
        const operatingSession = this.executor.getActiveSession();
        let operatingSessionTerminated = false;

        try {
            await new Promise<void>(resolve => {
                let settled = false;
                const settle = () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    resolve();
                };

                const timer = setTimeout(() => {
                    logger.info('State change detection timed out, returning current state');
                    settle();
                }, timeoutMs);

                // Register listeners BEFORE the fast-path check so a stop that
                // lands during that async check can't slip through unobserved.
                subscriptions.push(
                    vscode.debug.onDidChangeActiveStackItem(stackItem => {
                        // A newly focused stack frame is the signal that the
                        // step/continue has landed at its next stop.
                        if (stackItem && 'frameId' in stackItem) {
                            settle();
                        }
                    })
                );
                subscriptions.push(
                    vscode.debug.onDidTerminateDebugSession(session => {
                        // continue/step that runs the program to completion.
                        if (operatingSession && session.id === operatingSession.id) {
                            operatingSessionTerminated = true;
                            settle();
                        } else if (!vscode.debug.activeDebugSession) {
                            settle();
                        }
                    })
                );

                // Fast path: the step/continue may already have landed by the
                // time we subscribed (e.g. a trivial single-line step).
                void this.executor.getCurrentDebugState(this.numNextLines).then(currentState => {
                    if (this.hasStateChanged(beforeState, currentState) || !currentState.sessionActive) {
                        settle();
                    }
                });
            });
        } finally {
            subscriptions.forEach(d => d.dispose());
        }

        const afterState = await this.executor.getCurrentDebugState(this.numNextLines);
        // The operating session ended (program ran to completion). A lingering
        // parent session (e.g. the JS debug terminal) can leave a different
        // session reported as active, so reflect termination explicitly here.
        if (operatingSessionTerminated) {
            afterState.sessionActive = false;
        }
        return afterState;
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
