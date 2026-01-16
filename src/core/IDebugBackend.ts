// Copyright (c) Microsoft Corporation.

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
} from './types';

/**
 * Interface for debug backend operations.
 * 
 * This abstraction layer allows the MCP server to work with different
 * debug backends:
 * - VSCodeDebugBackend: Wraps VS Code's debug API for extension mode
 * - StandaloneDAPBackend: Communicates directly with DAP servers for standalone mode
 * 
 * All methods accept an optional sessionId parameter to future-proof for
 * multiple concurrent debug sessions.
 */
export interface IDebugBackend {
	// ============================================================
	// Debug Session Control
	// ============================================================

	/**
	 * Start a debugging session
	 * @param workingDirectory Working directory for the debug session
	 * @param config Debug configuration
	 * @param sessionId Optional session identifier for multi-session support
	 * @returns True if the session started successfully
	 */
	startDebugging(
		workingDirectory: string,
		config: DebugConfiguration,
		sessionId?: string
	): Promise<boolean>;

	/**
	 * Stop the debugging session
	 * @param sessionId Optional session to stop (defaults to active session)
	 */
	stopDebugging(sessionId?: string): Promise<void>;

	/**
	 * Check if there's an active debug session ready for operations
	 * @param sessionId Optional session to check
	 */
	hasActiveSession(sessionId?: string): Promise<boolean>;

	// ============================================================
	// Execution Control
	// ============================================================

	/**
	 * Execute step over command (step to next line)
	 * @param sessionId Optional session identifier
	 */
	stepOver(sessionId?: string): Promise<void>;

	/**
	 * Execute step into command (step into function call)
	 * @param sessionId Optional session identifier
	 */
	stepInto(sessionId?: string): Promise<void>;

	/**
	 * Execute step out command (step out of current function)
	 * @param sessionId Optional session identifier
	 */
	stepOut(sessionId?: string): Promise<void>;

	/**
	 * Continue execution until next breakpoint or program end
	 * @param sessionId Optional session identifier
	 */
	continue(sessionId?: string): Promise<void>;

	/**
	 * Restart the debug session
	 * @param sessionId Optional session identifier
	 */
	restart(sessionId?: string): Promise<void>;

	// ============================================================
	// Breakpoints
	// ============================================================

	/**
	 * Add a breakpoint at the specified location
	 * @param uri File URI
	 * @param line Line number (1-based)
	 * @param sessionId Optional session identifier
	 */
	addBreakpoint(uri: Uri, line: number, sessionId?: string): Promise<void>;

	/**
	 * Remove a breakpoint from the specified location
	 * @param uri File URI
	 * @param line Line number (1-based)
	 * @param sessionId Optional session identifier
	 */
	removeBreakpoint(uri: Uri, line: number, sessionId?: string): Promise<void>;

	/**
	 * Get all active breakpoints
	 * @param sessionId Optional session identifier
	 */
	getBreakpoints(sessionId?: string): readonly Breakpoint[];

	/**
	 * Clear all breakpoints
	 * @param sessionId Optional session identifier
	 */
	clearAllBreakpoints(sessionId?: string): void;

	// ============================================================
	// State & Inspection
	// ============================================================

	/**
	 * Get the current debug state including location, frame info, etc.
	 * @param numNextLines Number of lines to include after current line
	 * @param sessionId Optional session identifier
	 */
	getCurrentDebugState(numNextLines: number, sessionId?: string): Promise<DebugState>;

	/**
	 * Get the active frame ID for the current execution point.
	 * This replaces direct access to vscode.debug.activeStackItem.
	 * @param sessionId Optional session identifier
	 * @returns The frame ID or undefined if no active frame
	 */
	getActiveFrameId(sessionId?: string): Promise<number | undefined>;

	/**
	 * Get variables from the current debug context
	 * @param frameId Frame ID to get variables for
	 * @param scope Variable scope filter
	 * @param sessionId Optional session identifier
	 */
	getVariables(
		frameId: number,
		scope?: 'local' | 'global' | 'all',
		sessionId?: string
	): Promise<any>;

	/**
	 * Evaluate an expression in the current debug context
	 * @param expression Expression to evaluate
	 * @param frameId Frame ID for context
	 * @param sessionId Optional session identifier
	 */
	evaluateExpression(
		expression: string,
		frameId: number,
		sessionId?: string
	): Promise<any>;

	// ============================================================
	// File Access
	// ============================================================

	/**
	 * Read file contents for breakpoint line lookup.
	 * This replaces vscode.workspace.openTextDocument() usage.
	 * @param path File path to read
	 */
	readFileContents(path: string): Promise<string>;

	// ============================================================
	// Output
	// ============================================================

	/**
	 * Get recent program output (stdout/stderr).
	 * In standalone mode, this returns buffered output from the debug adapter.
	 * In VS Code mode, this may return empty or limited output depending on
	 * how the extension captures debug console output.
	 * @param options Options for filtering output
	 * @param sessionId Optional session identifier
	 */
	getRecentOutput(options?: GetOutputOptions, sessionId?: string): Promise<ProgramOutput>;

	// ============================================================
	// Events
	// ============================================================

	/**
	 * Register a callback for when execution stops (breakpoint hit, step complete, etc.)
	 * @param callback Function to call when stopped
	 * @returns Disposable to unregister the callback
	 */
	onStopped(callback: (data: StoppedEventData) => void): Disposable;

	/**
	 * Register a callback for when the debug session terminates
	 * @param callback Function to call when terminated
	 * @returns Disposable to unregister the callback
	 */
	onTerminated(callback: (data: TerminatedEventData) => void): Disposable;

	/**
	 * Register a callback for program output events
	 * @param callback Function to call when output is received
	 * @returns Disposable to unregister the callback
	 */
	onOutput(callback: (data: OutputEventData) => void): Disposable;
}
