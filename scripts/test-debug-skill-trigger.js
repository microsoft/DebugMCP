// Copyright (c) Microsoft Corporation.

const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const defaultPrompt =
	'A test fails only at runtime. The user object unexpectedly becomes null inside processOrder';
const prompt = process.argv.slice(2).join(' ') || defaultPrompt;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'debugmcp-skill-eval-'));
const worktreePath = path.join(tempRoot, 'worktree');

function run(command, args, options = {}) {
	const result = childProcess.spawnSync(command, args, {
		cwd: repoRoot,
		encoding: 'utf8',
		maxBuffer: 20 * 1024 * 1024,
		...options
	});

	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed with exit code ${result.status}\n` +
			`${result.stderr || result.stdout}`
		);
	}

	return result.stdout;
}

function getCopilotInvocation() {
	if (process.platform !== 'win32') {
		return { command: 'copilot', args: [] };
	}

	const copilotPath = run(
		'powershell.exe',
		['-NoProfile', '-NonInteractive', '-Command', '(Get-Command copilot -ErrorAction Stop).Source']
	).trim();
	return {
		command: 'powershell.exe',
		args: ['-NoProfile', '-NonInteractive', '-File', copilotPath]
	};
}

function parseEvents(output) {
	return output
		.split(/\r?\n/)
		.filter(Boolean)
		.flatMap(line => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

try {
	run('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD']);

	const sourceSkillPath = path.join(repoRoot, 'skills', 'debug-live');
	const projectSkillPath = path.join(worktreePath, '.agents', 'skills', 'debug-live');
	fs.mkdirSync(path.dirname(projectSkillPath), { recursive: true });
	fs.cpSync(sourceSkillPath, projectSkillPath, { recursive: true });

	const copilot = getCopilotInvocation();
	const output = run(copilot.command, [...copilot.args,
		'-C', worktreePath,
		'-p', prompt,
		'--output-format', 'json',
		'--allow-all-tools',
		'--no-custom-instructions',
		'--no-remote',
		'--no-remote-export',
		'--log-level', 'none'
	], { cwd: worktreePath });

	const events = parseEvents(output);
	const toolCalls = events
		.filter(event => event.type === 'tool.execution_start')
		.map(event => event.data);
	const firstToolCall = toolCalls[0];

	assert.ok(firstToolCall, 'Copilot did not execute any tool');
	assert.strictEqual(
		firstToolCall.toolName,
		'skill',
		`Expected the first tool to be skill, got ${firstToolCall.toolName}`
	);
	assert.strictEqual(
		firstToolCall.arguments?.skill,
		'debug-live',
		`Expected debug-live, got ${JSON.stringify(firstToolCall.arguments)}`
	);

	console.log(`Prompt: ${prompt}`);
	console.log('PASS: Copilot invoked debug-live as its first tool call.');
	console.log(`Next tool: ${toolCalls[1]?.toolName ?? '<none>'}`);
} finally {
	childProcess.spawnSync(
		'git',
		['worktree', 'remove', '--force', worktreePath],
		{ cwd: repoRoot, encoding: 'utf8' }
	);
	childProcess.spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8' });
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
