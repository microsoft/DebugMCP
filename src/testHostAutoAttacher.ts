// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { logger } from './utils/logger';

/**
 * Handles auto-attach to testhost process for .NET test debugging.
 * Listens for coreclr launch sessions and automatically attaches to testhost.
 */
export class TestHostAutoAttacher {
    private psList?: (options?: any | undefined) => Promise<any[]>;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly pidToSession = new Map<number, string>();


    constructor() {
        this.disposables.push(vscode.debug.onDidStartDebugSession(async (session) => {

            if (session.type !== 'coreclr' || !session.name.includes('DebugMCP .NET Test')) {
                return;
            }

            try {
                const pid = await this.waitForTestHost();
                if (!vscode.debug.activeDebugSession || vscode.debug.activeDebugSession.id !== session.id) {
                    return;
                }

                if (this.pidToSession.has(pid)) {
                    logger.error(`PID has been attached before (PID: ${pid})`);
                    return;
                }

                logger.info(`Found testhost PID=${pid}, attaching...`);
                logger.info(`Session=${session.id}, Name=${session.name}`);
                this.pidToSession.set(pid, session.id);
                await this.attachToTestHost(pid, session);
                logger.info(`Successfully attached to testhost (PID: ${pid})`);
            } catch (err) {
                logger.error('Failed to auto attach testhost', err);
            }
        }));

        this.disposables.push(vscode.debug.onDidTerminateDebugSession(async (session) => {
            for (const [pid, sid] of this.pidToSession) {
                if (sid === session.id) {
                    this.pidToSession.delete(pid);
                }
            }
        }));
    }


    /**
     * Wait for testhost process to appear
     */
    public async waitForTestHost(timeoutMs: number = 15000): Promise<number> {
        this.psList = this.psList ?? await import('ps-list').then(m => m.default);

        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (!vscode.debug.activeDebugSession) {
                break;
            }

            const processes = await this.psList();

            const testhost = processes
                .filter(p =>
                    p.name?.includes('testhost')
                    && !this.pidToSession.has(p.pid)
                )
                .sort((a, b) => b.pid - a.pid)
                .at(0);

            if (testhost?.pid) {
                return testhost.pid;
            }

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        throw new Error('testhost process not found');
    }

    /**
     * Attach debugger to testhost process
     */
    public async attachToTestHost(pid: number, session: vscode.DebugSession): Promise<void> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            await vscode.debug.startDebugging(workspaceFolder, {
                type: 'coreclr',
                request: 'attach',
                name: 'DebugMCP Attach testhost',
                processId: pid.toString()
            });
        } catch (error) {
            throw new Error(`Failed to attach to testhost: ${error}`);
        }
    }

    /**
     * Dispose the listener
     */
    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}
