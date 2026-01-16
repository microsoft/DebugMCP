// Copyright (c) Microsoft Corporation.

// Export core portable types and interfaces
export * from './core';

// Export VS Code specific implementations
export * from './vscode';

// Export debugging-related classes and interfaces
export { DebugState } from './debugState';
export { DebuggingHandler, IDebuggingHandler } from './debuggingHandler';

// Export the MCP server
export { DebugMCPServer } from './debugMCPServer';

// Export agent configuration classes
export { AgentConfigurationManager, AgentInfo, MCPServerConfig } from './utils/agentConfigurationManager';

// Legacy exports for backwards compatibility - these are deprecated
// Use the new imports from './core' and './vscode' instead
export { DebuggingExecutor, IDebuggingExecutor } from './debuggingExecutor';
export { DebugConfigurationManager as ConfigurationManager, IDebugConfigurationManager as IConfigurationManager } from './utils/debugConfigurationManager';
