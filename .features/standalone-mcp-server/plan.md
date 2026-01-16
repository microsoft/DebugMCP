# Plan: Standalone MCP Debug Server

## Goal
Decouple the MCP debug server from the VS Code extension so it can run independently, enabling AI coding agents (terminal-based, cloud, etc.) to debug applications without requiring an IDE. The VS Code extension will then become a thin client that uses the same shared code with a different backend.

## Success Criteria
- [x] MCP server runs as standalone Node.js process without VS Code dependency
- [x] Standalone server can debug Python applications via debugpy
- [x] VS Code extension works exactly as before using shared abstraction layer
- [x] Clear documentation for setting up debugpy and configuring the standalone server
- [x] AI agents can use the MCP server from any environment (CLI, cloud, etc.)

## Scope
**In**: 
- Abstract VS Code debug API into a portable interface (`IDebugBackend`)
- Create standalone DAP client that communicates directly with debug adapters
- Refactor MCP server to use abstraction layer
- VS Code extension embeds standalone code in-process with `VSCodeDebugBackend`
- JSON configuration file for adapter paths and settings
- Python (debugpy) support for initial release

**Out**: 
- GUI/TUI for standalone mode (agents use MCP tools)
- Auto-installation of debug adapters (user's responsibility)
- Auto-detection of adapter paths (explicit config only)
- JavaScript/TypeScript, Java, C# support (future phases)
- Remote debugging scenarios (local debugging first)

## Approach
Create an abstraction layer (`IDebugBackend`) that defines all debug operations. Implement two backends: `VSCodeDebugBackend` (wraps VS Code's debug API) and `StandaloneDAPBackend` (communicates directly with DAP servers). The MCP server uses whichever backend is provided at construction.

**Key insight**: The VS Code extension embeds the standalone code in-process—no IPC needed. The extension simply uses `VSCodeDebugBackend` while the standalone entry point uses `StandaloneDAPBackend`. Same MCP server code, different backends.

The standalone server will need to:
1. Read adapter configuration from JSON config file
2. Spawn and manage DAP server processes (debugpy initially)
3. Implement the DAP protocol for communication
4. Handle debug state tracking that VS Code currently provides implicitly

## Components

### Portable Types
Before defining interfaces, we need VS Code-agnostic types that both backends use:

- **`DebugConfiguration`**: Portable debug config (mirrors DAP's launch/attach request args)
- **`Breakpoint`**: Union of `SourceBreakpoint { path, line }` and `FunctionBreakpoint { name }`
- **`Uri`**: Simple `{ path: string }` wrapper (no `vscode.Uri` dependency)

These replace direct usage of `vscode.DebugConfiguration`, `vscode.Breakpoint`, and `vscode.Uri` throughout the codebase.

### IDebugBackend (Interface)
**Responsibility**: Defines all debug operations in a VS Code-agnostic way. Must include:
- Debug control: start/stop, step, continue, restart
- Breakpoints: add/remove/list/clear (using portable `Breakpoint` type)
- Inspection: getVariables, evaluateExpression
- State: hasActiveSession, getCurrentDebugState, **getActiveFrameId**
- File access: **readFileContents** (for breakpoint line lookup)
- Output: **getRecentOutput** (buffered stdout/stderr)
- Events: **onStopped**, **onTerminated**, **onOutput** (event registration)

**Key methods**:
- `getActiveFrameId(sessionId?: string): Promise<number | undefined>` — replaces `vscode.debug.activeStackItem` access in DebuggingHandler
- `readFileContents(path: string): Promise<string>` — replaces `vscode.workspace.openTextDocument()` for breakpoint line search
- `getRecentOutput(options?: { maxLines?: number; since?: number }): Promise<{ stdout: string; stderr: string; truncated: boolean }>` — returns buffered program output

**Event model** (hybrid approach):
- **Events** for execution flow: `onStopped` (breakpoint hit, step complete), `onTerminated` (session ended), `onOutput` (new output available)
- **Polling** for inspection: `getVariables`, `evaluateExpression`, `getCurrentDebugState`

**Session support**: All methods accept an optional `sessionId?: string` parameter to future-proof for multiple concurrent debug sessions.

**Collaborators**: DebuggingHandler

### StandaloneDAPBackend
**Responsibility**: Implements IDebugBackend using direct DAP communication
**Collaborators**: DAPClient, DebugAdapterManager, DebugStateTracker

### DAPClient
**Responsibility**: Handles DAP protocol communication (JSON-RPC over stdio)
**Collaborators**: StandaloneDAPBackend

### DebugAdapterManager
**Responsibility**: Spawns and manages debug adapter processes based on configuration
**Collaborators**: StandaloneDAPBackend, ConfigLoader

### DebugStateTracker
**Responsibility**: Internal component of `StandaloneDAPBackend` that tracks:
- Active session state (running, stopped, terminated)
- Current frame ID when stopped
- Output buffer for `getRecentOutput()` (circular buffer, configurable max lines)

This replicates what VS Code tracks implicitly. Centralizing in a dedicated class makes it testable and keeps `StandaloneDAPBackend` focused on DAP protocol translation.

**Collaborators**: StandaloneDAPBackend (internal component, not injected)

### ConfigLoader
**Responsibility**: Loads and validates JSON configuration file. **Implements `IDebugConfigurationManager`** for standalone mode—provides debug configurations from JSON file instead of VS Code's launch.json.
**Collaborators**: DebugAdapterManager, StandaloneServer

**Note**: The existing `IDebugConfigurationManager` interface needs updating to use portable `DebugConfiguration` type instead of `vscode.DebugConfiguration`. Both `ConfigLoader` (standalone) and the existing VS Code config manager implement this interface.

### VSCodeDebugBackend
**Responsibility**: Implements IDebugBackend by wrapping VS Code's debug API (refactored from DebuggingExecutor)
**Collaborators**: VS Code Extension

### StandaloneServer (Entry Point)
**Responsibility**: Standalone Node.js entry point that creates MCP server with StandaloneDAPBackend
**Collaborators**: DebugMCPServer, StandaloneDAPBackend, ConfigLoader

### Interaction Summary
```
Standalone Mode:
  StandaloneServer → ConfigLoader → DebugAdapterManager
                  → DebugMCPServer → DebuggingHandler → StandaloneDAPBackend → DAPClient → debugpy

VS Code Mode:
  Extension → DebugMCPServer → DebuggingHandler → VSCodeDebugBackend → VS Code Debug API
```

Both modes share DebugMCPServer and DebuggingHandler—only the backend differs.

## Decisions

### Extension-Server Relationship
**Choice**: Embed in-process
**Rationale**: Simplest migration path, no IPC complexity, same DX as today. Extension imports standalone code directly and uses VSCodeDebugBackend.
**Alternative**: Child process or external process — choose if sandboxing or multi-extension support becomes needed

### Debug Adapter Discovery
**Choice**: User-configured paths via JSON config file
**Rationale**: Explicit is better than magic. Users know exactly what's being used. Easier to debug when things go wrong.
**Alternative**: Auto-detect — more convenient but more failure modes and platform-specific complexity

### Initial Language Support
**Choice**: Python only (debugpy)
**Rationale**: Most common for AI/ML work, stable adapter, well-documented. Proves architecture with minimal scope.
**Alternative**: Add JS/TS in Phase 3 — if there's demand, easy to add once DAP infrastructure is solid

### Configuration Format
**Choice**: JSON config file (debugmcp.config.json)
**Rationale**: Familiar pattern (matches launch.json), good tooling support, can use JSON5 for comments
**Alternative**: Environment variables — better for containers, could add as supplement later

### Event Model
**Choice**: Hybrid (events for execution flow, polling for inspection)
**Rationale**: AI agents need immediate notification when execution stops (their signal to inspect), but inspection itself is naturally request/response. This matches DAP's own model.
**Events**: `onStopped`, `onTerminated`, `onOutput`
**Polling**: `getVariables`, `evaluateExpression`, `getCurrentDebugState`
**Alternative**: Full polling — simpler but less responsive; Full events — more complex with minimal benefit

### Threading Model
**Choice**: Single-thread debugging only
**Rationale**: Sufficient for most Python scripts, simpler interface. Multi-threaded debugging adds significant complexity (thread selection, concurrent stops).
**Alternative**: Add `threadId` parameter — future enhancement if needed

### Session Management
**Choice**: Optional `sessionId` parameter on all `IDebugBackend` methods
**Rationale**: Future-proofs the interface for multiple concurrent debug sessions without breaking changes. Initial implementation can ignore the parameter.
**Alternative**: Single session only — simpler but would require interface changes later

### State Tracking
**Choice**: Explicit DebugStateTracker component
**Rationale**: VS Code tracks active session/stack implicitly; standalone must do this explicitly. Centralizing makes it testable.
**Alternative**: Query adapter each time — simpler but slower and doesn't handle all edge cases

## Phases

### Phase 1: Abstraction Layer ✅ COMPLETE
**Objective**: Create portable types and IDebugBackend interface without breaking existing functionality
**Deliverables**: 
- Portable types: `DebugConfiguration`, `Breakpoint`, `Uri`
- `IDebugBackend` interface definition (including `getActiveFrameId`, `readFileContents`, `getRecentOutput`, event registration)
- `IDebugConfigurationManager` updated to use portable types
- `VSCodeDebugBackend` (refactored from current DebuggingExecutor)
- `VSCodeConfigurationManager` (thin wrapper implementing `IDebugConfigurationManager`)
- Updated DebuggingHandler to use `IDebugBackend` and portable types (remove all `vscode.*` imports)
- Dependency injection in `DebugMCPServer` constructor
**Milestone**: Extension works exactly as before—all existing tests pass, DebuggingHandler has zero vscode imports

### Phase 2: DAP Infrastructure ✅ COMPLETE
**Objective**: Build foundation for direct DAP communication
**Deliverables**: 
- `DAPClient` (DAP protocol implementation over stdio)
- `DebugAdapterManager` (spawn/manage adapter processes)
- `ConfigLoader` (JSON config parsing, implements `IDebugConfigurationManager`)
- `DebugStateTracker` (session/frame/output state management)
- Unit tests for DAPClient with mock adapter responses
- Test harness script for manual DAPClient testing (spawn debugpy, send requests, verify responses)
**Milestone**: Can manually test: spawn debugpy, send initialize/launch requests, receive responses

### Phase 3: Standalone Backend ✅ COMPLETE
**Objective**: Implement full debugging via StandaloneDAPBackend
**Deliverables**: 
- `StandaloneDAPBackend` implementing IDebugBackend
- `StandaloneServer` entry point
- Example config file for Python/debugpy
**Milestone**: Can debug a Python script using `node standalone.js` (set breakpoint, hit it, inspect variables, continue)

### Phase 4: Integration & Polish ✅ COMPLETE
**Objective**: Production-ready for both modes
**Deliverables**: 
- Unified package structure (extension + standalone)
- npm scripts for standalone usage (`npm run standalone`, `npm run standalone:init`)
- CLI entry point (`bin/debugmcp.js`)
- Setup documentation for debugpy (`docs/standalone-setup.md`)
- Error messages and troubleshooting guide
**Milestone**: New user can follow docs to debug Python with standalone server

## Risks / Open Questions

1. **DAP edge cases**: VS Code handles many DAP quirks (adapter-specific behaviors, error recovery). We'll discover these as we implement. Mitigation: Start with debugpy only, which is well-behaved.

2. **debugpy installation**: Users must `pip install debugpy`. What if they use conda, pyenv, virtualenv? Mitigation: Document common scenarios, config supports custom paths.

3. **Platform differences**: Adapter paths differ by OS (Windows vs Unix). Mitigation: Config file is explicit, user specifies their path.

4. **Source mapping**: VS Code handles source maps for transpiled code. Mitigation: Out of scope for Python; address when adding JS/TS support.

5. **Breakpoint persistence**: VS Code persists breakpoints across sessions. Mitigation: Standalone sessions are ephemeral; AI agents set breakpoints each session anyway.

6. **Multiple debug sessions**: Current design assumes single session. Mitigation: Interface includes optional `sessionId` parameter to future-proof; initial implementation supports single session only.

7. **Program output handling**: Debug adapters send `output` events for stdout/stderr. In standalone mode, these need to be captured and made available to AI agents. Mitigation: `DebugStateTracker` maintains circular buffer, exposed via `getRecentOutput()` method.

8. **Error handling and recovery**: Debug adapters can crash, connections can drop, DAP requests can fail.
   - Adapter crash: `DebugAdapterManager` detects process exit, emits `onTerminated` event, cleans up state
   - DAP errors: Surface error messages through rejected promises with descriptive messages
   - Connection issues: Timeout on DAP requests (configurable, default 30s), clean termination on timeout
   - Health check: `IDebugBackend.hasActiveSession()` returns connection status

## Example Configuration

```json
{
  "port": 3001,
  "adapters": {
    "python": {
      "command": "python",
      "args": ["-m", "debugpy.adapter"],
      "cwd": "${workspaceFolder}"
    }
  },
  "defaults": {
    "python": {
      "type": "python",
      "request": "launch",
      "console": "integratedTerminal"
    }
  }
}
```

**Supported variables**:
- `${workspaceFolder}` — Directory containing the config file
- `${env:VAR_NAME}` — Environment variable value

## Appendix: VS Code Coupling Analysis

Current VS Code dependencies that Phase 1 must abstract:

### DebuggingHandler (must become VS Code-free)
| Line | Current Usage | Abstraction |
|------|---------------|-------------|
| 249 | `vscode.workspace.openTextDocument()` | `IDebugBackend.readFileContents()` |
| 264, 289 | `vscode.Uri.file()` | Portable `Uri` type |
| 294, 325, 329 | `vscode.SourceBreakpoint`, `vscode.FunctionBreakpoint` | Portable `Breakpoint` type |
| 351, 401 | `vscode.debug.activeStackItem` | `IDebugBackend.getActiveFrameId()` |

### DebuggingExecutor → IDebugBackend
| Current | Change |
|---------|--------|
| `vscode.DebugConfiguration` param | Portable `DebugConfiguration` |
| `vscode.Uri` params | Portable `Uri` |
| Returns `vscode.Breakpoint[]` | Returns portable `Breakpoint[]` |
| `vscode.DebugSession` | Internal implementation detail |

### DebugConfigurationManager → IDebugConfigurationManager  
| Current | Change |
|---------|--------|
| Returns `vscode.DebugConfiguration` | Returns portable `DebugConfiguration` |
| Uses `vscode.workspace.openTextDocument()` | Implementation detail (VS Code version keeps this) |
| Uses `vscode.window.showQuickPick()` | Implementation detail (standalone uses config file) |
