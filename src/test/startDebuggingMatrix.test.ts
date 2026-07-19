// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebugState } from '../debugState';
import { DebuggingHandler } from '../debuggingHandler';
import { IDebuggingExecutor, TestDebugDispatch } from '../debuggingExecutor';
import { IDebugConfigurationManager } from '../utils/debugConfigurationManager';

/**
 * Regression matrix for handleStartDebugging.
 *
 * Covers four scenarios per language:
 *   1. pause-hit     — session reaches a breakpoint
 *   2. clean-run     — session runs to completion without pausing
 *   3. launch-error  — the debug adapter fails to start
 *   4. no-build      — config resolution fails (e.g. missing built assembly)
 *
 * Both the "launch" path (no testName) and the "test" path (testName + Testing
 * API) are exercised. The test path additionally guards the race between
 * waitForDebugSessionReady and the testing.debugAtCursor completion promise
 * — this is the regression that caused .NET test runs to hang past breakpoint
 * hit and past clean completion.
 */

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

type ReadyState = 'stopped' | 'terminated' | 'timeout' | 'no-session';

interface MockOpts {
    readyState?: Deferred<ReadyState>;
    startResult?: boolean | Error;
    testDispatch?: TestDebugDispatch | Error;
    debugConfig?: string | vscode.DebugConfiguration | Error;
    language?: string;
}

function makeMocks(opts: MockOpts) {
    const state = new DebugState();
    state.sessionActive = false;

    const executor: IDebuggingExecutor = {
        startDebugging: async () => {
            if (opts.startResult instanceof Error) {
                throw opts.startResult;
            }
            return opts.startResult ?? true;
        },
        debugTestAtCursor: async () => {
            if (opts.testDispatch instanceof Error) {
                throw opts.testDispatch;
            }
            // Default: never resolves runComplete unless caller provides one.
            return opts.testDispatch ?? { started: true, runComplete: new Promise<void>(() => { /* pending */ }) };
        },
        waitForDebugSessionReady: () =>
            opts.readyState?.promise ?? Promise.resolve('no-session' as ReadyState),
        getCurrentDebugState: async () => state,
        stopDebugging: async () => { /* noop */ },
        stepOver: async () => { /* noop */ },
        stepInto: async () => { /* noop */ },
        stepOut: async () => { /* noop */ },
        continue: async () => { /* noop */ },
        pause: async () => { /* noop */ },
        restart: async () => { /* noop */ },
        addBreakpoint: async () => { /* noop */ },
        removeBreakpoint: async () => { /* noop */ },
        getVariables: async () => ({}),
        evaluateExpression: async () => ({}),
        getBreakpoints: () => [],
        clearAllBreakpoints: () => { /* noop */ },
        hasActiveSession: async () => false,
        getActiveSession: () => undefined
    };

    const configManager: IDebugConfigurationManager = {
        getDebugConfig: async () => {
            if (opts.debugConfig instanceof Error) {
                throw opts.debugConfig;
            }
            return opts.debugConfig ?? {
                type: opts.language ?? 'python',
                request: 'launch',
                name: 'DebugMCP Launch',
                program: 'unused'
            };
        },
        detectLanguageFromFilePath: () => opts.language ?? 'python'
    };

    return { executor, configManager };
}

interface LangCase {
    label: string;
    file: string;
    debuggerType: string;
}

const LANGUAGES: LangCase[] = [
    { label: 'Python',     file: '/repo/src/app.py',          debuggerType: 'python'   },
    { label: 'JavaScript', file: '/repo/src/app.js',          debuggerType: 'pwa-node' },
    { label: 'TypeScript', file: '/repo/src/app.ts',          debuggerType: 'pwa-node' },
    { label: 'Java',       file: '/repo/src/App.java',        debuggerType: 'java'     },
    { label: 'C#',         file: '/repo/src/AppTests.cs',     debuggerType: 'coreclr'  },
    { label: 'C++',        file: '/repo/src/app.cpp',         debuggerType: 'cppdbg'   },
    { label: 'Go',         file: '/repo/src/main.go',         debuggerType: 'go'       }
];

suite('handleStartDebugging regression matrix', () => {

    // -------------------------------------------------------------------------
    // Launch path (no testName) — uses executor.startDebugging + readyPromise.
    // -------------------------------------------------------------------------
    for (const lang of LANGUAGES) {

        test(`[${lang.label}] launch path: pause-hit returns 'stopped'`, async () => {
            const ready = deferred<ReadyState>();
            const { executor, configManager } = makeMocks({
                readyState: ready,
                startResult: true,
                language: lang.debuggerType
            });
            const handler = new DebuggingHandler(executor, configManager, 30);

            const pending = handler.handleStartDebugging({
                fileFullPath: lang.file,
                workingDirectory: '/repo'
            });
            ready.resolve('stopped');
            const result = await pending;

            assert.match(result, /stopped at breakpoint/);
            assert.match(result, new RegExp(escapeRegex(lang.file)));
        });

        test(`[${lang.label}] launch path: clean-run returns 'terminated'`, async () => {
            const ready = deferred<ReadyState>();
            const { executor, configManager } = makeMocks({
                readyState: ready,
                startResult: true,
                language: lang.debuggerType
            });
            const handler = new DebuggingHandler(executor, configManager, 30);

            const pending = handler.handleStartDebugging({
                fileFullPath: lang.file,
                workingDirectory: '/repo'
            });
            ready.resolve('terminated');
            const result = await pending;

            assert.match(result, /ran to completion without stopping/);
        });

        test(`[${lang.label}] launch path: launch-error surfaces failure`, async () => {
            const { executor, configManager } = makeMocks({
                startResult: false,
                language: lang.debuggerType
            });
            const handler = new DebuggingHandler(executor, configManager, 30);

            await assert.rejects(
                handler.handleStartDebugging({
                    fileFullPath: lang.file,
                    workingDirectory: '/repo'
                }),
                /Failed to start debug session/
            );
        });
    }

    // -------------------------------------------------------------------------
    // No-build / config-resolution failure (most relevant to .NET coreclr,
    // but the handler must surface it uniformly for any language).
    // -------------------------------------------------------------------------
    test('[C#] launch path: no-build surfaces config error', async () => {
        const { executor, configManager } = makeMocks({
            debugConfig: new Error("Could not find a built assembly for App.csproj. Run 'dotnet build' first"),
            language: 'coreclr'
        });
        const handler = new DebuggingHandler(executor, configManager, 30);

        await assert.rejects(
            handler.handleStartDebugging({
                fileFullPath: '/repo/src/App.cs',
                workingDirectory: '/repo'
            }),
            /Could not find a built assembly/
        );
    });

    // -------------------------------------------------------------------------
    // Test path (testName) — uses executor.debugTestAtCursor and races
    // readyPromise against the test-run completion promise.
    // -------------------------------------------------------------------------
    for (const lang of LANGUAGES) {

        test(`[${lang.label}] test path: pause-hit wins race, returns 'stopped'`, async () => {
            const ready = deferred<ReadyState>();
            const runComplete = deferred<void>();
            const { executor, configManager } = makeMocks({
                readyState: ready,
                testDispatch: { started: true, runComplete: runComplete.promise },
                language: lang.debuggerType
            });
            const handler = new DebuggingHandler(executor, configManager, 30);

            const pending = handler.handleStartDebugging({
                fileFullPath: lang.file,
                workingDirectory: '/repo',
                testName: 'My_Test'
            });
            // Breakpoint hits BEFORE the test-run completes (the .NET case
            // where awaiting testing.debugAtCursor would have hung).
            ready.resolve('stopped');
            const result = await pending;

            assert.match(result, /stopped at breakpoint/);
            assert.match(result, /test: My_Test/);
            // Cleanup: avoid an unhandled-rejection-like dangling promise.
            runComplete.resolve();
        });

        test(`[${lang.label}] test path: clean-run wins race, returns 'terminated'`, async () => {
            const neverReady = deferred<ReadyState>(); // simulate no terminate event
            const runComplete = deferred<void>();
            const { executor, configManager } = makeMocks({
                readyState: neverReady,
                testDispatch: { started: true, runComplete: runComplete.promise },
                language: lang.debuggerType
            });
            const handler = new DebuggingHandler(executor, configManager, 30);

            const pending = handler.handleStartDebugging({
                fileFullPath: lang.file,
                workingDirectory: '/repo',
                testName: 'My_Test'
            });
            // Test runs to completion without ever pausing AND without
            // waitForDebugSessionReady firing 'terminated' — this is the
            // .NET parent/child-session edge case. Must still return promptly.
            runComplete.resolve();
            const result = await pending;

            assert.match(result, /ran to completion without stopping/);
            assert.match(result, /test: My_Test/);
            // Cleanup the dangling readyPromise.
            neverReady.resolve('timeout');
        });

        test(`[${lang.label}] test path: launch-error surfaces failure`, async () => {
            const { executor, configManager } = makeMocks({
                testDispatch: new Error(`Could not locate test 'My_Test' in ${lang.file}`),
                language: lang.debuggerType
            });
            const handler = new DebuggingHandler(executor, configManager, 30);

            await assert.rejects(
                handler.handleStartDebugging({
                    fileFullPath: lang.file,
                    workingDirectory: '/repo',
                    testName: 'My_Test'
                }),
                /Could not locate test/
            );
        });
    }

    // -------------------------------------------------------------------------
    // Race tie-breakers — same readyState resolved at the same microtask tick
    // must not produce a hang or double-resolve. Use Promise.all to ensure
    // we don't regress to awaiting the slower promise.
    // -------------------------------------------------------------------------
    test('test path: readyPromise resolving first beats already-pending runComplete', async () => {
        const ready = deferred<ReadyState>();
        const runComplete = deferred<void>();
        const { executor, configManager } = makeMocks({
            readyState: ready,
            testDispatch: { started: true, runComplete: runComplete.promise },
            language: 'coreclr'
        });
        const handler = new DebuggingHandler(executor, configManager, 30);

        const pending = handler.handleStartDebugging({
            fileFullPath: '/repo/AppTests.cs',
            workingDirectory: '/repo',
            testName: 'Foo'
        });
        ready.resolve('stopped');
        // Even if runComplete later resolves, the handler must already be done.
        runComplete.resolve();

        const result = await pending;
        assert.match(result, /stopped at breakpoint/);
    });
});

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
