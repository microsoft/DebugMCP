# Python Debugging Tips

🐍 **PYTHON-SPECIFIC GUIDANCE:**

## Prerequisites:
- Use Python debugger extension (Python extension by Microsoft)
- Set breakpoints inside function bodies
- Check virtual environment activation
- Use 'python' debug configuration type
- Common file extensions: `.py`

## Python-Specific Best Practices:
- **Virtual Environment:** Ensure the correct Python interpreter is selected
- **Module Imports:** Set breakpoints after import statements to debug module loading
- **Exception Handling:** Use breakpoints in `except` blocks to catch errors
- **List Comprehensions:** Break complex comprehensions into regular loops for easier debugging
- **Decorators:** Be aware that decorators can affect breakpoint placement

## Common Python Debug Configurations:
```json
{
    "type": "python",
    "request": "launch",
    "name": "Python: Current File",
    "program": "${file}",
    "console": "integratedTerminal"
}
```

## Debugging a Specific Test (pytest / unittest):

DebugMCP dispatches single-test debugging through VS Code's Test Explorer, which requires the Python extension to have **discovered** the test. If discovery hasn't run, `start_debugging` with a `testName` will appear to do nothing (the file opens, the cursor jumps to the test, but no debug session starts).

Discovery requires the test framework to be enabled in workspace settings. Add **one** of the following to `.vscode/settings.json`:

```jsonc
// For pytest:
{
    "python.testing.pytestEnabled": true
}

// For unittest:
{
    "python.testing.unittestEnabled": true,
    "python.testing.unittestArgs": ["-v", "-s", ".", "-p", "test_*.py"]
}
```

Alternatively, run **"Python: Configure Tests"** from the VS Code command palette once — it will write the appropriate settings for you.

Verify discovery worked by opening the Testing view (beaker icon in the sidebar): your tests should appear in the tree. If the tree is empty, the framework isn't configured correctly.

## Debugging Tips:
- Use `print()` statements for quick debugging
- Leverage Python's `pdb` module for command-line debugging
- Watch for `None` values and type mismatches
- Check indentation issues that might affect code flow
