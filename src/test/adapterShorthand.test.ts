// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert';
import { createShorthandAdapter, splitCommandLine } from '../cli/adapterShorthand';

suite('CLI adapter shorthand', () => {
	test('derives Python metadata and separates the adapter command', () => {
		assert.deepStrictEqual(
			createShorthandAdapter('python', ['python -m debugpy.adapter']),
			{
				command: 'python',
				args: ['-m', 'debugpy.adapter'],
				type: 'python',
				extensions: ['.py'],
				transport: 'stdio'
			}
		);
	});

	test('supports quoted executable paths', () => {
		assert.deepStrictEqual(
			splitCommandLine('"C:\\Program Files\\Python\\python.exe" -m debugpy.adapter'),
			['C:\\Program Files\\Python\\python.exe', '-m', 'debugpy.adapter']
		);
	});

	test('preserves separately tokenized command values', () => {
		assert.deepStrictEqual(
			createShorthandAdapter('python', ['python', '-m', 'debugpy.adapter']),
			{
				command: 'python',
				args: ['-m', 'debugpy.adapter'],
				type: 'python',
				extensions: ['.py'],
				transport: 'stdio'
			}
		);
	});

	test('appends explicitly separated adapter arguments', () => {
		assert.deepStrictEqual(
			createShorthandAdapter(
				'csharp',
				['netcoredbg'],
				['--interpreter=vscode']
			),
			{
				command: 'netcoredbg',
				args: ['--interpreter=vscode'],
				type: 'coreclr',
				extensions: ['.cs'],
				transport: 'stdio'
			}
		);
	});

	test('rejects malformed or empty command lines', () => {
		assert.throws(() => splitCommandLine('"unterminated'), /unterminated quote/);
		assert.throws(() => createShorthandAdapter('python', ['   ']), /requires --command/);
	});

	test('derives compiled-language metadata', () => {
		assert.deepStrictEqual(
			createShorthandAdapter('csharp', ['vsdbg --interpreter=vscode']),
			{
				command: 'vsdbg',
				args: ['--interpreter=vscode'],
				type: 'coreclr',
				extensions: ['.cs'],
				transport: 'stdio'
			}
		);
		assert.strictEqual(createShorthandAdapter('cpp', ['OpenDebugAD7.exe']).type, 'cppvsdbg');
	});

	test('requires explicit metadata for an unknown language', () => {
		assert.throws(
			() => createShorthandAdapter('custom', ['custom-dap']),
			/Provide --type and --extensions explicitly/
		);
	});
});
