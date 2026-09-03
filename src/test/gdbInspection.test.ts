// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebuggingExecutor, IDebuggingExecutor } from '../debuggingExecutor';
import { DebuggingHandler } from '../debuggingHandler';

suite('Cortex-Debug complex value inspection', () => {
    function withActiveSession<T>(
        customRequest: (command: string, args: any) => Promise<any>,
        run: () => Promise<T>
    ): Promise<T> {
        const descriptor = Object.getOwnPropertyDescriptor(vscode.debug, 'activeDebugSession');
        Object.defineProperty(vscode.debug, 'activeDebugSession', {
            configurable: true,
            get: () => ({
                id: 'cortex-session',
                name: 'Cortex Debug',
                type: 'cortex-debug',
                customRequest
            })
        });

        return run().finally(() => {
            if (descriptor) {
                Object.defineProperty(vscode.debug, 'activeDebugSession', descriptor);
            }
        });
    }

    function withActiveFrame<T>(run: () => Promise<T>): Promise<T> {
        const descriptor = Object.getOwnPropertyDescriptor(vscode.debug, 'activeStackItem');
        Object.defineProperty(vscode.debug, 'activeStackItem', {
            configurable: true,
            get: () => ({ frameId: 1, threadId: 1, session: {} })
        });

        return run().finally(() => {
            if (descriptor) {
                Object.defineProperty(vscode.debug, 'activeStackItem', descriptor);
            }
        });
    }

    test('p commands use watch evaluation so Cortex-Debug returns a result body', async () => {
        const requests: Array<{ command: string; args: any }> = [];
        await withActiveSession(async (command, args) => {
            requests.push({ command, args });
            return { result: '{b = {0x46, 0x29}}', variablesReference: 7 };
        }, async () => {
            const response = await new DebuggingExecutor().evaluateExpression('p pxMAC_ADDR', 42);

            assert.strictEqual(response.result, '{b = {0x46, 0x29}}');
            assert.deepStrictEqual(requests, [{
                command: 'evaluate',
                args: {
                    expression: 'pxMAC_ADDR',
                    frameId: 42,
                    context: 'watch'
                }
            }]);
        });
    });

    test('typed address casts are evaluated as C expressions', async () => {
        const requests: Array<{ command: string; args: any }> = [];
        await withActiveSession(async (command, args) => {
            requests.push({ command, args });
            return { result: '{b = {0x46}}', variablesReference: 0 };
        }, async () => {
            await new DebuggingExecutor().evaluateExpression(
                'p *(ARM_ETH_MAC_ADDR *)0x2001d17c',
                42
            );

            assert.strictEqual(
                requests[0].args.expression,
                '*(ARM_ETH_MAC_ADDR *)0x2001d17c'
            );
            assert.strictEqual(requests[0].args.context, 'watch');
        });
    });

    test('print/x requests hexadecimal DAP formatting', async () => {
        const requests: Array<{ command: string; args: any }> = [];
        await withActiveSession(async (command, args) => {
            requests.push({ command, args });
            return { result: '0x46', variablesReference: 0 };
        }, async () => {
            await new DebuggingExecutor().evaluateExpression('print/x pxMAC_ADDR.b[0]', 42);

            assert.deepStrictEqual(requests[0].args.format, { hex: true });
            assert.strictEqual(requests[0].args.expression, 'pxMAC_ADDR.b[0]');
        });
    });

    test('x/6bx reads and renders target memory', async () => {
        const requests: Array<{ command: string; args: any }> = [];
        await withActiveSession(async (command, args) => {
            requests.push({ command, args });
            if (command === 'evaluate') {
                return { result: '0x2001d17c', memoryReference: '0x2001d17c' };
            }
            return {
                address: '0x2001d17c',
                data: Buffer.from([0x46, 0x29, 0x04, 0xb4, 0x78, 0xd8]).toString('base64')
            };
        }, async () => {
            const response = await new DebuggingExecutor().evaluateExpression(
                'x/6bx &pxMAC_ADDR.b[0]',
                42
            );

            assert.strictEqual(requests[1].command, 'readMemory');
            assert.deepStrictEqual(requests[1].args, {
                memoryReference: '0x2001d17c',
                count: 6
            });
            assert.strictEqual(
                response.result,
                '0x2001d17c: 0x46 0x29 0x04 0xb4 0x78 0xd8'
            );
        });
    });

    test('requested structs and arrays expose descendant names and types without values', async () => {
        const executor = {
            hasActiveSession: async () => true,
            getVariables: async () => ({
                scopes: [{
                    name: 'Locals',
                    variables: [{
                        name: 'pxMAC_ADDR',
                        value: '{...}',
                        type: 'ARM_ETH_MAC_ADDR',
                        variablesReference: 10
                    }]
                }]
            }),
            getVariableChildren: async (reference: number) => {
                if (reference === 10) {
                    return [{
                        name: 'b',
                        value: 'uint8_t[6]',
                        type: 'uint8_t[6]',
                        variablesReference: 11
                    }];
                }
                return [0x46, 0x29, 0x04, 0xb4, 0x78, 0xd8].map((value, index) => ({
                    name: `[${index}]`,
                    value: `0x${value.toString(16).padStart(2, '0')}`,
                    type: 'uint8_t',
                    variablesReference: 0
                }));
            }
        } as unknown as IDebuggingExecutor;

        await withActiveFrame(async () => {
            const output = await new DebuggingHandler(executor, {} as any, 30)
                .handleGetVariables({ variableNames: ['pxMAC_ADDR'] });

            assert.match(output, /pxMAC_ADDR \(ARM_ETH_MAC_ADDR\)/);
            assert.match(output, /b \(uint8_t\[6\]\)/);
            assert.match(output, /\[0\] \(uint8_t\)/);
            assert.match(output, /\[5\] \(uint8_t\)/);
            assert.doesNotMatch(output, /0x46|0xd8/);
        });
    });

    test('nested fields do not expose values when only their parent is requested', async () => {
        const executor = {
            hasActiveSession: async () => true,
            getVariables: async () => ({
                scopes: [{
                    name: 'Locals',
                    variables: [{
                        name: 'config',
                        value: '{...}',
                        type: 'Config',
                        variablesReference: 20
                    }]
                }]
            }),
            getVariableChildren: async () => [{
                name: 'config.Password',
                evaluateName: 'config.Password',
                value: '"super-secret-password"',
                type: 'char *',
                variablesReference: 0
            }]
        } as unknown as IDebuggingExecutor;

        await withActiveFrame(async () => {
            const output = await new DebuggingHandler(executor, {} as any, 30)
                .handleGetVariables({ variableNames: ['config'] });

            assert.doesNotMatch(output, /super-secret-password/);
            assert.match(output, /config\.Password \(char \*\)/);
            assert.doesNotMatch(output, /<redacted: possible secret>/);
        });
    });

    test('evaluate_expression expands child names and types without reading their values', async () => {
        const executor = {
            hasActiveSession: async () => true,
            evaluateExpression: async () => ({
                result: '{Customer}',
                type: 'Customer',
                variablesReference: 30
            }),
            getVariableChildren: async (reference: number) => {
                if (reference === 30) {
                    return [{
                        name: 'customer.Name',
                        value: '"Alice"',
                        type: 'string 0;\ndec: 65\nhex: 0x41',
                        variablesReference: 0
                    }, {
                        name: 'customer.Address',
                        value: '{Address}',
                        type: 'Address',
                        variablesReference: 31
                    }];
                }
                return [{
                    name: 'customer.Address.City',
                    value: '"London"',
                    type: 'string',
                    variablesReference: 0
                }];
            }
        } as unknown as IDebuggingExecutor;

        await withActiveFrame(async () => {
            const output = await new DebuggingHandler(executor, {} as any, 30)
                .handleEvaluateExpression({ expression: 'customer' });

            assert.match(output, /Result: <complex value> \(Customer\)/);
            assert.match(output, /customer\.Name \(string\)/);
            assert.doesNotMatch(output, /dec:|hex:/);
            assert.match(output, /customer\.Address \(Address\)/);
            assert.match(output, /customer\.Address\.City \(string\)/);
            assert.doesNotMatch(output, /Alice|London/);
        });
    });

    test('explicitly evaluated pointers return their value instead of being treated as aggregates', async () => {
        const executor = {
            hasActiveSession: async () => true,
            evaluateExpression: async () => ({
                result: '0x94 "Alice"',
                type: 'const char *',
                variablesReference: 42
            }),
            getVariableChildren: async () => {
                throw new Error('Pointer children should not be expanded');
            }
        } as unknown as IDebuggingExecutor;

        await withActiveFrame(async () => {
            const output = await new DebuggingHandler(executor, {} as any, 30)
                .handleEvaluateExpression({ expression: 'customer.name' });

            assert.match(output, /Result: 0x94 "Alice" \(const char \*\)/);
        });
    });

    test('recursive expansion is capped at 100 total child fields', async () => {
        const expandedReferences: number[] = [];
        const executor = {
            hasActiveSession: async () => true,
            evaluateExpression: async () => ({
                result: '{Root}',
                type: 'Root',
                variablesReference: 100
            }),
            getVariableChildren: async (reference: number) => {
                expandedReferences.push(reference);
                if (reference === 100) {
                    return Array.from({ length: 60 }, (_, index) => ({
                        name: `field${index}`,
                        value: '{Child}',
                        type: 'Child',
                        variablesReference: 1000 + index
                    }));
                }
                return [{
                    name: `field${reference - 1000}.leaf`,
                    value: String(reference),
                    type: 'int',
                    variablesReference: 0
                }];
            }
        } as unknown as IDebuggingExecutor;

        await withActiveFrame(async () => {
            const output = await new DebuggingHandler(executor, {} as any, 30)
                .handleEvaluateExpression({ expression: 'root' });
            const renderedFields = output.split('\n')
                .filter(line => /^\s+field\d+(?:\.leaf)? \(/.test(line));

            assert.strictEqual(renderedFields.length, 100);
            assert.match(output, /field49\.leaf \(int\)/);
            assert.doesNotMatch(output, /field50 \(Child\)/);
            assert.match(output, /<10 more child variable\(s\)>/);
            assert.ok(!expandedReferences.includes(1050));
        });
    });

    test('successful empty adapter output is reported explicitly', async () => {
        const executor = {
            hasActiveSession: async () => true,
            evaluateExpression: async () => ({ resultClass: 'done', output: '' })
        } as unknown as IDebuggingExecutor;

        await withActiveFrame(async () => {
            const handler = new DebuggingHandler(executor, {} as any, 30);
            await assert.rejects(
                () => handler.handleEvaluateExpression({ expression: 'p pxMAC_ADDR' }),
                /reported success but returned no expression result or captured output/
            );
        });
    });
});
