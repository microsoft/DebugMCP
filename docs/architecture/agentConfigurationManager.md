# AgentConfigurationManager

## Purpose

Handles automatic configuration of AI coding agents (Cline, GitHub Copilot, Cursor) to connect to the DebugMCP server. Provides a seamless onboarding experience.

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
| Cursor | `mcp_settings.json` | `mcpServers` |

## Key Concepts

### Cross-Platform Paths

Config base paths vary by OS:
- **Windows**: `%APPDATA%` (e.g., `C:\Users\X\AppData\Roaming`)
- **macOS**: `~/Library/Application Support`
- **Linux**: `$XDG_CONFIG_HOME` or `~/.config`

### MCP Server Configuration

The configuration written to agent settings:
```json
{
  "debugmcp": {
    "autoApprove": [],
    "disabled": false,
    "timeout": 180,
    "type": "sse",
    "url": "http://localhost:3001/sse"
  }
}
```

### Popup State

Uses VS Code's `globalState` to track whether the onboarding popup has been shown, preventing repeated prompts on every activation.

## Key Code Locations

- Class definition: `src/utils/agentConfigurationManager.ts`
- Agent definitions: `getSupportedAgents()`
- Config writing: `addDebugMCPToAgent()`
- Path detection: `getConfigBasePath()`
- Popup logic: `shouldShowPopup()`, `showAgentSelectionPopup()`

## User Flow

1. Extension activates
2. Check if popup was previously shown
3. If not, display multi-select dialog with supported agents
4. For each selected agent, write/update config file
5. Show success message with option to open config file
6. Mark popup as shown

## Commands

- `debugmcp.showAgentSelectionPopup`: Manually trigger agent setup
- `debugmcp.configureAgents`: Alternative manual configuration
- `debugmcp.resetPopupState`: Reset for testing (re-shows popup)
