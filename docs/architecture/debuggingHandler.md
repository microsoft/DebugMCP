# DebuggingHandler

## Purpose

High-level orchestration layer that coordinates debugging operations between the MCP server and VS Code's debug API. Handles the asynchronous nature of debugging by implementing state change detection.

## Motivation

Debugging is inherently asynchronous - when you step over a line, the debugger takes time to execute and update its state. AI agents need reliable feedback about when operations complete. `DebuggingHandler` bridges this gap by polling for state changes and returning meaningful responses.

## Responsibility

- Orchestrate debugging operations (start, stop, step, breakpoints)
- Detect when debugger state has meaningfully changed after commands
- Format debug state into human/AI-readable responses
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

### Root Cause Analysis

When debugging stops, the handler prompts AI agents to consider whether they found the root cause or just a symptom, encouraging deeper investigation.

## Key Code Locations

- Class definition: `src/debuggingHandler.ts`
- Interface: `IDebuggingHandler`
- State change detection: `waitForStateChange()`, `hasStateChanged()`
- Session waiting: `waitForActiveDebugSession()`
- State formatting: `formatDebugState()`

## Design Patterns

- **Before/After Comparison**: All step operations capture state before and after
- **Timeout Configuration**: Controlled by `timeoutInSeconds` parameter
- **Dependency Injection**: Executor and config manager are injected via constructor

## Error Handling

All operations wrap errors with context about what operation failed, enabling AI agents to understand and potentially recover from failures.
