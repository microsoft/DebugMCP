// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebuggingExecutor } from '../debuggingExecutor';
import { DebuggingHandler } from '../debuggingHandler';
import { DebugState } from '../debugState';

suite('RSpec first-stop preservation with real readiness', () => {
    for (const reason of [ 'entry', 'exception', 'breakpoint', 'pause' ]) {
        test(`returns ${reason} without continuing an unmatched stopped frame`, async () => {
            const descriptor = Object.getOwnPropertyDescriptor(vscode.debug, 'activeStackItem')!;
            // Keep the old stopped frame present throughout the readiness check.
            // The former auto-continue path incorrectly reused this same frame.
            Object.defineProperty(vscode.debug, 'activeStackItem', {
                configurable: true,
                get: () => ({ frameId: 1, threadId: 1, session: { type: 'ruby_lsp' } })
            });
            const state = new DebugState();
            state.sessionActive = true;
            state.updateContext(1, 1);
            state.updateLocation('/repo/example_spec.rb', 'example_spec.rb', 5, 'debugger', []);
            state.updateFrameName(reason);
            state.breakpoints = [ 'example_spec.rb:12' ];
            const executor = new DebuggingExecutor();
            executor.debugTestAtCursor = async () => ({
                started: true, description: 'debugger CodeLens',
                runComplete: new Promise<void>(() => { /* pending while paused */ })
            });
            executor.getCurrentDebugState = async () => state;
            executor.getActiveSession = () => ({ type: 'ruby_lsp' }) as vscode.DebugSession;
            let continueCalls = 0;
            executor.continue = async () => { continueCalls++; };
            try {
                const output = await new DebuggingHandler(executor, {} as any, 1).handleStartDebugging({
                    fileFullPath: '/repo/example_spec.rb', workingDirectory: '/repo', testName: 'selected example'
                });
                assert.match(output, /"currentLine": 5/);
                assert.match(output, new RegExp(`"frameName": "${reason}"`));
                assert.strictEqual(continueCalls, 0);
            } finally {
                Object.defineProperty(vscode.debug, 'activeStackItem', descriptor);
            }
        });
    }
});
