// Copyright (c) Microsoft Corporation.

import * as path from 'path';
import * as fs from 'fs';
import { DebugMCPServer } from '../debugMCPServer';
import { ConfigLoader } from './ConfigLoader';
import { StandaloneDAPBackend } from './StandaloneDAPBackend';

/**
 * StandaloneServer is the entry point for running DebugMCP without VS Code.
 * 
 * It:
 * - Loads configuration from debugmcp.config.json
 * - Creates StandaloneDAPBackend for direct DAP communication
 * - Creates ConfigLoader as IDebugConfigurationManager
 * - Starts the MCP server with HTTP transport
 * 
 * Usage:
 *   npx ts-node src/standalone/StandaloneServer.ts [configPath]
 *   node out/standalone/StandaloneServer.js [configPath]
 */

const DEFAULT_CONFIG_FILENAME = 'debugmcp.config.json';

/**
 * Find configuration file by searching upward from cwd
 */
function findConfigFile(startDir: string): string | null {
	let currentDir = startDir;

	while (true) {
		const configPath = path.join(currentDir, DEFAULT_CONFIG_FILENAME);
		if (fs.existsSync(configPath)) {
			return configPath;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			// Reached root
			return null;
		}
		currentDir = parentDir;
	}
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
	console.log('DebugMCP Standalone Server');
	console.log('==========================\n');

	// Determine config file path
	let configPath = process.argv[2];

	if (!configPath) {
		// Try to find config file in current directory or parent directories
		const foundPath = findConfigFile(process.cwd());
		if (foundPath) {
			configPath = foundPath;
			console.log(`Found configuration file: ${configPath}`);
		} else {
			console.log(`No ${DEFAULT_CONFIG_FILENAME} found.`);
			console.log(`\nTo create a default configuration file, run:`);
			console.log(`  npx debugmcp init\n`);
			console.log(`Or specify a config file path:`);
			console.log(`  npx debugmcp serve /path/to/${DEFAULT_CONFIG_FILENAME}\n`);
			process.exit(1);
		}
	}

	// Resolve to absolute path
	configPath = path.resolve(configPath);

	// Check if config file exists
	if (!fs.existsSync(configPath)) {
		console.error(`Configuration file not found: ${configPath}`);
		process.exit(1);
	}

	console.log(`Loading configuration from: ${configPath}\n`);

	try {
		// Load configuration
		const configLoader = new ConfigLoader(configPath);
		await configLoader.load();

		const port = configLoader.getPort();
		const timeout = configLoader.getTimeout();
		const adapterNames = configLoader.getAdapterNames();

		console.log(`Configuration loaded successfully:`);
		console.log(`  Port: ${port}`);
		console.log(`  Timeout: ${timeout}s`);
		console.log(`  Adapters: ${adapterNames.join(', ')}\n`);

		// Create the standalone backend
		const backend = new StandaloneDAPBackend(configLoader, timeout * 1000);

		// Create and initialize the MCP server
		const server = new DebugMCPServer(port, timeout, backend, configLoader);
		await server.initialize();

		// Start the server
		await server.start();

		console.log(`\nDebugMCP server is running!`);
		console.log(`  Endpoint: ${server.getEndpoint()}`);
		console.log(`  SSE URL: ${server.getEndpoint()}/sse\n`);
		console.log(`Add to your MCP client configuration:`);
		console.log(JSON.stringify({
			"mcpServers": {
				"debugmcp": {
					"url": `${server.getEndpoint()}/sse`
				}
			}
		}, null, 2));
		console.log(`\nPress Ctrl+C to stop the server.\n`);

		// Handle graceful shutdown
		const shutdown = async () => {
			console.log('\nShutting down...');
			await server.stop();
			await backend.dispose();
			console.log('Server stopped.');
			process.exit(0);
		};

		process.on('SIGINT', shutdown);
		process.on('SIGTERM', shutdown);

	} catch (error) {
		console.error('Failed to start server:', error);
		process.exit(1);
	}
}

/**
 * Initialize a new configuration file in the current directory
 */
async function initConfig(): Promise<void> {
	const configPath = path.join(process.cwd(), DEFAULT_CONFIG_FILENAME);

	if (fs.existsSync(configPath)) {
		console.log(`Configuration file already exists: ${configPath}`);
		console.log('Delete it first if you want to create a new one.');
		process.exit(1);
	}

	await ConfigLoader.writeDefaultConfig(configPath);
	console.log(`Created configuration file: ${configPath}`);
	console.log('\nEdit this file to configure your debug adapters.');
	console.log('Then run: npx debugmcp serve');
}

// Check for init command
if (process.argv[2] === 'init') {
	initConfig().catch(err => {
		console.error('Failed to initialize configuration:', err);
		process.exit(1);
	});
} else {
	// Run main entry point
	main().catch(err => {
		console.error('Fatal error:', err);
		process.exit(1);
	});
}

// Export for programmatic use
export { main, initConfig };
