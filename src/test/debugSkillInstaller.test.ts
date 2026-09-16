// Copyright (c) Microsoft Corporation.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	getDebugSkillInstallTargets,
	installDebugSkill
} from '../utils/debugSkillInstaller';

suite('debug-live skill installer', () => {
	let directory: string;

	setup(async () => {
		directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'debugmcp-skill-'));
	});

	teardown(async () => {
		await fs.promises.rm(directory, { recursive: true, force: true });
	});

	test('includes Copilot target when its home exists', async () => {
		const home = path.join(directory, 'home');
		const copilotHome = path.join(home, '.copilot');
		await fs.promises.mkdir(copilotHome, { recursive: true });

		assert.deepStrictEqual(getDebugSkillInstallTargets(home, copilotHome), [
			path.join(home, '.agents', 'skills', 'debug-live'),
			path.join(copilotHome, 'skills', 'debug-live')
		]);
	});

	test('copies the complete skill and removes legacy names', async () => {
		const source = path.join(directory, 'bundled', 'debug-live');
		const destination = path.join(directory, 'home', '.agents', 'skills', 'debug-live');
		const skillsDirectory = path.dirname(destination);
		await fs.promises.mkdir(path.join(source, 'references'), { recursive: true });
		await fs.promises.writeFile(path.join(source, 'SKILL.md'), '# Debug live\n', 'utf8');
		await fs.promises.writeFile(
			path.join(source, 'references', 'python.md'),
			'# Python\n',
			'utf8'
		);
		await fs.promises.mkdir(path.join(skillsDirectory, 'debug'), { recursive: true });
		await fs.promises.mkdir(path.join(skillsDirectory, 'really-debug'), { recursive: true });

		await installDebugSkill(source, destination);

		assert.strictEqual(
			await fs.promises.readFile(path.join(destination, 'SKILL.md'), 'utf8'),
			'# Debug live\n'
		);
		assert.strictEqual(
			await fs.promises.readFile(path.join(destination, 'references', 'python.md'), 'utf8'),
			'# Python\n'
		);
		assert.strictEqual(fs.existsSync(path.join(skillsDirectory, 'debug')), false);
		assert.strictEqual(fs.existsSync(path.join(skillsDirectory, 'really-debug')), false);
	});

	test('rejects a package without the skill entry point', async () => {
		await assert.rejects(
			() => installDebugSkill(
				path.join(directory, 'missing'),
				path.join(directory, 'destination')
			),
			/Bundled debug-live skill not found/
		);
	});
});
