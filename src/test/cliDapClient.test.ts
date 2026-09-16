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

	test('surfaces DAP error responses', async () => {
		const adapterPath = path.join(directory, 'rejecting-adapter.js');
		await fs.promises.writeFile(adapterPath, `
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
	buffer = Buffer.concat([buffer, chunk]);
	const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
	if (headerEnd < 0) return;
	const length = Number(/Content-Length:\\s*(\\d+)/i.exec(
		buffer.subarray(0, headerEnd).toString('ascii')
	)[1]);
	const start = headerEnd + 4;
	if (buffer.length < start + length) return;
	const request = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
	const response = Buffer.from(JSON.stringify({
		seq: 1,
		type: 'response',
		request_seq: request.seq,
		command: request.command,
		success: false,
		message: 'launch configuration rejected'
	}));
	process.stdout.write('Content-Length: ' + response.length + '\\r\\n\\r\\n');
	process.stdout.write(response);
});
`, 'utf8');

		const client = new DapClient(process.execPath, [adapterPath], directory, 5_000);
		try {
			await assert.rejects(
				() => client.request('launch'),
				/launch configuration rejected/
			);
		} finally {
			await client.close();
		}
	});

	test('rejects pending requests when the adapter exits', async () => {
		const adapterPath = path.join(directory, 'exiting-adapter.js');
		await fs.promises.writeFile(
			adapterPath,
			'process.stdin.once("data", () => process.exit(7));\n',
			'utf8'
		);

		const client = new DapClient(process.execPath, [adapterPath], directory, 5_000);
		try {
			await assert.rejects(
				() => client.request('initialize'),
				/Debug adapter exited with exit code 7/
			);
		} finally {
			await client.close();
		}
	});

	test('returns a failed runInTerminal response when spawn fails', async () => {
		const adapterPath = path.join(directory, 'terminal-adapter.js');
		await fs.promises.writeFile(adapterPath, `
let buffer = Buffer.alloc(0);
let initializeRequest;
function send(message) {
	const payload = Buffer.from(JSON.stringify(message));
	process.stdout.write('Content-Length: ' + payload.length + '\\r\\n\\r\\n');
	process.stdout.write(payload);
}
function accept(message) {
	if (message.type === 'request' && message.command === 'initialize') {
		initializeRequest = message;
		send({
			seq: 10,
			type: 'request',
			command: 'runInTerminal',
			arguments: { args: ['definitely-missing-debugmcp-executable'] }
		});
		return;
	}
	if (message.type === 'response' && message.request_seq === 10) {
		send({
			seq: 11,
			type: 'response',
			request_seq: initializeRequest.seq,
			command: 'initialize',
			success: true,
			body: {
				reverseRequestSucceeded: message.success,
				reverseRequestMessage: message.message
			}
		});
	}
}
process.stdin.on('data', chunk => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
		if (headerEnd < 0) return;
		const length = Number(/Content-Length:\\s*(\\d+)/i.exec(
			buffer.subarray(0, headerEnd).toString('ascii')
		)[1]);
		const start = headerEnd + 4;
		if (buffer.length < start + length) return;
		const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
		buffer = buffer.subarray(start + length);
		accept(message);
	}
});
`, 'utf8');

		const client = new DapClient(process.execPath, [adapterPath], directory, 5_000);
		try {
			const response = await client.request('initialize');
			assert.strictEqual(response.reverseRequestSucceeded, false);
			assert.match(response.reverseRequestMessage, /ENOENT|not found/i);
		} finally {
			await client.close();
		}
	});
});
