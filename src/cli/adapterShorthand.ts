// Copyright (c) Microsoft Corporation.

import { AdapterRegistration } from './adapterConfig';

interface AdapterLanguage {
	type: string;
	extensions: string[];
}

const adapterLanguages: Record<string, AdapterLanguage> = {
	python: {
		type: 'python',
		extensions: ['.py']
	},
	csharp: {
		type: 'coreclr',
		extensions: ['.cs']
	},
	dotnet: {
		type: 'coreclr',
		extensions: ['.cs']
	},
	cpp: {
		type: 'cppvsdbg',
		extensions: ['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp']
	},
	c: {
		type: 'cppvsdbg',
		extensions: ['.c', '.h']
	},
	javascript: {
		type: 'pwa-node',
		extensions: ['.js', '.mjs', '.cjs', '.jsx']
	},
	typescript: {
		type: 'pwa-node',
		extensions: ['.ts', '.mts', '.cts', '.tsx']
	},
	node: {
		type: 'pwa-node',
		extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']
	},
	java: {
		type: 'java',
		extensions: ['.java']
	},
	go: {
		type: 'go',
		extensions: ['.go']
	},
	rust: {
		type: 'lldb',
		extensions: ['.rs']
	},
	ruby: {
		type: 'rdbg',
		extensions: ['.rb']
	},
	php: {
		type: 'php',
		extensions: ['.php']
	},
	swift: {
		type: 'lldb',
		extensions: ['.swift']
	},
	dart: {
		type: 'dart',
		extensions: ['.dart']
	}
};

export function createShorthandAdapter(
	language: string,
	commandValues: string[],
	adapterArgs: string[] = []
): AdapterRegistration {
	const metadata = adapterLanguages[language.toLowerCase()];
	if (!metadata) {
		throw new Error(
			`No adapter shorthand is defined for '${language}'. ` +
			'Provide --type and --extensions explicitly.'
		);
	}

	const commandLine = commandValues.length === 1
		? splitCommandLine(commandValues[0])
		: commandValues;
	const [command, ...args] = commandLine;
	if (!command) {
		throw new Error('adapter add requires --command');
	}

	return {
		command,
		args: [...args, ...adapterArgs],
		type: metadata.type,
		extensions: [...metadata.extensions],
		transport: 'stdio'
	};
}

export function splitCommandLine(value: string): string[] {
	const parts: string[] = [];
	let current = '';
	let quote: '"' | "'" | undefined;

	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (quote) {
			if (character === quote) {
				quote = undefined;
			} else if (quote === '"' &&
				character === '\\' &&
				(value[index + 1] === '"' || value[index + 1] === '\\')) {
				current += value[++index];
			} else {
				current += character;
			}
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (/\s/.test(character)) {
			if (current) {
				parts.push(current);
				current = '';
			}
		} else {
			current += character;
		}
	}

	if (quote) {
		throw new Error('Adapter command contains an unterminated quote.');
	}
	if (current) {
		parts.push(current);
	}
	return parts;
}
