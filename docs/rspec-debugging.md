# RSpec debugging

Requires Shopify Ruby LSP, the `debug` gem, and `ruby-lsp-rspec` in the active bundle, with CodeLens enabled.

## Debugging one RSpec example

Set the breakpoint in the application or example, then call `start_debugging` with:

- `fileFullPath` set to the spec file;
- `workingDirectory` set to the bundle root;
- `testName` set to the example you want to debug.

DebugMCP prefers the matching Ruby LSP debugger CodeLens and preserves its exact `file:line` target. This matters for
nested example groups and files containing many examples; a whole-file launch can exercise unrelated setup and hide the
original failure. Exact names take priority over suffix matches; ambiguous matches fail with a diagnostic instead
of selecting an unrelated example. Generated `file:line` targets are quoted as a single POSIX shell argument, including
embedded quotes and expansion characters. Provider-supplied programs and the configured runner command stay unchanged.

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

`rdbg` may pause before the requested breakpoint. DebugMCP returns that first stop unchanged. Inspect it before
calling `continue_execution`: an unmatched source breakpoint does not distinguish entry from an exception or an
explicit `debugger` stop. Automatic continuation is deliberately not part of this dispatch path.
