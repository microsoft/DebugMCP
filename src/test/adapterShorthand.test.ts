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

	test('derives metadata for popular language ecosystems', () => {
		const expected: Record<string, { type: string; extensions: string[] }> = {
			dotnet: { type: 'coreclr', extensions: ['.cs'] },
			c: { type: 'cppvsdbg', extensions: ['.c', '.h'] },
			javascript: { type: 'pwa-node', extensions: ['.js', '.mjs', '.cjs', '.jsx'] },
			typescript: { type: 'pwa-node', extensions: ['.ts', '.mts', '.cts', '.tsx'] },
			node: {
				type: 'pwa-node',
				extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']
			},
			java: { type: 'java', extensions: ['.java'] },
			go: { type: 'go', extensions: ['.go'] },
			rust: { type: 'lldb', extensions: ['.rs'] },
			ruby: { type: 'rdbg', extensions: ['.rb'] },
			php: { type: 'php', extensions: ['.php'] },
			swift: { type: 'lldb', extensions: ['.swift'] },
			dart: { type: 'dart', extensions: ['.dart'] }
		};

		for (const [language, metadata] of Object.entries(expected)) {
			const adapter = createShorthandAdapter(language, ['adapter']);
			assert.strictEqual(adapter.type, metadata.type, language);
			assert.deepStrictEqual(adapter.extensions, metadata.extensions, language);
		}
	});

	test('requires explicit metadata for an unknown language', () => {
		assert.throws(
			() => createShorthandAdapter('custom', ['custom-dap']),
			/Provide --type and --extensions explicitly/
		);
	});
});
