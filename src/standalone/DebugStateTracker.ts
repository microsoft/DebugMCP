// Copyright (c) Microsoft Corporation.

import { ProgramOutput, StoppedEventData, TerminatedEventData, OutputEventData } from '../core/types';

/**
 * Debug session state
 */
export type SessionState = 'inactive' | 'initializing' | 'running' | 'stopped' | 'terminated';

/**
 * Information about the current stack frame
 */
export interface FrameInfo {
	id: number;
	name: string;
	line: number;
	column: number;
	source?: {
		path?: string;
		name?: string;
	};
}

/**
 * Information about a thread
 */
export interface ThreadInfo {
	id: number;
	name: string;
}

/**
 * Circular buffer for output lines
 */
class OutputBuffer {
	private lines: { text: string; category: string; timestamp: number }[] = [];
	private maxLines: number;

	constructor(maxLines: number = 1000) {
		this.maxLines = maxLines;
	}

	public add(text: string, category: string): void {
		const timestamp = Date.now();
		// Split by newlines and add each line
		const newLines = text.split(/\r?\n/);
		for (const line of newLines) {
			if (line) { // Skip empty lines
				this.lines.push({ text: line, category, timestamp });
				if (this.lines.length > this.maxLines) {
					this.lines.shift();
				}
			}
		}
	}

	public get(options?: { maxLines?: number; since?: number }): {
		stdout: string;
		stderr: string;
		truncated: boolean;
	} {
		let filtered = this.lines;

		// Filter by timestamp if specified
		if (options?.since) {
			filtered = filtered.filter(l => l.timestamp >= options.since!);
		}

		// Limit lines if specified
		const maxLines = options?.maxLines || this.maxLines;
		const truncated = filtered.length > maxLines;
		if (truncated) {
			filtered = filtered.slice(-maxLines);
		}

		// Separate stdout and stderr
		const stdout = filtered
			.filter(l => l.category === 'stdout' || l.category === 'console')
			.map(l => l.text)
			.join('\n');

		const stderr = filtered
			.filter(l => l.category === 'stderr')
			.map(l => l.text)
			.join('\n');

		return { stdout, stderr, truncated };
	}

	public clear(): void {
		this.lines = [];
	}
}

/**
 * DebugStateTracker tracks the current state of a debug session.
 * 
 * This replicates what VS Code tracks implicitly. It tracks:
 * - Session state (running, stopped, terminated)
 * - Current thread and frame when stopped
 * - Output buffer for stdout/stderr
 * - Stop reason and location
 */
export class DebugStateTracker {
	private state: SessionState = 'inactive';
	private currentThreadId: number | null = null;
	private currentFrameId: number | null = null;
	private currentFrame: FrameInfo | null = null;
	private threads: ThreadInfo[] = [];
	private stopReason: string | null = null;
	private outputBuffer: OutputBuffer;

	constructor(maxOutputLines: number = 1000) {
		this.outputBuffer = new OutputBuffer(maxOutputLines);
	}

	// ============================================================
	// State Management
	// ============================================================

	/**
	 * Get the current session state
	 */
	public getState(): SessionState {
		return this.state;
	}

	/**
	 * Set the session state
	 */
	public setState(state: SessionState): void {
		this.state = state;
		if (state === 'inactive' || state === 'terminated') {
			this.reset();
		}
	}

	/**
	 * Check if the session is active (not inactive or terminated)
	 */
	public isActive(): boolean {
		return this.state !== 'inactive' && this.state !== 'terminated';
	}

	/**
	 * Check if the session is stopped (paused at a breakpoint, etc.)
	 */
	public isStopped(): boolean {
		return this.state === 'stopped';
	}

	/**
	 * Reset all state to initial values
	 */
	public reset(): void {
		this.currentThreadId = null;
		this.currentFrameId = null;
		this.currentFrame = null;
		this.threads = [];
		this.stopReason = null;
		this.outputBuffer.clear();
	}

	// ============================================================
	// Stop Event Handling
	// ============================================================

	/**
	 * Handle a stopped event from the debug adapter
	 */
	public handleStopped(data: StoppedEventData): void {
		this.state = 'stopped';
		this.stopReason = data.reason;
		if (data.threadId !== undefined) {
			this.currentThreadId = data.threadId;
		}
	}

	/**
	 * Handle a continued event (execution resumed)
	 */
	public handleContinued(threadId?: number): void {
		this.state = 'running';
		this.stopReason = null;
		// Keep thread ID but clear frame info
		this.currentFrameId = null;
		this.currentFrame = null;
	}

	/**
	 * Handle a terminated event
	 */
	public handleTerminated(_data?: TerminatedEventData): void {
		this.state = 'terminated';
	}

	/**
	 * Get the stop reason
	 */
	public getStopReason(): string | null {
		return this.stopReason;
	}

	// ============================================================
	// Thread Management
	// ============================================================

	/**
	 * Update the list of threads
	 */
	public updateThreads(threads: ThreadInfo[]): void {
		this.threads = threads;
	}

	/**
	 * Get all threads
	 */
	public getThreads(): ThreadInfo[] {
		return this.threads;
	}

	/**
	 * Get the current thread ID
	 */
	public getCurrentThreadId(): number | null {
		return this.currentThreadId;
	}

	/**
	 * Set the current thread ID
	 */
	public setCurrentThreadId(threadId: number): void {
		this.currentThreadId = threadId;
	}

	// ============================================================
	// Frame Management
	// ============================================================

	/**
	 * Update the current frame
	 */
	public updateCurrentFrame(frame: FrameInfo): void {
		this.currentFrame = frame;
		this.currentFrameId = frame.id;
	}

	/**
	 * Get the current frame
	 */
	public getCurrentFrame(): FrameInfo | null {
		return this.currentFrame;
	}

	/**
	 * Get the current frame ID
	 */
	public getCurrentFrameId(): number | null {
		return this.currentFrameId;
	}

	// ============================================================
	// Output Buffer
	// ============================================================

	/**
	 * Handle an output event from the debug adapter
	 */
	public handleOutput(data: OutputEventData): void {
		const category = data.category || 'console';
		this.outputBuffer.add(data.output, category);
	}

	/**
	 * Get recent program output
	 */
	public getRecentOutput(options?: { maxLines?: number; since?: number }): ProgramOutput {
		return this.outputBuffer.get(options);
	}

	/**
	 * Clear the output buffer
	 */
	public clearOutput(): void {
		this.outputBuffer.clear();
	}

	// ============================================================
	// Convenience Methods
	// ============================================================

	/**
	 * Check if we have a valid frame context for variable inspection
	 */
	public hasValidContext(): boolean {
		return this.state === 'stopped' &&
			this.currentFrameId !== null &&
			this.currentThreadId !== null;
	}

	/**
	 * Get a summary of the current state for debugging
	 */
	public getStateSummary(): string {
		return JSON.stringify({
			state: this.state,
			threadId: this.currentThreadId,
			frameId: this.currentFrameId,
			frame: this.currentFrame,
			stopReason: this.stopReason,
			threadCount: this.threads.length
		}, null, 2);
	}
}
