// Copyright (c) Microsoft Corporation.

import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebuggingExecutor } from '../debuggingExecutor';
import {
	getDebugStartupContext,
	IDebugStartupContext,
	startDebuggingWithDiagnostics
} from '../utils/debugStartup';

suite('Debug startup diagnostics', () => {
	const folder: vscode.WorkspaceFolder = {
		uri: vscode.Uri.file('/debugmcp-startup-tests'),
		name: 'startup-tests',
		index: 0
	};
	let started: vscode.EventEmitter<vscode.TaskStartEvent>;
	let ended: vscode.EventEmitter<vscode.TaskProcessEndEvent>;
	let listeners: number;

	setup(() => {
		started = new vscode.EventEmitter<vscode.TaskStartEvent>();
		ended = new vscode.EventEmitter<vscode.TaskProcessEndEvent>();
		listeners = 0;
	});

	teardown(() => {
		started.dispose();
		ended.dispose();
	});

	function trackedEvent<T>(event: vscode.Event<T>): vscode.Event<T> {
		return listener => {
			listeners++;
			const subscription = event(listener);
			return new vscode.Disposable(() => {
				listeners--;
				subscription.dispose();
			});
		};
	}

	function launch(start: () => Thenable<boolean>, overrides: Partial<IDebugStartupContext> = {}) {
		return startDebuggingWithDiagnostics(start, {
			configurationName: 'Launch app',
			preLaunchTasks: ['Copy Item'],
			workspaceFolder: folder,
			...overrides
		}, {
			onDidStartTask: trackedEvent(started.event),
			onDidEndTaskProcess: trackedEvent(ended.event)
		});
	}

	function execution(name = 'Copy Item', scope: vscode.WorkspaceFolder | vscode.TaskScope = folder): vscode.TaskExecution {
		return {
			task: new vscode.Task({ type: 'shell' }, scope, name, 'test', new vscode.ShellExecution('exit 1')),
			terminate: () => { /* no process is started */ }
		};
	}

	test('reports a failed pre-launch task even while VS Code waits on a dialog', async () => {
		const result = launch(() => new Promise<boolean>(() => { /* pending prompt */ }));
		const task = execution();
		started.fire({ execution: task });
		ended.fire({ execution: task, exitCode: 1 });
		await assert.rejects(result, error => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Pre-launch task 'Copy Item' failed with exit code 1/);
			assert.match(error.message, /Launch app.*terminal output.*launch\.json and tasks\.json/);
			assert.doesNotMatch(error.message, /extension.*installed/);
			return true;
		});
		assert.strictEqual(listeners, 0);
	});

	test('reports task failure rather than a simultaneous false startup result', async () => {
		await assert.rejects(launch(async () => {
			const task = execution();
			started.fire({ execution: task });
			ended.fire({ execution: task, exitCode: 2 });
			return false;
		}), /task 'Copy Item' failed with exit code 2/);
		assert.strictEqual(listeners, 0);
	});

	test('preserves errors thrown by VS Code configuration or adapter startup', async () => {
		const failure = new Error('launch.json: program could not be resolved');
		await assert.rejects(launch(async () => { throw failure; }), error => error === failure);
		assert.strictEqual(listeners, 0);
	});

	test('uses actionable neutral guidance when VS Code returns false without diagnostics', async () => {
		await assert.rejects(launch(async () => false), error => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /declined or cancelled.*launch\.json.*tasks\.json/);
			assert.doesNotMatch(error.message, /extension.*installed/);
			return true;
		});
		assert.strictEqual(listeners, 0);
	});

	test('ignores failed tasks in other workspaces, unrelated tasks and pre-existing executions', async () => {
		await launch(async () => {
			for (const task of [
				execution('unrelated'),
				execution('Copy Item', { ...folder, uri: vscode.Uri.file('/other-workspace') })
			]) {
				started.fire({ execution: task });
				ended.fire({ execution: task, exitCode: 1 });
			}
			ended.fire({ execution: execution(), exitCode: 1 });
			return true;
		});
		assert.strictEqual(listeners, 0);
	});

	test('does not treat successful tasks or missing exit codes as build failures', async () => {
		await launch(async () => {
			for (const exitCode of [0, undefined]) {
				const task = execution();
				started.fire({ execution: task });
				ended.fire({ execution: task, exitCode });
			}
			return true;
		});
		assert.strictEqual(listeners, 0);
	});

	test('matches task labels that include the task source', async () => {
		await assert.rejects(launch(async () => {
			const task = execution('build');
			started.fire({ execution: task });
			ended.fire({ execution: task, exitCode: 1 });
			return false;
		}, { preLaunchTasks: ['test: build'] }), /task 'build' failed/);
	});

	test('reports a failing dependency of a compound pre-launch task', async () => {
		await assert.rejects(launch(async () => {
			const task = execution('build');
			started.fire({ execution: task });
			ended.fire({ execution: task, exitCode: 3 });
			return false;
		}, { preLaunchTasks: ['prepare', 'build'] }), /task 'build' failed with exit code 3/);
	});

	test('accepts workspace-level tasks without attributing folder tasks to another workspace', async () => {
		await assert.rejects(launch(async () => {
			const task = execution('Copy Item', vscode.TaskScope.Workspace);
			started.fire({ execution: task });
			ended.fire({ execution: task, exitCode: 1 });
			return false;
		}), /task 'Copy Item' failed/);
	});

	test('collects named launch tasks and recursive dependencies without looping', () => {
		const original = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = section => ({
			get: (key: string, fallback: unknown) => {
				if (section === 'launch' && key === 'configurations') {
					return [{ name: 'Launch app', preLaunchTask: 'prepare' }];
				}
				if (section === 'tasks' && key === 'tasks') {
					return [
						{ label: 'prepare', dependsOn: ['build', 'Copy Item', { type: 'npm', script: 'build' }] },
						{ label: 'build', dependsOn: 'prepare' },
						{ label: 'Copy Item', dependsOn: { type: 'npm', script: 'prepare' } }
					];
				}
				return fallback;
			}
		} as vscode.WorkspaceConfiguration);
		try {
			assert.deepStrictEqual(getDebugStartupContext('Launch app', folder), {
				configurationName: 'Launch app',
				preLaunchTasks: ['prepare', 'build', 'Copy Item'],
				workspaceFolder: folder
			});
			assert.deepStrictEqual(getDebugStartupContext({
				name: 'Inline', type: 'node', request: 'launch', preLaunchTask: 'Copy Item'
			}, folder).preLaunchTasks, ['Copy Item']);
		} finally {
			vscode.workspace.getConfiguration = original;
		}
	});

	test('cancels readiness promptly instead of retaining the startup timeout', async () => {
		const controller = new AbortController();
		const ready = new DebuggingExecutor().waitForDebugSessionReady(60_000, controller.signal);
		controller.abort();
		assert.strictEqual(await ready, 'no-session');
		assert.strictEqual(await new DebuggingExecutor().waitForDebugSessionReady(60_000, controller.signal), 'no-session');
	});
});
