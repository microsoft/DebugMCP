# DebugState

## Purpose

Immutable data class representing a snapshot of the current debugging session state. Used for state comparison to detect when debugging operations complete.

## Motivation

Debugging operations are asynchronous - the debugger takes time to execute and update. To know when an operation completes, we compare "before" and "after" state snapshots. `DebugState` provides a clean, clonable structure for these comparisons.

## Responsibility

- Hold all relevant debug session state in one object
- Provide helper methods to check state validity
- Support cloning for before/after comparisons
- Provide state update methods for building state incrementally

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `sessionActive` | `boolean` | Whether a debug session is running |
| `fileFullPath` | `string \| null` | Full path to current file |
| `fileName` | `string \| null` | Just the filename |
| `currentLine` | `number \| null` | 1-based line number |
| `currentLineContent` | `string \| null` | Content of current line |
| `nextLines` | `string[]` | Preview of upcoming lines |
| `frameId` | `number \| null` | DAP frame identifier |
| `threadId` | `number \| null` | DAP thread identifier |
| `frameName` | `string \| null` | Current function/method name |

## Key Methods

| Method | Purpose |
|--------|---------|
| `hasValidContext()` | Check if frame/thread IDs are set |
| `hasLocationInfo()` | Check if file/line info is available |
| `hasFrameName()` | Check if frame name is available |
| `clone()` | Create a deep copy for comparison |
| `reset()` | Clear all state to initial values |
| `updateContext()` | Set frame and thread IDs |
| `updateLocation()` | Set file and line information |
| `updateFrameName()` | Set the current frame name |

## Key Code Locations

- Class definition: `src/debugState.ts`

## Usage Pattern

```
1. Capture before state: beforeState = executor.getCurrentDebugState()
2. Execute debug command
3. Poll for changes: compare beforeState with currentState
4. State changed when: file, line, frame, or session status differs
```

## Design Notes

- **Immutable by convention**: Use `clone()` when you need a snapshot
- **Incremental building**: State is built via multiple update calls during retrieval
- **Null-safe**: All optional fields default to null, with helper methods to check validity
