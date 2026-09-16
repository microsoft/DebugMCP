// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

suite('CLI npm package', () => {
	const packageRoot = path.resolve(__dirname, '..', '..', 'npm', 'cli');

	test('publishes the bundled debug-live skill', () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
		) as { files?: string[] };

		assert.ok(manifest.files?.includes('skills/debug-live'));
	});
});
