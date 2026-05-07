# DebugMCPServer

## Purpose

The MCP server component that exposes VS Code debugging capabilities to AI agents via the Model Context Protocol. This is the main entry point for all external AI agent communication.

## Motivation

AI coding agents need a standardized way to control debuggers programmatically. MCP provides this standard, and `DebugMCPServer` implements it using the official `@modelcontextprotocol/sdk` with Streamable HTTP transport over an express HTTP server.

## Responsibility

- Initialize and manage the MCP server lifecycle (using `McpServer` from `@modelcontextprotocol/sdk`)
- Register debugging tools that AI agents can invoke
- Register documentation resources for agent guidance
- Delegate all debugging operations to `DebuggingHandler`
- Manage Streamable HTTP transport via `StreamableHTTPServerTransport` on configurable port (default: 3001)

## Architecture Position

```
AI Agent (MCP Client)
        │
        ▼ HTTP POST /mcp
┌───────────────────┐
│  DebugMCPServer   │  ◄── You are here
│ (express + HTTP)  │
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
- **Resources**: Documentation the AI can read for guidance (note: some clients like GitHub Copilot don't support resources, so the `get_debug_instructions` tool is also provided)

### Streamable HTTP Transport

Uses stateless HTTP POST requests for MCP communication. The express server exposes:
- `POST /mcp` — Handles all MCP protocol messages (JSON-RPC over HTTP)

Each request creates a new stateless `StreamableHTTPServerTransport` instance that is closed when the HTTP response closes. The server returns JSON-RPC error responses (not HTML pages) for malformed payloads or unsupported methods to keep client behavior predictable.

## Key Code Locations

- Class definition: `src/debugMCPServer.ts`
- Tool registration: `setupTools()` method (uses `McpServer.registerTool()`)
- Resource registration: `setupResources()` method (uses `McpServer.registerResource()`)
- Server startup: `start()` method (creates express app with SSE/message routes)

## Exposed Tools

| Tool | Description |
|------|-------------|
| `get_debug_instructions` | Get debugging guide (for clients that don't support resources) |
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