// Copyright (c) Microsoft Corporation.

import { randomUUID } from 'node:crypto';
import { isSensitiveName, redactExpressionResult, REDACTION_PLACEHOLDER } from './secretRedaction';

export interface IDebugOutputQuery {
	sessionId: string;
	prefix?: string;
	category?: string;
	cursor?: string;
	limit?: number;
}

interface IOutputEntry {
	sequence: number;
	category: string;
	output: string;
	redacted: boolean;
}

interface ISessionOutput {
	token: string;
	sequence: number;
	bytes: number;
	entries: IOutputEntry[];
}

/** In-memory, opt-in capture. Never persists or logs debuggee output. */
export class DebugOutputBuffer {
	private readonly sessions = new Map<string, ISessionOutput>();

	constructor(private readonly enabled: () => boolean = () => false) {}

	public clear(): void {
		this.sessions.clear();
	}

	public startSession(sessionId: string): void {
		if (!this.isEnabled()) {
			return;
		}
		this.sessions.delete(sessionId);
		if (this.sessions.size >= 8) {
			this.sessions.delete(this.sessions.keys().next().value!);
		}
		this.sessions.set(sessionId, { token: randomUUID(), sequence: 0, bytes: 0, entries: [] });
	}

	public append(sessionId: string, body: unknown): void {
		if (!this.isEnabled() || !body || typeof body !== 'object' || !('output' in body) ||
			typeof body.output !== 'string') {
			return;
		}
		const category = 'category' in body ? body.category : 'console';
		if (typeof category !== 'string' || !['console', 'stdout', 'stderr', 'important'].includes(category)) {
			return;
		}
		if (!this.sessions.has(sessionId)) {
			this.startSession(sessionId);
		}
		const session = this.sessions.get(sessionId)!;
		// Do not truncate before redaction: that can hide part of a credential shape.
		const result = Buffer.byteLength(body.output) > 8192
			? { value: '<output omitted: event exceeds 8192-byte capture limit>', redacted: true }
			: redactExpressionResult('', body.output);
		const sensitiveLabel = [...body.output.slice(0, 8192).matchAll(/\b([A-Za-z_][\w-]*)\s*[:=]/g)]
			.some(match => isSensitiveName(match[1]));
		const output = sensitiveLabel ? REDACTION_PLACEHOLDER : result.value;
		const entry = { sequence: ++session.sequence, category, output, redacted: result.redacted || sensitiveLabel };
		session.entries.push(entry);
		session.bytes += Buffer.byteLength(output);
		while (session.entries.length > 1000 || session.bytes > 262144) {
			session.bytes -= Buffer.byteLength(session.entries.shift()!.output);
		}
	}

	public read(query: IDebugOutputQuery) {
		if (!this.isEnabled()) {
			throw new Error('Debug output capture is disabled. Enable debugmcp.captureDebugOutput in user settings, or start the CLI with --capture-output.');
		}
		if (!query.sessionId || (!query.prefix && !query.category) ||
			(query.prefix !== undefined && (query.prefix.length === 0 || query.prefix.length > 256)) ||
			(query.category !== undefined && !['console', 'stdout', 'stderr', 'important'].includes(query.category))) {
			throw new Error('Provide a session ID and a nonempty prefix (up to 256 characters) or a supported output category.');
		}
		const limit = query.limit ?? 100;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new Error('Output limit must be an integer from 1 to 100.');
		}
		const session = this.sessions.get(query.sessionId);
		if (!session) {
			throw new Error('No captured output session with that ID exists; it may predate capture or have been evicted.');
		}
		let after = 0;
		if (query.cursor !== undefined) {
			const [token, sequence, extra] = query.cursor.split(':');
			after = Number(sequence);
			if (token !== session.token || extra !== undefined || !/^\d+$/.test(sequence ?? '') ||
				!Number.isSafeInteger(after) || after < 0 || after > session.sequence) {
				throw new Error('Invalid output cursor for this debug session.');
			}
		}
		const truncated = after < (session.entries[0]?.sequence ?? 1) - 1;
		const entries: IOutputEntry[] = [];
		let scanned = after;
		for (const entry of session.entries) {
			if (entry.sequence <= after) {
				continue;
			}
			scanned = entry.sequence;
			if ((!query.prefix || entry.output.startsWith(query.prefix)) &&
				(!query.category || entry.category === query.category)) {
				entries.push({ ...entry });
				if (entries.length === limit) {
					break;
				}
			}
		}
		return {
			sessionId: query.sessionId,
			entries,
			nextCursor: `${session.token}:${scanned}`,
			truncated,
			hasMore: scanned < session.sequence
		};
	}

	private isEnabled(): boolean {
		const enabled = this.enabled();
		if (!enabled) {
			this.clear();
		}
		return enabled;
	}
}
