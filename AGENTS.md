# Agent Guidelines for DebugMCP

## Project Overview

DebugMCP is a VS Code extension that embeds an MCP (Model Context Protocol) server, enabling AI coding agents to control VS Code's debugger via DAP (Debug Adapter Protocol). AI agents can start/stop debugging, step through code, set breakpoints, inspect variables, and evaluate expressions.

### Architecture

```
AI Agent (Cline/Copilot/Cursor) → MCP/SSE → DebugMCPServer → DebuggingHandler → DebuggingExecutor → VS Code Debug API
```

### Key Components

| Component | Responsibility | Docs |
|-----------|----------------|------|
| `DebugMCPServer` | MCP server, tool/resource registration | [docs/architecture/debugMCPServer.md](docs/architecture/debugMCPServer.md) |
| `DebuggingHandler` | Operation orchestration, state change detection | [docs/architecture/debuggingHandler.md](docs/architecture/debuggingHandler.md) |
| `DebuggingExecutor` | VS Code debug API calls, DAP requests | [docs/architecture/debuggingExecutor.md](docs/architecture/debuggingExecutor.md) |
| `DebugState` | Debug session state model | [docs/architecture/debugState.md](docs/architecture/debugState.md) |
| `DebugConfigurationManager` | Launch configs, language detection | [docs/architecture/debugConfigurationManager.md](docs/architecture/debugConfigurationManager.md) |
| `AgentConfigurationManager` | AI agent auto-configuration | [docs/architecture/agentConfigurationManager.md](docs/architecture/agentConfigurationManager.md) |

## Documentation Maintenance

**IMPORTANT**: Keep `docs/*.md` files up to date when modifying components. These docs should remain high-level:
- Purpose and motivation
- Responsibility scope
- Key concepts and patterns
- Pointers to relevant code sections

Do NOT duplicate detailed implementation in docs - that information should be inferred from the code itself.

## File Header

Include in each source file:
```typescript
// Copyright (c) Microsoft Corporation.
```

## Build/Lint/Test Commands

| Command | Description |
|---------|-------------|
| `npm run compile` | Compile TypeScript to `out/` |
| `npm run lint` | Run ESLint on `src/` |
| `npm test` | Run all tests (`src/test/*.test.ts`) |
| `npm run watch` | Compile in watch mode |

## Code Style & Conventions

- **TypeScript**: Strict mode, ES2022 target, Node16 modules
- **Imports**: vscode → external packages → internal modules
- **Naming**: camelCase (variables/functions), PascalCase (classes/interfaces), `I` prefix for interfaces
- **Types**: Explicit types preferred, strict null checks, avoid `any`
- **Error Handling**: try-catch with descriptive messages, throw `Error` objects
- **Formatting**: Semicolons, curly braces for all control structures, tabs for indentation
- **Async**: async/await, exponential backoff for retries
- **Logging**: Use `logger` from `./utils/logger` (not `console.log`). Simple wrapper providing `info`, `warn`, `error` methods with consistent formatting.
- **VS Code API**: Import as `import * as vscode from 'vscode'`

## Key Dependencies

- `@modelcontextprotocol/sdk`: Official MCP server framework (`McpServer`, `SSEServerTransport`)
- `zod`: Schema validation for tool parameters
- `express`: HTTP server for SSE transport

## Entry Points

- **Extension activation**: `src/extension.ts` → `activate()`
- **MCP endpoint**: `http://localhost:{port}/sse` (default port: 3001)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `debugmcp.serverPort` | 3001 | MCP server port |
| `debugmcp.timeoutInSeconds` | 180 | Operation timeout |

## Documentation Resources

The `docs/` folder contains two types of documentation:

**Component docs** (referenced in Key Components table above): Developer documentation for understanding the codebase architecture.

**AI Agent resources** (served via MCP at runtime):

| File | Purpose |
|------|---------|
| `agent-resources/debug_instructions.md` | Core debugging workflow guide for AI agents |
| `agent-resources/troubleshooting/*.md` | Language-specific debugging tips (Python, JavaScript, Java, C#) |

These resource files are loaded by `DebugMCPServer` and exposed as MCP resources that AI agents can read to learn how to use the debugging tools effectively.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **DebugMCP** (1057 symbols, 2730 relationships, 82 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/DebugMCP/context` | Codebase overview, check index freshness |
| `gitnexus://repo/DebugMCP/clusters` | All functional areas |
| `gitnexus://repo/DebugMCP/processes` | All execution flows |
| `gitnexus://repo/DebugMCP/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
