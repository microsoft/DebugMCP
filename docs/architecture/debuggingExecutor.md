# DebuggingExecutor

## Purpose

Low-level wrapper around VS Code's Debug API and Debug Adapter Protocol (DAP). Executes actual debugging commands and retrieves debug state.

## Motivation

VS Code's debug API is powerful but requires careful handling. `DebuggingExecutor` encapsulates this complexity, providing a clean interface for the handler layer while dealing with DAP custom requests, breakpoint management, and state retrieval.

## Responsibility

- Execute VS Code debug commands (step, continue, restart, etc.)
- Start and stop debug sessions
- Manage breakpoints (add, remove, list, clear)
- Retrieve current debug state (file, line, frame info)
- Execute DAP custom requests for variables and expression evaluation
- Determine if a debug session is ready for operations

## Architecture Position

```
┌───────────────────┐
│ DebuggingHandler  │
└───────────────────┘
        │
        ▼ Uses
┌───────────────────┐
│ DebuggingExecutor │  ◄── You are here
└───────────────────┘
        │
        ▼ Calls
┌───────────────────┐
│  VS Code Debug API │
│  (DAP Protocol)    │
└───────────────────┘
```

## Key Concepts

### VS Code Debug Commands

Stepping and control operations use VS Code's command system:
- `workbench.action.debug.stepOver`
- `workbench.action.debug.stepInto`
- `workbench.action.debug.stepOut`
- `workbench.action.debug.continue`
- `workbench.action.debug.restart`

### DAP Custom Requests

For data retrieval, the executor uses DAP's custom request mechanism:

| Request | Purpose |
|---------|---------|
| `stackTrace` | Get call stack and frame names |
| `scopes` | Get variable scopes for a frame |
| `variables` | Get variables within a scope |
| `evaluate` | Evaluate expressions in REPL context |

### Session Readiness

A session is considered "ready" when:
1. `vscode.debug.activeDebugSession` exists
2. Location info is available (file name and line number)

This handles cases where the debugger is still initializing (common with Python).

### State Retrieval

`getCurrentDebugState()` queries multiple VS Code APIs:
- `vscode.debug.activeDebugSession` - Session existence
- `vscode.debug.activeStackItem` - Frame/thread context
- `vscode.window.activeTextEditor` - Current file and line
- DAP `stackTrace` request - Frame name

## Key Code Locations

- Class definition: `src/debuggingExecutor.ts`
- Interface: `IDebuggingExecutor`
- State retrieval: `getCurrentDebugState()`
- DAP requests: `getVariables()`, `evaluateExpression()`
- Session readiness: `hasActiveSession()`

## Breakpoint Management

Breakpoints use VS Code's `SourceBreakpoint` class:
- Line numbers are 0-indexed internally, 1-indexed in API
- Breakpoints are identified by URI and line position
- The executor provides read-only access to all breakpoints via `getBreakpoints()`

## Special Cases

### .NET Debugging

For `coreclr` debug type, the executor uses a different approach:
- Opens the test file directly
- Executes `testing.debugCurrentFile` command

This handles .NET's test debugging workflow which differs from other languages.
