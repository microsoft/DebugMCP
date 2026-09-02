# DebuggingHandler

## Purpose

High-level orchestration layer that coordinates debugging operations between the MCP server and VS Code's debug API. Handles the asynchronous nature of debugging by implementing state change detection.

## Motivation

Debugging is inherently asynchronous - when you step over a line, the debugger takes time to execute and update its state. AI agents need reliable feedback about when operations complete. `DebuggingHandler` bridges this gap by polling for state changes and returning meaningful responses.

## Responsibility

- Orchestrate debugging operations (start, stop, step, breakpoints)
- Preserve language-extension virtual source URIs when opening documents and setting breakpoints
- Detect when debugger state has meaningfully changed after commands
- Format debug state into human/AI-readable responses
- Recursively format explicitly requested structs and arrays
- Show descendant names and types when expanding complex values
- Provide root cause analysis guidance to AI agents
- Manage operation timeouts

## Architecture Position

```
┌───────────────────┐
│  DebugMCPServer   │
└───────────────────┘
        │
        ▼ Delegates to
┌───────────────────┐
│ DebuggingHandler  │  ◄── You are here
└───────────────────┘
        │
        ▼ Uses
┌───────────────────┐
│ DebuggingExecutor │
└───────────────────┘
```

## Key Concepts

### State Change Detection

After executing a debug command (step over, continue, etc.), the handler:
1. Captures "before" state
2. Executes the command via executor
3. Polls for state changes using exponential backoff
4. Returns the "after" state when a meaningful change is detected

### Exponential Backoff

Polling starts at 1 second intervals and increases exponentially (capped at 10 seconds for session activation, 1 second for state changes). Jitter is added to prevent thundering herd issues.

### Meaningful State Changes

A state change is considered meaningful when any of these change:
- Session active status
- Current file path
- Current line number
- Frame name (function/method)
- Frame ID

### Virtual source documents

Breakpoint and logpoint locations may be native paths or VS Code virtual-document URIs.
`src/utils/sourceUri.ts` keeps custom schemes intact instead of converting them into malformed
`file:` URIs. This is required for language-extension sources such as Business Central `.dal`
documents served through the `al-preview:` scheme.

### Root Cause Analysis

When debugging stops, the handler prompts AI agents to consider whether they found the root cause or just a symptom, encouraging deeper investigation.

### Secret Redaction

Variable inspection is the point where live process memory crosses the trust boundary into
an AI agent (and usually a remote model provider). Two controls apply there:

**Data minimization.** `handleGetVariables` requires an explicit `variableNames` list
(validated by `normalizeRequestedNames()`: non-empty, no wildcards, capped at
`maxRequestedVariables`) and returns only those variables. Unknown names are reported back
so the caller gets feedback instead of silence. `handleListVariableNames` exists for
discovery and returns names and types **only** — it never emits a value, so it needs no
redaction.

**Redaction.** Values that are returned still pass through `src/utils/secretRedaction.ts`,
which withholds credential-looking values by name (`api_key`, `password`, `token`, …) and by
content (JWT, PEM private key, `AKIA…`, `ghp_…`, `Bearer …`, `Password=…`, …).
`handleEvaluateExpression` is covered too, since evaluating `os.environ` is the trivial
bypass for per-variable controls. Null-ish values are deliberately left intact so
missing-credential bugs stay debuggable.
`handleGetVariables` and `handleEvaluateExpression` return the explicitly requested variable or expression's own result, but any expandable descendants are rendered as names and types only. A descendant value requires evaluating that exact path separately.
Recursive expansion is bounded to 100 child fields total per response, shared across all nested branches and requested roots.

## Key Code Locations

- Class definition: `src/debuggingHandler.ts`
- Interface: `IDebuggingHandler`
- State change detection: `waitForStateChange()`, `hasStateChanged()`
- Session waiting: `waitForActiveDebugSession()`
- State formatting: `formatDebugState()`
- Variable selection: `handleGetVariables()`, `handleListVariableNames()`, `normalizeRequestedNames()`
- Secret redaction: `src/utils/secretRedaction.ts`

## Design Patterns

- **Before/After Comparison**: All step operations capture state before and after
- **Timeout Configuration**: Controlled by `timeoutInSeconds` parameter
- **Dependency Injection**: Executor and config manager are injected via constructor

## Error Handling

All operations wrap errors with context about what operation failed, enabling AI agents to understand and potentially recover from failures.
Expression evaluation also distinguishes an adapter error from a successful
command whose result/output was not captured.
