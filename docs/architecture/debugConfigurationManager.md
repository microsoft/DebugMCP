# DebugConfigurationManager

## Purpose

Produces the argument passed to `vscode.debug.startDebugging()` — either a launch.json configuration name or a minimal `DebugConfiguration` stub.

## Motivation

Earlier versions of this class manually parsed `launch.json`, scored configurations, and assembled fully populated per-language config objects. That duplicated work VS Code and the language debug extensions already do better:

- **VS Code** resolves launch.json configurations by name when you pass a string to `startDebugging`.
- **Language extensions** (Python, JS/TS, Java, .NET, Go, …) each register a `DebugConfigurationProvider` whose `resolveDebugConfiguration` hook fills in `cwd`, `console`, `env`, `stopOnEntry`, and other sensible defaults for a minimal stub.

Delegating to those mechanisms keeps this class small and ensures defaults stay aligned with whatever the installed language extensions consider current.

## Responsibility

- Return a launch.json configuration name when the caller provides one — VS Code looks it up itself.
- Otherwise, return a minimal launch stub (`type`, `request`, `name`, `program`) for the file's language and let the language extension resolve the rest.
- For `.NET` (`coreclr`), locate the project's built DLL since `program` cannot be a `.cs` source file.
- Detect the debugger `type` from a file extension.

**Test debugging is not handled here.** It is routed through `DebuggingExecutor.debugTestAtCursor`, which uses VS Code's built-in `testing.debugAtCursor` command to dispatch to whichever `TestController` owns the test under the cursor. That path supports any language whose extension registers a Test Explorer integration and correctly handles parent/child process attach (e.g. `dotnet test`'s testhost).

## Key Concepts

### Return type

`getDebugConfig()` returns `string | vscode.DebugConfiguration`. Both forms are accepted by `vscode.debug.startDebugging(folder, nameOrConfiguration)`.

### Language detection

Maps file extensions to debugger `type` values:
- `.py` → `python`
- `.js/.ts/.jsx/.tsx` → `pwa-node`
- `.java` → `java`
- `.cs/.csproj` → `coreclr`
- `.cpp/.cc/.c` → `cppdbg`
- `.go` → `go`
- `.rs` → `lldb`
- `.php` → `php`
- `.rb` → `ruby`

### Test framework support

Test launches are dispatched via `DebuggingExecutor.debugTestAtCursor`, not via this class. Any language with a registered `TestController` is supported (Python unittest/pytest, Jest, Mocha, JUnit, C# Dev Kit, Go, Rust, ...).

### Selection flow

1. If `configurationName` is provided and is not the sentinel `Default Configuration`, return that name verbatim.
2. Otherwise, if the file is C# (`coreclr`), walk up to find the `.csproj`, locate its built DLL under `bin/{Debug,Release}/<tfm>/`, and return a coreclr config pointing at that assembly.
3. Otherwise, return `{ type, request: 'launch', name: 'DebugMCP Launch', program: fileFullPath }`.

## Key code locations

- Class definition: `src/utils/debugConfigurationManager.ts`
- Interface: `IDebugConfigurationManager`
- .NET assembly lookup: `findNearestCsproj()`, `findBuiltAssembly()`, `createDotNetLaunchConfig()`
- Language detection: `detectLanguageFromFilePath()`
- Test launches: see `DebuggingExecutor.debugTestAtCursor` in `src/debuggingExecutor.ts`

## Python test name formatting

Python test name handling now lives in the Python extension's `TestController`; we no longer format `module.ClassName.test_method` ourselves.
