// Copyright (c) Microsoft Corporation.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const skillName = 'debug-live';
const legacySkillNames = ['debug', 'really-debug'];

export function getDebugSkillInstallTargets(
	homeDirectory = os.homedir(),
	copilotHome = process.env.COPILOT_HOME || path.join(homeDirectory, '.copilot')
): string[] {
	const targets = [path.join(homeDirectory, '.agents', 'skills', skillName)];
	if (fs.existsSync(copilotHome)) {
		targets.push(path.join(copilotHome, 'skills', skillName));
	}
	return targets;
}

export async function installDebugSkill(
	bundledSkillPath: string,
	destination: string
): Promise<void> {
	const skillEntry = path.join(bundledSkillPath, 'SKILL.md');
	if (!fs.existsSync(skillEntry)) {
		throw new Error(`Bundled debug-live skill not found at ${bundledSkillPath}.`);
	}

	const skillsDirectory = path.dirname(destination);
	await fs.promises.mkdir(skillsDirectory, { recursive: true });
	await fs.promises.cp(bundledSkillPath, destination, {
		recursive: true,
		force: true
	});
	await Promise.all(legacySkillNames.map(async legacySkillName => {
		await fs.promises.rm(path.join(skillsDirectory, legacySkillName), {
			recursive: true,
			force: true
		});
	}));
}
