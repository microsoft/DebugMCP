// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { DebugState, StackFrame } from './debugState';

/**
 * Interface for debugging execution operations
 */
export interface IDebuggingExecutor {
    startDebugging(workingDirectory: string, config: vscode.DebugConfiguration): Promise<boolean>;
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
    hasActiveSession(): Promise<boolean>;
    getActiveSession(): vscode.DebugSession | undefined;
    resolveActiveFrameId(): Promise<number | null>;
}

/**
 * Responsible for executing VS Code debugging commands and managing debug sessions
 */
export class DebuggingExecutor implements IDebuggingExecutor {

    /**
     * Start a debugging session
     */
    public async startDebugging(
        workingDirectory: string, 
        config: vscode.DebugConfiguration
    ): Promise<boolean> {
        try {
            if (config.type === 'coreclr' && config.request !== 'attach') {
                // Open the specific test file instead of the workspace folder
                const testFileUri = vscode.Uri.file(config.program);
                await vscode.commands.executeCommand('vscode.open', testFileUri);
                vscode.commands.executeCommand('testing.debugCurrentFile');
                return true;
            }
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workingDirectory));
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
                state.updateConfigurationName(activeSession.configuration.name ?? null);
                
                // Resolve frame context — handles DebugStackFrame, DebugThread, and undefined activeStackItem
                const frameContext = await this.resolveFrameContext(activeSession);
                if (frameContext) {
                    state.updateContext(frameContext.frameId, frameContext.threadId);

                    // Extract frame name from stack frame
                    await this.extractFrameName(activeSession, frameContext.frameId, state);
                    
                    // Get the active editor
                    const activeEditor = vscode.window.activeTextEditor;
                    if (activeEditor) {
                        const fileName = activeEditor.document.fileName.split(/[/\\]/).pop() || '';
                        const currentLine = activeEditor.selection.active.line + 1; // 1-based line number
                        const currentLineContent = activeEditor.document.lineAt(activeEditor.selection.active.line).text.trim();
                        
                        // Get next non-empty lines
                        const nextLines = [];
                        let lineOffset = 1;
                        while (nextLines.length < numNextLines && 
                               activeEditor.selection.active.line + lineOffset < activeEditor.document.lineCount) {
                            const lineText = activeEditor.document.lineAt(activeEditor.selection.active.line + lineOffset).text.trim();
                            if (lineText.length > 0) {
                                nextLines.push(lineText);
                            }
                            lineOffset++;
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
        
        // Populate breakpoints as compact "fileName:line" strings
        const breakpoints = vscode.debug.breakpoints;
        const formattedBreakpoints = breakpoints
            .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
            .map(bp => {
                const fileName = bp.location.uri.fsPath.split(/[/\\]/).pop() || 'unknown';
                const line = bp.location.range.start.line + 1;
                return `${fileName}:${line}`;
            });
        state.updateBreakpoints(formattedBreakpoints);

        return state;
    }

    /**
     * Extract frame name and stack trace from the current debug session
     */
    private async extractFrameName(session: vscode.DebugSession, frameId: number, state: DebugState): Promise<void> {
        try {
            // Get full stack trace (up to 50 frames)
            const stackTraceResponse = await session.customRequest('stackTrace', {
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
            }
        } catch (error) {
            console.log('Unable to extract stack info:', error);
            // Set empty values on error
            state.updateFrameName(null);
            state.updateStackTrace([]);
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
     * Resolve the active frame context.
     * Tries three strategies in order:
     * 1. DebugStackFrame from activeStackItem (has frameId directly)
     * 2. DebugThread from activeStackItem (resolve top frame via DAP stackTrace)
     * 3. DAP threads request fallback (when activeStackItem is undefined)
     * Returns null if no paused frame can be found.
     */
    private async resolveFrameContext(session: vscode.DebugSession): Promise<{ frameId: number; threadId: number } | null> {
        const activeStackItem = vscode.debug.activeStackItem;

        // Strategy 1: DebugStackFrame — frameId is directly available
        if (activeStackItem && 'frameId' in activeStackItem) {
            return { frameId: activeStackItem.frameId, threadId: activeStackItem.threadId };
        }

        // Strategy 2: DebugThread — resolve top frame via DAP stackTrace
        if (activeStackItem && 'threadId' in activeStackItem) {
            const frame = await this.getTopFrameForThread(session, activeStackItem.threadId);
            if (frame) {
                return frame;
            }
        }

        // Strategy 3: activeStackItem is undefined — query DAP for threads directly
        // and find the first thread that has a stack (i.e., is paused).
        return await this.resolveFrameFromDAPThreads(session);
    }

    /**
     * Get the top stack frame for a specific thread via DAP stackTrace request.
     * Returns null if the thread is running (not paused).
     */
    private async getTopFrameForThread(session: vscode.DebugSession, threadId: number): Promise<{ frameId: number; threadId: number } | null> {
        try {
            const response = await session.customRequest('stackTrace', {
                threadId,
                startFrame: 0,
                levels: 1
            });
            if (response?.stackFrames?.length > 0) {
                return { frameId: response.stackFrames[0].id, threadId };
            }
        } catch {
            // Thread is running or stackTrace not supported
        }
        return null;
    }

    /**
     * Fallback: query DAP for all threads and find the first one with a valid stack frame.
     * Used when activeStackItem is undefined (VS Code hasn't selected a thread).
     */
    private async resolveFrameFromDAPThreads(session: vscode.DebugSession): Promise<{ frameId: number; threadId: number } | null> {
        try {
            const threadsResponse = await session.customRequest('threads');
            if (!threadsResponse?.threads?.length) {
                return null;
            }

            for (const thread of threadsResponse.threads) {
                const frame = await this.getTopFrameForThread(session, thread.id);
                if (frame) {
                    return frame;
                }
            }
        } catch {
            // threads request not supported or session not ready
        }
        return null;
    }

    /**
     * Resolve the active frame ID, handling DebugStackFrame, DebugThread, and
     * undefined activeStackItem. Returns null if no paused frame is available.
     */
    public async resolveActiveFrameId(): Promise<number | null> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            return null;
        }
        const context = await this.resolveFrameContext(session);
        return context?.frameId ?? null;
    }

    /**
     * Check if there's an active debug session.
     * This only checks session existence (debug adapter is attached), NOT whether
     * execution is paused at a frame. Use resolveActiveFrameId() to check for a
     * paused frame when needed (e.g., before variable inspection or expression eval).
     */
    public async hasActiveSession(): Promise<boolean> {
        return !!vscode.debug.activeDebugSession;
    }

    /**
     * Get the active debug session
     */
    public getActiveSession(): vscode.DebugSession | undefined {
        return vscode.debug.activeDebugSession;
    }
}
