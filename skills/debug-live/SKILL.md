---
name: debug-live
description: Drive an interactive VS Code debugger to investigate bugs, failing tests, wrong/null variable values, unexpected runtime behavior, and other "it doesn't work" reports. Use this skill whenever speculation about runtime behavior would be cheaper to *verify* by stepping through the code than to reason about. Pairs with the DebugMCP MCP server, which exposes the underlying breakpoint / step / inspect tools.
license: MIT
allowed-tools:
  - add_breakpoint
  - remove_breakpoint
  - clear_all_breakpoints
  - list_breakpoints
  - start_debugging
  - stop_debugging
  - restart_debugging
  - step_over
  - step_into
  - step_out
  - continue_execution
  - pause_execution
  - get_variables_values
  - evaluate_expression
---

# DebugMCP — Interactive Debugging Skill

This skill teaches an agent how to use the DebugMCP MCP server effectively. The MCP server
itself exposes only tools (with brief, behavioral descriptions); the *workflow*, *root cause
analysis framework*, and *language-specific guidance* live here.

> The `allowed-tools` list above uses the tool names registered by the DebugMCP MCP server.
> Some runtimes namespace MCP tools (e.g. `mcp__debugmcp__start_debugging`); adapt as needed.

---

## When to invoke this skill

Reach for this skill whenever you would otherwise *guess* at runtime behavior:

- Any reported bug, failing test, exception, or unexpected output.
- A variable holds an unexpected `null` / `undefined` / wrong type / wrong value.
- A function returns something the caller didn't expect.
- A code path executes (or fails to execute) when you didn't predict it would.
- You're about to read a large amount of code "trying to figure out what happens at runtime."

If you can step through the code in a few tool calls, do that instead of speculating.

---

## Core workflow

1. **Set a starting breakpoint.** Use `add_breakpoint` with the file path and the 1-based
   line number you want to pause on. Place it at the earliest point that's still
   relevant to the suspected issue.
2. **Optionally add strategic breakpoints.** Decision points, error-handling branches,
   data boundaries (where input enters, where output is produced).
3. **Start the session.** Call `start_debugging` with the source file path. For a single
   test, pass `testName`; the server routes through VS Code's Testing API so test runners
   like `dotnet test` / `pytest` / `jest` work correctly. The call returns when the
   program either hits a breakpoint (`stopped`) or runs to completion without pausing
   (`terminated`).
4. **Navigate and inspect.** Use `step_over`, `step_into`, `step_out`, `continue_execution`
   to move through code. Use `pause_execution` to interrupt a freely-running program
   (e.g. a busy loop or embedded target) when there is no breakpoint to stop at.
   Use `get_variables_values` to see local/global state and
   `evaluate_expression` to test hypotheses live (call methods, read properties, run
   list comprehensions, etc.).
5. **Find the root cause** (see framework below). Don't stop at the first wrong thing
   you see — trace it back to *why*.
6. **Clean up.** Call `clear_all_breakpoints` when you're done so you don't pollute the
   next session, and `stop_debugging` if the session is still active.

---

## 🚨 Root cause analysis framework

### Never stop at symptoms — always find the root cause

When you encounter an issue during debugging (null variable, unexpected value, thrown
error, wrong branch taken), apply this systematic approach.

#### Symptom vs root cause

- **Symptom:** what you observed is wrong (e.g. "variable `user` is null").
- **Root cause:** *why* the symptom occurred (e.g. "`user` is null because `getUserById()`
  returned null because the DB query failed because the connection string in
  `appsettings.json` points at the wrong host").

#### Investigation process

1. **Identify the symptom.** What exactly is wrong? Which line, which variable, which
   thrown exception? Record the current state.
2. **Ask "why?"** Why is this value wrong? Why did this function return this? Why did
   this condition evaluate this way?
3. **Trace backwards.** Set a breakpoint *before* the symptom, restart, and step
   forward to watch where the wrong state first appears.
4. **Repeat until you reach the origin.** Keep asking "why" until you hit a fundamental
   cause — usually where data enters the system, a config is read, or an assumption
   is first violated.

#### ⚠️ Warning signs you're stopping too early

- You found a `null` / `undefined` variable but didn't check why it's that way.
- You see an error but didn't trace where it originates.
- You identified "bad data" but didn't find why the data is bad.
- You found a failing condition but didn't check why it fails.

#### ✅ Signs you've found the root cause

- You can explain the complete chain from root cause → symptom.
- Fixing this one thing would prevent the symptom from occurring.
- The issue is at a fundamental level (data input, configuration, logic invariant).
- You understand not just *what* is wrong but *why* it's wrong.

---

## Practical examples

### Example 1 — Null variable
❌ **Symptom-only:** "The `user` object is null on line 45."
✅ **Root cause:** "`user` is null because `getUserById()` returned null because the DB
query failed because the connection string is incorrect in the configuration file."

**Investigation:**
1. `user` is null → set breakpoint in `getUserById()`.
2. `getUserById()` returns null → set breakpoint inside the function.
3. DB query fails → check connection parameters.
4. Connection string wrong → root cause identified.

### Example 2 — Function exits early
❌ **Symptom-only:** "`processOrder()` exits early due to invalid payment status."
✅ **Root cause:** "`processOrder()` exits early because payment validation fails when
the payment service doesn't receive the required `currency` field, which wasn't
included in the request due to a missing form field in the UI."

**Investigation:**
1. Function exits early → breakpoint at validation check.
2. Payment status invalid → debug payment validation logic.
3. `currency` missing → trace back to request formation.
4. UI form missing `currency` field → root cause identified.

### Example 3 — Unexpected value
❌ **Symptom-only:** "Calculation result is `NaN`."
✅ **Root cause:** "The result is `NaN` because one input is a string instead of a
number, because `parseFloat()` fails when the input contains currency symbols that
weren't stripped by the sanitization function."

**Investigation:**
1. Result is `NaN` → check input parameters.
2. Parameter is a string → find where conversion should happen.
3. `parseFloat()` fails → check what's being parsed.
4. Currency symbols not stripped → root cause identified.

---

## Root cause investigation checklist

Before ending the debug session, confirm you can answer:

- [ ] What is the immediate symptom?
- [ ] What function / code caused this symptom?
- [ ] What input or condition caused that function to behave incorrectly?
- [ ] Where did that input or condition originate?
- [ ] Can I trace this back further to a more fundamental cause?
- [ ] If I fix this root cause, will it prevent the symptom from occurring?

---

## Breakpoint strategy

- **Start broad, then narrow.** Begin at the entry point of the suspect function. As
  you isolate the issue, add tighter breakpoints around the problematic region.
- **Use line numbers.** `add_breakpoint` takes a 1-based `line`; re-check the line after
  edits since numbers shift when code changes.
- **Don't overuse breakpoints.** A handful of well-placed pauses beats dozens of noisy
  ones. After each session, `clear_all_breakpoints` to start fresh.
- **For test debugging,** pass `testName` to `start_debugging`. The server routes through
  VS Code's Testing API so test runners (`dotnet test`, `pytest`, `jest`, etc.) are
  driven correctly and the debugger attaches to the child test-host process.

---

## Tool-call patterns

### Investigating a bug in `calculate.py`
```text
add_breakpoint  fileFullPath=/repo/src/calculate.py  line=42
start_debugging fileFullPath=/repo/src/calculate.py  workingDirectory=/repo
# session pauses on the breakpoint
get_variables_values scope=local
evaluate_expression  expression="type(raw).__name__"
step_into
# … iterate until root cause found …
clear_all_breakpoints
```

### Debugging a single xUnit test in C#
```text
add_breakpoint  fileFullPath=C:\Repo\Calculator.Tests\CalculatorTests.cs  line=18
start_debugging fileFullPath=C:\Repo\Calculator.Tests\CalculatorTests.cs  workingDirectory=C:\Repo  testName=Add_ReturnsSum
# pauses inside the test
step_into
get_variables_values
```

### Verifying a fix without re-launching VS Code
```text
restart_debugging
# session restarts with the same configuration; breakpoints persist
continue_execution
```

---

## Language-specific guidance

Load the relevant reference file for the language you're debugging:

- **Python** → `references/troubleshooting/python.md`
- **JavaScript / TypeScript** → `references/troubleshooting/javascript.md`
- **Java** → `references/troubleshooting/java.md`
- **C#** → `references/troubleshooting/csharp.md`
- **C++** → `references/troubleshooting/cpp.md`
- **Go** → `references/troubleshooting/go.md`

Each reference covers prerequisites (which VS Code extension to install), framework-specific
configuration (e.g. enabling `pytest` test discovery, building `.NET` projects before
launch), and common pitfalls.

---

## Things to avoid

- ❌ **Speculating about runtime values when you could just inspect them.** That's what
  `get_variables_values` and `evaluate_expression` are for.
- ❌ **Calling `start_debugging` without first setting a breakpoint.** The program will
  run to completion and you'll learn nothing.
- ❌ **Stopping at the first wrong value you find.** That's a symptom. Trace it back.
- ❌ **Leaving breakpoints set across sessions.** Future runs will pause in unexpected
  places. Always `clear_all_breakpoints` when done.
- ❌ **Awaiting interactive input when the program reads stdin.** DebugMCP drives the
  VS Code debugger; if the program blocks on stdin, no tool call can unblock it. Pick
  a code path that doesn't require interactive input, or pre-supply input via the
  launch config / fixture.
