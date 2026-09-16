// Copyright (c) Microsoft Corporation.

export interface DebugConfiguration {
	name?: string;
	type?: string;
	request?: string;
	[key: string]: unknown;
}

export interface DebugBreakpoint {
	fileFullPath: string;
	line: number;
	condition?: string;
	logMessage?: string;
	verified?: boolean;
	message?: string;
}

export interface DebugSessionInfo {
	id: string;
	name: string;
	type: string;
	request?: 'launch' | 'attach';
}
