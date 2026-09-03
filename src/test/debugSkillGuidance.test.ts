// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { suite, test } from 'mocha';

suite('debug-live skill guidance', () => {
    const skillPath = path.resolve(__dirname, '..', '..', 'skills', 'debug-live', 'SKILL.md');
    const serverPath = path.resolve(__dirname, '..', '..', 'src', 'debugMCPServer.ts');
    const skill = fs.readFileSync(skillPath, 'utf8');
    const serverSource = fs.readFileSync(serverPath, 'utf8');
    const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? '';

    test('skill metadata covers common runtime investigation triggers', () => {
        for (const trigger of [
            'runtime bugs',
            'failing tests',
            'exceptions',
            'crashes',
            'hangs',
            'wrong/null values',
            'unexpected output'
        ]) {
            assert.ok(description.includes(trigger), `Missing skill trigger: ${trigger}`);
        }
    });

    test('skill metadata prefers live debugging over temporary source logging', () => {
        assert.match(description, /when live inspection is practical/i);
        assert.match(description, /instead of modifying source code with temporary logs, print statements, or console output/i);
        assert.doesNotMatch(description, /\bMUST use first\b/);
    });

    test('MCP instructions say to invoke the skill first and explain why', () => {
        assert.match(serverSource, /invoke the "debug-live" Agent Skill first/i);
        assert.match(serverSource, /breakpoint strategy/i);
        assert.match(serverSource, /step-and-inspect/i);
        assert.match(serverSource, /root-cause guidance/i);
    });

    test('start_debugging points agents to the skill', () => {
        assert.match(serverSource, /Invoke the "debug-live" skill first\./);
    });
});
