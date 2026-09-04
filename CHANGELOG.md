# Changelog

All notable changes to DebugMCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Ruby live-debugging guidance.** The bundled `debug-live` skill now covers Ruby LSP setup, exact RSpec example launches, Rails launch and attach workflows with read-only breakpoint waiting, rdbg entry pauses, and Ruby value inspection.

### Fixed
- **Ruby debugging now uses Shopify Ruby LSP correctly.** Automatic `.rb` launch configurations target the modern `ruby_lsp` debug adapter and pass the Ruby command and file separately, including paths with spaces. Scalar rdbg values are returned instead of being mistaken for complex objects, synthetic class metadata is omitted, Ruby arrays use indexed DAP retrieval, and RSpec Testing API launches continue past rdbg's entry pause to the configured breakpoint. Documentation no longer points to the deprecated `rebornix.ruby` extension.
- **Named RSpec debugging now targets one example.** `start_debugging` matches the example's debugger CodeLens and preserves its exact `file:line` instead of degrading to a whole-file run when full test discovery is enabled. CodeLens dispatch is scoped to `*_spec.rb`, so every other language retains its previous VS Code Testing API path.
- **Paused frames no longer require source locations.** `get_debug_status`, step state changes, and continue settlement now use the actionable DAP frame/thread context, so adapters such as rdbg remain paused when file and line metadata are unavailable.

## [2.3.4] - 2026-09-03

### Added
- **`get_debug_status` tool** - reports whether the debuggee is paused, running, or inactive and can optionally wait for a breakpoint without changing execution state.

### Changed
- Debugger navigation now records clearer timing and location diagnostics, and hint-less operations can safely route to the sole registered VS Code window.
- npm lockfiles no longer record registry-specific download URLs, improving portability across package registries.

### Fixed
- `start_debugging` now returns promptly after attaching to a long-lived process instead of waiting for a stop event that may never occur.
- `continue_execution` now returns as soon as the debuggee resumes while step operations continue waiting for their next stack frame.
- Fork pull requests no longer fail extension builds when the optional artifact-comment step lacks write permission.

### Dependencies
- Updated `@humanfs/node`, `@humanfs/core`, `fast-uri`, and `qs`.

## [2.3.0] - 2026-07-28

### Changed
- **`get_variables_values` now retrieves variables by name.** Pass an explicit `variableNames` array; only the variables you name are returned (max 50, no wildcards). Unknown names are reported back so the caller gets feedback instead of silence.

### Added
- **`list_variable_names` tool** - lists the names and types of variables at the current execution point without reading any values, so an agent can discover what is in scope and then request only what it needs.

### Breaking
- `get_variables_values` calls without a `variableNames` array now fail with an actionable error pointing at `list_variable_names`.

## [2.1.0] - 2026-06-23

### Added
- **Conditional breakpoints** — `add_breakpoint` now accepts an optional `condition` expression so execution only pauses when the condition evaluates to true (e.g. `i == 5`, `user.id === null`). Conditions are surfaced in `list_breakpoints` and the debug state.

### Changed
- **Renamed the companion Agent Skill from `really-debug` to `debug-live`.** It now installs at `skills/debug-live/` (e.g. `~/.copilot/skills/debug-live/`) and is invoked with `/debug-live`. Previous `really-debug` (and `debug`) installs are cleaned up automatically on registration.

### Fixed
- **`continue`/step no longer hangs when the program runs to completion.** Detection now settles on termination of the specific session being debugged (by identity) instead of waiting for the global active session to clear, which previously hung until the timeout when a parent session (e.g. the JS debug terminal) outlived the program.

## [1.2.0] - 2026-06-04

### Added
- **`/really-debug` Agent Skill** — bundled companion skill at `skills/really-debug/` that encodes the systematic debugging workflow for AI agents. The skill is automatically copied into each configured harness's personal skills directory (e.g. `~/.copilot/skills/really-debug/`) when DebugMCP is registered, and can be invoked with `/really-debug` in supporting agents. (Named `really-debug` rather than `debug` to avoid shadowing built-in `/debug` commands in some harnesses such as GitHub Copilot Chat.)
- **Robust test debugging via the VS Code Testing API** — `start_debugging` with a `testName` now discovers and launches the target test through the VS Code Testing API, producing reliable breakpoint hits across pytest, Jest/Vitest, Java, .NET, Go, and other Testing-API-integrated runners.

## [1.0.8] - 2025-03-14

### Added
- Improved debug state reporting with richer context for AI agents
- Named debug configuration support via `configurationName` parameter — use specific `launch.json` configurations by name

### Fixed
- Fixed debug state consistency issues during rapid step operations

## [1.0.7] - 2025-02-XX

### Changed
- **Migrated from SSE to Streamable HTTP transport** — faster, more reliable MCP communication
- Automatic migration of existing SSE configurations to new Streamable HTTP format
- SSE backward compatibility maintained during transition period

### Fixed
- Dependency security updates (undici, express, body-parser, glob, js-yaml)

### Internal
- Migrated from `fastmcp` to official `@modelcontextprotocol/sdk`

## [1.0.6] - 2025-01-XX

### Added
- **Agent auto-configuration popup** — automatically detects and registers with AI assistants (Cline, Copilot, Cursor)
- **Comprehensive documentation** — added architecture docs, AGENTS.md, and troubleshooting guides
- Language-specific debugging tips for Python, JavaScript, Java, C#, C++, and Go

### Fixed
- Fixed failure when `launch.json` contains comments (JSONC parsing)
- Fixed C++ debug configuration issues
- Fixed string equality comparison in breakpoint matching

## [1.0.5] - 2025-01-XX

### Added
- **Debug specific test methods** — pass `testName` to debug individual unit tests
- Clear all breakpoints tool for quick cleanup
- Breakpoint listing tool to view all active breakpoints

### Changed
- Default launch configurations moved to lower priority (user configs preferred)
- Improved MCP tool descriptions for better AI agent understanding

## [1.0.4] - 2024-12-XX

### Added
- **C#/.NET debugging support**
- Keep-alive for SSE sessions to prevent timeouts

## [1.0.3] - 2024-12-XX

### Added
- Multi-language debugging support: Python, JavaScript/TypeScript, Java, C/C++, Go, Rust, PHP, Ruby
- Breakpoint management (add, remove, list, clear all)
- Step-through execution (step over, step into, step out)
- Variable inspection with scope filtering (local, global, all)
- Expression evaluation in debug context
- Automatic debug configuration generation from file extensions
- MCP server with SSE transport

## [1.0.0] - 2024-12-XX

### Added
- Initial release
- Core debugging capabilities via MCP protocol
- VS Code Debug Adapter Protocol integration
- Automatic MCP server startup on extension activation
