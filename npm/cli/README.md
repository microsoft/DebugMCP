# DebugMCP CLI

**Give your AI coding agent a debugger, without requiring any IDE.**

DebugMCP CLI is a standalone package that lets coding agents set breakpoints, step through code, inspect
variables, and evaluate expressions in a live debug session via [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Instead of guessing
from source code alone, your agent can observe what the program actually does.

Works with GitHub Copilot CLI, Claude Code, Codex, Cursor and other MCP clients that can
launch a stdio server. DebugMCP starts the configured debug adapter as a background
process and communicates with it using the Debug Adapter Protocol (DAP).

[Report an issue](https://github.com/microsoft/DebugMCP/issues) |
[VS Code extension](https://marketplace.visualstudio.com/items?itemName=ozzafar.debugmcpextension)

## Requirements

- **Node.js 20 or newer** and npm.
- An MCP-capable coding agent.
- A separately installed **DAP adapter that communicates over stdio**, plus the
  runtime or compiled program you want to debug.

DebugMCP does **not** discover, download, install, or choose debugger installations
for you. Language support and individual debugging features depend on the adapter
you register. Adapters that only expose a TCP socket are not supported directly.

## Quick start

### 1. Install DebugMCP

```console
npm install --global debugmcp
```

### 2. Connect your agent

```console
debugmcp configure --agent copilot-cli
```

For Claude Code or Codex, use `--agent claude-code` or `--agent codex`.
Run `debugmcp configure` without flags for an interactive agent picker, or
configure several agents at once:

```console
debugmcp configure --agent copilot-cli --agent claude-code --agent codex
```

This registers the standalone stdio server and installs the bundled
**`debug-live` skill**, which guides agents through breakpoint-driven root-cause
investigation. Restart the configured agent to load the server and skill.

> Configuration uses one canonical `debugmcp` entry. If that agent already uses
> the DebugMCP VS Code extension, this command replaces its connection with the
> standalone CLI connection.

### 3. Register your project's debugger

For a Python project, use the interpreter from your intended environment.
Install [debugpy](https://github.com/microsoft/debugpy) there if it is not already
available:

```console
cd path\to\python-project
python -m pip install debugpy
debugmcp adapter add python --command "python -m debugpy.adapter"
debugmcp adapter validate python
```

`adapter add` saves the registration in `.debugmcp.json` in the current directory.
`adapter validate` starts the adapter and performs a DAP initialization handshake;
it does not launch or debug your application.

If your agent does not inherit the same environment, register an absolute
interpreter path rather than relying on `python` being on its `PATH`. Paths in
these examples use Windows syntax; substitute paths appropriate to your system.

### 4. Ask your agent to debug

Start the agent from your project directory and give it a concrete symptom:

> Use the debug-live skill to investigate why the total in app.py is incorrect.
> Set a breakpoint before the calculation, run the debugger, inspect the relevant
> inputs, and trace the cause before changing the code.

The agent invokes the debugger tools through MCP. You do not need to run
`debugmcp serve` separately when the agent is configured to launch it over stdio.

## What your agent can do

| Task | MCP tools |
| --- | --- |
| Start and stop a session | `start_debugging`, `stop_debugging` |
| Check whether execution is paused, running, or inactive | `get_debug_status` |
| Step over, into, or out of code | `step_over`, `step_into`, `step_out` |
| Resume, interrupt, or restart execution | `continue_execution`, `pause_execution`, `restart_debugging` |
| Manage breakpoints and logpoints | `add_breakpoint`, `add_logpoint`, `remove_breakpoint`, `list_breakpoints`, `clear_all_breakpoints` |
| Discover variables, then read specific values | `list_variable_names`, `get_variables_values` |
| Evaluate an expression in the paused program | `evaluate_expression` |

Conditional breakpoints, logpoints, expression syntax, and restart support depend
on your adapter. `get_variables_values` requires explicit variable names; use
`list_variable_names` for discovery instead of dumping the entire scope.

## Adapter configuration

### Language shorthands and explicit registration

Shorthands provide a default DAP type and file extensions for `python`, `csharp`,
`dotnet`, `cpp`, `c`, `javascript`, `typescript`, `node`, `java`, `go`, `rust`,
`ruby`, `php`, `swift`, and `dart`. They are **configuration conveniences, not
bundled debuggers or a guarantee that every adapter for that language will work**.

For a custom registration, provide both `--type` and `--extensions`. Keep the
executable in `--command` and its arguments in `--args`. For example, using a
specific Python environment:

```console
debugmcp adapter add project-python --command "C:\projects\demo\.venv\Scripts\python.exe" --type python --extensions .py --args -m debugpy.adapter
```

Use the DAP type and startup arguments required by your adapter. For adapter
arguments that conflict with DebugMCP options, put them after `--args --`.

### Launch settings

You can edit `.debugmcp.json` to supply adapter-specific launch properties:

```json
{
  "version": 1,
  "adapters": {
    "python": {
      "command": "python",
      "args": ["-m", "debugpy.adapter"],
      "type": "python",
      "extensions": [".py"],
      "transport": "stdio",
      "launch": {
        "program": "${file}",
        "cwd": "${workspaceFolder}",
        "justMyCode": true
      }
    }
  }
}
```

Alternatively, `adapter add` accepts `--launch` followed by a JSON object; quote
it according to your shell. Launch values support `${workspaceFolder}`, `${file}`,
`${fileDirname}`, and `${fileBasenameNoExtension}`.

By default, the requested source file is the program and the requested working
directory is its `cwd`. For compiled languages, build the program separately and
set `launch.program` to the executable. For attach workflows, set
`launch.request` to `"attach"` and provide the connection properties required by
your adapter.

The CLI does not use VS Code's test-discovery API or automatically load
`launch.json`. To debug tests, configure your adapter's launch properties to run
the test runner rather than relying on the `testName` tool parameter.

### Project and user scope

Registrations are project-local by default. Add `--user` to `adapter add` or
`adapter remove` to change user-level registrations. Project registrations
override user registrations with the same name.

```console
debugmcp adapter list
debugmcp adapter list --user
debugmcp adapter remove python
```

`adapter list` shows the effective project-plus-user registrations.
If several adapters match a source file's extension, the agent must pass the
desired registration name as `start_debugging.configurationName`.

## Other MCP clients

Add a stdio server using your client's configuration format. For clients with
an `mcpServers` object, the entry typically looks like this:

```json
{
  "mcpServers": {
    "debugmcp": {
      "command": "debugmcp",
      "args": ["serve", "--stdio"]
    }
  }
}
```

Make sure `debugmcp` is on the client's `PATH`, or use its absolute executable
path. Manual registration does not install the companion skill; its source and
workflow are available in
[`skills/debug-live`](https://github.com/microsoft/DebugMCP/tree/main/skills/debug-live).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No debug adapter is configured | Run `adapter add` in the project directory used by `start_debugging.workingDirectory`, or create a user-level registration. |
| Adapter fails to start or initialize | Run `debugmcp adapter validate <name>`. Check the executable path, arguments, dependencies, and stdio DAP support. |
| Tools or the skill are missing | Restart your agent after `configure`. `debugmcp status` inspects the **GitHub Copilot CLI registration only**, not debugger health or other agents. |
| Several adapters match a file | Pass the registration name as `configurationName`. |
| Program launches but a breakpoint is not hit | Check the source path, executable, debug symbols/source maps, and adapter-specific launch settings. |

When filing an issue, include the DebugMCP, Node.js, adapter, and OS versions;
your MCP client; the exact tool sequence; and a minimal, sanitized adapter
configuration. Remove secrets from logs and configuration before sharing them.

## Security

Debugger access can execute code and read program state with your user's
permissions. Only connect trusted agents and adapters, review tool approvals,
and avoid exposing production credentials in debug sessions. Although the CLI
and adapter run locally, debugger results are returned to your AI client and may
be sent to its model provider.

## CLI or VS Code extension?

Use this npm package for a standalone debugger host with no IDE dependency.
Use the [DebugMCP extension](https://marketplace.visualstudio.com/items?itemName=ozzafar.debugmcpextension)
to control VS Code's debugger, launch configurations, and test integration.
The npm package and extension have separate release versions.

Run `debugmcp help` for the command summary.
Licensed under [MIT](https://github.com/microsoft/DebugMCP/blob/main/LICENSE.txt).
