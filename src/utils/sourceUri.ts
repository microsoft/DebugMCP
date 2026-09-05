// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';

/**
 * True when a source location is a URI rather than a native filesystem path.
 *
 * The drive letter in a Windows path looks like a URI scheme, so explicitly
 * exclude drive-letter paths before applying the generic scheme check.
 */
export function isSourceUri(source: string): boolean {
	if (/^[a-zA-Z]:[\\/]/.test(source)) {
		return false;
	}
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source);
}

/** Preserve virtual-document schemes while retaining native path behavior. */
export function toSourceUri(source: string): vscode.Uri {
	return isSourceUri(source) ? vscode.Uri.parse(source, true) : vscode.Uri.file(source);
}
