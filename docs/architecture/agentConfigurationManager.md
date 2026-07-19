# AgentConfigurationManager

## Purpose

Handles automatic configuration of AI coding agents (Cline, GitHub Copilot, GitHub Copilot CLI, Cursor, Codex) to connect to the DebugMCP server. Provides a seamless onboarding experience.

## Motivation

For AI agents to use DebugMCP, they need MCP server configuration in their settings files. Rather than requiring users to manually edit JSON files, this manager auto-configures supported agents with the correct SSE endpoint.

## Responsibility

- Detect supported AI agents and their config file paths
- Show post-install popup for agent selection
- Write MCP server configuration to agent settings files
- Handle cross-platform config path differences (Windows, macOS, Linux)
- Track whether onboarding popup has been shown

## Supported Agents

| Agent | Config File | MCP Field |
|-------|-------------|-----------|
| Cline | `cline_mcp_settings.json` | `mcpServers` |
| GitHub Copilot | `mcp.json` | `servers` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` or `${COPILOT_HOME}/mcp-config.json` | `mcpServers` |
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

Codex uses TOML:
```toml
[mcp_servers.debugmcp]
url = "http://localhost:3001/mcp"
```

### Popup State

Uses VS Code's `globalState` to track whether the onboarding popup has been shown, preventing repeated prompts on every activation.

### Skill delivery — standard skills directories

The `debug-live` Agent Skill is installed into the **standard personal skills directories** defined by the Agent Skills open standard (agentskills.io), rather than being copied next to each agent's config file:
- **`~/.agents/skills/debug-live/`** — the cross-agent location honored by skills-compatible harnesses, including VS Code agent mode and Copilot CLI. Always installed.
- **`~/.copilot/skills/debug-live/`** — Copilot's own skills path; also installed when a Copilot home directory (`~/.copilot`, or `$COPILOT_HOME`) exists.

`installDebugMCPSkill()` copies the one bundled source (`skills/debug-live/SKILL.md`) into each target with `force: true` (idempotent refresh) and removes stale legacy copies (`debug`, `really-debug`). It is agent-independent — a single shared install covers every skills-compatible harness.

This fixes issue #105: earlier builds copied the skill next to each agent's config (e.g. `Code/User/skills/` for VS Code Copilot), a directory no harness scans, so the skill never loaded. Installing to `~/.agents/skills/` — which VS Code agent mode does scan — makes it discoverable.

## Key Code Locations

- Class definition: `src/utils/agentConfigurationManager.ts`
- Agent definitions: `getSupportedAgents()`
- Config writing: `addDebugMCPToAgent()`
- Skill install: `installDebugMCPSkill()` / `getSkillInstallTargets()` / `ensureSkillRegistered()`
- Codex TOML upsert: `upsertCodexDebugMCPConfig()`
- Path detection: `getConfigBasePath()`
- Popup logic: `shouldShowPopup()`, `showAgentSelectionPopup()`

## User Flow

1. Extension activates
2. Check if popup was previously shown
3. If not, display multi-select dialog with supported agents
4. For each selected agent, write/update config file
5. Show success message with option to open config file
6. Mark popup as shown

The bundled `debug-live` skill is installed into the standard skills directories (`~/.agents/skills/`, plus `~/.copilot/skills/` when present) during step 4, so every skills-compatible harness discovers it from one shared location.

## Commands

- `debugmcp.showAgentSelectionPopup`: Manually trigger agent setup
- `debugmcp.configureAgents`: Alternative manual configuration
- `debugmcp.resetPopupState`: Reset for testing (re-shows popup)
