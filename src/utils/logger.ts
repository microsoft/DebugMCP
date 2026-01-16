// Copyright (c) Microsoft Corporation.

/**
 * Log levels
 */
export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3
}

/**
 * Logger interface that works in both VS Code and standalone modes
 */
export interface ILogger {
	debug(message: string, error?: any): void;
	info(message: string, error?: any): void;
	warn(message: string, error?: any): void;
	error(message: string, error?: any): void;
	setLogLevel(level: LogLevel): void;
}

/**
 * Console-based logger for standalone mode
 */
class ConsoleLogger implements ILogger {
	private logLevel: LogLevel = LogLevel.INFO;

	private shouldLog(level: LogLevel): boolean {
		return level >= this.logLevel;
	}

	private formatError(error: any): string {
		if (error instanceof Error) {
			return `${error.message}${error.stack ? `\nStack: ${error.stack}` : ''}`;
		}
		return JSON.stringify(error, null, 2);
	}

	private formatMessage(level: string, message: string, error?: any): string {
		const timestamp = new Date().toISOString();
		const base = `[${timestamp}] [${level}] ${message}`;
		if (error) {
			return `${base}: ${this.formatError(error)}`;
		}
		return base;
	}

	public debug(message: string, error?: any): void {
		if (this.shouldLog(LogLevel.DEBUG)) {
			console.log(this.formatMessage('DEBUG', message, error));
		}
	}

	public info(message: string, error?: any): void {
		if (this.shouldLog(LogLevel.INFO)) {
			console.log(this.formatMessage('INFO', message, error));
		}
	}

	public warn(message: string, error?: any): void {
		if (this.shouldLog(LogLevel.WARN)) {
			console.warn(this.formatMessage('WARN', message, error));
		}
	}

	public error(message: string, error?: any): void {
		if (this.shouldLog(LogLevel.ERROR)) {
			console.error(this.formatMessage('ERROR', message, error));
		}
	}

	public setLogLevel(level: LogLevel): void {
		this.logLevel = level;
		this.info(`Log level set to ${LogLevel[level]}`);
	}
}

/**
 * VS Code logger wrapper - only used when vscode module is available
 */
class VSCodeLogger implements ILogger {
	private outputChannel: any;
	private logLevel: LogLevel = LogLevel.INFO;

	constructor(vscodeModule: any) {
		this.outputChannel = vscodeModule.window.createOutputChannel('DebugMCP', { log: true });
	}

	private shouldLog(level: LogLevel): boolean {
		return level >= this.logLevel;
	}

	private formatError(error: any): string {
		if (error instanceof Error) {
			return `${error.message}${error.stack ? `\nStack: ${error.stack}` : ''}`;
		}
		return JSON.stringify(error, null, 2);
	}

	public debug(message: string, error?: any): void {
		if (this.shouldLog(LogLevel.DEBUG)) {
			if (error) {
				this.outputChannel.debug(`${message}: ${this.formatError(error)}`);
			} else {
				this.outputChannel.debug(message);
			}
		}
	}

	public info(message: string, error?: any): void {
		if (this.shouldLog(LogLevel.INFO)) {
			if (error) {
				this.outputChannel.info(`${message}: ${this.formatError(error)}`);
			} else {
				this.outputChannel.info(message);
			}
		}
	}

	public warn(message: string, error?: any): void {
		if (this.shouldLog(LogLevel.WARN)) {
			if (error) {
				this.outputChannel.warn(`${message}: ${this.formatError(error)}`);
			} else {
				this.outputChannel.warn(message);
			}
		}
	}

	public error(message: string, error?: any): void {
		if (this.shouldLog(LogLevel.ERROR)) {
			if (error) {
				this.outputChannel.error(`${message}: ${this.formatError(error)}`);
			} else {
				this.outputChannel.error(message);
			}
		}
	}

	public setLogLevel(level: LogLevel): void {
		this.logLevel = level;
		this.info(`Log level set to ${LogLevel[level]}`);
	}

	public show(): void {
		this.outputChannel.show();
	}

	public logSystemInfo(vscodeModule: any): void {
		this.info('=== System Information ===');
		this.info(`VS Code Version: ${vscodeModule.version}`);
		this.info(`Platform: ${process.platform}`);
		this.info(`Architecture: ${process.arch}`);
		this.info(`Node.js Version: ${process.version}`);
		this.info(`Extension Host PID: ${process.pid}`);
		this.info('=== End System Information ===');
	}
}

/**
 * Create the appropriate logger based on environment
 */
function createLogger(): ILogger {
	try {
		// Try to load vscode module - this will succeed in VS Code extension mode
		const vscode = require('vscode');
		return new VSCodeLogger(vscode);
	} catch {
		// Fall back to console logger for standalone mode
		return new ConsoleLogger();
	}
}

// Export singleton instance
export const logger = createLogger();

// Also export for backwards compatibility with Logger class usage
export const Logger = {
	getInstance(): ILogger {
		return logger;
	}
};
