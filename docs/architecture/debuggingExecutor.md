# DebuggingExecutor

## Purpose

Host abstraction for executing debugging commands and retrieving debug state.
The VS Code implementation wraps the editor Debug API, while the standalone CLI
implementation hosts a debug adapter directly over DAP stdio.

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
│ VS Code Debug API │
│ or CLI DAP Client │
└───────────────────┘
```

### Standalone CLI host

`src/cli/cliDebuggingExecutor.ts` implements the same executor interface without
VS Code. It starts an explicitly registered adapter, performs the DAP
initialize/launch/configuration sequence, handles adapter events and
`runInTerminal`, and owns session, thread, frame, and breakpoint state.
Step operations wait for a fresh stopped or terminated event. Continue allows a
short stop-event grace period so immediately reached breakpoints are reported,
while still returning promptly for long-running programs.
Closing an MCP session disposes its standalone executor, adapter process, and
any debuggee processes started through reverse `runInTerminal` requests.
`src/cli/adapterConfig.ts` loads project and user registrations. No adapter is
registered, discovered, selected, installed, or upgraded implicitly.

## Key Concepts

### Startup Failure Diagnostics

`src/utils/debugStartup.ts` observes task lifecycle events before dispatching a
launch. It correlates newly started executions with the selected configuration's
`preLaunchTask` and labeled `dependsOn` tasks in the same workspace. Nonzero exit
codes produce an error naming the task and configuration, even if VS Code is
still waiting for the user to dismiss a task-failure dialog. Reporting the failure
does not dismiss that dialog or cancel VS Code's pending launch request.

Thrown configuration/adapter errors are preserved. When VS Code declines startup
without details, the response directs the caller to launch/task configuration
and diagnostic output instead of assuming a missing language extension. Task
events expose an exit code, not terminal text; the response makes that limitation
explicit rather than inventing the underlying command error.
Task-identifier objects and dynamically supplied task configuration are not
resolved by this observer; startup still proceeds through VS Code normally.

### VS Code Debug Commands

Stepping and control operations use VS Code's command system:
- `workbench.action.debug.stepOver`
- `workbench.action.debug.stepInto`
- `workbench.action.debug.stepOut`
- `workbench.action.debug.continue`
- `workbench.action.debug.pause`
- `workbench.action.debug.restart`

### DAP Custom Requests

For data retrieval, the executor uses DAP's custom request mechanism:

| Request | Purpose |
|---------|---------|
| `stackTrace` | Get call stack and frame names |
| `scopes` | Get variable scopes for a frame |
| `variables` | Get variables within a scope |
| `evaluate` | Evaluate expressions in the adapter-appropriate context |
| `readMemory` | Read raw target memory for GDB `x/...` commands |

All custom requests go through `dapRequest()`, which caps each call so an
unresponsive adapter rejects with an error instead of hanging the caller.

For Cortex-Debug sessions, common GDB inspection commands are adapted to DAP
operations that return structured results instead of relying on Debug Console
text that Cortex-Debug does not include in its `evaluate` response:

- `p` / `print` use watch-context expression evaluation.
- `x/...` resolves the address and uses `readMemory`.
- Struct and array `variablesReference` values are expanded only for variables
  explicitly requested by the caller.

### Session Readiness

A session is considered "ready" when:
1. `vscode.debug.activeDebugSession` exists
2. Location info is available (file name and line number)

This handles cases where the debugger is still initializing (common with Python).
`waitForDebugSessionReady()` accepts cancellation so a failed startup does not
leave its readiness timeout and event subscriptions behind.

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
- Bounded DAP calls: `dapRequest()`
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

## Variable inspection

When a parent advertises indexed children, retrieve both indexed and named groups, including adapters that omit the named count. This preserves custom properties on containers. Parents without indexed children retain the unfiltered variables request.
