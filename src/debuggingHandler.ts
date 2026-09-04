// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { DebugConfigurationManager, IDebugConfigurationManager } from './utils/debugConfigurationManager';
import { DebugState } from './debugState';
import { IDebuggingExecutor } from './debuggingExecutor';
import { logger } from './utils/logger';
import {
    isSensitiveExpression,
    isSensitiveName,
    redactExpressionResult,
    redactVariableValue,
    REDACTION_NOTICE,
    REDACTION_PLACEHOLDER
} from './utils/secretRedaction';

/**
 * Interface for debugging handler operations
 */
export interface IDebuggingHandler {
    handleStartDebugging(args: { fileFullPath: string; workingDirectory: string; testName?: string; configurationName?: string }): Promise<string>;
    handleStopDebugging(): Promise<string>;
    handleStepOver(): Promise<string>;
    handleStepInto(): Promise<string>;
    handleStepOut(): Promise<string>;
    handleContinue(): Promise<string>;
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
    handleGetDebugStatus(args?: { waitForPauseSeconds?: number }): Promise<string>;
}

/**
 * Render a debug state as a compact "file:line" for logs.
 *
 * A running (frameless) program has no location, which is a meaningful outcome
 * rather than missing data - it is exactly what a successful continue against a
 * server process looks like - so it gets its own label instead of "null:null".
 */
function describeLocation(state: DebugState): string {
    if (!state.sessionActive) {
        return '<session ended>';
    }
    if (!state.hasLocationInfo()) {
        return '<running, no frame>';
    }
    return `${state.fileName}:${state.currentLine}`;
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
    }): Promise<string> {
        const { fileFullPath, workingDirectory, testName, configurationName } = args;
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
                // RSpec needs its exact debugger CodeLens. Every other test
                // retains the original VS Code Testing API dispatch.
                const dispatch = await this.executor.debugTestAtCursor(fileFullPath, testName);
                started = dispatch.started;
                testRunComplete = dispatch.runComplete;
                configDescription = dispatch.description ?? 'testing.debugAtCursor';
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
                // Race the readiness signal against the test run completion. For .NET
                // (and any runner where onDidTerminateDebugSession doesn't fire
                // reliably for parent/child sessions), the test-run-complete signal
                // is what tells us a clean run finished without ever pausing.
                let readyState = testRunComplete
                    ? await Promise.race([
                        readyPromise,
                        testRunComplete.then(() => 'terminated' as const)
                    ])
                    : await readyPromise;

                logger.info(`handleStartDebugging: readyState=${readyState}, fetching current state…`);
                const testInfo = testName ? ` (test: ${testName})` : '';
                let currentState = await this.executor.getCurrentDebugState(this.numNextLines);

                // rdbg reports its debugger-entry pause before the requested
                // RSpec breakpoint. Continue that Ruby test debug session once
                // so start_debugging returns at the user's actual breakpoint.
                if (readyState === 'stopped' &&
                    testRunComplete &&
                    this.executor.getActiveSession()?.type.toLowerCase() === 'ruby_lsp' &&
                    this.shouldContinueToConfiguredBreakpoint(currentState)) {
                    const breakpointReady = this.executor.waitForDebugSessionReady(this.timeoutInSeconds * 1000);
                    await this.executor.continue();
                    readyState = await Promise.race([
                        breakpointReady,
                        testRunComplete.then(() => 'terminated' as const)
                    ]);
                    currentState = await this.executor.getCurrentDebugState(this.numNextLines);
                }

                logger.info('handleStartDebugging: got current state, returning response');

                switch (readyState) {
                    case 'stopped':
                        return `Debug session stopped at breakpoint for: ${fileFullPath} using ${configDescription}${testInfo}. Current state: ${currentState.toString()}`;
                    case 'attached':
                        return `Debug session attached to the running process for: ${fileFullPath} using ${configDescription}${testInfo}. The process keeps running until a breakpoint is hit - add breakpoints, then exercise the process. Current state: ${currentState.toString()}`;
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

    private shouldContinueToConfiguredBreakpoint(state: DebugState): boolean {
        if (!state.fileName || state.currentLine === null || state.breakpoints.length === 0) {
            return false;
        }

        const location = `${state.fileName}:${state.currentLine}`;
        return !state.breakpoints.some(breakpoint =>
            breakpoint === location || breakpoint.startsWith(`${location} [`));
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
     * Run one navigation command (step/continue/pause) and wait for it to land.
     *
     * These five handlers were byte-for-byte identical apart from the executor
     * call and the error prose, so they share one implementation. Crucially it
     * is also the single place that logs navigation: without this, a step or a
     * continue produced no log output whatsoever, and the only evidence that it
     * worked was the tool's own return value - which is no use when the question
     * being asked is whether that return value can be trusted.
     *
     * Each call logs where it started, where it landed, and how long it took, so
     * a session can be reconstructed from DebugMCP.log alone.
     */
    private async navigate(
        operation: string,
        run: () => Promise<void>,
        settleOnResume = false
    ): Promise<string> {
        try {
            if (!(await this.executor.hasActiveSession())) {
                throw new Error('Debug session is not ready. Please wait for initialization to complete.');
            }

            // Get the state before executing the command
            const beforeState = await this.executor.getCurrentDebugState(this.numNextLines);
            logger.info(`${operation}: from ${describeLocation(beforeState)}`);

            const startedAt = Date.now();
            await run();

            // Wait for the debugger to leave its current stop. For a step that
            // means the next frame; for a continue, "running again" is itself
            // the terminal state (see waitForStateChange).
            const afterState = await this.waitForStateChange(beforeState, settleOnResume);
            const elapsedMs = Date.now() - startedAt;

            logger.info(
                `${operation}: landed at ${describeLocation(afterState)} in ${elapsedMs}ms ` +
                    `(sessionActive=${afterState.sessionActive})`
            );

            return afterState.toString();
        } catch (error) {
            logger.warn(`${operation}: failed - ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Error executing ${operation}: ${error}`);
        }
    }

    /**
     * Execute step over command(s)
     */
    public async handleStepOver(args?: { steps?: number }): Promise<string> {
        return this.navigate('step over', () => this.executor.stepOver());
    }

    /**
     * Execute step into command
     */
    public async handleStepInto(): Promise<string> {
        return this.navigate('step into', () => this.executor.stepInto());
    }

    /**
     * Execute step out command
     */
    public async handleStepOut(): Promise<string> {
        return this.navigate('step out', () => this.executor.stepOut());
    }

    /**
     * Continue execution
     */
    public async handleContinue(): Promise<string> {
        return this.navigate('continue', () => this.executor.continue(), true);
    }

    /**
     * Report whether the debuggee is paused, optionally waiting for it to be.
     *
     * Without this there is no way to *ask* the question: callers had to infer
     * it from `get_variables_values`/`evaluate_expression` failing with "No
     * active stack frame", which conflates "still running" (fine, wait) with
     * "session is broken" (not fine), and `pause_execution` is not an option
     * because deliberately freezing a shared app pool to find out whether it
     * was already frozen is not a read-only question.
     *
     * Never throws for a healthy session and never times out the tool call: not
     * being paused is a legitimate answer, reported as `running`. When waiting,
     * it returns the instant the breakpoint lands, so the usual "arm breakpoint
     * then drive a request" sequence needs no polling and no sleep guesswork.
     */
    public async handleGetDebugStatus(args?: { waitForPauseSeconds?: number }): Promise<string> {
        // Clamp to the configured operation timeout: the router's forward
        // timeout and the tool backstop are both derived from it, so a longer
        // wait here would be killed in transit and surface as a spurious
        // "aborted" instead of the honest "still running".
        const requestedSeconds = Math.max(0, args?.waitForPauseSeconds ?? 0);
        const waitSeconds = Math.min(requestedSeconds, this.timeoutInSeconds);
        try {
            if (!(await this.executor.hasActiveSession())) {
                logger.info('debug status: no active session');
                return JSON.stringify({ status: 'no-session', paused: false, sessionActive: false }, null, 2);
            }

            const startedAt = Date.now();
            let state = await this.executor.getCurrentDebugState(this.numNextLines);
            if (waitSeconds > 0 && state.sessionActive && !state.hasLocationInfo()) {
                state = await this.waitForPause(waitSeconds * 1000);
            }

            const paused = state.sessionActive && state.hasLocationInfo();
            logger.info(
                `debug status: ${paused ? 'paused' : 'running'} at ${describeLocation(state)} ` +
                    `after ${Date.now() - startedAt}ms (waited up to ${waitSeconds}s)`
            );

            // One envelope for every outcome: a machine consumer should not have
            // to special-case the shape to find out whether it is paused.
            return JSON.stringify(
                {
                    status: paused ? 'paused' : state.sessionActive ? 'running' : 'no-session',
                    paused,
                    sessionActive: state.sessionActive,
                    configurationName: state.configurationName,
                    breakpoints: state.breakpoints,
                    requestedWaitSeconds: requestedSeconds,
                    effectiveWaitSeconds: waitSeconds,
                    state: paused ? JSON.parse(state.toString()) : undefined,
                    hint: paused
                        ? undefined
                        : waitSeconds < requestedSeconds
                          ? `The wait was clamped to the configured operation timeout of ${waitSeconds}s. The debuggee had not hit a breakpoint by then; call get_debug_status again to keep waiting.`
                          : state.sessionActive
                            ? 'The debuggee is running and has not hit a breakpoint. Trigger the code path, then call get_debug_status again with waitForPauseSeconds to block until it does.'
                            : 'No debug session is active. Call start_debugging first.'
                },
                null,
                2
            );
        } catch (error) {
            logger.warn(`debug status: failed - ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Error getting debug status: ${error}`);
        }
    }

    /**
     * Resolve as soon as the debuggee stops, or after `timeoutMs` if it doesn't.
     *
     * A timeout here is an ordinary outcome ("still running"), not a failure, so
     * it resolves with the current state rather than rejecting.
     */
    private async waitForPause(timeoutMs: number): Promise<DebugState> {
        const subscriptions: vscode.Disposable[] = [];
        try {
            await new Promise<void>(resolve => {
                let settled = false;
                const settle = (reason: string) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    logger.info(`waitForPause: settled on ${reason}`);
                    clearTimeout(timer);
                    resolve();
                };

                const timer = setTimeout(() => settle('timeout (still running)'), timeoutMs);

                // Subscribe before the fast-path check so a stop landing during
                // that async check cannot slip through unobserved.
                subscriptions.push(
                    vscode.debug.onDidChangeActiveStackItem(stackItem => {
                        if (stackItem && 'frameId' in stackItem) {
                            settle('breakpoint hit');
                        }
                    })
                );
                subscriptions.push(
                    vscode.debug.onDidTerminateDebugSession(() => {
                        if (!vscode.debug.activeDebugSession) {
                            settle('session terminated');
                        }
                    })
                );

                void this.executor.getCurrentDebugState(this.numNextLines).then(currentState => {
                    if (!currentState.sessionActive || currentState.hasLocationInfo()) {
                        settle('fast path');
                    }
                });
            });
        } finally {
            subscriptions.forEach(d => d.dispose());
        }
        return this.executor.getCurrentDebugState(this.numNextLines);
    }

    /**
     * Pause execution — interrupt a running program so it stops at its current
     * location. Unlike a breakpoint, this works even when no breakpoint is set
     * (e.g. a busy loop or an embedded/bare-metal target that is running freely).
     */
    public async handlePause(): Promise<string> {
        return this.navigate('pause', () => this.executor.pause());
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
            return `Breakpoint added at ${fileFullPath}:${line}${conditionInfo}${await this.sessionCaveat()}`;
        } catch (error) {
            throw new Error(`Error adding breakpoint: ${error}`);
        }
    }

    /**
     * Warn when a breakpoint is registered with no debug session attached.
     *
     * VS Code accepts breakpoints with no session at all, so "Breakpoint added"
     * reads as confirmation that debugging is live when it is not. The failure
     * then surfaces much later, as an unrelated-looking error on the first
     * inspection call, after the caller has already waited for a code path that
     * was never going to pause.
     */
    private async sessionCaveat(): Promise<string> {
        try {
            if (await this.executor.hasActiveSession()) {
                return '';
            }
        } catch {
            return '';
        }
        return (
            '\n\nWARNING: no debug session is currently active, so this breakpoint will not pause anything yet. ' +
            'Call start_debugging first, then confirm with get_debug_status.'
        );
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
            return `Logpoint added at ${fileFullPath}:${line}${conditionInfo}${await this.sessionCaveat()}`;
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
    private readonly maxVariableExpansionDepth: number = 6;
    private readonly maxExpandedFields: number = 100;

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

    private static redactionVariableName(variable: any, canonicalName: string): string {
        const displayName = typeof variable?.name === 'string' ? variable.name : canonicalName;
        const canonicalMember = canonicalName.match(/(?:^|\.|->)([A-Za-z_][A-Za-z0-9_]*)$/);
        if (canonicalMember) {
            return canonicalMember[1];
        }

        const displayMember = displayName.match(/(?:^|\.|->)([A-Za-z_][A-Za-z0-9_]*)$/);
        return displayMember?.[1] ?? displayName;
    }

    private static displayVariableType(variable: any): string | undefined {
        if (typeof variable?.type !== 'string') {
            return undefined;
        }

        // Cortex-Debug appends index and numeric renderings to scalar types:
        // "uint8_t 0;\ndec: 70\nhex: 0x46...".
        return variable.type.split(/\r?\n/, 1)[0].replace(/\s+\d+;$/, '').trim() || undefined;
    }

    private static isPointerLikeType(type: unknown): boolean {
        if (typeof type !== 'string') {
            return false;
        }
        return /[*&]\s*$/.test(type.split(/\r?\n/, 1)[0].trim());
    }

    /**
     * Some adapters expose implementation metadata as children of scalar
     * values. Ruby rdbg, for example, gives Integer and String values a
     * variablesReference for #class and other internals. Those references do
     * not make the user value an aggregate and should not hide its result.
     */
    private static isScalarLikeType(type: unknown): boolean {
        if (typeof type !== 'string') {
            return false;
        }

        const typeName = type.split(/\r?\n/, 1)[0].trim();
        return /^(?:Integer|Float|Rational|Complex|String|Symbol|TrueClass|FalseClass|NilClass|Regexp)$/.test(typeName);
    }

    private static isAdapterMetadataVariable(variable: any): boolean {
        return variable?.name === '#class' || variable?.name === '%ancestors';
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
            const expansionBudget = { remaining: this.maxExpandedFields };

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
                    const formatted = await this.formatVariableTree(
                        variable,
                        '  ',
                        0,
                        new Set<number>(),
                        true,
                        expansionBudget
                    );
                    variablesInfo += `${formatted.text}\n`;
                    redactedAny = redactedAny || formatted.redacted;
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
                const isComplex = response.variablesReference > 0 &&
                    !DebuggingHandler.isPointerLikeType(response.type) &&
                    !DebuggingHandler.isScalarLikeType(response.type);
                const expressionIsSensitive = isSensitiveExpression(expression);
                const { value, redacted } = isComplex
                    ? {
                        value: expressionIsSensitive ? REDACTION_PLACEHOLDER : '<complex value>',
                        redacted: expressionIsSensitive
                    }
                    : redactExpressionResult(expression, response.result);
                resultText += `Result: ${value}`;
                if (response.type) {
                    resultText += ` (${response.type})`;
                }
                if (!redacted && isComplex) {
                    const children = await this.formatVariableChildren(
                        response.variablesReference,
                        '  ',
                        1,
                        new Set<number>(),
                        { remaining: this.maxExpandedFields },
                        response
                    );
                    if (children.text) {
                        resultText += `\n${children.text}`;
                    }
                    if (children.redacted) {
                        resultText += `\n\n${REDACTION_NOTICE}`;
                    }
                }
                if (redacted) {
                    resultText += `\n\n${REDACTION_NOTICE}`;
                }

                return resultText;
            } else if (response && typeof response.output === 'string') {
                if (response.output.trim().length > 0) {
                    const { value, redacted } = redactExpressionResult(expression, response.output);
                    return `Expression: ${expression}\nResult: ${value}` +
                        (redacted ? `\n\n${REDACTION_NOTICE}` : '');
                }
                if (response.resultClass === 'done') {
                    throw new Error(
                        'The debug adapter reported success but returned no expression result or captured output.'
                    );
                }
                throw new Error(
                    `The debug adapter returned no expression result (resultClass: ${response.resultClass || 'unknown'}).`
                );
            } else {
                throw new Error('The debug adapter returned no expression result.');
            }
        } catch (error) {
            throw new Error(`Error evaluating expression: ${error}`);
        }
    }

    private async formatVariableTree(
        variable: any,
        indent: string,
        depth: number,
        visitedReferences: Set<number>,
        includeValue: boolean,
        expansionBudget: { remaining: number }
    ): Promise<{ text: string; redacted: boolean }> {
        const name = DebuggingHandler.canonicalVariableName(variable);
        let text = `${indent}${name}`;
        let redacted = false;
        const variablesReference = Number(variable.variablesReference) || 0;
        const isComplex = variablesReference > 0 &&
            !DebuggingHandler.isPointerLikeType(variable.type) &&
            !DebuggingHandler.isScalarLikeType(variable.type);
        if (includeValue && isComplex) {
            const redactionName = DebuggingHandler.redactionVariableName(variable, name);
            if (isSensitiveName(redactionName)) {
                text += `: ${REDACTION_PLACEHOLDER}`;
                redacted = true;
            }
        } else if (includeValue) {
            const redactionName = DebuggingHandler.redactionVariableName(variable, name);
            const result = redactVariableValue(redactionName, variable.value);
            text += `: ${result.value}`;
            redacted = result.redacted;
        }
        const type = DebuggingHandler.displayVariableType(variable);
        if (type) {
            text += ` (${type})`;
        }

        if (!redacted && isComplex) {
            const children = await this.formatVariableChildren(
                variablesReference,
                `${indent}  `,
                depth + 1,
                visitedReferences,
                expansionBudget,
                variable
            );
            if (children.text) {
                text += `\n${children.text}`;
            }
            return { text, redacted: children.redacted };
        }

        return { text, redacted };
    }

    private async formatVariableChildren(
        variablesReference: number,
        indent: string,
        depth: number,
        visitedReferences: Set<number>,
        expansionBudget: { remaining: number },
        parent: any = {}
    ): Promise<{ text: string; redacted: boolean }> {
        if (depth > this.maxVariableExpansionDepth) {
            return { text: `${indent}<maximum expansion depth reached>`, redacted: false };
        }
        if (visitedReferences.has(variablesReference)) {
            return { text: `${indent}<cyclic reference>`, redacted: false };
        }

        const nextVisited = new Set(visitedReferences);
        nextVisited.add(variablesReference);
        const children = (await this.executor.getVariableChildren(variablesReference, {
            indexedVariables: parent.indexedVariables
        })).filter(child => !DebuggingHandler.isAdapterMetadataVariable(child));
        const rendered: string[] = [];
        let redacted = false;
        let renderedChildren = 0;

        for (const child of children) {
            if (expansionBudget.remaining === 0) {
                break;
            }
            expansionBudget.remaining--;
            renderedChildren++;
            const formatted = await this.formatVariableTree(
                child,
                indent,
                depth,
                nextVisited,
                false,
                expansionBudget
            );
            rendered.push(formatted.text);
            redacted = redacted || formatted.redacted;
        }
        if (children.length > renderedChildren) {
            rendered.push(`${indent}<${children.length - renderedChildren} more child variable(s)>`);
        }

        return { text: rendered.join('\n'), redacted };
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
     *
     * `settleOnResume` (continue only) additionally treats "running again, no
     * stack frame" as a terminal state. `hasStateChanged` deliberately reports
     * paused -> running as "no change" so that a step isn't settled by the
     * transient frameless moment mid-step; for a continue, though, that state
     * is the successful outcome, and a process that keeps running (a server, an
     * event loop) never produces the next frame the step path waits for.
     */
    private async waitForStateChange(beforeState: DebugState, settleOnResume = false): Promise<DebugState> {
        const timeoutMs = this.timeoutInSeconds * 1000;
        const subscriptions: vscode.Disposable[] = [];
        const operatingSession = this.executor.getActiveSession();
        let operatingSessionTerminated = false;

        try {
            await new Promise<void>(resolve => {
                let settled = false;
                const settle = (reason: string) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    logger.info(`waitForStateChange: settled on ${reason}`);
                    clearTimeout(timer);
                    resolve();
                };

                const timer = setTimeout(() => {
                    logger.info('State change detection timed out, returning current state');
                    settle('timeout');
                }, timeoutMs);

                // Register listeners BEFORE the fast-path check so a stop that
                // lands during that async check can't slip through unobserved.
                subscriptions.push(
                    vscode.debug.onDidChangeActiveStackItem(stackItem => {
                        // A newly focused stack frame is the signal that the
                        // step/continue has landed at its next stop.
                        if (stackItem && 'frameId' in stackItem) {
                            settle('new stack frame');
                        } else if (settleOnResume && !stackItem) {
                            // Continue only: the active stack item being cleared
                            // means the program resumed. That IS the terminal
                            // state for a continue against a process that keeps
                            // running (a server, an event loop) and will never
                            // stop again on its own.
                            settle('program resumed');
                        }
                    })
                );
                subscriptions.push(
                    vscode.debug.onDidTerminateDebugSession(session => {
                        // continue/step that runs the program to completion.
                        if (operatingSession && session.id === operatingSession.id) {
                            operatingSessionTerminated = true;
                            settle('session terminated');
                        } else if (!vscode.debug.activeDebugSession) {
                            settle('no active session');
                        }
                    })
                );

                // Fast path: the step/continue may already have landed by the
                // time we subscribed (e.g. a trivial single-line step), or the
                // program may already be running again after a continue.
                void this.executor.getCurrentDebugState(this.numNextLines).then(currentState => {
                    const resumed = settleOnResume && currentState.sessionActive && !currentState.hasLocationInfo();
                    if (this.hasStateChanged(beforeState, currentState) || !currentState.sessionActive || resumed) {
                        settle('fast path');
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
