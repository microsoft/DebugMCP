// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { DebugState, StackFrame } from './debugState';
import { logger } from './utils/logger';
import { withTimeout } from './utils/withTimeout';

/**
 * Outcome of dispatching a test debugger through a matching CodeLens or
 * `testing.debugAtCursor`.
 *
 * `started` indicates the command was dispatched successfully.
 * `runComplete` resolves when the underlying test run *finishes* (pass, fail,
 * or aborted). For .NET this includes the `dotnet test` parent/testhost
 * teardown. The handler races this against waitForDebugSessionReady so a test
 * that runs to completion without hitting a breakpoint is reported as
 * 'terminated' immediately instead of waiting for the configured timeout.
 */
export interface TestDebugDispatch {
    started: boolean;
    runComplete: Promise<void>;
    description?: string;
}

export interface VariableChildrenOptions {
    indexedVariables?: number;
}

interface PositionedTest {
    uri: vscode.Uri;
    codeLensTarget: vscode.Position;
    target: vscode.Position;
}

export function findDebugCodeLens(
    codeLenses: readonly vscode.CodeLens[],
    target: vscode.Position,
    testName?: string
): vscode.CodeLens | undefined {
    const debuggerCodeLenses = codeLenses.filter(codeLens =>
        codeLens.command && /debug/i.test(codeLens.command.command)
    );
    const namedCodeLenses = testName
        ? debuggerCodeLenses.filter(codeLens => codeLensCommandMatchesTest(codeLens.command, testName))
        : [];
    const containingCodeLenses = debuggerCodeLenses.filter(codeLens => codeLens.range.contains(target));
    const sameLineCodeLenses = debuggerCodeLenses.filter(codeLens => codeLens.range.start.line === target.line);
    const candidates = namedCodeLenses.length > 0
        ? namedCodeLenses
        : containingCodeLenses.length > 0
            ? containingCodeLenses
            : sameLineCodeLenses;

    return candidates
        .sort((left, right) => rangeWeight(left.range) - rangeWeight(right.range))[0];
}

export function addRubyRspecProgram(
    command: vscode.Command,
    fileFullPath: string,
    line: number,
    rspecCommand: string
): vscode.Command {
    const existingProgram = command.arguments?.[2];
    if (
        command.command !== 'rubyLsp.debugTest' ||
        !fileFullPath.endsWith('_spec.rb') ||
        (typeof existingProgram === 'string' && existingProgram.trim().length > 0)
    ) {
        return command;
    }

    const args = [ ...(command.arguments ?? []) ];
    while (args.length < 2) {
        args.push(undefined);
    }
    args[2] = `${rspecCommand} ${fileFullPath}:${line}`;
    return { ...command, arguments: args };
}

export function rubyRspecDebugConfiguration(program: string): vscode.DebugConfiguration {
    return {
        type: 'ruby_lsp',
        name: 'Debug',
        request: 'launch',
        program,
        env: { DISABLE_SPRING: '1' }
    };
}

function codeLensCommandMatchesTest(command: vscode.Command | undefined, testName: string): boolean {
    return command?.arguments?.some(argument =>
        typeof argument === 'string' && (argument === testName || argument.endsWith(testName))
    ) ?? false;
}

function rangeWeight(range: vscode.Range): number {
    const lineSpan = range.end.line - range.start.line;
    const characterSpan = lineSpan === 0
        ? range.end.character - range.start.character
        : range.end.character + range.start.character;
    return lineSpan * 1_000_000 + characterSpan;
}

/**
 * Interface for debugging execution operations
 */
export interface IDebuggingExecutor {
    startDebugging(workingDirectory: string, config: string | vscode.DebugConfiguration): Promise<boolean>;
    debugTestAtCursor(fileFullPath: string, testName: string): Promise<TestDebugDispatch>;
    stopDebugging(session?: vscode.DebugSession): Promise<void>;
    stepOver(): Promise<void>;
    stepInto(): Promise<void>;
    stepOut(): Promise<void>;
    continue(): Promise<void>;
    pause(): Promise<void>;
    restart(): Promise<void>;
    addBreakpoint(uri: vscode.Uri, line: number, condition?: string, logMessage?: string): Promise<void>;
    removeBreakpoint(uri: vscode.Uri, line: number): Promise<void>;
    getCurrentDebugState(numNextLines: number): Promise<DebugState>;
    getVariables(frameId: number, scope?: 'local' | 'global' | 'all'): Promise<any>;
    getVariableChildren(variablesReference: number, options?: VariableChildrenOptions): Promise<any[]>;
    evaluateExpression(expression: string, frameId: number): Promise<any>;
    getBreakpoints(): readonly vscode.Breakpoint[];
    clearAllBreakpoints(): void;
    hasActiveSession(): Promise<boolean>;
    getActiveSession(): vscode.DebugSession | undefined;
    waitForDebugSessionReady(timeoutMs: number): Promise<'stopped' | 'terminated' | 'timeout' | 'no-session'>;
}

/**
 * Responsible for executing VS Code debugging commands and managing debug sessions
 */
export class DebuggingExecutor implements IDebuggingExecutor {

    // Cap each DAP request so an unresponsive adapter can't hang the caller.
    // Kept small relative to the router/tool backstops so it fails fast.
    private static readonly DAP_REQUEST_TIMEOUT_MS = 30_000;

    /**
     * Issue a DAP request with an upper time bound, rejecting if the adapter
     * doesn't respond in time.
     */
    private async dapRequest(
        session: vscode.DebugSession,
        command: string,
        args: unknown
    ): Promise<any> {
        return withTimeout(
            Promise.resolve(session.customRequest(command, args)),
            DebuggingExecutor.DAP_REQUEST_TIMEOUT_MS,
            () => new Error(
                `Debug adapter did not respond to '${command}' within ` +
                `${Math.round(DebuggingExecutor.DAP_REQUEST_TIMEOUT_MS / 1000)}s (it may be unresponsive).`
            )
        );
    }

    /**
     * Start a debugging session
     */
    public async startDebugging(
        workingDirectory: string, 
        config: string | vscode.DebugConfiguration
    ): Promise<boolean> {
        try {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workingDirectory));
            return await vscode.debug.startDebugging(workspaceFolder, config);
        } catch (error) {
            throw new Error(`Failed to start debugging: ${error}`);
        }
    }

    /**
     * Debug a single test through its debugger CodeLens when available, then
     * fall back to VS Code's Testing API.
     *
     * Works for any language whose extension registers a TestController
     * (Python, Jest/Mocha, JUnit, C# Dev Kit, Go, Rust, ...). This is the
     * only correct way to debug `dotnet test` and similar runners where
     * the actual test code runs in a child process — the language's test
     * integration handles the parent/child debugger attach.
     *
     * Implementation strategy:
     *  1. Open the file in an editor.
     *  2. Place the cursor on the test method's definition line.
     *  3. Execute the narrowest matching debugger CodeLens when the language
     *     extension publishes one.
     *  4. Otherwise execute the built-in `testing.debugAtCursor` command.
     *
     * The handler's existing readiness wait picks up the resulting session.
     */
    public async debugTestAtCursor(fileFullPath: string, testName: string): Promise<TestDebugDispatch> {
        const positioned = await this.positionCursorAtTest(fileFullPath, testName);
        if (!positioned) {
            throw new Error(
                `Could not locate test '${testName}' in ${fileFullPath}. ` +
                `Check the test name, or pass a launch.json configurationName instead.`
            );
        }

        const codeLensDispatch = await this.debugTestWithCodeLens(positioned, testName);
        if (codeLensDispatch) {
            return codeLensDispatch;
        }

        // Trigger test discovery before dispatching. Some controllers (notably
        // Python's) lazily discover tests on first Test Explorer open; without
        // this, testing.debugAtCursor silently no-ops because no TestItem exists
        // at the cursor yet. refreshTests typically resolves once discovery is
        // complete, but we add a small grace period for controllers that report
        // completion before all TestItems are registered.
        try {
            await vscode.commands.executeCommand('testing.refreshTests');
            await new Promise(resolve => setTimeout(resolve, 300));
        } catch {
            // Not fatal — debugAtCursor may still work if tests were already discovered.
        }

        // `testing.debugAtCursor` resolves only when the entire test run
        // *completes*, not when the debug session starts. We must not await
        // it here — if the test hits a breakpoint, awaiting would block the
        // handler forever. Instead, return the completion promise so the
        // handler can race it against waitForDebugSessionReady: a clean run
        // that never pauses will be reported as 'terminated' immediately.
        const runComplete = Promise.resolve(vscode.commands.executeCommand('testing.debugAtCursor'))
            .then(() => undefined)
            .catch(err => {
                logger.error(`testing.debugAtCursor failed: ${err}`);
            });
        return { started: true, runComplete, description: 'testing.debugAtCursor' };
    }

    private async debugTestWithCodeLens(
        positioned: PositionedTest,
        testName: string
    ): Promise<TestDebugDispatch | undefined> {
        let codeLenses: vscode.CodeLens[] | undefined;
        try {
            codeLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
                'vscode.executeCodeLensProvider',
                positioned.uri,
                1_000
            );
        } catch {
            return undefined;
        }

        const codeLens = findDebugCodeLens(codeLenses ?? [], positioned.codeLensTarget, testName);
        if (!codeLens?.command) {
            logger.info(
                `No debugger CodeLens found for test '${testName}'; ` +
                `the provider returned ${codeLenses?.length ?? 0} CodeLenses.`
            );
            return undefined;
        }

        let command = codeLens.command;
        if (command.command === 'rubyLsp.debugTest' && positioned.uri.fsPath.endsWith('_spec.rb')) {
            command = addRubyRspecProgram(
                command,
                positioned.uri.fsPath,
                codeLens.range.start.line + 1,
                await this.rubyLspRspecCommand(positioned.uri)
            );
        }
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.toString() === positioned.uri.toString()) {
            // Older CodeLens providers may resolve their command from the active
            // line. Modern Ruby LSP receives the exact program directly below;
            // the body line remains reserved for testing.debugAtCursor fallback.
            const selection = new vscode.Selection(codeLens.range.start, codeLens.range.start);
            editor.selection = selection;
            editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
        }

        const rubyRspecProgram = command.command === 'rubyLsp.debugTest'
            ? command.arguments?.[2]
            : undefined;
        if (typeof rubyRspecProgram === 'string' && rubyRspecProgram.length > 0) {
            logger.info(`Starting exact Ruby RSpec debugger: ${rubyRspecProgram}`);
            return this.startRubyRspecDebug(positioned.uri, rubyRspecProgram);
        }

        logger.info(`Dispatching test debugger through CodeLens command ${command.command}`);

        // A CodeLens command may resolve only after the entire test run, so do
        // not await it here before the debugger reaches its first stop.
        const runComplete = Promise.resolve(
            vscode.commands.executeCommand(command.command, ...(command.arguments ?? []))
        )
            .then(() => undefined)
            .catch(err => {
                logger.error(`Debugger CodeLens command ${command.command} failed: ${err}`);
            });

        return { started: true, runComplete, description: 'debugger CodeLens' };
    }

    private async startRubyRspecDebug(uri: vscode.Uri, program: string): Promise<TestDebugDispatch> {
        let targetSessionId: string | undefined;
        let resolveComplete: (() => void) | undefined;
        const runComplete = new Promise<void>(resolve => {
            resolveComplete = resolve;
        });
        const matches = (session: vscode.DebugSession) =>
            session.type === 'ruby_lsp' && session.configuration.program === program;
        const startSubscription = vscode.debug.onDidStartDebugSession(session => {
            if (matches(session)) {
                targetSessionId = session.id;
            }
        });
        const terminateSubscription = vscode.debug.onDidTerminateDebugSession(session => {
            if (session.id === targetSessionId) {
                cleanup();
                resolveComplete?.();
            }
        });
        const cleanup = () => {
            startSubscription.dispose();
            terminateSubscription.dispose();
        };

        try {
            const started = await vscode.debug.startDebugging(
                vscode.workspace.getWorkspaceFolder(uri),
                rubyRspecDebugConfiguration(program)
            );
            if (!started) {
                cleanup();
                throw new Error(`Failed to start exact RSpec debugging for ${program}`);
            }

            if (!targetSessionId && vscode.debug.activeDebugSession && matches(vscode.debug.activeDebugSession)) {
                targetSessionId = vscode.debug.activeDebugSession.id;
            }
            return { started: true, runComplete, description: 'debugger CodeLens' };
        } catch (error) {
            cleanup();
            throw error;
        }
    }

    private async rubyLspRspecCommand(uri: vscode.Uri): Promise<string> {
        const addonSettings = vscode.workspace
            .getConfiguration('rubyLsp', uri)
            .get<Record<string, { rspecCommand?: unknown }>>('addonSettings');
        const configuredCommand = addonSettings?.['Ruby LSP RSpec']?.rspecCommand;
        if (typeof configuredCommand === 'string' && configuredCommand.trim().length > 0) {
            return configuredCommand;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            return 'bundle exec rspec';
        }

        const binstub = await this.uriExists(vscode.Uri.joinPath(workspaceFolder.uri, 'bin', 'rspec'))
            ? 'bin/rspec'
            : 'rspec';
        return await this.uriExists(vscode.Uri.joinPath(workspaceFolder.uri, 'Gemfile'))
            ? `bundle exec ${binstub}`
            : binstub;
    }

    private async uriExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Open the file and move the active editor's cursor to the line that
     * defines `testName`. Tries language-aware patterns first, then falls
     * back to a literal substring search (covers JS/TS `it('name')` style
     * where the test name is a string literal, not an identifier).
     *
     * The cursor is placed on the test name itself (not on the preceding
     * `void`/`def`/etc. keyword) because some TestController implementations
     * — notably C# Dev Kit — register tight TestItem ranges around the
     * method name. A cursor outside that range causes testing.debugAtCursor
     * to fall back to the first test in the file.
     *
     * The cursor position is passed via the `selection` option to
     * showTextDocument so it's applied atomically with the open — separate
     * `editor.selection = ...` writes race testing.debugAtCursor.
     */
    private async positionCursorAtTest(fileFullPath: string, testName: string): Promise<PositionedTest | undefined> {
        const uri = vscode.Uri.file(fileFullPath);
        const doc = await vscode.workspace.openTextDocument(uri);

        const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = [
            // identifier-style definitions: def/void/func/fn/fun/etc NAME(
            new RegExp(`\\b(?:def|void|func|fn|fun|sub|Task|async|public|private|protected|internal|static)\\b[^\\n]*?\\b(${escaped})\\s*\\(`),
            // bare identifier followed by (
            new RegExp(`\\b(${escaped})\\s*\\(`),
            // last resort: any substring match (covers it('add two numbers', ...))
            new RegExp(`(${escaped})`)
        ];

        let target: vscode.Position | undefined;
        let codeLensTarget: vscode.Position | undefined;
        for (const pattern of patterns) {
            for (let i = 0; i < doc.lineCount; i++) {
                const line = doc.lineAt(i).text;
                const match = pattern.exec(line);
                if (match) {
                    codeLensTarget = new vscode.Position(i, match.index);
                    // Place cursor one line below the method signature, inside
                    // the body. The method-name line itself can be outside the
                    // TestItem range used by some test controllers (notably
                    // C# Dev Kit), causing testing.debugAtCursor to fall back
                    // to the first test in the file. Landing inside the body
                    // is reliably within the TestItem range across languages.
                    const bodyLine = Math.min(i + 1, doc.lineCount - 1);
                    const bodyText = doc.lineAt(bodyLine).text;
                    const indent = bodyText.match(/^\s*/)?.[0].length ?? 0;
                    target = new vscode.Position(bodyLine, indent);
                    break;
                }
            }
            if (target) {
                break;
            }
        }

        if (!target || !codeLensTarget) {
            return undefined;
        }

        const selection = new vscode.Range(target, target);
        const editor = await vscode.window.showTextDocument(doc, {
            selection,
            preserveFocus: false,
            preview: false
        });

        // Belt-and-suspenders: showTextDocument's `selection` option sets the
        // selection but doesn't always scroll the viewport, especially when the
        // editor was already open. Explicitly reveal to guarantee the cursor
        // line is visible (and, more importantly, is the active line).
        editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);

        // Wait until VS Code considers this editor active. testing.debugAtCursor
        // reads the active editor synchronously, so without this small wait the
        // command can race and pick whichever editor was previously focused.
        await this.waitForActiveEditor(uri);
        return { uri, codeLensTarget, target };
    }

    private async waitForActiveEditor(uri: vscode.Uri, timeoutMs = 1500): Promise<void> {
        const matches = (editor: vscode.TextEditor | undefined) =>
            editor?.document.uri.toString() === uri.toString();

        if (matches(vscode.window.activeTextEditor)) {
            return;
        }

        await new Promise<void>(resolve => {
            const timer = setTimeout(() => {
                disposable.dispose();
                resolve();
            }, timeoutMs);
            const disposable = vscode.window.onDidChangeActiveTextEditor(editor => {
                if (matches(editor)) {
                    clearTimeout(timer);
                    disposable.dispose();
                    resolve();
                }
            });
        });
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
            await vscode.commands.executeCommand('workbench.action.debug.stepOver');
        } catch (error) {
            throw new Error(`Failed to step over: ${error}`);
        }
    }

    /**
     * Execute step into command
     */
    public async stepInto(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.stepInto');
        } catch (error) {
            throw new Error(`Failed to step into: ${error}`);
        }
    }

    /**
     * Execute step out command
     */
    public async stepOut(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.stepOut');
        } catch (error) {
            throw new Error(`Failed to step out: ${error}`);
        }
    }

    /**
     * Execute continue command
     */
    public async continue(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.continue');
        } catch (error) {
            throw new Error(`Failed to continue: ${error}`);
        }
    }

    /**
     * Execute pause command — interrupt a running program so execution stops at
     * its current point (useful for embedded/bare-metal or busy-loop debugging
     * where there is no breakpoint to stop at).
     */
    public async pause(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.pause');
        } catch (error) {
            throw new Error(`Failed to pause: ${error}`);
        }
    }

    /**
     * Execute restart command
     */
    public async restart(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.restart');
        } catch (error) {
            throw new Error(`Failed to restart: ${error}`);
        }
    }

    /**
     * Add a breakpoint at specified location. An optional condition makes it a
     * conditional breakpoint that only pauses execution when the expression
     * evaluates to true. An optional logMessage makes it a logpoint that logs
     * the message (with {expressions} interpolated) instead of pausing.
     */
    public async addBreakpoint(uri: vscode.Uri, line: number, condition?: string, logMessage?: string): Promise<void> {
        try {
            const breakpoint = new vscode.SourceBreakpoint(
                new vscode.Location(uri, new vscode.Position(line - 1, 0)),
                true,
                condition,
                undefined,
                logMessage
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
                state.updateConfigurationName(activeSession.configuration.name ?? null);
                
                const activeStackItem = vscode.debug.activeStackItem;
                if (activeStackItem && 'frameId' in activeStackItem) {
                    state.updateContext(activeStackItem.frameId, activeStackItem.threadId);

                    // Pull the current location from the debug adapter's top stack
                    // frame (via stackTrace) instead of scraping the active text
                    // editor. VS Code updates the editor cursor/selection
                    // asynchronously after a stop and only for the focused editor,
                    // so reading it here was both racy (it lagged the actual stop)
                    // and wrong when focus was elsewhere — the source of stale
                    // "current line" reports. The DAP frame is ground truth.
                    const topFrame = await this.extractFrameName(activeSession, activeStackItem.frameId, state);

                    if (topFrame?.path && typeof topFrame.line === 'number') {
                        await this.populateLocationFromFrame(state, topFrame.path, topFrame.line, numNextLines);
                    }
                }
            }
        } catch (error) {
            console.log('Unable to get debug state:', error);
        }
        
        // Populate breakpoints as compact "fileName:line" strings
        const breakpoints = vscode.debug.breakpoints;
        const formattedBreakpoints = breakpoints
            .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
            .map(bp => {
                const fileName = bp.location.uri.fsPath.split(/[/\\]/).pop() || 'unknown';
                const line = bp.location.range.start.line + 1;
                const base = `${fileName}:${line}`;
                return bp.condition ? `${base} [when: ${bp.condition}]` : base;
            });
        state.updateBreakpoints(formattedBreakpoints);

        return state;
    }

    /**
     * Extract frame name and stack trace from the current debug session.
     *
     * Returns the top frame's source location ({ path, line, column }) so the
     * caller can report the authoritative current position without scraping the
     * editor. Returns undefined if no stack frame is available.
     */
    private async extractFrameName(
        session: vscode.DebugSession,
        frameId: number,
        state: DebugState
    ): Promise<{ path?: string; line?: number; column?: number } | undefined> {
        try {
            const stackTraceResponse = await this.dapRequest(session, 'stackTrace', {
                threadId: state.threadId,
                startFrame: 0,
                levels: 50
            });

            if (stackTraceResponse?.stackFrames && stackTraceResponse.stackFrames.length > 0) {
                // Extract frame name from current frame
                const currentFrame = stackTraceResponse.stackFrames[0];
                state.updateFrameName(currentFrame.name || null);

                // Build stack trace array
                const stackTrace: StackFrame[] = stackTraceResponse.stackFrames.map((frame: any) => ({
                    name: frame.name || 'unknown',
                    source: frame.source?.path || frame.source?.name || undefined,
                    line: frame.line || undefined,
                    column: frame.column || undefined,
                }));

                state.updateStackTrace(stackTrace);

                // DAP line/column are 1-based (VS Code's default). Hand the raw
                // top-frame location back to the caller for location reporting.
                return {
                    path: currentFrame.source?.path,
                    line: currentFrame.line,
                    column: currentFrame.column,
                };
            }
        } catch (error) {
            console.log('Unable to extract stack info:', error);
            // Set empty values on error
            state.updateFrameName(null);
            state.updateStackTrace([]);
        }
        return undefined;
    }

    /**
     * Populate the DebugState location (file, current line + content, and the
     * next few non-empty lines) by reading the source document at the debugger's
     * current frame line. Uses the DAP-reported path/line rather than the active
     * editor, so it's accurate regardless of which editor (if any) has focus.
     */
    private async populateLocationFromFrame(
        state: DebugState,
        filePath: string,
        line: number,
        numNextLines: number
    ): Promise<void> {
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            const zeroBasedLine = Math.max(0, Math.min(line - 1, doc.lineCount - 1));
            const fileName = filePath.split(/[/\\]/).pop() || '';
            const currentLineContent = doc.lineAt(zeroBasedLine).text.trim();

            // Collect the next non-empty lines for lookahead context.
            const nextLines: string[] = [];
            let lineOffset = 1;
            while (nextLines.length < numNextLines && zeroBasedLine + lineOffset < doc.lineCount) {
                const lineText = doc.lineAt(zeroBasedLine + lineOffset).text.trim();
                if (lineText.length > 0) {
                    nextLines.push(lineText);
                }
                lineOffset++;
            }

            state.updateLocation(filePath, fileName, line, currentLineContent, nextLines);
        } catch (error) {
            // Native/library frames or paths VS Code can't open won't resolve to
            // a document; degrade gracefully and leave location unset.
            console.log('Unable to read frame source document:', error);
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

            const response = await this.dapRequest(activeSession, 'scopes', { frameId });
            
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
                    const variablesResponse = await this.dapRequest(activeSession, 'variables', {
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
     * Expand a DAP variable reference. Kept separate from getVariables so the
     * handler only reads children for variables explicitly requested by the
     * caller, rather than recursively dumping every value in scope.
     */
    public async getVariableChildren(
        variablesReference: number,
        options: VariableChildrenOptions = {}
    ): Promise<any[]> {
        if (variablesReference <= 0) {
            return [];
        }

        try {
            const activeSession = vscode.debug.activeDebugSession;
            if (!activeSession) {
                throw new Error('No active debug session');
            }

            const indexedVariables = Number(options.indexedVariables) || 0;
            const response = await this.dapRequest(activeSession, 'variables', {
                variablesReference,
                ...(indexedVariables > 0 ? {
                    filter: 'indexed',
                    start: 0,
                    count: indexedVariables
                } : {})
            });
            return response?.variables || [];
        } catch (error) {
            throw new Error(`Failed to expand variable: ${error}`);
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

            if (activeSession.type.toLowerCase() === 'cortex-debug') {
                const memoryCommand = DebuggingExecutor.parseGdbMemoryCommand(expression);
                if (memoryCommand) {
                    return await this.evaluateGdbMemoryCommand(activeSession, memoryCommand, frameId);
                }

                const printCommand = DebuggingExecutor.parseGdbPrintCommand(expression);
                return await this.dapRequest(activeSession, 'evaluate', {
                    expression: printCommand?.expression ?? expression,
                    frameId,
                    context: 'watch',
                    ...(printCommand?.hex ? { format: { hex: true } } : {})
                });
            }

            const response = await this.dapRequest(activeSession, 'evaluate', {
                expression: expression,
                frameId: frameId,
                context: 'repl'
            });

            return response;
        } catch (error) {
            throw new Error(`Failed to evaluate expression: ${error}`);
        }
    }

    private static parseGdbPrintCommand(expression: string): { expression: string; hex: boolean } | undefined {
        const match = expression.match(/^\s*(?:p|print)(?:\/([a-z]+))?\s+([\s\S]+)$/i);
        if (!match) {
            return undefined;
        }

        return {
            expression: match[2].trim(),
            hex: (match[1] || '').toLowerCase().includes('x')
        };
    }

    private static parseGdbMemoryCommand(
        expression: string
    ): { addressExpression: string; count: number; unitSize: number } | undefined {
        const match = expression.match(/^\s*x\/(\d+)?([a-z]*)\s+([\s\S]+)$/i);
        if (!match) {
            return undefined;
        }

        const count = match[1] ? Number.parseInt(match[1], 10) : 1;
        const modifiers = (match[2] || '').toLowerCase();
        const unit = [...modifiers].find(modifier => ['b', 'h', 'w', 'g'].includes(modifier)) || 'w';
        const unitSizes: Record<string, number> = { b: 1, h: 2, w: 4, g: 8 };

        if (!Number.isSafeInteger(count) || count <= 0) {
            throw new Error(`Invalid GDB memory element count: ${match[1]}`);
        }

        const byteCount = count * unitSizes[unit];
        if (byteCount > 4096) {
            throw new Error(`GDB memory reads are limited to 4096 bytes (requested ${byteCount}).`);
        }

        return {
            addressExpression: match[3].trim(),
            count,
            unitSize: unitSizes[unit]
        };
    }

    private async evaluateGdbMemoryCommand(
        session: vscode.DebugSession,
        command: { addressExpression: string; count: number; unitSize: number },
        frameId: number
    ): Promise<any> {
        const addressResponse = await this.dapRequest(session, 'evaluate', {
            expression: command.addressExpression,
            frameId,
            context: 'watch'
        });
        const memoryReference = addressResponse?.memoryReference ||
            DebuggingExecutor.extractMemoryReference(addressResponse?.result) ||
            DebuggingExecutor.extractMemoryReference(command.addressExpression);

        if (!memoryReference) {
            throw new Error(
                `Could not resolve a memory address from '${command.addressExpression}'.`
            );
        }

        const byteCount = command.count * command.unitSize;
        const memoryResponse = await this.dapRequest(session, 'readMemory', {
            memoryReference,
            count: byteCount
        });
        if (typeof memoryResponse?.data !== 'string') {
            throw new Error('Debug adapter completed readMemory without returning data.');
        }

        const bytes = Buffer.from(memoryResponse.data, 'base64');
        const address = memoryResponse.address || memoryReference;
        const renderedBytes = [...bytes].map(byte => `0x${byte.toString(16).padStart(2, '0')}`).join(' ');
        const unreadable = memoryResponse.unreadableBytes
            ? ` (${memoryResponse.unreadableBytes} unreadable byte(s))`
            : '';

        return {
            result: `${address}: ${renderedBytes}${unreadable}`,
            type: 'memory',
            variablesReference: 0
        };
    }

    private static extractMemoryReference(value: unknown): string | undefined {
        if (typeof value !== 'string') {
            return undefined;
        }

        return value.match(/0x[0-9a-f]+/i)?.[0];
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
     * Check if there's an active debug session that is ready for debugging operations
     */
    public async hasActiveSession(): Promise<boolean> {
        return vscode.debug.activeDebugSession !== undefined;
    }

    /**
     * Get the active debug session
     */
    public getActiveSession(): vscode.DebugSession | undefined {
        return vscode.debug.activeDebugSession;
    }

    /**
     * Wait for the debug session to reach a steady, caller-actionable state.
     *
     * Returns when one of the following happens:
     *  - 'stopped':    A stack frame is available (paused at breakpoint / entry / exception).
     *                  Subsequent calls (step, get_variables, evaluate) can act immediately.
     *  - 'terminated': The session ended (program ran to completion without stopping).
     *  - 'no-session': No debug session ever started within the wait window.
     *  - 'timeout':    A session is running but never stopped or terminated in time.
     *
     * Implemented with VS Code events rather than polling so we react the moment
     * the state actually changes — important because a fast-running program can
     * start *and* terminate inside a polling interval.
     */
    public async waitForDebugSessionReady(
        timeoutMs: number
    ): Promise<'stopped' | 'terminated' | 'timeout' | 'no-session'> {
        // Helper: a session is only truly "stopped and actionable" when we have
        // a DebugStackFrame (frameId present). A bare DebugThread means a thread
        // is selected but the adapter hasn't published a frame yet — calling
        // stackTrace/variables at that point can stall or return empty.
        const isStoppedWithFrame = () => {
            const item = vscode.debug.activeStackItem;
            return !!item && 'frameId' in item;
        };

        if (isStoppedWithFrame()) {
            return 'stopped';
        }

        const subscriptions: vscode.Disposable[] = [];
        let trackedSession: vscode.DebugSession | undefined = vscode.debug.activeDebugSession;

        try {
            return await new Promise<'stopped' | 'terminated' | 'timeout' | 'no-session'>(resolve => {
                let settled = false;
                const settle = (result: 'stopped' | 'terminated' | 'timeout' | 'no-session') => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    logger.info(`Debug session ready: ${result}`);
                    resolve(result);
                };

                const timer = setTimeout(() => {
                    settle(trackedSession ? 'timeout' : 'no-session');
                }, timeoutMs);

                subscriptions.push(
                    vscode.debug.onDidStartDebugSession(session => {
                        logger.info(`onDidStartDebugSession: ${session.name}`);
                        trackedSession = session;
                        setTimeout(() => {
                            if (isStoppedWithFrame()) {
                                settle('stopped');
                            }
                        }, 100);
                    })
                );

                subscriptions.push(
                    vscode.debug.onDidChangeActiveStackItem(stackItem => {
                        const kind = !stackItem
                            ? 'cleared'
                            : 'frameId' in stackItem ? 'frame' : 'thread';
                        logger.info(`onDidChangeActiveStackItem: ${kind}`);
                        // Only resolve when we have a stack frame. A bare
                        // DebugThread can fire while the program is still
                        // running, before the adapter publishes frame info.
                        if (stackItem && 'frameId' in stackItem) {
                            settle('stopped');
                        }
                    })
                );

                subscriptions.push(
                    vscode.debug.onDidTerminateDebugSession(session => {
                        logger.info(`onDidTerminateDebugSession: ${session.name}, activeSession=${vscode.debug.activeDebugSession?.name ?? 'none'}`);
                        // Only treat as 'terminated' if no other session is active.
                        // dotnet test spawns a parent + testhost; wait for both to end.
                        if (!vscode.debug.activeDebugSession) {
                            settle('terminated');
                        }
                    })
                );
            });
        } finally {
            subscriptions.forEach(d => d.dispose());
        }
    }
}
