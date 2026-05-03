[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/microsoft-debugmcp-badge.png)](https://mseep.ai/app/microsoft-debugmcp)

# DebugMCP (MCP Server) - Empowering AI Agents with Multi-Language Debugging Capabilities

Let AI agents debug your code inside VS Code — set breakpoints, step through execution, inspect variables, and evaluate expressions. Works with **Codex**, **GitHub Copilot**, **Cline**, **Cursor**, and any MCP-compatible assistant. Supports **Python**, **JavaScript/TypeScript**, **Java**, **C#**, **C++**, **Go**, **Rust**, **PHP**, and **Ruby**.

> **📢 Beta Version Notice**: This is a beta version of DebugMCP maintained by [ozzafar@microsoft.com](mailto:ozzafar@microsoft.com) and [orbarila@microsoft.com](mailto:orbarila@microsoft.com). We welcome feedback and contributions to help improve this extension.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.104.0+-blue.svg)](https://code.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-1.0.9-green.svg)](https://github.com/microsoft/DebugMCP)
[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-Install-blue.svg)](https://marketplace.visualstudio.com/items?itemName=ozzafar.debugmcpextension)

> Watch DebugMCP in action — your AI assistant autonomously sets breakpoints, steps through code, and inspects variables directly in VS Code.

<p align="center">
  <img src="assets/DebugMCP.webp" alt="DebugMCP Demo" width="800">
</p>

## 🚀 Quick Install

**[Install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ozzafar.debugmcpextension)** or use the direct link: `vscode:extension/ozzafar.debugmcpextension`

## Table of Contents
- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Supported Languages](#supported-languages)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Overview

DebugMCP is an MCP server that gives AI coding agents full control over the VS Code debugger. Instead of reading logs or guessing, your AI assistant can autonomously set breakpoints, launch debug sessions, step through code line by line, inspect variable values, and evaluate expressions — just like a human developer would. It runs 100% locally, requires zero configuration, and works out of the box with any MCP-compatible AI assistant.

## Features

### 🔧 Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| **get_debug_instructions** | Get the debugging guide with best practices and workflow instructions | None |
| **start_debugging** | Start a debug session for a source code file | `fileFullPath` (required)<br>`workingDirectory` (required)<br>`testName` (optional)<br>`configurationName` (optional) |
| **stop_debugging** | Stop the current debug session | None |
| **step_over** | Execute the next line (step over function calls) | None |
| **step_into** | Step into function calls | None |
| **step_out** | Step out of the current function | None |
| **continue_execution** | Continue until next breakpoint | None |
| **restart_debugging** | Restart the current debug session | None |
| **add_breakpoint** | Add a breakpoint at a specific line | `fileFullPath` (required)<br>`lineContent` (required) |
| **remove_breakpoint** | Remove a breakpoint from a specific line | `fileFullPath` (required)<br>`line` (required) |
| **clear_all_breakpoints** | Remove all breakpoints at once | None |
| **list_breakpoints** | List all active breakpoints | None |
| **get_variables_values** | Get variables and their values at current execution point | `scope` (optional: 'local', 'global', 'all') |
| **evaluate_expression** | Evaluate an expression in debug context | `expression` (required) |

> **Note:** The `get_debug_instructions` tool is particularly useful for AI clients like GitHub Copilot that don't support MCP resources. It provides the same debugging guide content that is also available as an MCP resource.

### 🎯 Debugging Best Practices

DebugMCP follows systematic debugging practices for effective issue resolution:

- **Start with Entry Points**: Begin debugging at function entry points or main execution paths
- **Follow the Execution Flow**: Use step-by-step execution to understand code flow
- **Root Cause Analysis**: Don't stop at symptoms - find the underlying cause

### 🛡️ Security & Reliability
- **Secure Communication**: All MCP communications use secure protocols
- **Local Operation**: The MCP server runs 100% locally with no external communications and requires no credentials
- **State Validation**: Robust validation of debugging states and operations

## Installation

### Quick Install Options

**Option 1: Direct Link** (Fastest)
- Click this link: [vscode:extension/ozzafar.debugmcpextension](vscode:extension/ozzafar.debugmcpextension)
- Or copy and paste in your browser: `vscode:extension/ozzafar.debugmcpextension`

**Option 2: VS Code Marketplace**
- Visit: [https://marketplace.visualstudio.com/items?itemName=ozzafar.debugmcpextension](https://marketplace.visualstudio.com/items?itemName=ozzafar.debugmcpextension)
- Click "Install"

**Option 3: Within VS Code**
1. Open VSCode
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "DebugMCP"
4. Click Install
5. The extension automatically activates and registers as an MCP server

### Verification
After installation, you should see:
- DebugMCP extension in your installed extensions
- MCP server automatically running on port 3001 (configurable)
- Debug tools available to connected AI assistants

> **📝 Note**: No additional debugging rule instructions are needed - the extension works out of the box.

> **💡 Tip**: Enable auto-approval for all debugmcp tools in your AI assistant to create seamless debugging workflows without constant approval interruptions.

## Quick Start

1. **Install the extension** (see [Installation](#installation))
2. **Open your project** in VSCode
3. **Ask your AI to debug** - it can now set breakpoints, start debugging, and analyze your code!

## Supported Languages

DebugMCP supports debugging for the following languages with their respective VSCode extensions:

| Language | Extension Required | File Extensions | Status |
|----------|-------------------|-----------------|---------|
| **Python** | [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python) | `.py` | ✅ Fully Supported |
| **JavaScript/TypeScript** | Built-in / [JS Debugger](https://marketplace.visualstudio.com/items?itemName=ms-vscode.js-debug) | `.js`, `.ts`, `.jsx`, `.tsx` | ✅ Fully Supported |
| **Java** | [Extension Pack for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-pack) | `.java` | ✅ Fully Supported |
| **C/C++** | [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) | `.c`, `.cpp`, `.cc` | ✅ Fully Supported |
| **Go** | [Go](https://marketplace.visualstudio.com/items?itemName=golang.Go) | `.go` | ✅ Fully Supported |
| **Rust** | [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) | `.rs` | ✅ Fully Supported |
| **PHP** | [PHP Debug](https://marketplace.visualstudio.com/items?itemName=xdebug.php-debug) | `.php` | ✅ Fully Supported |
| **Ruby** | [Ruby](https://marketplace.visualstudio.com/items?itemName=rebornix.ruby) | `.rb` | ✅ Fully Supported |
| **C#/.NET** | [C#](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp) | `.cs` | ✅ Fully Supported |

## Configuration

### MCP Server Configuration (Recommended)

The extension runs an MCP server automatically. It will pop up a message to auto-register the MCP server in your AI assistant.

### Manual MCP Server Registration (Optional)

> **🔄 Auto-Migration**: If you previously configured DebugMCP with SSE transport, the extension will automatically migrate your configuration to the new Streamable HTTP transport on activation.

#### Cline
Add to your Cline settings or `cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "debugmcp": {
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp",
      "description": "DebugMCP - AI-powered debugging assistant"
    }
  }
}
```

#### GitHub Copilot
Add to your VS Code settings (`settings.json`):
```json
{
  "mcp": {
    "servers": {
      "debugmcp": {
        "type": "http",
        "url": "http://localhost:3001/mcp",
        "description": "DebugMCP - Multi-language debugging support"
      }
    }
  }
}
```

#### Cursor
Add to Cursor's MCP settings:
```json
{
  "mcpServers": {
    "debugmcp": {
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp",
      "description": "DebugMCP - Debugging tools for AI assistants"
    }
  }
}
```

#### Codex
Register DebugMCP with Codex:
```bash
codex mcp add debugmcp --url http://localhost:3001/mcp
```

Or add the equivalent configuration to `~/.codex/config.toml` (`${CODEX_HOME}/config.toml` if `CODEX_HOME` is set):
```toml
[mcp_servers.debugmcp]
url = "http://localhost:3001/mcp"
```

### Extension Settings

Configure DebugMCP behavior in VSCode settings:

```json
{
  "debugmcp.serverPort": 3001,
  "debugmcp.timeoutInSeconds": 180
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `debugmcp.serverPort` | `3001` | Port number for the MCP server |
| `debugmcp.timeoutInSeconds` | `180` | Timeout for debugging operations |


## FAQ

<details>
<summary><b>Which AI assistants are supported?</b></summary>

DebugMCP works with any MCP-compatible AI assistant, including **GitHub Copilot**, **Cline**, **Cursor**, **Roo Code**, **Windsurf**, and others. If your assistant supports the Model Context Protocol, it can use DebugMCP.
</details>

<details>
<summary><b>Does it work with VS Code Remote SSH / Codespaces / WSL?</b></summary>

Yes. DebugMCP runs as a VS Code extension with `extensionKind: workspace`, so it activates in the remote environment where your code lives. The MCP server runs on `localhost` within that remote context.
</details>

<details>
<summary><b>Do I need to configure launch.json?</b></summary>

No. DebugMCP automatically generates appropriate debug configurations based on the file's language/extension. If you have a `launch.json`, it will use matching configurations from there. You can also specify a configuration by name using the `configurationName` parameter.
</details>

<details>
<summary><b>Is my code sent to any external service?</b></summary>

No. DebugMCP runs 100% locally. The MCP server runs on `localhost`, and no code, variables, or debug data is sent to any external service. The AI assistant communicates with the MCP server entirely within your local machine.
</details>

<details>
<summary><b>What if port 3001 is already in use?</b></summary>

Change the port in VS Code settings: `"debugmcp.serverPort": 3002` (or any available port). Then update your AI assistant's MCP configuration to use the new port.
</details>

<details>
<summary><b>Can I debug unit tests?</b></summary>

Yes. Pass the `testName` parameter to `start_debugging` to debug a specific test method. DebugMCP will configure the debug session to run and pause at breakpoints within that test.
</details>

<details>
<summary><b>Why is my AI assistant not using the debug tools?</b></summary>

Make sure DebugMCP is registered in your AI assistant's MCP settings. The extension should auto-detect and offer to register itself. If not, see the [Manual MCP Server Registration](#manual-mcp-server-registration-optional) section. Also enable auto-approval for DebugMCP tools for a smoother workflow.
</details>

## Troubleshooting

### Common Issues

#### MCP Server Not Starting
- **Symptom**: AI assistant can't connect to DebugMCP
- **Solution**: 
  - Check if port 3001 is available
  - Restart VSCode
  - Verify extension is installed and activated

## How It Works

### Architecture

<p align="center">
  <img src="assets/architecture.png" alt="DebugMCP Architecture" width="800">
</p>

### Launch Configuration Integration
The extension handles debug configurations intelligently:

- **Existing launch.json**: If a `.vscode/launch.json` file exists, it will:
   - Search for a relevant configuration
   - Use a specific configuration if found

- **Default Configuration**: If no launch.json exists or no relevant config, it creates an appropriate default configurations for each language based on file extension detection


## Requirements

- VSCode with appropriate language extensions installed:
  - **Python**: [Python extension](vscode:extension/ms-python.debugpy) for `.py` files
  - **JavaScript/TypeScript**: Built-in Node.js debugger or [JavaScript Debugger extension](vscode:extension/ms-vscode.js-debug)
  - **Java**: [Extension Pack for Java](vscode:extension/vscjava.vscode-java-pack)
  - **C#/.NET**: [C# extension](vscode:extension/ms-dotnettools.csharp)
  - **C/C++**: [C/C++ extension](vscode:extension/ms-vscode.cpptools)
  - **Go**: [Go extension](vscode:extension/golang.go)
  - **Rust**: [rust-analyzer extension](vscode:extension/rust-lang.rust-analyzer)
  - **PHP**: [PHP Debug extension](vscode:extension/xdebug.php-debug)
  - **Ruby**: [Ruby extension](vscode:extension/rebornix.ruby) with debug support
- MCP-compatible AI assistant (Copilot, Cline, Roo..)

## Development

To build the extension:

```bash
npm install
npm run compile
```

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Security

Security vulnerabilities should be reported following the guidance at [https://aka.ms/SECURITY.md](https://aka.ms/SECURITY.md).
Please do not report security vulnerabilities through public GitHub issues.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft 
trademarks or logos is subject to and must follow 
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.

## ⭐ Star History

<a href="https://star-history.com/#microsoft/DebugMCP&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=microsoft/DebugMCP&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=microsoft/DebugMCP&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=microsoft/DebugMCP&type=Date" />
 </picture>
</a>

## License

MIT License - See [LICENSE](LICENSE.txt) for details

This extension was created by **Oz Zafar**, **Ori Bar-Ilan** and **Karin Brisker**.
