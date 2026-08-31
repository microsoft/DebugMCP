# Ruby Debugging Tips

## Prerequisites

- Install the [Shopify Ruby LSP](https://marketplace.visualstudio.com/items?itemName=Shopify.ruby-lsp) extension.
- Add Ruby's official [`debug`](https://github.com/ruby/debug) gem to the project bundle. With Bundler, verify that the
  selected Ruby can run it with `bundle exec rdbg -v`.
- Make sure Ruby LSP activates the same Ruby version and bundle as the application. If automatic detection selects the
  wrong runtime, configure `rubyLsp.rubyVersionManager` and restart Ruby LSP.
- For RSpec CodeLens support, add [`ruby-lsp-rspec`](https://github.com/st0012/ruby-lsp-rspec) to the development bundle
  and keep Ruby LSP's `codeLens` feature enabled.

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

## Debugging one RSpec example

Set the breakpoint in the application or example, then call `start_debugging` with:

- `fileFullPath` set to the spec file;
- `workingDirectory` set to the bundle root;
- `testName` set to the example you want to debug.

DebugMCP prefers the matching Ruby LSP debugger CodeLens and preserves its exact `file:line` target. This matters for
nested example groups and files containing many examples; a whole-file launch can exercise unrelated setup and hide the
original failure.

If the debugger CodeLens is missing:

1. Confirm `ruby-lsp-rspec` is in the active bundle and run `bundle install`.
2. Confirm Ruby LSP's `codeLens` feature is enabled.
3. Run **Ruby LSP: Restart** and inspect the **Ruby LSP** Output channel for activation or bundle errors.
4. If the project needs a wrapper, container command, or non-default bundle, configure the add-on's `rspecCommand`:

```json
{
  "rubyLsp.addonSettings": {
    "Ruby LSP RSpec": {
      "rspecCommand": "bin/rspec"
    }
  }
}
```

`rdbg` may report a debugger-entry pause before reaching the requested RSpec breakpoint. DebugMCP automatically
continues past that technical pause for Ruby test launches. Treat the later stop at the configured breakpoint as the
start of the investigation.

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

## Inspecting Ruby values

- Call `list_variable_names` first, then request only the needed locals with `get_variables_values`.
- Evaluate ordinary Ruby expressions such as `user.id`, `records.length`, or `records[0]`; do not prefix them with the
  interactive `rdbg` console command `p`.
- Ruby's DAP adapter exposes metadata children even for scalar values. DebugMCP returns the scalar value directly and
  omits synthetic class metadata, so a `String` or `Integer` should not be treated as a complex object solely because
  the adapter reports children.
- Ruby arrays are retrieved through indexed DAP paging. Inspect a specific element with an expression when the full
  collection is large.
- Expression evaluation runs in the paused process and may call application methods. Prefer read-only expressions until
  intentionally testing a hypothesis that requires a side effect.

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

### The wrong RSpec scope runs

- Pass `testName`; do not rely on the spec file path alone for a single-example investigation.
- Verify the debugger CodeLens appears on the intended example.
- Check that a custom `rspecCommand` accepts the appended `file:line` argument unchanged.
