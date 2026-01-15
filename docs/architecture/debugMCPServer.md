# DebugMCPServer

## Purpose

The MCP server component that exposes VS Code debugging capabilities to AI agents via the Model Context Protocol. This is the main entry point for all external AI agent communication.

## Motivation

AI coding agents need a standardized way to control debuggers programmatically. MCP provides this standard, and `DebugMCPServer` implements it using FastMCP with Server-Sent Events (SSE) transport for real-time bidirectional communication.

## Responsibility

- Initialize and manage the FastMCP server lifecycle
- Register debugging tools that AI agents can invoke
- Register documentation resources for agent guidance
- Delegate all debugging operations to `DebuggingHandler`
- Handle SSE transport on configurable port (default: 3001)

## Architecture Position

```
AI Agent (MCP Client)
        │
        ▼ SSE Connection
┌───────────────────┐
│  DebugMCPServer   │  ◄── You are here
└───────────────────┘
        │
        ▼ Delegates to
┌───────────────────┐
│ DebuggingHandler  │
└───────────────────┘
```

## Key Concepts

### Tools vs Resources

- **Tools**: Actions the AI can perform (start debugging, step over, etc.)
- **Resources**: Documentation the AI can read for guidance

### SSE Transport

Uses HTTP with Server-Sent Events for persistent connections. This allows the server to push updates to clients and maintain connection health via ping/keepalive.

## Key Code Locations

- Class definition: `src/debugMCPServer.ts`
- Tool registration: `setupTools()` method
- Resource registration: `setupResources()` method
- Server startup: `start()` method

## Exposed Tools

| Tool | Description |
|------|-------------|
| `start_debugging` | Start a debug session |
| `stop_debugging` | Stop current session |
| `step_over/into/out` | Stepping commands |
| `continue_execution` | Continue to next breakpoint |
| `restart_debugging` | Restart session |
| `add/remove_breakpoint` | Breakpoint management |
| `clear_all_breakpoints` | Remove all breakpoints |
| `list_breakpoints` | List active breakpoints |
| `get_variables_values` | Inspect variable values |
| `evaluate_expression` | Evaluate expressions |

## Exposed Resources

| URI | Content |
|-----|---------|
| `debugmcp://docs/debug_instructions` | General debugging guide |
| `debugmcp://docs/troubleshooting/*` | Language-specific tips |

## Configuration

- `debugmcp.serverPort`: Port number (default: 3001)
- `debugmcp.timeoutInSeconds`: Operation timeout (default: 180)
