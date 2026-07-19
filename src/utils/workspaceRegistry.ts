// Copyright (c) Microsoft Corporation.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';

/** One VS Code window's advertisement in the shared registry. */
export interface WindowRegistration {
	pid: number;
	controlPort: number;
	controlToken: string;
	workspaceFolders: string[];
	name: string;
	updatedAt: number;
}

/** Default directory holding one JSON file per live window. */
const DEFAULT_REGISTRY_DIR = path.join(os.tmpdir(), 'debugmcp-registry');

/** Entries not refreshed within this window are considered stale. */
const STALE_MS = 60_000;

/** Best-effort pid liveness check (EPERM means the process exists). */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		return !!(err && (err as NodeJS.ErrnoException).code === 'EPERM');
	}
}

/** Resolve, strip trailing separators, and lower-case on Windows. */
function normalizePath(p: string): string {
	let normalized = path.resolve(p);
	if (process.platform === 'win32') {
		normalized = normalized.toLowerCase();
	}
	return normalized.replace(/[\\/]+$/, '');
}

/** True when `target` is `folder` or a descendant of it. */
function isInside(target: string, folder: string): boolean {
	return target === folder || target.startsWith(folder + path.sep) || target.startsWith(folder + '/');
}

/**
 * File-based registry of DebugMCP-enabled VS Code windows on this machine.
 * One file per window (named by pid); reads prune dead/stale entries.
 */
export class WorkspaceRegistry {
	private readonly registryDir: string;
	private readonly filePath: string;

	constructor(private readonly pid: number = process.pid, registryDir: string = DEFAULT_REGISTRY_DIR) {
		this.registryDir = registryDir;
		this.filePath = path.join(this.registryDir, `window-${this.pid}.json`);
	}

	/** Write (or overwrite) this window's registration. */
	public register(reg: Omit<WindowRegistration, 'pid' | 'updatedAt'>): void {
		try {
			fs.mkdirSync(this.registryDir, { recursive: true });
			const entry: WindowRegistration = { ...reg, pid: this.pid, updatedAt: Date.now() };
			fs.writeFileSync(this.filePath, JSON.stringify(entry), 'utf8');
		} catch (error) {
			logger.error('Failed to write DebugMCP registry entry', error);
		}
	}

	/** Refresh `updatedAt` so other windows don't prune this one. */
	public heartbeat(): void {
		try {
			const entry = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as WindowRegistration;
			entry.updatedAt = Date.now();
			fs.writeFileSync(this.filePath, JSON.stringify(entry), 'utf8');
		} catch {
			// Entry missing — caller re-registers on change.
		}
	}

	/** Remove this window's registration (on deactivate). */
	public unregister(): void {
		this.tryUnlink(this.filePath);
	}

	/** All live windows, pruning dead-pid and stale entries as a side effect. */
	public list(): WindowRegistration[] {
		let files: string[];
		try {
			files = fs.readdirSync(this.registryDir);
		} catch {
			return [];
		}
		const result: WindowRegistration[] = [];
		for (const file of files) {
			if (!file.endsWith('.json')) {
				continue;
			}
			const full = path.join(this.registryDir, file);
			try {
				const entry = JSON.parse(fs.readFileSync(full, 'utf8')) as WindowRegistration;
				const isStale = Date.now() - entry.updatedAt > STALE_MS;
				if (!isProcessAlive(entry.pid) || (isStale && entry.pid !== this.pid)) {
					this.tryUnlink(full);
					continue;
				}
				result.push(entry);
			} catch {
				this.tryUnlink(full);
			}
		}
		return result;
	}

	/**
	 * Find the window whose workspace folder best (deepest) contains `targetPath`.
	 *
	 * Returns undefined when no window's folders contain the path — the router
	 * turns that into an actionable error rather than guessing. The only fallback
	 * is a sole window that declares NO folders (an "empty" window that can't be
	 * matched by prefix); a folder-bearing window is never chosen for a path it
	 * doesn't actually contain, which previously caused files to open in the
	 * wrong workspace.
	 */
	public findByPath(targetPath: string): WindowRegistration | undefined {
		const target = normalizePath(targetPath);
		const entries = this.list();
		let best: WindowRegistration | undefined;
		let bestLen = -1;
		for (const entry of entries) {
			for (const folder of entry.workspaceFolders) {
				const normalizedFolder = normalizePath(folder);
				if (isInside(target, normalizedFolder) && normalizedFolder.length > bestLen) {
					bestLen = normalizedFolder.length;
					best = entry;
				}
			}
		}
		if (!best && entries.length === 1 && entries[0].workspaceFolders.length === 0) {
			return entries[0];
		}
		return best;
	}

	private tryUnlink(full: string): void {
		try {
			fs.unlinkSync(full);
		} catch {
			// Another window may have pruned it first — ignore.
		}
	}
}
