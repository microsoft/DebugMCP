// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebuggingExecutor, IDebuggingExecutor } from '../debuggingExecutor';
import { DebuggingHandler } from '../debuggingHandler';

suite('Mixed indexed and named variable children', () => {
    for (const type of [ 'ruby_lsp', 'pwa-node', 'cppdbg' ]) {
        test(`${type}: retrieves indexed elements and named properties`, async () => {
            const descriptor = Object.getOwnPropertyDescriptor(vscode.debug, 'activeDebugSession')!;
            const requests: unknown[] = [];
            const indexed = { name: '0', type: 'Integer', variablesReference: 0 };
            const named = { name: 'label', type: 'String', variablesReference: 0 };
            Object.defineProperty(vscode.debug, 'activeDebugSession', {
                configurable: true,
                get: () => ({ type, customRequest: async (_command: string, args: { filter?: string }) => {
                    requests.push(args);
                    return { variables: args.filter === 'indexed' ? [ indexed ] : [ named ] };
                } })
            });
            try {
                assert.deepStrictEqual(await new DebuggingExecutor().getVariableChildren(5, { indexedVariables: 1 }),
                    [ indexed, named ]);
                assert.deepStrictEqual(requests, [
                    { variablesReference: 5, filter: 'indexed', start: 0, count: 1 },
                    { variablesReference: 5, filter: 'named' }
                ]);
                requests.length = 0;
                await new DebuggingExecutor().getVariableChildren(5);
                assert.deepStrictEqual(requests, [ { variablesReference: 5 } ]);
            } finally {
                Object.defineProperty(vscode.debug, 'activeDebugSession', descriptor);
            }
        });
    }

    test('non-Ruby String objects retain their children and metadata-like user fields', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(vscode.debug, 'activeStackItem')!;
        Object.defineProperty(vscode.debug, 'activeStackItem', {
            configurable: true, get: () => ({ frameId: 1, threadId: 1 })
        });
        const executor = {
            hasActiveSession: async () => true,
            getActiveFrameId: () => 1,
            getActiveSession: () => ({ type: 'pwa-node' }),
            evaluateExpression: async () => ({ type: 'String', result: 'private preview', variablesReference: 1 }),
            getVariableChildren: async () => [
                { name: '#class', type: 'string', value: 'private value', variablesReference: 0 },
                { name: '%ancestors', type: 'string', value: 'private value', variablesReference: 0 }
            ]
        } as unknown as IDebuggingExecutor;
        try {
            const output = await new DebuggingHandler(executor, {} as any, 30)
                .handleEvaluateExpression({ expression: 'value' });
            assert.match(output, /#class \(string\)/);
            assert.match(output, /%ancestors \(string\)/);
            assert.doesNotMatch(output, /private/);
        } finally {
            Object.defineProperty(vscode.debug, 'activeStackItem', descriptor);
        }
    });
});
