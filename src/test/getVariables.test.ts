// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebuggingHandler } from '../debuggingHandler';
import { IDebuggingExecutor } from '../debuggingExecutor';

/**
 * Executor stub that reports a paused session with a fixed set of scopes,
 * so variable-selection behavior can be tested without a live debug adapter.
 */
function makeExecutor(scopes: any[]): IDebuggingExecutor {
    return {
        hasActiveSession: async () => true,
        getActiveFrameId: () => 1,
        getVariables: async () => ({ scopes })
    } as unknown as IDebuggingExecutor;
}

const SCOPES = [
    {
        name: 'Locals',
        variables: [
            { name: 'user', value: "{'id': 7}", type: 'dict' },
            { name: 'retries', value: '3', type: 'int' },
            { name: 'api_key', value: "'sk-abcdefghijklmnopqrst'", type: 'str' }
        ]
    },
    {
        name: 'Globals',
        variables: [
            { name: 'CONFIG_PATH', value: "'/etc/app.conf'", type: 'str' }
        ]
    }
];

suite('get_variables_values targeted retrieval', () => {

    // vscode.debug.activeStackItem is read-only; stub it for the duration of a test.
    function withStubbedFrame<T>(run: () => Promise<T>): Promise<T> {
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

    function newHandler(): DebuggingHandler {
        return new DebuggingHandler(makeExecutor(SCOPES), {} as any, 30);
    }

    test('returns only the requested variables, not the whole scope', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['user'] });
            assert.ok(output.includes('user:'), 'requested variable missing');
            assert.ok(!output.includes('retries'), 'unrequested variable leaked');
            assert.ok(!output.includes('CONFIG_PATH'), 'unrequested global leaked');
        });
    });

    test('supports several names across scopes', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['retries', 'CONFIG_PATH'] });
            assert.ok(output.includes('retries: 3'));
            assert.ok(output.includes('CONFIG_PATH'));
            assert.ok(!output.includes('user:'), 'unrequested variable leaked');
        });
    });

    test('still redacts a requested secret-looking variable', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['api_key'] });
            assert.ok(!output.includes('sk-abcdefghijklmnopqrst'), 'secret leaked');
            assert.ok(output.includes('<redacted: possible secret>'));
        });
    });

    test('rejects a missing or empty variableNames list', async () => {
        const handler = newHandler();
        await assert.rejects(
            () => handler.handleGetVariables({} as any),
            /variableNames' is required/
        );
        await assert.rejects(
            () => handler.handleGetVariables({ variableNames: [] }),
            /variableNames' is required/
        );
        await assert.rejects(
            () => handler.handleGetVariables({ variableNames: ['   '] }),
            /no usable names/
        );
    });

    test('rejects wildcard requests that would dump the scope', async () => {
        const handler = newHandler();
        await assert.rejects(() => handler.handleGetVariables({ variableNames: ['*'] }), /Wildcards are not supported/);
        await assert.rejects(() => handler.handleGetVariables({ variableNames: ['all'] }), /Wildcards are not supported/);
    });

    test('rejects an oversized request', async () => {
        const handler = newHandler();
        const many = Array.from({ length: 51 }, (_, i) => `v${i}`);
        await assert.rejects(() => handler.handleGetVariables({ variableNames: many }), /Too many variables requested/);
    });

    test('reports unknown names instead of silently returning nothing', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['user', 'nope'] });
            assert.ok(output.includes('user:'));
            assert.ok(output.includes('Not found in any scope: nope'));
        });
    });

    test('explains how to recover when no requested name matches', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['nope'] });
            assert.ok(output.includes('None of the requested variables'));
            assert.ok(output.includes('list_variable_names'));
        });
    });
});

/**
 * When an adapter supplies no evaluateName its `name` is used verbatim and is
 * never parsed, so a display decoration is reported exactly as received rather
 * than being guessed at.
 */
const SUFFIXED_SCOPES = [
    {
        name: 'Locals',
        variables: [
            { name: 'config [Dictionary]', value: 'Count = 5', type: 'System.Collections.Generic.Dictionary<string, object>' },
            { name: 'api_key [string]', value: '"sk-abcdefghijklmnopqrst"', type: 'string' },
            { name: 'this', value: '{Calculator}', type: 'Calculator' }
        ]
    }
];

suite('variables without an evaluateName', () => {

    function withStubbedFrame<T>(run: () => Promise<T>): Promise<T> {
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

    function newHandler(): DebuggingHandler {
        return new DebuggingHandler(makeExecutor(SUFFIXED_SCOPES), {} as any, 30);
    }

    test('matches the raw adapter name exactly', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['config [Dictionary]'] });
            assert.ok(output.includes('config [Dictionary]: Count = 5'));
            assert.ok(!output.includes('Not found in any scope'));
        });
    });

    test('does not parse a display decoration out of the name', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['config'] });
            assert.ok(output.includes('None of the requested variables'),
                'name must be used verbatim, not stripped');
        });
    });

    test('lists the raw name verbatim', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleListVariableNames({});
            assert.ok(output.includes('config [Dictionary] (System.Collections.Generic.Dictionary<string, object>)'));
        });
    });

    test('plain names keep working', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['this', 'nope'] });
            assert.ok(output.includes('this: {Calculator}'));
            assert.ok(output.includes('Not found in any scope: nope'));
        });
    });

    test('redaction still applies to a decorated secret name', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['api_key [string]'] });
            assert.ok(!output.includes('sk-abcdefghijklmnopqrst'), 'secret leaked');
            assert.ok(output.includes('<redacted: possible secret>'));
        });
    });
});

/**
 * `Variable.evaluateName` is the adapter's canonical, evaluatable name and is
 * preferred over any parsing of the display name.
 */
const EVALUATE_NAME_SCOPES = [
    {
        name: 'Locals',
        variables: [
            {
                name: 'config [Dictionary]',
                evaluateName: 'config',
                value: 'Count = 5',
                type: 'System.Collections.Generic.Dictionary<string, object>'
            },
            {
                // A display name that no amount of parsing would recover.
                name: 'matrix [int[,]]',
                evaluateName: 'matrix',
                value: '{int[2, 2]}',
                type: 'int[,]'
            }
        ]
    }
];

suite('evaluateName is preferred over the display name', () => {

    function withStubbedFrame<T>(run: () => Promise<T>): Promise<T> {
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

    function newHandler(): DebuggingHandler {
        return new DebuggingHandler(makeExecutor(EVALUATE_NAME_SCOPES), {} as any, 30);
    }

    test('resolves and reports the adapter-supplied evaluateName', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['config'] });
            assert.ok(output.includes('config: Count = 5'));
            assert.ok(!output.includes('[Dictionary]'), 'display decoration leaked into the name');
        });
    });

    test('handles names no parsing of the display name could recover', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['matrix'] });
            assert.ok(output.includes('matrix: {int[2, 2]}'));
            assert.ok(!output.includes('None of the requested variables'));
        });
    });

    test('lists the evaluateName so it can be passed straight back', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleListVariableNames({});
            assert.ok(output.includes('config (System.Collections.Generic.Dictionary<string, object>)'));
            assert.ok(output.includes('matrix (int[,])'));
            assert.ok(!output.includes('[Dictionary]'), 'display decoration leaked into the listing');
        });
    });
});

/**
 * Names that legitimately end in brackets (array elements, raw views) must be
 * reported and matched verbatim.
 */
const BRACKET_NAME_SCOPES = [
    {
        name: 'Locals',
        variables: [
            { name: '[0]', value: '7', type: 'int' },
            { name: 'arr[0]', value: '8', type: 'int' },
            { name: '[Raw View]', value: '{...}', type: 'view' }
        ]
    }
];

suite('names that legitimately end in brackets', () => {

    function withStubbedFrame<T>(run: () => Promise<T>): Promise<T> {
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

    function newHandler(): DebuggingHandler {
        return new DebuggingHandler(makeExecutor(BRACKET_NAME_SCOPES), {} as any, 30);
    }

    test('an array element name is preserved, not collapsed to empty', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['[0]'] });
            assert.ok(output.includes('[0]: 7'), 'array element name was mangled');
        });
    });

    test('an indexed name is not collapsed onto its parent', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleGetVariables({ variableNames: ['arr'] });
            assert.ok(output.includes('None of the requested variables'),
                "'arr' must not resolve to the distinct variable 'arr[0]'");
        });
    });

    test('listing reports bracketed names verbatim', async () => {
        await withStubbedFrame(async () => {
            const output = await newHandler().handleListVariableNames({});
            assert.ok(output.includes('[0] (int)'));
            assert.ok(output.includes('arr[0] (int)'));
            assert.ok(output.includes('[Raw View] (view)'));
        });
    });
});

suite('list_variable_names discovery', () => {

    function withStubbedFrame<T>(run: () => Promise<T>): Promise<T> {
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

    test('lists names and types but never any values', async () => {
        await withStubbedFrame(async () => {
            const handler = new DebuggingHandler(makeExecutor(SCOPES), {} as any, 30);
            const output = await handler.handleListVariableNames({});

            assert.ok(output.includes('user (dict)'));
            assert.ok(output.includes('retries (int)'));
            assert.ok(output.includes('api_key (str)'));
            // No values, redacted or otherwise.
            assert.ok(!output.includes('sk-abcdefghijklmnopqrst'), 'secret value leaked');
            assert.ok(!output.includes('/etc/app.conf'), 'value leaked');
            assert.ok(!output.includes('redacted'), 'listing should not need redaction');
        });
    });
});
