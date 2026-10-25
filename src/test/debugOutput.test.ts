// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert/strict';
import { DebugOutputBuffer } from '../utils/debugOutputBuffer';
import { REDACTION_PLACEHOLDER } from '../utils/secretRedaction';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DebugMCPServer } from '../debugMCPServer';
import { DebuggingHandler } from '../debuggingHandler';
import { DebuggingExecutor } from '../debuggingExecutor';
import { DebugConfigurationManager } from '../utils/debugConfigurationManager';

suite('Opt-in debug output (#178)', () => {
	let enabled: boolean;
	let buffer: DebugOutputBuffer;

	setup(() => {
		enabled = true;
		buffer = new DebugOutputBuffer(() => enabled);
		buffer.startSession('one');
	});

	test('capture is disabled by default and disabling discards history', () => {
		const disabled = new DebugOutputBuffer();
		disabled.append('one', { output: 'PROBE|1' });
		assert.throws(() => disabled.read({ sessionId: 'one', prefix: 'PROBE|' }), /disabled/);
		buffer.append('one', { output: 'PROBE|1' });
		enabled = false;
		assert.throws(() => buffer.read({ sessionId: 'one', prefix: 'PROBE|' }), /disabled/);
		enabled = true;
		assert.throws(() => buffer.read({ sessionId: 'one', prefix: 'PROBE|' }), /No captured output session/);
	});

	test('requires a specific session and explicit nonempty filter', () => {
		assert.throws(() => buffer.read({ sessionId: 'one' }), /prefix/);
		assert.throws(() => buffer.read({ sessionId: 'one', prefix: '' }), /prefix/);
		assert.throws(() => buffer.read({ sessionId: 'two', category: 'stdout' }), /No captured output session/);
		for (const limit of [0, 101, 1.5, NaN]) {
			assert.throws(() => buffer.read({ sessionId: 'one', category: 'stdout', limit }), /limit/);
		}
	});

	test('filters, paginates, skips unmatched output, and resumes incrementally', () => {
		buffer.append('one', { output: 'unrelated', category: 'stdout' });
		buffer.append('one', { output: 'PROBE|1', category: 'stdout' });
		buffer.append('one', { output: 'PROBE|wrong category', category: 'stderr' });
		buffer.append('one', { output: 'PROBE|2', category: 'stdout' });
		const query = { sessionId: 'one', prefix: 'PROBE|', category: 'stdout', limit: 1 };
		const first = buffer.read(query);
		assert.deepEqual(first.entries.map(entry => entry.output), ['PROBE|1']);
		assert.equal(first.hasMore, true);
		const second = buffer.read({ ...query, cursor: first.nextCursor });
		assert.deepEqual(second.entries.map(entry => entry.output), ['PROBE|2']);
		assert.equal(second.hasMore, false);
		assert.equal(buffer.read({ ...query, cursor: second.nextCursor }).entries.length, 0);
		buffer.append('one', { output: 'PROBE|3', category: 'stdout' });
		assert.equal(buffer.read({ ...query, cursor: second.nextCursor }).entries[0].output, 'PROBE|3');
	});

	test('rejects cross-session, malformed, future, and previous-incarnation cursors', () => {
		const cursor = buffer.read({ sessionId: 'one', category: 'console' }).nextCursor;
		buffer.startSession('two');
		assert.throws(() => buffer.read({ sessionId: 'two', category: 'console', cursor }), /cursor/);
		for (const invalid of ['', `${cursor}:extra`, cursor.replace(/:0$/, ':1'), cursor.replace(/:0$/, ':')]) {
			assert.throws(() => buffer.read({ sessionId: 'one', category: 'console', cursor: invalid }), /cursor/);
		}
		buffer.startSession('one');
		assert.throws(() => buffer.read({ sessionId: 'one', category: 'console', cursor }), /cursor/);
	});

	test('redacts known credentials and sensitive assignments before retention', () => {
		for (const output of ['PROBE|Password=synthetic', 'PROBE|api_key: synthetic', `PROBE|ghp_${'a'.repeat(36)}`]) {
			buffer.append('one', { output });
		}
		const entries = buffer.read({ sessionId: 'one', category: 'console' }).entries;
		assert.equal(entries.length, 3);
		assert.ok(entries.every(entry => entry.redacted && entry.output === REDACTION_PLACEHOLDER));
	});

	test('bounds event size, retained bytes, entries, and number of sessions', () => {
		buffer.append('one', { output: 'x'.repeat(8193) });
		assert.match(buffer.read({ sessionId: 'one', category: 'console' }).entries[0].output, /omitted/);
		for (let i = 0; i < 40; i++) {
			buffer.append('one', { output: 'x'.repeat(8192) });
		}
		assert.equal(buffer.read({ sessionId: 'one', category: 'console' }).entries.length, 32);
		assert.equal(buffer.read({ sessionId: 'one', category: 'console' }).truncated, true);
		buffer.startSession('one');
		for (let i = 0; i < 1001; i++) {
			buffer.append('one', { output: String(i) });
		}
		assert.equal(buffer.read({ sessionId: 'one', category: 'console' }).entries[0].output, '1');
		for (let i = 0; i < 8; i++) {
			buffer.startSession(String(i));
		}
		assert.throws(() => buffer.read({ sessionId: 'one', category: 'console' }), /evicted/);
	});

	test('ignores malformed output and telemetry, and returns independent entries', () => {
		for (const body of [undefined, {}, { output: 3 }, { output: 'secret', category: 'telemetry' }]) {
			buffer.append('one', body);
		}
		assert.equal(buffer.read({ sessionId: 'one', category: 'console' }).entries.length, 0);
		buffer.append('one', { output: 'PROBE|ok' });
		const result = buffer.read({ sessionId: 'one', prefix: 'PROBE|' });
		result.entries[0].output = 'changed';
		assert.equal(buffer.read({ sessionId: 'one', prefix: 'PROBE|' }).entries[0].output, 'PROBE|ok');
		buffer.clear();
		assert.throws(() => buffer.read({ sessionId: 'one', prefix: 'PROBE|' }), /No captured output session/);
	});

	test('MCP tool exposes filtered output and explicit validation errors', async () => {
		class OutputExecutor extends DebuggingExecutor {
			public override getDebugOutput(query: Parameters<DebugOutputBuffer['read']>[0]) {
				return buffer.read(query);
			}
		}
		buffer.append('one', { output: 'PROBE|ms=123' });
		const host = new DebugMCPServer(0, 1);
		const handler = new DebuggingHandler(new OutputExecutor(), new DebugConfigurationManager(), 1);
		const server = host['createMcpServer'](handler);
		const client = new Client({ name: 'output-test', version: '1.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		try {
			await server.connect(serverTransport);
			await client.connect(clientTransport);
			assert.ok((await client.listTools()).tools.some(tool => tool.name === 'get_debug_output'));
			const result = await client.callTool({
				name: 'get_debug_output', arguments: { sessionId: 'one', prefix: 'PROBE|' }
			});
			assert.equal(result.isError, undefined);
			assert.match(JSON.stringify(result.content), /PROBE\|ms=123/);
			const invalid = await client.callTool({
				name: 'get_debug_output', arguments: { sessionId: 'one' }
			});
			assert.equal(invalid.isError, true);
			enabled = false;
			const disabled = await client.callTool({
				name: 'get_debug_output', arguments: { sessionId: 'one', prefix: 'PROBE|' }
			});
			assert.equal(disabled.isError, true);
			assert.match(JSON.stringify(disabled.content), /disabled/);
		} finally {
			await client.close();
			await server.close();
		}
	});
});
