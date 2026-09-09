# Ruby Debugging Tips

## Prerequisites

- Install the [Shopify Ruby LSP](https://marketplace.visualstudio.com/items?itemName=Shopify.ruby-lsp) extension.
- Add Ruby's official [`debug`](https://github.com/ruby/debug) gem to the project bundle. With Bundler, verify that the
  selected Ruby can run it with `bundle exec rdbg -v`.
- Make sure Ruby LSP activates the same Ruby version and bundle as the application. If automatic detection selects the
  wrong runtime, configure `rubyLsp.rubyVersionManager` and restart Ruby LSP.

DebugMCP uses the `ruby_lsp` debug adapter for `.rb` files. Do not install or configure the deprecated
`rebornix.ruby` adapter for this workflow.

## Ruby scripts

For an ordinary Ruby script, set a breakpoint on an executable line and call `start_debugging` with the script path and
the project root. DebugMCP creates a minimal Ruby LSP launch configuration and passes the Ruby command and file
separately, so paths containing spaces or shell metacharacters remain valid.

Use a named `launch.json` configuration only when the program needs a specific command, environment, or attach mode:

```json
{
  "type": "ruby_lsp",
  "request": "launch",
  "name": "Debug Rails",
  "program": "bin/rails server"
}
```

Pass its name as `configurationName` to `start_debugging`.

## Rails and long-running processes

For a Rails request, job, or callback, set the breakpoint before starting the debug session and make sure the request or
job is triggered in the process launched by the debugger. A breakpoint in a web process will not catch code executed by
a separate Sidekiq process, Puma worker, test process, container, or preloader.

To attach to a Rails server instead of launching a new one, start it with the official debugger and use a named
`ruby_lsp` attach configuration:

```text
bundle exec rdbg -O -n -c -- bin/rails server
```

```json
{
  "type": "ruby_lsp",
  "request": "attach",
  "name": "Attach to Ruby"
}
```

Then pass `configurationName: "Attach to Ruby"` to `start_debugging`. Keep the debugger endpoint local unless the
project has an explicit, secured remote-debugging setup.

`start_debugging` returns as soon as the Ruby attach succeeds; it does not wait for a later request or job to hit the
breakpoint. Trigger that work after the attach result, then call `get_debug_status` with `waitForPauseSeconds` to wait
for the Ruby breakpoint without polling or interrupting the server with `pause_execution`. Inspect values only after
the returned status is `paused`.

## Common failures

### The debugger does not start

- Run `bundle exec rdbg -v` from `workingDirectory`.
- Verify VS Code and Ruby LSP selected the project's intended Ruby and Gemfile.
- Open the workspace at the directory that owns the bundle; incorrect workspace roots commonly select another runtime.
- Restart Ruby LSP after changing gems, version-manager settings, or the bundle.

### A breakpoint is not hit

- Put it on an executable Ruby line, not a blank line, comment, method declaration terminator, or DSL line that ran
  before the debugger attached.
- Confirm the debugged process actually executes that file and code path.
- Check for a different worker, preloader, container, generated copy, or mismatched local/remote source path.
- For a long-running server, trigger the request or job only after the debugger session has started.
