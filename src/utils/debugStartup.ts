// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';

export interface IDebugStartupContext {
	configurationName?: string;
	preLaunchTasks: readonly string[];
	workspaceFolder?: vscode.WorkspaceFolder;
}

interface IConfiguredTask {
	label?: string;
	dependsOn?: string | vscode.TaskDefinition | (string | vscode.TaskDefinition)[];
}

export function getDebugStartupContext(
	config: string | vscode.DebugConfiguration,
	workspaceFolder?: vscode.WorkspaceFolder
): IDebugStartupContext {
	const launch = vscode.workspace.getConfiguration('launch', workspaceFolder?.uri);
	const configuration = typeof config === 'string'
		? [...launch.get<vscode.DebugConfiguration[]>('configurations', []),
			...launch.get<vscode.DebugConfiguration[]>('compounds', [])].find(entry => entry.name === config)
		: config;
	const tasks = vscode.workspace.getConfiguration('tasks', workspaceFolder?.uri)
		.get<IConfiguredTask[]>('tasks', []);
	const preLaunchTasks = new Set<string>();
	const addTask = (name: string) => {
		if (preLaunchTasks.has(name)) {
			return;
		}
		preLaunchTasks.add(name);
		const dependencies = tasks.find(task => task.label === name)?.dependsOn;
		for (const dependency of Array.isArray(dependencies) ? dependencies : [dependencies]) {
			if (typeof dependency === 'string') {
				addTask(dependency);
			}
		}
	};
	if (typeof configuration?.preLaunchTask === 'string') {
		addTask(configuration.preLaunchTask);
	}
	return {
		configurationName: typeof config === 'string' ? config : config.name,
		preLaunchTasks: [...preLaunchTasks],
		workspaceFolder
	};
}

export async function startDebuggingWithDiagnostics(
	start: () => Thenable<boolean>,
	context: IDebugStartupContext,
	taskEvents: Pick<typeof vscode.tasks, 'onDidStartTask' | 'onDidEndTaskProcess'> = vscode.tasks
): Promise<boolean> {
	const executions = new Set<vscode.TaskExecution>();
	const subscriptions: vscode.Disposable[] = [];
	const failure = new Promise<Error>(resolve => {
		subscriptions.push(taskEvents.onDidStartTask(({ execution }) => {
			const task = execution.task;
			const matchesName = context.preLaunchTasks.some(name =>
				name === task.name || name === `${task.source}: ${task.name}`);
			const scope = task.scope;
			const matchesWorkspace = typeof scope === 'object'
				? scope.uri.toString() === context.workspaceFolder?.uri.toString()
				: scope === vscode.TaskScope.Workspace || !context.workspaceFolder;
			if (matchesName && matchesWorkspace) {
				executions.add(execution);
			}
		}));
		subscriptions.push(taskEvents.onDidEndTaskProcess(({ execution, exitCode }) => {
			if (!executions.delete(execution) || exitCode === undefined || exitCode === 0) {
				return;
			}
			resolve(new Error(
				`Pre-launch task '${execution.task.name}' failed with exit code ${exitCode}` +
				(context.configurationName ? ` while starting '${context.configurationName}'` : '') +
				'. Check its terminal output and the preLaunchTask/dependsOn configuration in launch.json and tasks.json. ' +
				'VS Code does not include the task terminal output in this event.'
			));
		}));
	});

	try {
		// A failed task can leave startDebugging pending on VS Code's "Debug Anyway"
		// dialog. Report the known failure without waiting for user interaction.
		const result = await Promise.race([Promise.resolve().then(start), failure]);
		if (result instanceof Error) {
			throw result;
		}
		if (!result) {
			throw new Error(
				'Failed to start debug session' +
				(context.configurationName ? ` for configuration '${context.configurationName}'` : '') +
				'. VS Code declined or cancelled startup without providing an error detail. ' +
				'Check launch.json, any preLaunchTask in tasks.json, and the task terminal or Debug Console for the underlying error.'
			);
		}
		return true;
	} finally {
		subscriptions.forEach(subscription => subscription.dispose());
	}
}
