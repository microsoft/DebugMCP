// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import { PassThrough } from 'stream';
import { DAPClient, DAPResponse, DAPEvent } from '../standalone/DAPClient';

/**
 * Helper to create a DAP message with content-length header
 */
function createDAPMessage(message: any): string {
	const json = JSON.stringify(message);
	const contentLength = Buffer.byteLength(json, 'utf8');
	return `Content-Length: ${contentLength}\r\n\r\n${json}`;
}

suite('DAPClient Test Suite', () => {
	let inputStream: PassThrough;
	let outputStream: PassThrough;
	let client: DAPClient;

	setup(() => {
		// Create mock streams for testing
		inputStream = new PassThrough();
		outputStream = new PassThrough();
		client = new DAPClient(inputStream, outputStream, 1000); // 1 second timeout for tests
	});

	teardown(() => {
		client.close();
	});

	test('should send request with correct format', (done) => {
		// Capture what's written to the output stream
		let output = '';
		outputStream.on('data', (chunk: Buffer) => {
			output += chunk.toString();

			// Verify the format
			const match = output.match(/Content-Length: (\d+)\r\n\r\n(.*)/);
			if (match) {
				const contentLength = parseInt(match[1], 10);
				const body = match[2];
				assert.strictEqual(body.length, contentLength);

				const message = JSON.parse(body);
				assert.strictEqual(message.type, 'request');
				assert.strictEqual(message.command, 'initialize');
				assert.strictEqual(message.seq, 1);
				done();
			}
		});

		// Send a request (don't await - we just want to test the send format)
		client.sendRequest('initialize', { adapterID: 'test' }).catch(() => {
			// Expected to timeout since we don't send a response
		});
	});

	test('should handle response correctly', async () => {
		// Start the request
		const requestPromise = client.sendRequest('initialize', { adapterID: 'test' });

		// Wait for request to be sent
		await new Promise(resolve => setTimeout(resolve, 10));

		// Send back a response
		const response: DAPResponse = {
			seq: 1,
			type: 'response',
			request_seq: 1,
			success: true,
			command: 'initialize',
			body: { supportsConfigurationDoneRequest: true }
		};
		inputStream.write(createDAPMessage(response));

		// Verify the response
		const result = await requestPromise;
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.body.supportsConfigurationDoneRequest, true);
	});

	test('should reject on error response', async () => {
		// Start the request
		const requestPromise = client.sendRequest('launch', { program: 'test.py' });

		// Wait for request to be sent
		await new Promise(resolve => setTimeout(resolve, 10));

		// Send back an error response
		const response: DAPResponse = {
			seq: 1,
			type: 'response',
			request_seq: 1,
			success: false,
			command: 'launch',
			message: 'Launch failed'
		};
		inputStream.write(createDAPMessage(response));

		// Verify it rejects
		try {
			await requestPromise;
			assert.fail('Should have thrown');
		} catch (error) {
			assert.ok((error as Error).message.includes('Launch failed'));
		}
	});

	test('should emit events', (done) => {
		// Listen for the event
		client.on('event:stopped', (body: any) => {
			assert.strictEqual(body.reason, 'breakpoint');
			assert.strictEqual(body.threadId, 1);
			done();
		});

		// Send an event
		const event: DAPEvent = {
			seq: 1,
			type: 'event',
			event: 'stopped',
			body: {
				reason: 'breakpoint',
				threadId: 1
			}
		};
		inputStream.write(createDAPMessage(event));
	});

	test('should handle multiple messages in one chunk', async () => {
		// Start two requests
		const request1 = client.sendRequest('initialize', { adapterID: 'test' });
		const request2 = client.sendRequest('launch', { program: 'test.py' });

		// Wait for requests to be sent
		await new Promise(resolve => setTimeout(resolve, 10));

		// Send both responses in one chunk
		const response1: DAPResponse = {
			seq: 1,
			type: 'response',
			request_seq: 1,
			success: true,
			command: 'initialize',
			body: {}
		};
		const response2: DAPResponse = {
			seq: 2,
			type: 'response',
			request_seq: 2,
			success: true,
			command: 'launch',
			body: {}
		};

		// Write both in one chunk
		inputStream.write(createDAPMessage(response1) + createDAPMessage(response2));

		// Both should resolve
		const result1 = await request1;
		const result2 = await request2;
		assert.strictEqual(result1.command, 'initialize');
		assert.strictEqual(result2.command, 'launch');
	});

	test('should handle fragmented messages', async () => {
		// Start a request
		const requestPromise = client.sendRequest('initialize', { adapterID: 'test' });

		// Wait for request to be sent
		await new Promise(resolve => setTimeout(resolve, 10));

		// Send response in fragments
		const response: DAPResponse = {
			seq: 1,
			type: 'response',
			request_seq: 1,
			success: true,
			command: 'initialize',
			body: {}
		};
		const fullMessage = createDAPMessage(response);

		// Split the message into fragments
		inputStream.write(fullMessage.slice(0, 10));
		await new Promise(resolve => setTimeout(resolve, 5));
		inputStream.write(fullMessage.slice(10, 20));
		await new Promise(resolve => setTimeout(resolve, 5));
		inputStream.write(fullMessage.slice(20));

		// Should still resolve correctly
		const result = await requestPromise;
		assert.strictEqual(result.success, true);
	});

	test('should timeout on no response', async () => {
		try {
			await client.sendRequest('initialize', { adapterID: 'test' });
			assert.fail('Should have timed out');
		} catch (error) {
			assert.ok((error as Error).message.includes('timed out'));
		}
	});

	test('should reject pending requests on close', async () => {
		// Start a request
		const requestPromise = client.sendRequest('initialize', { adapterID: 'test' });

		// Close the client immediately
		client.close();

		// Should reject
		try {
			await requestPromise;
			assert.fail('Should have rejected');
		} catch (error) {
			assert.ok((error as Error).message.includes('closed'));
		}
	});

	test('should throw when sending after close', async () => {
		client.close();

		try {
			await client.sendRequest('initialize', { adapterID: 'test' });
			assert.fail('Should have thrown');
		} catch (error) {
			assert.ok((error as Error).message.includes('closed'));
		}
	});

	test('should increment sequence numbers', async () => {
		const seqs: number[] = [];

		outputStream.on('data', (chunk: Buffer) => {
			const match = chunk.toString().match(/"seq":(\d+)/);
			if (match) {
				seqs.push(parseInt(match[1], 10));
			}
		});

		// Send multiple requests
		client.sendRequest('initialize', {}).catch(() => { });
		client.sendRequest('launch', {}).catch(() => { });
		client.sendRequest('continue', {}).catch(() => { });

		await new Promise(resolve => setTimeout(resolve, 50));

		assert.deepStrictEqual(seqs, [1, 2, 3]);
	});
});
