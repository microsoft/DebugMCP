// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import { DebugMCPServer, isLoopbackHost, isLoopbackOrigin } from '../debugMCPServer';

suite('DebugMCPServer security', () => {

    suite('isLoopbackHost', () => {
        test('accepts loopback hostnames with or without port', () => {
            assert.strictEqual(isLoopbackHost('localhost'), true);
            assert.strictEqual(isLoopbackHost('localhost:3001'), true);
            assert.strictEqual(isLoopbackHost('127.0.0.1'), true);
            assert.strictEqual(isLoopbackHost('127.0.0.1:3001'), true);
            assert.strictEqual(isLoopbackHost('[::1]'), true);
            assert.strictEqual(isLoopbackHost('[::1]:3001'), true);
            assert.strictEqual(isLoopbackHost('LOCALHOST'), true);
        });

        test('rejects non-loopback / attacker-controlled hostnames (DNS rebinding)', () => {
            assert.strictEqual(isLoopbackHost('attacker.example'), false);
            assert.strictEqual(isLoopbackHost('attacker.example:3001'), false);
            assert.strictEqual(isLoopbackHost('rebind.local:3001'), false);
            assert.strictEqual(isLoopbackHost('192.168.1.10:3001'), false);
            assert.strictEqual(isLoopbackHost('10.0.0.1'), false);
            assert.strictEqual(isLoopbackHost('169.254.169.254'), false);
            assert.strictEqual(isLoopbackHost(''), false);
            assert.strictEqual(isLoopbackHost(undefined), false);
        });

        test('with expectedPort, rejects loopback host whose port does not match', () => {
            assert.strictEqual(isLoopbackHost('localhost:3001', 3001), true);
            assert.strictEqual(isLoopbackHost('127.0.0.1:3001', 3001), true);
            assert.strictEqual(isLoopbackHost('[::1]:3001', 3001), true);
            // Absent port is still allowed (some clients omit it for default ports).
            assert.strictEqual(isLoopbackHost('localhost', 3001), true);
            // Wrong port is rejected — prevents Host: localhost:99999 sneaking through.
            assert.strictEqual(isLoopbackHost('localhost:99999', 3001), false);
            assert.strictEqual(isLoopbackHost('127.0.0.1:8080', 3001), false);
            assert.strictEqual(isLoopbackHost('[::1]:8080', 3001), false);
        });
    });

    suite('isLoopbackOrigin', () => {
        test('absent Origin is allowed (typical non-browser MCP clients)', () => {
            assert.strictEqual(isLoopbackOrigin(undefined), true);
            assert.strictEqual(isLoopbackOrigin(''), true);
        });

        test('accepts loopback origins', () => {
            assert.strictEqual(isLoopbackOrigin('http://localhost:3001'), true);
            assert.strictEqual(isLoopbackOrigin('http://127.0.0.1:3001'), true);
            assert.strictEqual(isLoopbackOrigin('http://[::1]:3001'), true);
        });

        test('rejects non-loopback origins and malformed values', () => {
            assert.strictEqual(isLoopbackOrigin('https://attacker.example'), false);
            assert.strictEqual(isLoopbackOrigin('http://192.168.1.10:3001'), false);
            assert.strictEqual(isLoopbackOrigin('not a url'), false);
        });
    });

    suite('HTTP server (live)', () => {
        const port = 30099;
        let server: DebugMCPServer;

        suiteSetup(async () => {
            server = new DebugMCPServer(port, 60);
            await server.initialize();
            await server.start();
        });

        suiteTeardown(async () => {
            await server.stop();
        });

        function postMcp(headers: http.OutgoingHttpHeaders, hostAddr: string = '127.0.0.1'): Promise<{ status: number; body: string }> {
            const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
            const opts: http.RequestOptions = {
                host: hostAddr,
                port,
                path: '/mcp',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                    'Content-Length': Buffer.byteLength(body).toString(),
                    ...headers
                }
            };
            return new Promise((resolve, reject) => {
                const req = http.request(opts, res => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
                });
                req.on('error', reject);
                req.write(body);
                req.end();
            });
        }

        test('server is NOT reachable on non-loopback interface (LAN exposure)', async () => {
            // Find a non-loopback IPv4 interface on this machine.
            const interfaces = os.networkInterfaces();
            let lanAddr: string | undefined;
            for (const list of Object.values(interfaces)) {
                for (const iface of list || []) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        lanAddr = iface.address;
                        break;
                    }
                }
                if (lanAddr) { break; }
            }
            if (!lanAddr) {
                // No external interface present on this test agent — nothing to assert.
                return;
            }

            await new Promise<void>((resolve) => {
                const sock = new net.Socket();
                sock.setTimeout(1500);
                sock.once('connect', () => {
                    sock.destroy();
                    assert.fail(`DebugMCP accepted a TCP connection on non-loopback address ${lanAddr}:${port} — server is exposed to the LAN.`);
                });
                sock.once('error', () => { sock.destroy(); resolve(); });
                sock.once('timeout', () => { sock.destroy(); resolve(); });
                sock.connect(port, lanAddr!);
            });
        });

        test('request with attacker Host header is rejected (403) — DNS rebinding defense', async () => {
            const res = await postMcp({ Host: 'attacker.example' });
            assert.strictEqual(res.status, 403, `expected 403 for DNS-rebinding Host header, got ${res.status}: ${res.body}`);
        });

        test('request with non-loopback Origin header is rejected (403)', async () => {
            const res = await postMcp({ Host: '127.0.0.1', Origin: 'https://attacker.example' });
            assert.strictEqual(res.status, 403, `expected 403 for attacker Origin, got ${res.status}: ${res.body}`);
        });

        test('request with loopback Host but mismatched port is rejected (403)', async () => {
            const res = await postMcp({ Host: 'localhost:99999' });
            assert.strictEqual(res.status, 403, `expected 403 for wrong-port Host header, got ${res.status}: ${res.body}`);
        });

        test('loopback request with valid Host header is accepted', async () => {
            const res = await postMcp({ Host: `127.0.0.1:${port}` });
            // Anything other than 403 means the rebinding middleware let it through.
            // We don't validate the exact response shape because MCP handshake semantics
            // are outside the scope of this security test.
            assert.notStrictEqual(res.status, 403, `loopback request was incorrectly rejected: ${res.body}`);
        });

        test('server is reachable over IPv6 loopback (::1)', async () => {
            try {
                const res = await postMcp({ Host: `[::1]:${port}` }, '::1');
                assert.notStrictEqual(res.status, 403, `IPv6 loopback request was incorrectly rejected: ${res.body}`);
            } catch (err: any) {
                // ENETUNREACH / EAFNOSUPPORT — host has no IPv6 stack; not a failure of the server.
                if (err && (err.code === 'ENETUNREACH' || err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
                    return;
                }
                throw err;
            }
        });
    });

    // Stateful Streamable-HTTP session lifecycle. Regression guard for the bug
    // where the transport ran stateless and GET /mcp returned 404, so clients
    // (Cursor) could never open the server->client SSE stream and tombstoned the
    // connection as "errored". Here we drive the real handshake: initialize over
    // POST mints a session id, and GET /mcp with that id must return a live
    // text/event-stream.
    suite('Streamable-HTTP session lifecycle', () => {
        const port = 30100;
        let server: DebugMCPServer;

        suiteSetup(async () => {
            server = new DebugMCPServer(port, 60);
            await server.initialize();
            await server.start();
        });

        suiteTeardown(async () => {
            await server.stop();
        });

        // POST an `initialize` request and resolve with the response status plus
        // the mcp-session-id header the server assigns to the new session.
        function postInitialize(): Promise<{ status: number; sessionId?: string }> {
            const body = JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'lifecycle-test', version: '0.0.0' }
                }
            });
            const opts: http.RequestOptions = {
                host: '127.0.0.1',
                port,
                path: '/mcp',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                    'Content-Length': Buffer.byteLength(body).toString(),
                    'Host': `127.0.0.1:${port}`
                }
            };
            return new Promise((resolve, reject) => {
                const req = http.request(opts, res => {
                    const sessionId = res.headers['mcp-session-id'] as string | undefined;
                    // Drain so the socket is released; we only need status + id.
                    res.on('data', () => { /* discard */ });
                    res.on('end', () => resolve({ status: res.statusCode || 0, sessionId }));
                    // initialize responds on an SSE channel that may stay open; the
                    // headers (and session id) are already available, so resolve now
                    // and let the drain handler clean up.
                    resolve({ status: res.statusCode || 0, sessionId });
                });
                req.on('error', reject);
                req.write(body);
                req.end();
            });
        }

        // Open GET /mcp (the server->client SSE stream) and resolve with the
        // status + content-type as soon as the response headers arrive, then
        // tear down the long-lived stream.
        function getMcp(headers: http.OutgoingHttpHeaders): Promise<{ status: number; contentType?: string }> {
            const opts: http.RequestOptions = {
                host: '127.0.0.1',
                port,
                path: '/mcp',
                method: 'GET',
                headers: {
                    'Accept': 'text/event-stream',
                    'Host': `127.0.0.1:${port}`,
                    ...headers
                }
            };
            return new Promise((resolve, reject) => {
                const req = http.request(opts, res => {
                    const contentType = res.headers['content-type'];
                    resolve({ status: res.statusCode || 0, contentType });
                    req.destroy(); // close the long-lived SSE stream
                });
                req.on('error', err => {
                    // A destroy() after we resolved can surface as ECONNRESET; ignore.
                    if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
                        return;
                    }
                    reject(err);
                });
                req.end();
            });
        }

        test('initialize over POST mints an mcp-session-id', async () => {
            const res = await postInitialize();
            assert.strictEqual(res.status, 200, `initialize should succeed, got ${res.status}`);
            assert.ok(res.sessionId, 'server did not return an mcp-session-id header on initialize');
        });

        test('GET /mcp with a valid session opens a text/event-stream', async () => {
            const init = await postInitialize();
            assert.ok(init.sessionId, 'precondition: initialize must yield a session id');

            const res = await getMcp({ 'mcp-session-id': init.sessionId });
            assert.strictEqual(res.status, 200, `GET /mcp should open the SSE stream (200), got ${res.status}`);
            assert.match(
                res.contentType || '',
                /text\/event-stream/,
                `GET /mcp must serve an SSE stream, got content-type: ${res.contentType}`
            );
        });

        test('GET /mcp without a session id is rejected (400)', async () => {
            const res = await getMcp({});
            assert.strictEqual(res.status, 400, `GET /mcp with no session must be 400, got ${res.status}`);
        });

        test('GET /mcp with an unknown session id is rejected (400)', async () => {
            const res = await getMcp({ 'mcp-session-id': 'does-not-exist' });
            assert.strictEqual(res.status, 400, `GET /mcp with bogus session must be 400, got ${res.status}`);
        });
    });
});
