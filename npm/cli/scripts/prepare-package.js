// Copyright (c) Microsoft Corporation.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const packageRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(packageRoot, '..', '..');
const outputDirectory = path.join(packageRoot, 'dist');
const skillsDirectory = path.join(packageRoot, 'skills');

execFileSync(process.execPath, [path.join(repositoryRoot, 'esbuild.js'), '--production'], {
	cwd: repositoryRoot,
	stdio: 'inherit'
});

fs.mkdirSync(outputDirectory, { recursive: true });
fs.copyFileSync(
	path.join(repositoryRoot, 'dist', 'debugmcp.js'),
	path.join(outputDirectory, 'debugmcp.js')
);
fs.copyFileSync(
	path.join(repositoryRoot, 'LICENSE.txt'),
	path.join(packageRoot, 'LICENSE.txt')
);
fs.rmSync(skillsDirectory, { recursive: true, force: true });
fs.cpSync(
	path.join(repositoryRoot, 'skills', 'debug-live'),
	path.join(skillsDirectory, 'debug-live'),
	{ recursive: true }
);
