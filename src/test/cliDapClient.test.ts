// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DapClient } from '../cli/dapClient';

suite('CLI DAP client', () => {
	let directory: string;

	setup(async () => {
		directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'debugmcp-dap-'));
	});

	teardown(async () => {
		await fs.promises.rm(directory, { recursive: true, force: true });
	});

	test('frames requests and correlates responses', async () => {
		const adapterPath = path.join(directory, 'adapter.js');
		await fs.promises.writeFile(adapterPath, `
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
	buffer = Buffer.concat([buffer, chunk]);
	const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
	if (headerEnd < 0) return;
	const header = buffer.subarray(0, headerEnd).toString('ascii');
	const length = Number(/Content-Length:\\s*(\\d+)/i.exec(header)[1]);
	const start = headerEnd + 4;
	if (buffer.length < start + length) return;
	const request = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
	const response = Buffer.from(JSON.stringify({
		seq: 1,
		type: 'response',
		request_seq: request.seq,
		command: request.command,
		success: true,
		body: { echoed: request.arguments.value }
	}));
	process.stdout.write('Content-Length: ' + response.length + '\\r\\n\\r\\n');
	process.stdout.write(response);
});
`, 'utf8');

		const client = new DapClient(process.execPath, [adapterPath], directory, 5_000);
		try {
			const response = await client.request('echo', { value: 42 });
			assert.deepStrictEqual(response, { echoed: 42 });
		} finally {
			await client.close();
		}
	});
});
