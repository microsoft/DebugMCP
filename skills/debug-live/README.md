# DebugMCP Skill

This folder is a self-contained **Agent Skill** that teaches an AI agent how to use the
DebugMCP MCP server effectively. It follows the Anthropic-style Skills convention: a
`SKILL.md` entry point with YAML frontmatter, plus bundled reference docs.

## Why this is separate from the MCP server

The DebugMCP MCP server exposes only **tools** (with brief, behavioral descriptions).
All workflow guidance — when to debug, how to structure a root-cause investigation,
which breakpoints to set, language-specific quirks — lives in this skill, not in tool
descriptions.

This separation matches modern agent ecosystems where:
- **MCP servers** = capabilities (tools, resources, prompts)
- **Skills** = procedural knowledge an agent loads as context

## Contents

```
skills/debugmcp/
├── SKILL.md                           # Entry point + workflow + root cause framework
├── README.md                          # This file
└── references/
    └── troubleshooting/
        ├── python.md
        ├── javascript.md
        ├── java.md
        ├── csharp.md
        ├── cpp.md
        └── go.md
```

## Installation

How you install a skill depends on your agent runtime. Common patterns:

- **Anthropic / Claude API with the Skills feature** — point the runtime at this folder
  (or vendor the folder into your project) and the agent will read `SKILL.md` and load
  references on demand.
- **Claude Code** — drop this folder under your project's configured skills directory.
- **Cursor / Cline / other clients without native skills support** — copy the contents
  of `SKILL.md` into a project rule / system prompt, and keep the `references/` files
  available for the agent to read on request.

Refer to your client's documentation for the exact path / mechanism.

## Tool naming

The `allowed-tools` list in `SKILL.md` uses the raw tool names registered by the
DebugMCP MCP server (`start_debugging`, `add_breakpoint`, etc.). Some runtimes namespace
MCP tools (e.g. `mcp__debugmcp__start_debugging`). Adapt the list to whatever convention
your runtime uses, or omit `allowed-tools` if the runtime doesn't honor it.

## Prerequisites

You also need:

1. The DebugMCP VS Code extension installed and running (it starts an MCP server on
   `http://127.0.0.1:3001/mcp` by default).
2. The language extension for whatever you're debugging (Python, C# Dev Kit, Java
   Extension Pack, etc. — see the per-language reference for specifics).
3. Your AI agent runtime configured to connect to that MCP endpoint.
