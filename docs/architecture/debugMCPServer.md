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

### Multi-window routing (multiple VS Code windows / repos)

The MCP endpoint uses a fixed port, but every open VS Code window activates the
extension. To avoid debugging the wrong workspace when several windows are open:

- **Every window** starts a loopback `ControlServer` (`src/controlServer.ts`) that runs
  debug operations against *its own* `DebuggingHandler`, and advertises its workspace
  folders (plus control port + token) in a shared file registry
  (`src/utils/workspaceRegistry.ts`).
- **One window** wins the public MCP port and becomes the **router**. Its per-MCP-session
  handler is a `RoutingDebuggingHandler` (`src/routingDebuggingHandler.ts`) that resolves
  the target window from the request's `workingDirectory`/`fileFullPath` and forwards the
  operation to that window's `ControlServer`. The target is cached per session so hint-less
  follow-ups (step/continue/inspect) reach the same window. If the router window closes,
  a worker window takes over the port on retry.

`DebugMCPServer` builds one handler **per MCP session** via a handler factory, which is
what lets concurrent agent sessions drive debuggers in different repos simultaneously.

### Tools only — no resources, no instructions

`DebugMCPServer` exposes **tools only**. Procedural workflow guidance (when to debug,
how to structure a root-cause investigation, language-specific quirks) lives in the
companion Agent Skill at `skills/debug-live/SKILL.md`, not in tool descriptions or MCP
resources. This separation matches modern agent ecosystems where MCP servers provide
*capabilities* and skills provide *procedural knowledge* an agent loads as context.

Tool descriptions are intentionally terse and behavioral — they describe *what* the
tool does, not *when* or *how* to use it in a multi-step workflow.

### Streamable HTTP Transport

Uses stateless HTTP POST requests for MCP communication. The express server exposes:
- `POST /mcp` — Handles all MCP protocol messages (JSON-RPC over HTTP)

Each request creates a new stateless `StreamableHTTPServerTransport` instance that is closed when the HTTP response closes. The server returns JSON-RPC error responses (not HTML pages) for malformed payloads or unsupported methods to keep client behavior predictable.

### Bounded operations (no hung tool calls)

Every layer that a tool call passes through is time-bounded so a wedged debug
adapter or an unresponsive worker window can never leave an MCP request pending
forever (which surfaces to clients as "Request timed out" and makes the whole
server look stuck). The bounds are nested innermost-first so the most specific
error wins:

- **DAP request** (`DebuggingExecutor.dapRequest`) caps each `customRequest`
  (stackTrace/scopes/variables/evaluate).
- **Router → worker forward** (`RoutingDebuggingHandler`) caps the loopback
  round-trip to a worker window's `ControlServer` (`timeoutInSeconds + 15s`).
- **Tool boundary** (`DebugMCPServer.runTool`) is the final backstop around every
  tool invocation (`timeoutInSeconds + 30s`), guaranteeing the client always
  gets a prompt response.

## Key Code Locations

- Class definition: `src/debugMCPServer.ts`
- Tool registration: `setupTools()` method (uses `McpServer.registerTool()`)
- Server startup / router election: `start()` method (returns whether this window owns the port)
- Per-window control server: `src/controlServer.ts`
- Cross-window routing handler: `src/routingDebuggingHandler.ts`
- Shared window registry: `src/utils/workspaceRegistry.ts`
- Agent Skill (companion, not part of the MCP surface): `skills/debug-live/SKILL.md`

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

## Configuration

- `debugmcp.serverPort`: Port number (default: 3001)
- `debugmcp.timeoutInSeconds`: Operation timeout (default: 180)