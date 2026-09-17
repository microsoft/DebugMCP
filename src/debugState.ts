// Copyright (c) Microsoft Corporation.

/**
 * Represents a single stack frame in the call stack
 */
export interface StackFrame {
    name: string;
    source?: string;
    line?: number;
    column?: number;
}

/**
 * Represents the current state of a debugging session
 */
export class DebugState {
    public sessionActive: boolean;
    public paused: boolean | null;
    public fileFullPath: string | null;
    public fileName: string | null;
    public currentLine: number | null;
    public currentLineContent: string | null;
    public nextLines: string[];
    public frameId: number | null;
    public threadId: number | null;
    public frameName: string | null;
    public stackTrace: StackFrame[];
    public configurationName: string | null;
    public breakpoints: string[];
    
    constructor() {
        this.sessionActive = false;
        this.paused = null;
        this.fileFullPath = null;
        this.fileName = null;
        this.currentLine = null;
        this.currentLineContent = null;
        this.nextLines = [];
        this.frameId = null;
        this.threadId = null;
        this.frameName = null;
        this.stackTrace = [];
        this.configurationName = null;
        this.breakpoints = [];
    }

    /**
     * Reset the debug state to initial values
     */
    public reset(): void {
        this.sessionActive = false;
        this.paused = null;
        this.fileFullPath = null;
        this.fileName = null;
        this.currentLine = null;
        this.currentLineContent = null;
        this.nextLines = [];
        this.frameId = null;
        this.threadId = null;
        this.frameName = null;
        this.stackTrace = [];
        this.configurationName = null;
        this.breakpoints = [];
    }

    /**
     * Check if the debug session has valid execution context
     */
    public hasValidContext(): boolean {
        return this.sessionActive && 
               this.frameId !== null && 
               this.threadId !== null;
    }

    /**
     * Prefer observed execution state; frames are a fallback for unobserved sessions.
     */
    public isPaused(): boolean {
        return this.sessionActive && (this.paused ?? this.hasValidContext());
    }

    /**
     * Check if location information is available
     */
    public hasLocationInfo(): boolean {
        return this.fileName !== null && 
               this.currentLine !== null;
    }

    /**
     * Update the current execution context
     */
    public updateContext(frameId: number, threadId: number): void {
        this.frameId = frameId;
        this.threadId = threadId;
    }

    /**
     * Update the current execution location
     */
    public updateLocation(
        fileFullPath: string,
        fileName: string,
        currentLine: number,
        currentLineContent: string,
        nextLines: string[]
    ): void {
        this.fileFullPath = fileFullPath;
        this.fileName = fileName;
        this.currentLine = currentLine;
        this.currentLineContent = currentLineContent;
        this.nextLines = [...nextLines];
    }

    /**
     * Update frame name context
     */
    public updateFrameName(frameName: string | null): void {
        this.frameName = frameName;
    }

    /**
     * Update stack trace
     */
    public updateStackTrace(stackTrace: StackFrame[]): void {
        this.stackTrace = [...stackTrace];
    }

    /**
     * Check if frame name is available
     */
    public hasFrameName(): boolean {
        return this.frameName !== null;
    }

    /**
     * Update the configuration name
     */
    public updateConfigurationName(configurationName: string | null): void {
        this.configurationName = configurationName;
    }

    /**
     * Update breakpoints list (formatted as "fileName:line" strings)
     */
    public updateBreakpoints(breakpoints: string[]): void {
        this.breakpoints = [...breakpoints];
    }

    public clone(): DebugState {
        const cloned = new DebugState();
        cloned.sessionActive = this.sessionActive;
        cloned.paused = this.paused;
        cloned.fileFullPath = this.fileFullPath;
        cloned.fileName = this.fileName;
        cloned.currentLine = this.currentLine;
        cloned.currentLineContent = this.currentLineContent;
        cloned.nextLines = [...this.nextLines];
        cloned.frameId = this.frameId;
        cloned.threadId = this.threadId;
        cloned.frameName = this.frameName;
        cloned.stackTrace = [...this.stackTrace];
        cloned.configurationName = this.configurationName;
        cloned.breakpoints = [...this.breakpoints];
        return cloned;
    }

    /**
     * Format debug state as a JSON string for structured output
     */
    public toString(): string {
        const stateObject: {
            sessionActive: boolean;
            paused: boolean;
            configurationName?: string | null;
            stackTrace?: string[];
            breakpoints?: string[];
            fileFullPath?: string | null;
            fileName?: string | null;
            currentLine?: number | null;
            currentLineContent?: string | null;
            nextLines?: string[];
            frameId?: number | null;
            threadId?: number | null;
            frameName?: string | null;
        } = {
            sessionActive: this.sessionActive,
            paused: this.isPaused(),
        };

        if (this.sessionActive) {
            stateObject.configurationName = this.configurationName;

            // Compact stack trace: "functionName:line" format
            stateObject.stackTrace = this.stackTrace.map(frame => 
                `${frame.name}:${frame.line || '?'}`
            );

            stateObject.breakpoints = this.breakpoints;

            stateObject.fileFullPath = this.fileFullPath;
            stateObject.fileName = this.fileName;
            stateObject.currentLine = this.currentLine;
            stateObject.currentLineContent = this.currentLineContent;
            stateObject.nextLines = this.nextLines;
            stateObject.frameId = this.frameId;
            stateObject.threadId = this.threadId;
            stateObject.frameName = this.frameName;
        }

        return JSON.stringify(stateObject, null, 2);
    }
}
