# AgentConfigurationManager

## Purpose

Handles automatic configuration of AI coding agents (Cline, GitHub Copilot, GitHub Copilot CLI, Claude Code, Cursor, Codex) to connect to the DebugMCP server. Provides a seamless onboarding experience.

## Motivation

For AI agents to use DebugMCP, they need MCP server configuration in their settings files. Rather than requiring users to manually edit JSON files, this manager auto-configures supported agents with the Streamable HTTP endpoint.

## Responsibility

- Detect supported AI agents and their config file paths
- Show post-install popup for agent selection
- Write MCP server configuration to agent settings files
- Preserve existing JSON configuration files when they cannot be parsed
- Handle cross-platform config path differences (Windows, macOS, Linux)
- Track whether onboarding popup has been shown

When an existing JSON configuration is malformed, setup leaves it unchanged and offers to
open the file. The error also directs users to rerun **DebugMCP: Show Agent Selection
Popup** from the Command Palette after correcting the JSON.

## Supported Agents

| Agent | Config File | MCP Field |
|-------|-------------|-----------|
| Cline | `cline_mcp_settings.json` | `mcpServers` |
| GitHub Copilot | `mcp.json` | `servers` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` or `${COPILOT_HOME}/mcp-config.json` | `mcpServers` |
| Claude Code | `~/.claude.json` | Top-level `mcpServers` (user scope, shared across projects) |
| Cursor | `mcp_settings.json` | `mcpServers` |
| Codex | `~/.codex/config.toml` or `${CODEX_HOME}/config.toml` | `mcp_servers.debugmcp` |

## Key Concepts

### Cross-Platform Paths

Config base paths vary by OS:
- **Windows**: `%APPDATA%` (e.g., `C:\Users\X\AppData\Roaming`)
- **macOS**: `~/Library/Application Support`
- **Linux**: `$XDG_CONFIG_HOME` or `~/.config`

### MCP Server Configuration

The configuration written to most JSON-based agent settings:
```json
{
  "debugmcp": {
    "autoApprove": [],
    "disabled": false,
    "timeout": 180,
    "type": "streamableHttp",
    "url": "http://localhost:3001/mcp"
  }
}
```

GitHub Copilot CLI uses:
```json
{
  "mcpServers": {
    "debugmcp": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "tools": ["*"]
    }
  }
}
```

Claude Code uses `type: "http"` and `url` in the top-level `mcpServers.debugmcp`
entry of `~/.claude.json`. Setup preserves unrelated top-level settings, project
settings (including project-scoped MCP servers), and other user-scoped MCP servers.

On extension activation, migration leaves existing Claude Code `http` and
`streamable-http` entries unchanged, including custom URLs and headers, unless
the URL still ends in `/sse`. Entries with `type: "sse"` or a legacy `/sse` URL
are migrated to the current HTTP configuration. Once migrated, subsequent runs
do not rewrite the configuration or report another migration.

Codex uses TOML:
```toml
[mcp_servers.debugmcp]
url = "http://localhost:3001/mcp"
```

### Popup State

Uses VS Code's `globalState` to track whether the onboarding popup has been shown or dismissed, preventing repeated prompts on every activation. Users can still reopen setup from the Command Palette.

### Skill delivery — standard skills directories

The `debug-live` Agent Skill is installed into the **standard personal skills directories** defined by the Agent Skills open standard (agentskills.io), rather than being copied next to each agent's config file:
- **`~/.agents/skills/debug-live/`** — the cross-agent location honored by skills-compatible harnesses, including VS Code agent mode and Copilot CLI. Always installed.
- **`~/.copilot/skills/debug-live/`** — Copilot's own skills path; also installed when a Copilot home directory (`~/.copilot`, or `$COPILOT_HOME`) exists.

The shared installer in `src/utils/debugSkillInstaller.ts` copies the one bundled
source (`skills/debug-live/`) into each target with `force: true` (idempotent
refresh) and removes stale legacy copies (`debug`, `really-debug`). Both the VS
Code extension and standalone CLI use this installer. The npm package includes
the complete skill tree, and `debugmcp configure` installs it while registering
the selected agents.

This fixes issue #105: earlier builds copied the skill next to each agent's config (e.g. `Code/User/skills/` for VS Code Copilot), a directory no harness scans, so the skill never loaded. Installing to `~/.agents/skills/` — which VS Code agent mode does scan — makes it discoverable.

## Key Code Locations

- Class definition: `src/utils/agentConfigurationManager.ts`
- Agent definitions: `getSupportedAgents()`
- Config writing: `addDebugMCPToAgent()`
- Shared skill install: `src/utils/debugSkillInstaller.ts`
- Extension skill orchestration: `installDebugMCPSkill()` / `ensureSkillRegistered()`
- Standalone skill orchestration: `src/cli/main.ts` (`configureAgents()`)
- Codex TOML upsert: `upsertCodexDebugMCPConfig()`
- Path detection: `getConfigBasePath()`
- Popup logic: `shouldShowPopup()`, `showAgentSelectionPopup()`

## User Flow

1. Extension activates
2. Check if popup was previously shown
3. If not, display multi-select dialog with supported agents
4. For each selected agent, write/update config file
5. Show success message with option to open config file
6. Mark popup as shown after it is accepted or dismissed

The bundled `debug-live` skill is installed into the standard skills directories (`~/.agents/skills/`, plus `~/.copilot/skills/` when present) during step 4, so every skills-compatible harness discovers it from one shared location.

## Commands

- `debugmcp.showAgentSelectionPopup`: Manually trigger agent setup
- `debugmcp.configureAgents`: Alternative manual configuration
- `debugmcp.resetPopupState`: Reset for testing (re-shows popup)
