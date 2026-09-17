# DebugMCP CLI

DebugMCP CLI lets MCP-capable coding agents control language debuggers without
running VS Code. It communicates with explicitly configured Debug Adapter
Protocol (DAP) adapters over stdio, supporting any language for which such an
adapter is available.

## Install

```console
npm install --global debugmcp
```

## Configure an agent

Configure GitHub Copilot CLI once:

```console
debugmcp configure --agent copilot-cli
```

This also installs the bundled `debug-live` skill into the standard personal
skills directories. Restart the agent after configuration so it discovers the
skill.

## Configure a project

DebugMCP does not discover, install, or choose debugger installations. Register
the adapter provided by the project's environment:

```console
cd path\to\python-project
debugmcp adapter add python --command "python -m debugpy.adapter"
debugmcp adapter validate python
```

The project registration is stored in `.debugmcp.json`. Start the configured
agent from that project and ask it to use the `debug-live` skill.

Use `debugmcp help` for all commands.
