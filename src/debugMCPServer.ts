// Copyright (c) Microsoft Corporation.

import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import { IDebugBackend } from './core/IDebugBackend';
import { IDebugConfigurationManager } from './core/IDebugConfigurationManager';
import { DebuggingHandler, IDebuggingHandler } from './debuggingHandler';
import { logger } from './utils/logger';

// Dynamic import for FastMCP since it's an ES module
let FastMCP: any;

async function initializeFastMCP() {
	if (!FastMCP) {
		try {
			logger.info('Loading FastMCP module...');
			const fastmcpModule = await import('fastmcp');
			FastMCP = fastmcpModule.FastMCP;
			logger.info('FastMCP module loaded successfully');
		} catch (importError) {
			logger.error('Failed to load FastMCP module', importError);
			throw new Error(`Failed to import fastmcp module: ${importError}. This may be due to ES module compatibility issues in your environment.`);
		}
	}
}

/**
 * Main MCP server class that exposes debugging functionality as tools and resources.
 * 
 * This server is backend-agnostic - it works with any IDebugBackend implementation:
 * - VSCodeDebugBackend for VS Code extension mode
 * - StandaloneDAPBackend for standalone CLI mode (Phase 3)
 */
export class DebugMCPServer {
	private server: any;
	private port: number;
	private initialized: boolean = false;
	private debuggingHandler: IDebuggingHandler;

	/**
	 * Create a new DebugMCPServer instance
	 * @param port Port number for the HTTP server
	 * @param timeoutInSeconds Timeout for debugging operations
	 * @param backend Debug backend implementation
	 * @param configManager Configuration manager implementation
	 */
	constructor(
		port: number,
		timeoutInSeconds: number,
		backend: IDebugBackend,
		configManager: IDebugConfigurationManager
	) {
		// Initialize the debugging handler with injected dependencies
		this.debuggingHandler = new DebuggingHandler(backend, configManager, timeoutInSeconds);
		this.port = port;
	}

	/**
	 * Initialize the MCP server
	 */
	async initialize() {
		if (this.initialized) {
			return;
		}

		await initializeFastMCP();

		this.server = new FastMCP({
			name: 'debugmcp',
			version: '1.0.0',
			ping: {
				enabled: true,
				intervalMs: 30000, // Send ping to keep SSE connection alive
			}
		});

		this.setupTools();
		this.setupResources();
		this.initialized = true;
	}

	/**
	 * Setup MCP tools that delegate to the debugging handler
	 */
	private setupTools() {
		// Start debugging tool
		this.server.addTool({
			name: 'start_debugging',
			description: 'IMPORTANT DEBUGGING TOOL - Start a debug session for a code file' +
				'\n\nUSE THIS WHEN:' +
				'\n• Any bug, error, or unexpected behavior occurs' +
				'\n• Asked to debug a unit test' +
				'\n• Variables have wrong/null values' +
				'\n• Functions return incorrect results' +
				'\n• Code behaves differently than expected' +
				'\n• User reports \"it doesn\'t work\"' +
				'\n\n⚠️ CRITICAL: Before using this tool, first read debugmcp://docs/debug_instructions resource!',
			parameters: z.object({
				fileFullPath: z.string().describe('Full path to the source code file to debug'),
				workingDirectory: z.string().describe('Working directory for the debug session'),
				testName: z.string().optional().describe('Name of the specific test name to debug.'),
			}),
			execute: async (args: { fileFullPath: string; workingDirectory: string; testName?: string }) => {
				return await this.debuggingHandler.handleStartDebugging(args);
			},
		});

		// Stop debugging tool
		this.server.addTool({
			name: 'stop_debugging',
			description: 'Stop the current debug session',
			execute: async () => {
				return await this.debuggingHandler.handleStopDebugging();
			},
		});

		// Step over tool
		this.server.addTool({
			name: 'step_over',
			description: 'Execute the current line of code without diving into it.',
			execute: async () => {
				return await this.debuggingHandler.handleStepOver();
			},
		});

		// Step into tool
		this.server.addTool({
			name: 'step_into',
			description: 'Dive into the current line of code.',
			execute: async () => {
				return await this.debuggingHandler.handleStepInto();
			},
		});

		// Step out tool
		this.server.addTool({
			name: 'step_out',
			description: 'Step out of the current function',
			execute: async () => {
				return await this.debuggingHandler.handleStepOut();
			},
		});

		// Continue execution tool
		this.server.addTool({
			name: 'continue_execution',
			description: 'Resume program execution until the next breakpoint is hit or the program completes.',
			execute: async () => {
				return await this.debuggingHandler.handleContinue();
			},
		});

		// Restart debugging tool
		this.server.addTool({
			name: 'restart_debugging',
			description: 'Restart the debug session from the beginning with the same configuration.',
			execute: async () => {
				return await this.debuggingHandler.handleRestart();
			},
		});

		// Add breakpoint tool
		this.server.addTool({
			name: 'add_breakpoint',
			description: 'Set a breakpoint to pause execution at a critical line of code. Essential for debugging: pause before potential errors, examine state at decision points, or verify code paths. Breakpoints let you inspect variables and control flow at exact moments.',
			parameters: z.object({
				fileFullPath: z.string().describe('Full path to the file'),
				lineContent: z.string().describe('Line content'),
			}),
			execute: async (args: { fileFullPath: string; lineContent: string }) => {
				return await this.debuggingHandler.handleAddBreakpoint(args);
			},
		});

		// Remove breakpoint tool
		this.server.addTool({
			name: 'remove_breakpoint',
			description: 'Remove a breakpoint that is no longer needed.',
			parameters: z.object({
				fileFullPath: z.string().describe('Full path to the file'),
				line: z.number().describe('Line number (1-based)'),
			}),
			execute: async (args: { fileFullPath: string; line: number }) => {
				return await this.debuggingHandler.handleRemoveBreakpoint(args);
			},
		});

		// Clear all breakpoints tool
		this.server.addTool({
			name: 'clear_all_breakpoints',
			description: 'Clear all breakpoints at once. Use this after verifying the root cause to clean up before moving on to the next task.',
			execute: async () => {
				return await this.debuggingHandler.handleClearAllBreakpoints();
			},
		});

		// List breakpoints tool
		this.server.addTool({
			name: 'list_breakpoints',
			description: 'View all currently set breakpoints across all files.',
			execute: async () => {
				return await this.debuggingHandler.handleListBreakpoints();
			},
		});

		// Get variables tool
		this.server.addTool({
			name: 'get_variables_values',
			description: 'Inspect all variable values at the current execution point. This is your window into program state - see what data looks like at runtime, verify assumptions, identify unexpected values, and understand why code behaves as it does.',
			parameters: z.object({
				scope: z.enum(['local', 'global', 'all']).optional().describe("Variable scope: 'local', 'global', or 'all'"),
			}),
			execute: async (args: { scope?: 'local' | 'global' | 'all' }) => {
				return await this.debuggingHandler.handleGetVariables(args);
			},
		});

		// Evaluate expression tool
		this.server.addTool({
			name: 'evaluate_expression',
			description: 'Powerful runtime expression evaluator: Test hypotheses, check computed values, call methods, or inspect object properties in the live debug context. Goes beyond simple variable inspection - evaluate any valid expression in the target language.',
			parameters: z.object({
				expression: z.string().describe('Expression to evaluate in the current programming language context'),
			}),
			execute: async (args: { expression: string }) => {
				return await this.debuggingHandler.handleEvaluateExpression(args);
			},
		});
	}

	/**
	 * Setup MCP resources for documentation
	 */
	private setupResources() {
		// Add MCP resources for debugging documentation
		this.server.addResource({
			uri: 'debugmcp://docs/debug_instructions',
			name: 'Debugging Instructions Guide',
			description: 'Step-by-step instructions for debugging with DebugMCP',
			mimeType: 'text/markdown',
			load: async () => {
				const content = await this.loadMarkdownFile('debug_instructions.md');
				return {
					text: content
				};
			}
		});

		// Add language-specific resources
		const languages = ['python', 'javascript', 'java', 'csharp'];
		const languageTitles = {
			'python': 'Python Debugging Tips',
			'javascript': 'JavaScript Debugging Tips',
			'java': 'Java Debugging Tips',
			'csharp': 'C# Debugging Tips'
		};

		languages.forEach(language => {
			this.server.addResource({
				uri: `debugmcp://docs/troubleshooting/${language}`,
				name: languageTitles[language as keyof typeof languageTitles],
				description: `Debugging tips specific to ${language}`,
				mimeType: 'text/markdown',
				load: async () => {
					const content = await this.loadMarkdownFile(`troubleshooting/${language}.md`);
					return {
						text: content
					};
				}
			});
		});
	}

	/**
	 * Load content from a Markdown file in the docs directory
	 */
	private async loadMarkdownFile(relativePath: string): Promise<string> {
		try {
			// Get the extension's installation directory
			const extensionPath = __dirname; // This points to the compiled extension's directory
			const docsPath = path.join(extensionPath, '..', 'docs', relativePath);

			console.log(`Loading markdown file from: ${docsPath}`);

			// Read the file content
			const content = await fs.promises.readFile(docsPath, 'utf8');
			console.log(`Successfully loaded ${relativePath}, content length: ${content.length}`);

			return content;
		} catch (error) {
			console.error(`Failed to load ${relativePath}:`, error);
			return `Error loading documentation from ${relativePath}: ${error}`;
		}
	}

	/**
	 * Check if the server is already running
	 */
	private async isServerRunning(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const http = require('http');

			const request = http.request({
				hostname: 'localhost',
				port: this.port,
				path: '/',
				method: 'GET',
				timeout: 1000
			}, (_response: any) => {
				resolve(true); // Server is responding
			});

			request.on('error', () => {
				resolve(false); // Server is not running
			});

			request.on('timeout', () => {
				request.destroy();
				resolve(false); // Server is not responding
			});

			request.end();
		});
	}

	/**
	 * Start the MCP server
	 */
	async start(): Promise<void> {
		// First check if server is already running
		const isRunning = await this.isServerRunning();
		if (isRunning) {
			throw new Error(`Port ${this.port} is already in use. Kill the existing process or use a different port.`);
		}

		try {
			logger.info(`Starting DebugMCP server on port ${this.port}...`);

			await this.server.start({
				transportType: 'httpStream',
				httpStream: {
					port: this.port,
					endpoint: '/sse'
				},
			});

			logger.info(`DebugMCP FastMCP server started successfully on port ${this.port}`);

		} catch (error) {
			logger.error(`Failed to start DebugMCP server`, error);
			throw new Error(`Failed to start DebugMCP server: ${error}`);
		}
	}

	/**
	 * Stop the MCP server
	 */
	async stop() {
		// FastMCP handles cleanup automatically
		console.log('DebugMCP FastMCP server stopped');
	}

	/**
	 * Get the server endpoint
	 */
	getEndpoint(): string {
		return `http://localhost:${this.port}`;
	}

	/**
	 * Get the debugging handler (for testing purposes)
	 */
	getDebuggingHandler(): IDebuggingHandler {
		return this.debuggingHandler;
	}

	/**
	 * Check if the server is initialized
	 */
	isInitialized(): boolean {
		return this.initialized;
	}
}
