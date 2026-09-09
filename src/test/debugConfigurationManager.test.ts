// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import { DebugConfigurationManager } from '../utils/debugConfigurationManager';

suite('DebugConfigurationManager', () => {
    const manager = new DebugConfigurationManager();

    test('uses the Ruby LSP debug adapter for Ruby files', () => {
        assert.strictEqual(manager.detectLanguageFromFilePath('/repo/example.rb'), 'ruby_lsp');
    });

    test('creates a Ruby LSP launch config with a separate command and file', async () => {
        const fileFullPath = '/repo/with spaces/example.rb';

        const config = await manager.getDebugConfig('/repo', fileFullPath);

        assert.deepStrictEqual(config, {
            type: 'ruby_lsp',
            request: 'launch',
            name: 'DebugMCP Launch',
            command: 'ruby',
            file: fileFullPath
        });
    });

    test('preserves explicitly named launch configurations for Ruby', async () => {
        const config = await manager.getDebugConfig('/repo', '/repo/example.rb', 'Debug Rails');

        assert.strictEqual(config, 'Debug Rails');
    });
});
