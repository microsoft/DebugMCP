// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as path from 'path';
import { isSourceUri, toSourceUri } from '../utils/sourceUri';

suite('Source URI handling', () => {
	test('preserves an AL virtual .dal document URI', () => {
		const source = 'al-preview://AlLang/437dbf0e84ff417a965ded2bb9650972/Table/18/Customer.dal';
		const uri = toSourceUri(source);

		assert.strictEqual(isSourceUri(source), true);
		assert.strictEqual(uri.scheme, 'al-preview');
		assert.strictEqual(uri.authority, 'AlLang');
		assert.strictEqual(uri.path, '/437dbf0e84ff417a965ded2bb9650972/Table/18/Customer.dal');
		assert.strictEqual(
			uri.toString(),
			'al-preview://allang/437dbf0e84ff417a965ded2bb9650972/Table/18/Customer.dal'
		);
	});

	test('keeps native filesystem paths as file URIs', () => {
		const source = path.join(path.sep, 'workspace', 'src', 'main.ts');
		const uri = toSourceUri(source);

		assert.strictEqual(isSourceUri(source), false);
		assert.strictEqual(uri.scheme, 'file');
		assert.strictEqual(uri.fsPath, source);
	});

	test('does not mistake a Windows drive letter for a URI scheme', () => {
		assert.strictEqual(isSourceUri('C:\\workspace\\src\\main.ts'), false);
	});
});
