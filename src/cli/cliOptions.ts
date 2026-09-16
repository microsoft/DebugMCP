// Copyright (c) Microsoft Corporation.

export interface ParsedOptions {
	values: Record<string, string[]>;
	positionals: string[];
}

export function parseOptions(
	args: string[],
	acceptedOptions: readonly string[]
): ParsedOptions {
	const accepted = new Set(acceptedOptions);
	const values: Record<string, string[]> = {};
	const positionals: string[] = [];
	let current: string | undefined;
	let passthrough = false;

	for (const arg of args) {
		if (passthrough && current) {
			values[current].push(arg);
			continue;
		}
		if (arg === '--' && current) {
			passthrough = true;
			continue;
		}
		if (arg.startsWith('--')) {
			const option = arg.slice(2);
			if (current === 'args' && !accepted.has(option)) {
				values[current].push(arg);
				continue;
			}
			if (!accepted.has(option)) {
				throw new Error(`Unknown option '--${option}'.`);
			}
			current = option;
			values[current] ??= [];
		} else if (current) {
			values[current].push(arg);
		} else {
			positionals.push(arg);
		}
	}
	return { values, positionals };
}
