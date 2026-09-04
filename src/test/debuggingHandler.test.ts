// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DebugState } from '../debugState';
import { DebuggingHandler } from '../debuggingHandler';
import { IDebuggingExecutor } from '../debuggingExecutor';

/**
 * Test suite for DebuggingHandler state change detection
 */
suite('DebuggingHandler State Change Detection', () => {
    
    test('hasStateChanged should detect line number changes', () => {
        const handler = new DebuggingHandler({} as any, {} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        beforeState.updateLocation('/test/file.js', 'file.js', 10, 'let x = 5;', []);
        beforeState.updateContext(1, 1);
        beforeState.updateFrameName('main');
        
        const afterState = beforeState.clone();
        afterState.updateLocation('/test/file.js', 'file.js', 11, 'let y = 10;', []);
        
        // Use reflection to access the private method for testing
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, true);
    });
    
    test('hasStateChanged should detect file changes', () => {
        const handler = new DebuggingHandler({} as any, {} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        beforeState.updateLocation('/test/file1.js', 'file1.js', 10, 'let x = 5;', []);
        beforeState.updateContext(1, 1);
        
        const afterState = beforeState.clone();
        afterState.updateLocation('/test/file2.js', 'file2.js', 10, 'let x = 5;', []);
        
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, true);
    });
    
    test('hasStateChanged should detect session status changes', () => {
        const handler = new DebuggingHandler({} as any, {} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        beforeState.updateLocation('/test/file.js', 'file.js', 10, 'let x = 5;', []);
        
        const afterState = beforeState.clone();
        afterState.sessionActive = false;
        
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, true);
    });
    
    test('hasStateChanged should detect frame name changes', () => {
        const handler = new DebuggingHandler({} as any, {} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        beforeState.updateLocation('/test/file.js', 'file.js', 10, 'let x = 5;', []);
        beforeState.updateFrameName('main');
        
        const afterState = beforeState.clone();
        afterState.updateFrameName('helper');
        
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, true);
    });
    
    test('hasStateChanged should return false for identical states', () => {
        const handler = new DebuggingHandler({} as any, {} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        beforeState.updateLocation('/test/file.js', 'file.js', 10, 'let x = 5;', []);
        beforeState.updateContext(1, 1);
        beforeState.updateFrameName('main');
        
        const afterState = beforeState.clone();
        
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, false);
    });
    
    test('hasStateChanged should handle states without location info', () => {
        const handler = new DebuggingHandler({} as any, {} as any, 30);
        
        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        // No location info
        
        const afterState = new DebugState();
        afterState.sessionActive = true;
        afterState.updateLocation('/test/file.js', 'file.js', 10, 'let x = 5;', []);
        
        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);
        
        assert.strictEqual(hasStateChanged, true);
    });

    test('hasStateChanged should detect frame changes without source locations', () => {
        const handler = new DebuggingHandler({} as any, {} as any, 30);

        const beforeState = new DebugState();
        beforeState.sessionActive = true;
        beforeState.updateContext(1, 1);
        beforeState.updateFrameName('first');

        const afterState = beforeState.clone();
        afterState.updateContext(2, 1);
        afterState.updateFrameName('second');

        const hasStateChanged = (handler as any).hasStateChanged(beforeState, afterState);

        assert.strictEqual(hasStateChanged, true);
    });
});

/**
 * Tests for the event-driven waitForStateChange (exercised via handleStepOver).
 *
 * The previous implementation blind-slept ~1s per step regardless of when the
 * stop actually landed. The current one resolves the moment the new state is
 * observable (fast-path) or the session ends, and only falls back to the
 * configured timeout when nothing changes. These tests drive that logic through
 * the injected executor's getCurrentDebugState — the real vscode.debug events
 * can't be fired from a unit test, but the fast-path and timeout branches both
 * funnel through the executor, which is what we assert on here.
 */
suite('DebuggingHandler waitForStateChange (event-driven)', () => {

    function lineState(line: number, active = true): DebugState {
        const s = new DebugState();
        s.sessionActive = active;
        if (active) {
            s.updateLocation('/test/file.js', 'file.js', line, `let v = ${line};`, []);
            s.updateContext(1, 1);
            s.updateFrameName('main');
        }
        return s;
    }

    // Minimal executor whose getCurrentDebugState is driven by a per-call
    // function (call index is 0-based). All other methods are inert.
    function makeExecutor(getState: (call: number) => DebugState): IDebuggingExecutor {
        let call = 0;
        return {
            startDebugging: async () => true,
            debugTestAtCursor: async () => ({ started: true, runComplete: new Promise<void>(() => { /* pending */ }) }),
            stopDebugging: async () => { /* noop */ },
            stepOver: async () => { /* noop */ },
            stepInto: async () => { /* noop */ },
            stepOut: async () => { /* noop */ },
            continue: async () => { /* noop */ },
            pause: async () => { /* noop */ },
            restart: async () => { /* noop */ },
            addBreakpoint: async () => { /* noop */ },
            removeBreakpoint: async () => { /* noop */ },
            getCurrentDebugState: async () => getState(call++),
            getVariables: async () => ({}),
            getVariableChildren: async () => [],
            evaluateExpression: async () => ({}),
            getBreakpoints: () => [],
            clearAllBreakpoints: () => { /* noop */ },
            hasActiveSession: async () => true,
            getActiveSession: () => undefined,
            waitForDebugSessionReady: async () => 'no-session'
        };
    }

    test('fast-path: resolves immediately when the new line is already observable', async () => {
        // call 0 = before (line 10); subsequent calls = after (line 11).
        const executor = makeExecutor(call => (call === 0 ? lineState(10) : lineState(11)));
        // Large timeout: if this resolved via the timer instead of the fast
        // path, the test would take 30s and the latency assertion would fail.
        const handler = new DebuggingHandler(executor, {} as any, 30);

        const started = Date.now();
        const result = await handler.handleStepOver();
        const elapsed = Date.now() - started;

        assert.match(result, /"currentLine": 11/, `expected to land on line 11, got: ${result}`);
        assert.ok(elapsed < 2000, `fast-path should resolve in ms, took ${elapsed}ms (did it wait for the timeout?)`);
    });

    test('fast-path: resolves immediately when the session has ended', async () => {
        // call 0 = active (line 10); subsequent calls = session inactive.
        const executor = makeExecutor(call => (call === 0 ? lineState(10) : lineState(0, false)));
        const handler = new DebuggingHandler(executor, {} as any, 30);

        const started = Date.now();
        const result = await handler.handleStepOver();
        const elapsed = Date.now() - started;

        assert.match(result, /"sessionActive": false/, `expected an inactive session, got: ${result}`);
        assert.ok(elapsed < 2000, `termination should resolve in ms, took ${elapsed}ms`);
    });

    test('timeout: falls back to the bounded timeout when nothing changes', async () => {
        // Every call reports the same active line — no change, no event.
        const executor = makeExecutor(() => lineState(10));
        // 0.3s timeout so the fallback path is quick to exercise.
        const handler = new DebuggingHandler(executor, {} as any, 0.3);

        const started = Date.now();
        const result = await handler.handleStepOver();
        const elapsed = Date.now() - started;

        assert.match(result, /"currentLine": 10/, `expected to stay on line 10, got: ${result}`);
        // Must actually wait out the timer (not settle spuriously) but still be
        // bounded by it (not hang).
        assert.ok(elapsed >= 200, `should wait for the ~300ms timeout, only took ${elapsed}ms`);
        assert.ok(elapsed < 3000, `timeout should bound the wait, took ${elapsed}ms`);
    });
});

/**
 * Regression tests for continue against a process that resumes and keeps
 * running (a server, an event loop) rather than stopping again.
 *
 * hasStateChanged deliberately reports paused -> running as "no change", so
 * that a step isn't settled by the transient frameless moment mid-step. Before
 * the fix, handleContinue reused those step semantics and waited for a next
 * frame that never arrives, burning the full timeout on a successful continue.
 */
suite('DebuggingHandler continue on a never-stopping process', () => {

    function pausedState(line: number): DebugState {
        const s = new DebugState();
        s.sessionActive = true;
        s.updateLocation('/test/file.js', 'file.js', line, 'let v = 1;', []);
        s.updateContext(1, 1);
        s.updateFrameName('main');
        return s;
    }

    // Session alive, but no stack frame: the program is running.
    function runningState(): DebugState {
        const s = new DebugState();
        s.sessionActive = true;
        return s;
    }

    function pausedStateWithoutLocation(): DebugState {
        const s = new DebugState();
        s.sessionActive = true;
        s.updateContext(1, 1);
        s.updateFrameName('money');
        return s;
    }

    function makeExecutor(getState: (call: number) => DebugState): IDebuggingExecutor {
        let call = 0;
        return {
            startDebugging: async () => true,
            debugTestAtCursor: async () => ({ started: true, runComplete: new Promise<void>(() => { /* pending */ }) }),
            stopDebugging: async () => { /* noop */ },
            stepOver: async () => { /* noop */ },
            stepInto: async () => { /* noop */ },
            stepOut: async () => { /* noop */ },
            continue: async () => { /* noop */ },
            pause: async () => { /* noop */ },
            restart: async () => { /* noop */ },
            addBreakpoint: async () => { /* noop */ },
            removeBreakpoint: async () => { /* noop */ },
            getCurrentDebugState: async () => getState(call++),
            getVariables: async () => ({}),
            getVariableChildren: async () => [],
            evaluateExpression: async () => ({}),
            getBreakpoints: () => [],
            clearAllBreakpoints: () => { /* noop */ },
            hasActiveSession: async () => true,
            getActiveSession: () => undefined,
            waitForDebugSessionReady: async () => 'no-session'
        };
    }

    test('continue returns promptly once the program is running again', async () => {
        // call 0 = paused at a breakpoint; afterwards = running, no frame.
        const executor = makeExecutor(call => (call === 0 ? pausedState(10) : runningState()));
        // 30s timeout: without the fix this waits it out and the test fails on latency.
        const handler = new DebuggingHandler(executor, {} as any, 30);

        const started = Date.now();
        await handler.handleContinue();
        const elapsed = Date.now() - started;

        assert.ok(elapsed < 2000, 'continue should resolve as soon as the program resumes, took ' + elapsed + 'ms');
    });

    test('continue does not mistake a source-less stopped frame for resumed execution', async () => {
        const executor = makeExecutor(() => pausedStateWithoutLocation());
        const handler = new DebuggingHandler(executor, {} as any, 0.3);

        const started = Date.now();
        await handler.handleContinue();
        const elapsed = Date.now() - started;

        assert.ok(elapsed >= 200, 'a still-paused frame should wait for resume, only took ' + elapsed + 'ms');
    });

    test('step still waits for the next frame rather than settling on the resume', async () => {
        // Same state sequence, but stepping must NOT treat "running" as arrival,
        // otherwise a step would return a frameless state mid-step.
        const executor = makeExecutor(call => (call === 0 ? pausedState(10) : runningState()));
        const handler = new DebuggingHandler(executor, {} as any, 0.3);

        const started = Date.now();
        await handler.handleStepOver();
        const elapsed = Date.now() - started;

        assert.ok(elapsed >= 200, 'step should wait for its next frame, only took ' + elapsed + 'ms');
    });
});

suite('DebuggingHandler get_debug_status', () => {

    function pausedState(): DebugState {
        const s = new DebugState();
        s.sessionActive = true;
        s.updateLocation('/test/file.js', 'file.js', 42, 'let v = 1;', []);
        s.updateContext(1, 1);
        s.updateFrameName('main');
        return s;
    }

    function runningState(): DebugState {
        const s = new DebugState();
        s.sessionActive = true;
        return s;
    }

    function pausedStateWithoutLocation(): DebugState {
        const s = new DebugState();
        s.sessionActive = true;
        s.updateContext(1, 1);
        s.updateFrameName('money');
        return s;
    }

    function makeExecutor(state: DebugState, hasSession = true): IDebuggingExecutor {
        return {
            startDebugging: async () => true,
            debugTestAtCursor: async () => ({ started: true, runComplete: Promise.resolve() }),
            stopDebugging: async () => { /* noop */ },
            stepOver: async () => { /* noop */ },
            stepInto: async () => { /* noop */ },
            stepOut: async () => { /* noop */ },
            continue: async () => { /* noop */ },
            pause: async () => { /* noop */ },
            restart: async () => { /* noop */ },
            addBreakpoint: async () => { /* noop */ },
            removeBreakpoint: async () => { /* noop */ },
            getCurrentDebugState: async () => state,
            getVariables: async () => ({}),
            getVariableChildren: async () => [],
            evaluateExpression: async () => ({}),
            getBreakpoints: () => [],
            clearAllBreakpoints: () => { /* noop */ },
            hasActiveSession: async () => hasSession,
            getActiveSession: () => undefined,
            waitForDebugSessionReady: async () => 'no-session'
        } as unknown as IDebuggingExecutor;
    }

    test('reports paused with the current location', async () => {
        const handler = new DebuggingHandler(makeExecutor(pausedState()), {} as any, 30);
        const result = JSON.parse(await handler.handleGetDebugStatus());

        assert.strictEqual(result.status, 'paused');
        assert.strictEqual(result.paused, true);
        assert.strictEqual(result.state.currentLine, 42);
        assert.strictEqual(result.state.fileName, 'file.js');
    });

    test('reports an rdbg frame as paused when source location is unavailable', async () => {
        const handler = new DebuggingHandler(makeExecutor(pausedStateWithoutLocation()), {} as any, 30);

        const started = Date.now();
        const result = JSON.parse(await handler.handleGetDebugStatus({ waitForPauseSeconds: 30 }));
        const elapsed = Date.now() - started;

        assert.strictEqual(result.status, 'paused');
        assert.strictEqual(result.paused, true);
        assert.strictEqual(result.state.frameId, 1);
        assert.strictEqual(result.state.threadId, 1);
        assert.strictEqual(result.state.fileName, null);
        assert.strictEqual(result.state.currentLine, null);
        assert.ok(elapsed < 1000, 'an existing rdbg frame must not wait, took ' + elapsed + 'ms');
    });

    test('waiting settles when a source-less stopped frame becomes available', async () => {
        let call = 0;
        const executor = makeExecutor(runningState());
        executor.getCurrentDebugState = async () => (call++ === 0 ? runningState() : pausedStateWithoutLocation());
        const handler = new DebuggingHandler(executor, {} as any, 30);

        const started = Date.now();
        const result = JSON.parse(await handler.handleGetDebugStatus({ waitForPauseSeconds: 30 }));
        const elapsed = Date.now() - started;

        assert.strictEqual(result.status, 'paused');
        assert.strictEqual(result.state.frameName, 'money');
        assert.ok(elapsed < 1000, 'the source-less stopped frame should settle the wait, took ' + elapsed + 'ms');
    });

    test('reports running without waiting and without throwing', async () => {
        const handler = new DebuggingHandler(makeExecutor(runningState()), {} as any, 30);

        const started = Date.now();
        const result = JSON.parse(await handler.handleGetDebugStatus());
        const elapsed = Date.now() - started;

        assert.strictEqual(result.status, 'running');
        assert.strictEqual(result.paused, false);
        assert.ok(elapsed < 1000, 'a snapshot must not wait, took ' + elapsed + 'ms');
    });

    test('a wait that never sees a pause still returns normally, not an error', async () => {
        // "Still running" is a legitimate answer; it must never surface as a
        // tool timeout, which is what callers previously had to interpret.
        const handler = new DebuggingHandler(makeExecutor(runningState()), {} as any, 30);

        const started = Date.now();
        const result = JSON.parse(await handler.handleGetDebugStatus({ waitForPauseSeconds: 1 }));
        const elapsed = Date.now() - started;

        assert.strictEqual(result.status, 'running');
        assert.ok(elapsed >= 900, 'should have waited the requested second, took ' + elapsed + 'ms');
        assert.ok(elapsed < 5000, 'should return right after the wait, took ' + elapsed + 'ms');
    });

    test('already-paused session returns immediately even when a wait is requested', async () => {
        const handler = new DebuggingHandler(makeExecutor(pausedState()), {} as any, 30);

        const started = Date.now();
        const result = JSON.parse(await handler.handleGetDebugStatus({ waitForPauseSeconds: 30 }));
        const elapsed = Date.now() - started;

        assert.strictEqual(result.status, 'paused');
        assert.ok(elapsed < 1000, 'must not wait when already paused, took ' + elapsed + 'ms');
    });

    test('reports no-session instead of failing when nothing is attached', async () => {
        const handler = new DebuggingHandler(makeExecutor(runningState(), false), {} as any, 30);
        const result = JSON.parse(await handler.handleGetDebugStatus());

        assert.strictEqual(result.status, 'no-session');
        assert.strictEqual(result.paused, false);
    });
});

suite('DebuggingHandler add_breakpoint session caveat', () => {

    const tmpFile = path.join(os.tmpdir(), `debugmcp-bp-caveat-${process.pid}.js`);

    suiteSetup(() => {
        fs.writeFileSync(tmpFile, 'let a = 1;\nlet b = 2;\nlet c = 3;\n', 'utf8');
    });

    suiteTeardown(() => {
        fs.rmSync(tmpFile, { force: true });
    });

    function makeExecutor(hasSession: boolean): IDebuggingExecutor {
        return {
            addBreakpoint: async () => { /* noop */ },
            hasActiveSession: async () => hasSession
        } as unknown as IDebuggingExecutor;
    }

    test('warns that a breakpoint will not pause anything when no session is attached', async () => {
        // VS Code accepts breakpoints with no debug session, so a bare
        // "Breakpoint added" reads as proof the debugger is live when it isn't.
        const handler = new DebuggingHandler(makeExecutor(false), {} as any, 30);
        const result = await handler.handleAddBreakpoint({ fileFullPath: tmpFile, line: 2 });

        assert.ok(result.includes('Breakpoint added'), result);
        assert.match(result, /no debug session is currently active/i);
    });

    test('stays quiet when a session is attached', async () => {
        const handler = new DebuggingHandler(makeExecutor(true), {} as any, 30);
        const result = await handler.handleAddBreakpoint({ fileFullPath: tmpFile, line: 2 });

        assert.ok(result.includes('Breakpoint added'), result);
        assert.doesNotMatch(result, /WARNING/i);
    });
});
