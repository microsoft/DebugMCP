// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebuggingHandler } from '../debuggingHandler';
import { DebuggingExecutor, IDebuggingExecutor } from '../debuggingExecutor';

suite('Ruby rdbg variable inspection', () => {
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

    test('returns scalar values instead of expanding rdbg metadata', async () => {
        let expanded = false;
        const executor = {
            hasActiveSession: async () => true,
            getVariables: async () => ({
                scopes: [{
                    name: 'Local variables',
                    variables: [{
                        name: 'probe_value',
                        value: '41',
                        type: 'Integer',
                        variablesReference: 10
                    }]
                }]
            }),
            getVariableChildren: async () => {
                expanded = true;
                return [{ name: '#class', type: 'Class', variablesReference: 11 }];
            }
        } as unknown as IDebuggingExecutor;

        await withActiveFrame(async () => {
            const output = await new DebuggingHandler(executor, {} as any, 30)
                .handleGetVariables({ variableNames: ['probe_value'], scope: 'local' });

            assert.match(output, /probe_value: 41 \(Integer\)/);
            assert.doesNotMatch(output, /#class/);
            assert.strictEqual(expanded, false);
        });
    });

    test('keeps aggregate descendants to names and types without scalar metadata', async () => {
        const expandedReferences: number[] = [];
        const executor = {
            hasActiveSession: async () => true,
            getVariables: async () => ({
                scopes: [{
                    name: 'Local variables',
                    variables: [{
                        name: 'probe_record',
                        value: '{:label=>"rbilling", :count=>41}',
                        type: 'Hash',
                        variablesReference: 20,
                        namedVariables: 3
                    }]
                }]
            }),
            getVariableChildren: async (reference: number, options: any) => {
                expandedReferences.push(reference);
                assert.deepStrictEqual(options, { indexedVariables: undefined });
                return [{
                    name: '#class',
                    value: 'Hash',
                    type: 'Class',
                    variablesReference: 23
                }, {
                    name: ':label',
                    value: '"rbilling"',
                    type: 'String',
                    variablesReference: 21
                }, {
                    name: ':count',
                    value: '41',
                    type: 'Integer',
                    variablesReference: 22
                }];
            }
        } as unknown as IDebuggingExecutor;

        await withActiveFrame(async () => {
            const output = await new DebuggingHandler(executor, {} as any, 30)
                .handleGetVariables({ variableNames: ['probe_record'], scope: 'local' });

            assert.match(output, /probe_record \(Hash\)/);
            assert.match(output, /:label \(String\)/);
            assert.match(output, /:count \(Integer\)/);
            assert.doesNotMatch(output, /rbilling|:count=>41|#class/);
            assert.deepStrictEqual(expandedReferences, [20]);
        });
    });

    test('uses indexed DAP paging for Ruby Array children', async () => {
        const requests: Array<{ command: string; args: any }> = [];
        const descriptor = Object.getOwnPropertyDescriptor(vscode.debug, 'activeDebugSession');
        Object.defineProperty(vscode.debug, 'activeDebugSession', {
            configurable: true,
            get: () => ({
                id: 'ruby-session',
                name: 'Ruby LSP',
                type: 'ruby_lsp',
                customRequest: async (command: string, args: any) => {
                    requests.push({ command, args });
                    return { variables: [] };
                }
            })
        });

        try {
            await new DebuggingExecutor().getVariableChildren(50, {
                indexedVariables: 2
            });

            assert.deepStrictEqual(requests, [{
                command: 'variables',
                args: {
                    variablesReference: 50,
                    filter: 'indexed',
                    start: 0,
                    count: 2
                }
            }]);
        } finally {
            if (descriptor) {
                Object.defineProperty(vscode.debug, 'activeDebugSession', descriptor);
            }
        }
    });

    test('returns scalar expression results instead of expanding rdbg metadata', async () => {
        let expanded = false;
        const executor = {
            hasActiveSession: async () => true,
            evaluateExpression: async () => ({
                result: '42',
                type: 'Integer',
                variablesReference: 30
            }),
            getVariableChildren: async () => {
                expanded = true;
                return [{ name: '#class', type: 'Class', variablesReference: 31 }];
            }
        } as unknown as IDebuggingExecutor;

        await withActiveFrame(async () => {
            const output = await new DebuggingHandler(executor, {} as any, 30)
                .handleEvaluateExpression({ expression: 'probe_value + 1' });

            assert.match(output, /Result: 42 \(Integer\)/);
            assert.doesNotMatch(output, /#class/);
            assert.strictEqual(expanded, false);
        });
    });

    test('still redacts Ruby String values that have metadata children', async () => {
        const executor = {
            hasActiveSession: async () => true,
            getVariables: async () => ({
                scopes: [{
                    name: 'Local variables',
                    variables: [{
                        name: 'api_token',
                        value: '"ghp_abcdefghijklmnopqrstuvwxyz0123456789"',
                        type: 'String',
                        variablesReference: 40
                    }]
                }]
            }),
            getVariableChildren: async () => {
                throw new Error('Ruby String metadata should not be expanded');
            }
        } as unknown as IDebuggingExecutor;

        await withActiveFrame(async () => {
            const output = await new DebuggingHandler(executor, {} as any, 30)
                .handleGetVariables({ variableNames: ['api_token'], scope: 'local' });

            assert.doesNotMatch(output, /ghp_/);
            assert.match(output, /<redacted: possible secret>/);
        });
    });
});
