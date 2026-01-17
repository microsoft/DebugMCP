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

## Debugging Tips:
- Use `print()` statements for quick debugging
- Leverage Python's `pdb` module for command-line debugging
- Watch for `None` values and type mismatches
- Check indentation issues that might affect code flow
