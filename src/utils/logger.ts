// Copyright (c) Microsoft Corporation.

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

export interface LogSink {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    show?(): void;
}

const stderrSink: LogSink = {
    debug: message => process.stderr.write(`[debug] ${message}\n`),
    info: message => process.stderr.write(`[info] ${message}\n`),
    warn: message => process.stderr.write(`[warn] ${message}\n`),
    error: message => process.stderr.write(`[error] ${message}\n`)
};

export class Logger {
    private static instance: Logger;
    private outputChannel: LogSink = stderrSink;
    private logLevel: LogLevel = LogLevel.INFO;

    private constructor() {}

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    private shouldLog(level: LogLevel): boolean {
        return level >= this.logLevel;
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

    private formatError(error: any): string {
        if (error instanceof Error) {
            return `${error.message}${error.stack ? `\nStack: ${error.stack}` : ''}`;
        }
        return JSON.stringify(error, null, 2);
    }

    public setLogLevel(level: LogLevel): void {
        this.logLevel = level;
        this.info(`Log level set to ${LogLevel[level]}`);
    }

    public setSink(sink: LogSink): void {
        this.outputChannel = sink;
    }

    public logSystemInfo(hostVersion?: string): void {
        this.info('=== System Information ===');
        if (hostVersion) {
            this.info(`Host Version: ${hostVersion}`);
        }
        this.info(`Platform: ${process.platform}`);
        this.info(`Architecture: ${process.arch}`);
        this.info(`Node.js Version: ${process.version}`);
        this.info(`Extension Host PID: ${process.pid}`);
        this.info('=== End System Information ===');
    }

    public logEnvironment(): void {
        this.info('=== Environment Variables ===');
        this.info(`HOME: ${process.env.HOME || 'undefined'}`);
        this.info(`USERPROFILE: ${process.env.USERPROFILE || 'undefined'}`);
        this.info(`APPDATA: ${process.env.APPDATA || 'undefined'}`);
        this.info(`PATH: ${process.env.PATH?.substring(0, 200) || 'undefined'}...`);
        this.info('=== End Environment Variables ===');
    }

    public show(): void {
        this.outputChannel.show?.();
    }
}

// Export a singleton instance for easy access
export const logger = Logger.getInstance();
