// Copyright (c) Microsoft Corporation.

// Export portable types
export {
	Uri,
	createUri,
	DebugConfiguration,
	Breakpoint,
	SourceBreakpoint,
	FunctionBreakpoint,
	isSourceBreakpoint,
	isFunctionBreakpoint,
	createSourceBreakpoint,
	createFunctionBreakpoint,
	ProgramOutput,
	StoppedEventData,
	TerminatedEventData,
	OutputEventData,
	GetOutputOptions,
	Disposable,
} from './types';

// Export interfaces
export { IDebugBackend } from './IDebugBackend';
export { IDebugConfigurationManager } from './IDebugConfigurationManager';
