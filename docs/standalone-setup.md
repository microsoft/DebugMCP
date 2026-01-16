# DebugMCP Standalone Mode

Run DebugMCP without VS Code - perfect for AI coding agents like Claude Code, Cursor, or any MCP-compatible tool.

## Quick Start

### 1. Install Dependencies

```bash
# Install debugpy for Python debugging
pip install debugpy

# Clone and build DebugMCP
git clone https://github.com/microsoft/DebugMCP.git
cd DebugMCP
npm install
npm run compile
```

### 2. Initialize Configuration

```bash
# Create debugmcp.config.json in your project
npx debugmcp init
```

Or copy the example:
```bash
cp debugmcp.config.json.example debugmcp.config.json
```

### 3. Start the Server

```bash
npx debugmcp serve
```

The server will start on port 3001 by default.

### 4. Configure Your MCP Client

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "debugmcp": {
      "url": "http://localhost:3001/sse"
    }
  }
}
```

## Configuration Reference

The `debugmcp.config.json` file structure:

```json
{
  "port": 3001,
  "timeout": 180,
  "adapters": {
    "python": {
      "command": "python",
      "args": ["-m", "debugpy.adapter"],
      "cwd": "${workspaceFolder}",
      "env": {}
    }
  },
  "defaults": {
    "python": {
      "type": "python",
      "request": "launch",
      "console": "internalConsole",
      "justMyCode": true
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | 3001 | HTTP server port |
| `timeout` | number | 180 | Debug operation timeout (seconds) |
| `adapters` | object | - | Debug adapter configurations |
| `defaults` | object | - | Default launch configurations |

### Variable Expansion

Configuration values support variable expansion:

- `${workspaceFolder}` - Directory containing the config file
- `${env:VAR_NAME}` - Environment variable value

### Adapter Configuration

Each adapter entry defines how to spawn the debug adapter:

```json
{
  "command": "python",           // Executable to run
  "args": ["-m", "debugpy.adapter"],  // Command arguments
  "cwd": "${workspaceFolder}",   // Working directory
  "env": {}                      // Environment variables
}
```

## Setting Up Debug Adapters

### Python (debugpy)

1. Install debugpy:
   ```bash
   pip install debugpy
   ```

2. Configure in `debugmcp.config.json`:
   ```json
   {
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
         "justMyCode": true
       }
     }
   }
   ```

### Node.js

For Node.js debugging, you can use the VS Code JavaScript debugger:

```json
{
  "adapters": {
    "node": {
      "command": "node",
      "args": ["${env:HOME}/.vscode/extensions/ms-vscode.js-debug-*/src/dapDebugServer.js"],
      "cwd": "${workspaceFolder}"
    }
  },
  "defaults": {
    "node": {
      "type": "node",
      "request": "launch"
    }
  }
}
```

Or use `node --inspect` with a DAP bridge.

## Available MCP Tools

Once running, DebugMCP exposes these tools to your AI agent:

| Tool | Description |
|------|-------------|
| `start_debugging` | Start a debug session for a file |
| `stop_debugging` | Stop the current debug session |
| `step_over` | Execute current line without diving into calls |
| `step_into` | Step into function calls |
| `step_out` | Step out of current function |
| `continue_execution` | Continue until next breakpoint |
| `restart_debugging` | Restart the debug session |
| `add_breakpoint` | Set a breakpoint at a line |
| `remove_breakpoint` | Remove a breakpoint |
| `clear_all_breakpoints` | Remove all breakpoints |
| `list_breakpoints` | Show all breakpoints |
| `get_variables_values` | Inspect variable values |
| `evaluate_expression` | Evaluate an expression |

## CLI Commands

```bash
# Show help
debugmcp help

# Create default configuration
debugmcp init

# Start server (auto-finds config)
debugmcp serve

# Start with specific config
debugmcp serve /path/to/config.json

# Show version
debugmcp --version
```

## Troubleshooting

### "No adapter configuration found"

Make sure you have:
1. Created `debugmcp.config.json` in your project
2. Defined the adapter for your language (e.g., "python")
3. The adapter command is in your PATH

### "Adapter process exited"

The debug adapter crashed. Check:
1. The adapter is installed (e.g., `pip install debugpy`)
2. The command and args are correct
3. stderr output for error messages

### "Timeout waiting for initialized event"

The adapter didn't respond in time. Try:
1. Increasing the timeout in config
2. Checking if the adapter command works manually
3. Looking for error messages in adapter stderr

### Connection Issues

If your MCP client can't connect:
1. Verify the server is running (`curl http://localhost:3001/`)
2. Check the port isn't blocked by firewall
3. Ensure the URL includes `/sse` path

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Client                           │
│            (Claude Code, Cursor, etc.)                  │
└─────────────────────┬───────────────────────────────────┘
                      │ HTTP/SSE
                      ▼
┌─────────────────────────────────────────────────────────┐
│                  DebugMCP Server                        │
│    ┌───────────────────────────────────────────────┐   │
│    │              DebugMCPServer                   │   │
│    │         (MCP Protocol Handler)                │   │
│    └───────────────────┬───────────────────────────┘   │
│                        │                                │
│    ┌───────────────────▼───────────────────────────┐   │
│    │            DebuggingHandler                   │   │
│    │         (Debug Operation Logic)               │   │
│    └───────────────────┬───────────────────────────┘   │
│                        │                                │
│    ┌───────────────────▼───────────────────────────┐   │
│    │          StandaloneDAPBackend                 │   │
│    │        (DAP Protocol Client)                  │   │
│    └───────────────────┬───────────────────────────┘   │
└─────────────────────────┼───────────────────────────────┘
                          │ DAP (stdio)
                          ▼
┌─────────────────────────────────────────────────────────┐
│               Debug Adapter Process                     │
│              (debugpy, js-debug, etc.)                 │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                  Target Program                         │
│              (your code being debugged)                │
└─────────────────────────────────────────────────────────┘
```

## License

MIT License - Copyright (c) Microsoft Corporation
