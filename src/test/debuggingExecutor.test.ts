// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import {
    addRubyRspecProgram,
    findDebugCodeLens,
    rubyRspecDebugConfiguration,
    shouldUseDebuggerCodeLens
} from '../debuggingExecutor';

suite('DebuggingExecutor CodeLens selection', () => {
    test('selects the narrowest debugger CodeLens for a nested test', () => {
        const target = new vscode.Position(6, 6);
        const group = codeLens('rubyLsp.debugTest', new vscode.Range(4, 0, 30, 3));
        const example = codeLens('rubyLsp.debugTest', new vscode.Range(6, 2, 6, 80));
        const run = codeLens('rubyLsp.runTest', new vscode.Range(6, 2, 6, 80));

        assert.strictEqual(findDebugCodeLens([ group, run, example ], target), example);
    });

    test('ignores debugger CodeLenses outside the selected test', () => {
        const target = new vscode.Position(6, 6);
        const other = codeLens('rubyLsp.debugTest', new vscode.Range(20, 0, 25, 3));

        assert.strictEqual(findDebugCodeLens([ other ], target), undefined);
    });

    test('selects a debugger CodeLens by exact test name regardless of range', () => {
        const target = new vscode.Position(6, 6);
        const first = codeLens('rubyLsp.debugTest', new vscode.Range(5, 2, 12, 3), [ 'first test' ]);
        const selected = codeLens(
            'rubyLsp.debugTest',
            new vscode.Range(20, 2, 20, 3),
            [ 'RequestTelegramNotifier#test_0005_selected test' ]
        );

        assert.strictEqual(findDebugCodeLens([ first, selected ], target, 'selected test'), selected);
    });

    test('selects a one-character debugger CodeLens on the test definition line', () => {
        const target = new vscode.Position(6, 6);
        const selected = codeLens('rubyLsp.debugTest', new vscode.Range(6, 2, 6, 3));

        assert.strictEqual(findDebugCodeLens([ selected ], target), selected);
    });

    test('prefers saves over an earlier also saves CodeLens with an equal range size', () => {
        const target = new vscode.Position(6, 6);
        const suffix = codeLens('rubyLsp.debugTest', new vscode.Range(2, 2, 2, 3), [ 'also saves' ]);
        const exact = codeLens('rubyLsp.debugTest', new vscode.Range(6, 2, 6, 3), [ 'saves' ]);
        assert.strictEqual(findDebugCodeLens([ suffix, exact ], target, 'saves'), exact);
        assert.strictEqual(findDebugCodeLens([ exact, suffix ], target, 'saves'), exact);
        assert.strictEqual(findDebugCodeLens([ suffix, exact ], suffix.range.start, 'saves'), exact);
    });

    test('uses the requested position to disambiguate identical example names', () => {
        const first = codeLens('rubyLsp.debugTest', new vscode.Range(2, 2, 2, 3), [ 'saves' ]);
        const selected = codeLens('rubyLsp.debugTest', new vscode.Range(6, 2, 6, 3), [ 'saves' ]);
        assert.strictEqual(findDebugCodeLens([ first, selected ], new vscode.Position(6, 6), 'saves'), selected);
    });

    for (const names of [ [ 'saves', 'saves' ], [ 'group saves', 'another group saves' ] ]) {
        test(`rejects ambiguous names away from the requested position: ${names.join(', ')}`, () => {
            const first = codeLens('rubyLsp.debugTest', new vscode.Range(2, 2, 2, 3), [ names[0] ]);
            const second = codeLens('rubyLsp.debugTest', new vscode.Range(6, 2, 6, 40), [ names[1] ]);
            assert.throws(() => findDebugCodeLens([ first, second ], new vscode.Position(20, 0), 'saves'),
                /Ambiguous debugger CodeLens/);
        });
    }

    test('rejects equally ranked debugger lenses at the same position', () => {
        const range = new vscode.Range(6, 2, 6, 3);
        const first = codeLens('rubyLsp.debugTest', range, [ 'saves' ]);
        const second = codeLens('rubyLsp.debugTest', range, [ 'saves' ]);
        assert.throws(() => findDebugCodeLens([ first, second ], range.start, 'saves'),
            /Ambiguous debugger CodeLens/);
    });

    test('disambiguates suffix-only provider names by the requested definition line', () => {
        const first = codeLens('rubyLsp.debugTest', new vscode.Range(2, 2, 2, 3), [ 'group also saves' ]);
        const selected = codeLens('rubyLsp.debugTest', new vscode.Range(6, 2, 6, 3), [ 'group saves' ]);
        assert.strictEqual(findDebugCodeLens([ first, selected ], new vscode.Position(6, 6), 'saves'), selected);
    });

    test('passes a spaced or shell-sensitive file:line to a real shell as exactly one literal argument', function () {
        if (process.platform === 'win32') {
            this.skip(); // This integration check requires a POSIX shell.
        }
        for (const file of [
            '/repo/with spaces/spec/example_spec.rb',
            '/repo/with\'single"double/spec/example_spec.rb',
            '/repo/$(printf injected)/`printf injected`/$PATH/example_spec.rb',
            '/repo/a;b&c|d>e<f*(g)?[h]/example_spec.rb',
            '/repo/with\nnewline/example_spec.rb'
        ]) {
            const command = addRubyRspecProgram(vscodeCommand('rubyLsp.debugTest', [ file, 'example' ]),
                file, 6, "printf '%s\\0'");
            const output = execFileSync('/bin/sh', [ '-c', command.arguments![2] ], { encoding: 'utf8' });
            assert.strictEqual(output, `${file}:6\0`);
        }
    });

    test('adds an exact RSpec command to a modern Ruby LSP CodeLens', () => {
        const command = vscodeCommand('rubyLsp.debugTest', [
            '/repo/spec/example_spec.rb',
            './spec/example_spec.rb:4::./spec/example_spec.rb:6'
        ]);

        assert.deepStrictEqual(
            addRubyRspecProgram(command, '/repo/spec/example_spec.rb', 6, 'bin/rspec-lsp').arguments,
            [
                '/repo/spec/example_spec.rb',
                './spec/example_spec.rb:4::./spec/example_spec.rb:6',
                "bin/rspec-lsp '/repo/spec/example_spec.rb:6'"
            ]
        );
    });

    test('preserves a ready RSpec command from an older Ruby LSP CodeLens', () => {
        const command = vscodeCommand('rubyLsp.debugTest', [
            '/repo/spec/example_spec.rb',
            'example',
            'custom-rspec /repo/spec/example_spec.rb:6'
        ]);

        assert.strictEqual(
            addRubyRspecProgram(command, '/repo/spec/example_spec.rb', 6, 'bin/rspec-lsp'),
            command
        );
    });

    test('builds an exact ruby_lsp launch configuration without Test Explorer', () => {
        assert.deepStrictEqual(
            rubyRspecDebugConfiguration("bin/rspec-lsp '/repo/spec/example_spec.rb:6'"),
            {
                type: 'ruby_lsp',
                name: 'Debug',
                request: 'launch',
                program: "bin/rspec-lsp '/repo/spec/example_spec.rb:6'",
                env: { DISABLE_SPRING: '1' }
            }
        );
    });

    test('limits debugger CodeLens dispatch to RSpec files', () => {
        assert.strictEqual(shouldUseDebuggerCodeLens('/repo/spec/example_spec.rb'), true);
        assert.strictEqual(shouldUseDebuggerCodeLens('/repo/src/number_pattern.rs'), false);
        assert.strictEqual(shouldUseDebuggerCodeLens('/repo/test/example_test.rb'), false);
    });
});

function codeLens(command: string, range: vscode.Range, args: unknown[] = []): vscode.CodeLens {
    return new vscode.CodeLens(range, vscodeCommand(command, args));
}

function vscodeCommand(command: string, args: unknown[] = []): vscode.Command {
    return { title: command, command, arguments: args };
}

suite('DebuggingExecutor RSpec dispatch', () => {
    test('launches the selected CodeLens file:line and waits for session termination', async () => {
        const { DebuggingExecutor } = await import('../debuggingExecutor.js');
        const executor = new DebuggingExecutor();
        const uri = vscode.Uri.file('/repo/spec/example_spec.rb');
        (executor as any).positionCursorAtTest = async () => ({
            uri, target: new vscode.Position(6, 2), codeLensTarget: new vscode.Position(5, 2)
        });
        (executor as any).rubyLspRspecCommand = async () => 'bin/rspec-lsp';
        const execute = vscode.commands.executeCommand;
        const start = vscode.debug.startDebugging;
        const onStart = Object.getOwnPropertyDescriptor(vscode.debug, 'onDidStartDebugSession')!;
        const onTerminate = Object.getOwnPropertyDescriptor(vscode.debug, 'onDidTerminateDebugSession')!;
        let started: ((session: vscode.DebugSession) => void) | undefined;
        let terminated: ((session: vscode.DebugSession) => void) | undefined;
        let disposed = 0;
        const disposable = () => new vscode.Disposable(() => { disposed++; });
        Object.defineProperty(vscode.debug, 'onDidStartDebugSession', { configurable: true,
            value: (listener: (session: vscode.DebugSession) => void) => { started = listener; return disposable(); } });
        Object.defineProperty(vscode.debug, 'onDidTerminateDebugSession', { configurable: true,
            value: (listener: (session: vscode.DebugSession) => void) => { terminated = listener; return disposable(); } });
        vscode.commands.executeCommand = (async (command: string) => {
            assert.strictEqual(command, 'vscode.executeCodeLensProvider');
            return [ codeLens('rubyLsp.debugTest', new vscode.Range(5, 2, 5, 3), [ uri.fsPath, 'selected' ]) ];
        }) as typeof execute;
        let launched: vscode.DebugConfiguration | undefined;
        vscode.debug.startDebugging = async (_folder, config) => {
            assert.notStrictEqual(typeof config, 'string');
            launched = config as vscode.DebugConfiguration;
            started?.({ id: 'selected-session', type: 'ruby_lsp', configuration: launched } as vscode.DebugSession);
            return true;
        };
        try {
            const dispatch = await executor.debugTestAtCursor(uri.fsPath, 'selected');
            assert.strictEqual(dispatch.started, true);
            assert.strictEqual(launched?.program, "bin/rspec-lsp '/repo/spec/example_spec.rb:6'");
            let complete = false;
            void dispatch.runComplete.then(() => { complete = true; });
            terminated?.({ id: 'unrelated-session' } as vscode.DebugSession);
            await Promise.resolve();
            assert.strictEqual(complete, false);
            terminated?.({ id: 'selected-session' } as vscode.DebugSession);
            await dispatch.runComplete;
            assert.strictEqual(complete, true);
            assert.strictEqual(disposed, 2);
        } finally {
            vscode.commands.executeCommand = execute;
            vscode.debug.startDebugging = start;
            Object.defineProperty(vscode.debug, 'onDidStartDebugSession', onStart);
            Object.defineProperty(vscode.debug, 'onDidTerminateDebugSession', onTerminate);
        }
    });
});
