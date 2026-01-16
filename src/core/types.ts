// Copyright (c) Microsoft Corporation.

/**
 * Portable types for debug operations that work without VS Code dependency.
 * These types mirror DAP (Debug Adapter Protocol) concepts and enable
 * the abstraction layer between VS Code and standalone modes.
 */

/**
 * Simple URI wrapper that doesn't depend on vscode.Uri.
 * Used for file paths throughout the debug abstraction layer.
 */
export interface Uri {
	/** The file system path */
	readonly path: string;
	/** File system path (alias for compatibility) */
	readonly fsPath: string;
}

/**
 * Create a portable Uri from a file path
 */
export function createUri(path: string): Uri {
	// Normalize path separators
	const normalizedPath = path.replace(/\\/g, '/');
	return {
		path: normalizedPath,
		fsPath: path,
	};
}

/**
 * Portable debug configuration that mirrors DAP launch/attach request args.
 * This replaces vscode.DebugConfiguration throughout the codebase.
 */
export interface DebugConfiguration {
	/** The type of the debug adapter (e.g., 'python', 'node', 'coreclr') */
	type: string;
	/** The request type: 'launch' or 'attach' */
	request: 'launch' | 'attach';
	/** A user-friendly name for this configuration */
	name: string;
	/** Program to debug (for launch requests) */
	program?: string;
	/** Arguments to pass to the program */
	args?: string[];
	/** Working directory for the debug session */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Console type: 'integratedTerminal', 'externalTerminal', or 'internalConsole' */
	console?: 'integratedTerminal' | 'externalTerminal' | 'internalConsole';
	/** Stop on entry point */
	stopOnEntry?: boolean;
	/** Stop at entry (coreclr variant) */
	stopAtEntry?: boolean;
	/** Debug only user code */
	justMyCode?: boolean;
	/** Debug purpose tags */
	purpose?: string[];
	/** Module to run (for Python module execution) */
	module?: string;
	/** Main class (for Java) */
	mainClass?: string;
	/** Debug mode (for Go) */
	mode?: string;
	/** Allow additional properties for adapter-specific options */
	[key: string]: unknown;
}

/**
 * Source breakpoint set at a specific file location
 */
export interface SourceBreakpoint {
	readonly kind: 'source';
	/** File path where the breakpoint is set */
	readonly path: string;
	/** Line number (1-based) */
	readonly line: number;
	/** Optional column number (1-based) */
	readonly column?: number;
	/** Optional condition expression */
	readonly condition?: string;
	/** Optional hit condition */
	readonly hitCondition?: string;
	/** Optional log message */
	readonly logMessage?: string;
}

/**
 * Function breakpoint set on a function name
 */
export interface FunctionBreakpoint {
	readonly kind: 'function';
	/** Function name to break on */
	readonly name: string;
	/** Optional condition expression */
	readonly condition?: string;
	/** Optional hit condition */
	readonly hitCondition?: string;
}

/**
 * Union type for all breakpoint types
 */
export type Breakpoint = SourceBreakpoint | FunctionBreakpoint;

/**
 * Type guard to check if a breakpoint is a source breakpoint
 */
export function isSourceBreakpoint(bp: Breakpoint): bp is SourceBreakpoint {
	return bp.kind === 'source';
}

/**
 * Type guard to check if a breakpoint is a function breakpoint
 */
export function isFunctionBreakpoint(bp: Breakpoint): bp is FunctionBreakpoint {
	return bp.kind === 'function';
}

/**
 * Create a source breakpoint
 */
export function createSourceBreakpoint(
	path: string,
	line: number,
	options?: {
		column?: number;
		condition?: string;
		hitCondition?: string;
		logMessage?: string;
	}
): SourceBreakpoint {
	return {
		kind: 'source',
		path,
		line,
		...options,
	};
}

/**
 * Create a function breakpoint
 */
export function createFunctionBreakpoint(
	name: string,
	options?: {
		condition?: string;
		hitCondition?: string;
	}
): FunctionBreakpoint {
	return {
		kind: 'function',
		name,
		...options,
	};
}

/**
 * Output from the debugged program
 */
export interface ProgramOutput {
	/** Standard output content */
	stdout: string;
	/** Standard error content */
	stderr: string;
	/** Whether output was truncated */
	truncated: boolean;
}

/**
 * Event data for when execution stops
 */
export interface StoppedEventData {
	/** Reason for stopping (e.g., 'breakpoint', 'step', 'exception') */
	reason: string;
	/** Optional description */
	description?: string;
	/** Thread that stopped */
	threadId?: number;
	/** Whether all threads stopped */
	allThreadsStopped?: boolean;
}

/**
 * Event data for when a session terminates
 */
export interface TerminatedEventData {
	/** Optional restart data if the session should restart */
	restart?: unknown;
}

/**
 * Event data for output from the debugged program
 */
export interface OutputEventData {
	/** Output category: 'console', 'stdout', 'stderr', or 'telemetry' */
	category?: 'console' | 'stdout' | 'stderr' | 'telemetry';
	/** The output content */
	output: string;
}

/**
 * Options for getRecentOutput
 */
export interface GetOutputOptions {
	/** Maximum number of lines to return */
	maxLines?: number;
	/** Return output since this timestamp (ms since epoch) */
	since?: number;
}

/**
 * Disposable interface for event subscriptions
 */
export interface Disposable {
	dispose(): void;
}
