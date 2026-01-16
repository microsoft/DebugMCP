// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import * as fs from 'fs';
import { IDebugBackend } from '../core/IDebugBackend';
import { DebugState } from '../debugState';
import {
	DebugConfiguration,
	Breakpoint,
	Uri,
	ProgramOutput,
	GetOutputOptions,
	StoppedEventData,
	TerminatedEventData,
	OutputEventData,
	Disposable,
	createSourceBreakpoint,
	createFunctionBreakpoint,
} from '../core/types';

/**
 * VS Code implementation of IDebugBackend.
 * 
 * This backend wraps VS Code's debug API for use in the extension mode.
 * It implements the portable IDebugBackend interface while using VS Code's
 * native debugging capabilities.
 */
export class VSCodeDebugBackend implements IDebugBackend {
	private stoppedCallbacks: Set<(data: StoppedEventData) => void> = new Set();
	private terminatedCallbacks: Set<(data: TerminatedEventData) => void> = new Set();
	private outputCallbacks: Set<(data: OutputEventData) => void> = new Set();
	private disposables: vscode.Disposable[] = [];

	constructor() {
		// Set up VS Code debug event listeners
		this.disposables.push(
			vscode.debug.onDidChangeActiveDebugSession((session) => {
				if (!session) {
					// Session ended
					this.terminatedCallbacks.forEach(cb => cb({}));
				}
			})
		);

		// Note: VS Code doesn't expose a direct "stopped" event through the public API.
		// The debug state changes are tracked via getCurrentDebugState polling.
		// For full event support, we would need to intercept DAP messages which
		// is not available through the public VS Code API.
	}

	/**
	 * Clean up resources
	 */
	public dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
		this.stoppedCallbacks.clear();
		this.terminatedCallbacks.clear();
		this.outputCallbacks.clear();
	}

	// ============================================================
	// Debug Session Control
	// ============================================================

	public async startDebugging(
		workingDirectory: string,
		config: DebugConfiguration,
		_sessionId?: string
	): Promise<boolean> {
		try {
			// Convert portable config to VS Code config
			const vscodeConfig: vscode.DebugConfiguration = { ...config };

			if (config.type === 'coreclr') {
				// Open the specific test file instead of the workspace folder
				const testFileUri = vscode.Uri.file(config.program || '');
				await vscode.commands.executeCommand('vscode.open', testFileUri);
				vscode.commands.executeCommand('testing.debugCurrentFile');
				return true;
			}

			const workspaceFolder = vscode.workspace.getWorkspaceFolder(
				vscode.Uri.file(workingDirectory)
			);
			return await vscode.debug.startDebugging(workspaceFolder, vscodeConfig);
		} catch (error) {
			throw new Error(`Failed to start debugging: ${error}`);
		}
	}

	public async stopDebugging(_sessionId?: string): Promise<void> {
		try {
			const activeSession = vscode.debug.activeDebugSession;
			if (activeSession) {
				await vscode.debug.stopDebugging(activeSession);
			}
		} catch (error) {
			throw new Error(`Failed to stop debugging: ${error}`);
		}
	}

	public async hasActiveSession(_sessionId?: string): Promise<boolean> {
		if (!vscode.debug.activeDebugSession) {
			return false;
		}

		try {
			const debugState = await this.getCurrentDebugState(0);
			return debugState.sessionActive && debugState.hasLocationInfo();
		} catch (error) {
			console.log('Session readiness check failed:', error);
			return false;
		}
	}

	// ============================================================
	// Execution Control
	// ============================================================

	public async stepOver(_sessionId?: string): Promise<void> {
		try {
			await vscode.commands.executeCommand('workbench.action.debug.stepOver');
		} catch (error) {
			throw new Error(`Failed to step over: ${error}`);
		}
	}

	public async stepInto(_sessionId?: string): Promise<void> {
		try {
			await vscode.commands.executeCommand('workbench.action.debug.stepInto');
		} catch (error) {
			throw new Error(`Failed to step into: ${error}`);
		}
	}

	public async stepOut(_sessionId?: string): Promise<void> {
		try {
			await vscode.commands.executeCommand('workbench.action.debug.stepOut');
		} catch (error) {
			throw new Error(`Failed to step out: ${error}`);
		}
	}

	public async continue(_sessionId?: string): Promise<void> {
		try {
			await vscode.commands.executeCommand('workbench.action.debug.continue');
		} catch (error) {
			throw new Error(`Failed to continue: ${error}`);
		}
	}

	public async restart(_sessionId?: string): Promise<void> {
		try {
			await vscode.commands.executeCommand('workbench.action.debug.restart');
		} catch (error) {
			throw new Error(`Failed to restart: ${error}`);
		}
	}

	// ============================================================
	// Breakpoints
	// ============================================================

	public async addBreakpoint(uri: Uri, line: number, _sessionId?: string): Promise<void> {
		try {
			const vscodeUri = vscode.Uri.file(uri.fsPath);
			const breakpoint = new vscode.SourceBreakpoint(
				new vscode.Location(vscodeUri, new vscode.Position(line - 1, 0))
			);
			vscode.debug.addBreakpoints([breakpoint]);
		} catch (error) {
			throw new Error(`Failed to add breakpoint: ${error}`);
		}
	}

	public async removeBreakpoint(uri: Uri, line: number, _sessionId?: string): Promise<void> {
		try {
			const vscodeUri = vscode.Uri.file(uri.fsPath);
			const breakpoints = vscode.debug.breakpoints.filter(bp => {
				if (bp instanceof vscode.SourceBreakpoint) {
					return bp.location.uri.toString() === vscodeUri.toString() &&
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

	public getBreakpoints(_sessionId?: string): readonly Breakpoint[] {
		return vscode.debug.breakpoints.map(bp => {
			if (bp instanceof vscode.SourceBreakpoint) {
				return createSourceBreakpoint(
					bp.location.uri.fsPath,
					bp.location.range.start.line + 1 // Convert to 1-based
				);
			} else if (bp instanceof vscode.FunctionBreakpoint) {
				return createFunctionBreakpoint(bp.functionName);
			}
			// Fallback for other breakpoint types
			return createFunctionBreakpoint('unknown');
		});
	}

	public clearAllBreakpoints(_sessionId?: string): void {
		const breakpoints = vscode.debug.breakpoints;
		if (breakpoints.length > 0) {
			vscode.debug.removeBreakpoints([...breakpoints]);
		}
	}

	// ============================================================
	// State & Inspection
	// ============================================================

	public async getCurrentDebugState(
		numNextLines: number = 3,
		_sessionId?: string
	): Promise<DebugState> {
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
						const currentLine = activeEditor.selection.active.line + 1;
						const currentLineContent = activeEditor.document.lineAt(
							activeEditor.selection.active.line
						).text.trim();

						// Get next lines
						const nextLines: string[] = [];
						for (let i = 1; i <= numNextLines; i++) {
							if (activeEditor.selection.active.line + i < activeEditor.document.lineCount) {
								nextLines.push(
									activeEditor.document.lineAt(activeEditor.selection.active.line + i).text.trim()
								);
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

	public async getActiveFrameId(_sessionId?: string): Promise<number | undefined> {
		const activeStackItem = vscode.debug.activeStackItem;
		if (activeStackItem && 'frameId' in activeStackItem) {
			return activeStackItem.frameId;
		}
		return undefined;
	}

	public async getVariables(
		frameId: number,
		scope?: 'local' | 'global' | 'all',
		_sessionId?: string
	): Promise<any> {
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
				if (scope === 'all') { return true; }
				const scopeName = scopeItem.name.toLowerCase();
				if (scope === 'local') { return scopeName.includes('local'); }
				if (scope === 'global') { return scopeName.includes('global'); }
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

	public async evaluateExpression(
		expression: string,
		frameId: number,
		_sessionId?: string
	): Promise<any> {
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

	// ============================================================
	// File Access
	// ============================================================

	public async readFileContents(path: string): Promise<string> {
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
			return document.getText();
		} catch (error) {
			// Fallback to fs if vscode fails
			return fs.promises.readFile(path, 'utf8');
		}
	}

	// ============================================================
	// Output
	// ============================================================

	public async getRecentOutput(
		_options?: GetOutputOptions,
		_sessionId?: string
	): Promise<ProgramOutput> {
		// VS Code doesn't provide a direct API to get debug console output.
		// In VS Code mode, output is shown in the Debug Console panel.
		// This method returns empty output - the Debug Console serves this purpose.
		return {
			stdout: '',
			stderr: '',
			truncated: false
		};
	}

	// ============================================================
	// Events
	// ============================================================

	public onStopped(callback: (data: StoppedEventData) => void): Disposable {
		this.stoppedCallbacks.add(callback);
		return {
			dispose: () => {
				this.stoppedCallbacks.delete(callback);
			}
		};
	}

	public onTerminated(callback: (data: TerminatedEventData) => void): Disposable {
		this.terminatedCallbacks.add(callback);
		return {
			dispose: () => {
				this.terminatedCallbacks.delete(callback);
			}
		};
	}

	public onOutput(callback: (data: OutputEventData) => void): Disposable {
		this.outputCallbacks.add(callback);
		return {
			dispose: () => {
				this.outputCallbacks.delete(callback);
			}
		};
	}

	// ============================================================
	// Private Helpers
	// ============================================================

	/**
	 * Extract frame name from the current stack frame
	 */
	private async extractFrameName(
		session: vscode.DebugSession,
		_frameId: number,
		state: DebugState
	): Promise<void> {
		try {
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
			state.updateFrameName(null);
		}
	}
}
