// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert';
import { parseOptions } from '../cli/cliOptions';

suite('CLI options', () => {
	const adapterOptions = ['user', 'command', 'type', 'extensions', 'args', 'launch'];

	test('preserves long adapter arguments after --args', () => {
		const parsed = parseOptions([
			'python',
			'--command', 'netcoredbg',
			'--args', '--interpreter=vscode',
			'--user'
		], adapterOptions);

		assert.deepStrictEqual(parsed.positionals, ['python']);
		assert.deepStrictEqual(parsed.values.args, ['--interpreter=vscode']);
		assert.ok(Object.hasOwn(parsed.values, 'user'));
	});

	test('supports passthrough for arguments matching CLI option names', () => {
		const parsed = parseOptions(
			['python', '--args', '--', '--user', '--type'],
			adapterOptions
		);
		assert.deepStrictEqual(parsed.values.args, ['--user', '--type']);
	});

	test('rejects unknown top-level options', () => {
		assert.throws(
			() => parseOptions(['--unknown'], adapterOptions),
			/Unknown option '--unknown'/
		);
	});
});
