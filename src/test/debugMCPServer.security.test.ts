// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import { DebugMCPServer, isLoopbackHost, isLoopbackOrigin } from '../debugMCPServer';

suite('DebugMCPServer security (ICM 31000000603080 / 31000000611073)', () => {

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
            server = new DebugMCPServer(port, 60, '127.0.0.1');
            await server.initialize();
            await server.start();
        });

        suiteTeardown(async () => {
            await server.stop();
        });

        function postMcp(headers: http.OutgoingHttpHeaders): Promise<{ status: number; body: string }> {
            const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
            const opts: http.RequestOptions = {
                host: '127.0.0.1',
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

        test('ICM 603080: server is NOT reachable on non-loopback interface', async () => {
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

        test('ICM 611073: request with attacker Host header is rejected (403)', async () => {
            const res = await postMcp({ Host: 'attacker.example' });
            assert.strictEqual(res.status, 403, `expected 403 for DNS-rebinding Host header, got ${res.status}: ${res.body}`);
        });

        test('ICM 611073: request with non-loopback Origin header is rejected (403)', async () => {
            const res = await postMcp({ Host: '127.0.0.1', Origin: 'https://attacker.example' });
            assert.strictEqual(res.status, 403, `expected 403 for attacker Origin, got ${res.status}: ${res.body}`);
        });

        test('loopback request with valid Host header is accepted', async () => {
            const res = await postMcp({ Host: `127.0.0.1:${port}` });
            // Anything other than 403 means the rebinding middleware let it through.
            // We don't validate the exact response shape because MCP handshake semantics
            // are outside the scope of this security test.
            assert.notStrictEqual(res.status, 403, `loopback request was incorrectly rejected: ${res.body}`);
        });
    });
});
