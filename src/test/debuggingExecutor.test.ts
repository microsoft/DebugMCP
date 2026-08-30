// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    addRubyRspecProgram,
    findDebugCodeLens,
    rubyRspecDebugConfiguration
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
                'bin/rspec-lsp /repo/spec/example_spec.rb:6'
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
            rubyRspecDebugConfiguration('bin/rspec-lsp /repo/spec/example_spec.rb:6'),
            {
                type: 'ruby_lsp',
                name: 'Debug',
                request: 'launch',
                program: 'bin/rspec-lsp /repo/spec/example_spec.rb:6',
                env: { DISABLE_SPRING: '1' }
            }
        );
    });
});

function codeLens(command: string, range: vscode.Range, args: unknown[] = []): vscode.CodeLens {
    return new vscode.CodeLens(range, vscodeCommand(command, args));
}

function vscodeCommand(command: string, args: unknown[] = []): vscode.Command {
    return { title: command, command, arguments: args };
}
