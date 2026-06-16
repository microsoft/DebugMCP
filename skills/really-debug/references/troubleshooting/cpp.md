# C/C++ Debugging Tips

**C/C++-SPECIFIC GUIDANCE:**

## Prerequisites:
- Use C/C++ extension for VS Code (by Microsoft)
- Ensure GDB or LLDB debugger is installed
- Compile with debug symbols (`-g` flag)
- Set breakpoints in `.c`, `.cpp`, `.cc`, `.h`, `.hpp` files
- Use 'cppdbg' debug configuration type

## C/C++-Specific Best Practices:
- **Compilation:** Always compile with `-g` flag and disable optimizations (`-O0`) for debugging
- **Memory Issues:** Watch for buffer overflows, memory leaks, and dangling pointers
- **Pointers:** Carefully inspect pointer values and dereferenced contents
- **Stack Frames:** Use call stack to trace function calls and local variables
- **Core Dumps:** Enable core dumps for post-mortem debugging of crashes

## Common C++ Debug Configurations:

### GDB (Linux/Windows with MinGW):
```json
{
    "type": "cppdbg",
    "request": "launch",
    "name": "Debug with GDB",
    "program": "${fileDirname}/${fileBasenameNoExtension}",
    "args": [],
    "stopAtEntry": false,
    "cwd": "${fileDirname}",
    "environment": [],
    "externalConsole": false,
    "MIMode": "gdb",
    "setupCommands": [
        {
            "description": "Enable pretty-printing for gdb",
            "text": "-enable-pretty-printing",
            "ignoreFailures": true
        }
    ]
}
```

### LLDB (macOS):
```json
{
    "type": "cppdbg",
    "request": "launch",
    "name": "Debug with LLDB",
    "program": "${fileDirname}/${fileBasenameNoExtension}",
    "args": [],
    "stopAtEntry": false,
    "cwd": "${fileDirname}",
    "environment": [],
    "externalConsole": false,
    "MIMode": "lldb"
}
```

## Debugging Tips:
- Use `printf()` or `std::cout` for quick debugging
- Watch for uninitialized variables
- Check array bounds carefully
- Be aware of undefined behavior from pointer arithmetic
- Use address sanitizer (`-fsanitize=address`) to detect memory errors
- Use valgrind for memory leak detection (Linux)

## Common Issues:
- **"Unable to start debugging":** Ensure executable is compiled with debug symbols
- **"No symbol table":** Recompile with `-g` flag
- **Breakpoints grayed out:** Source file doesn't match compiled binary - rebuild
- **Segmentation fault:** Use backtrace to find the crashing line, check pointer operations
- **Optimized away variables:** Compile with `-O0` to disable optimizations

## Memory Debugging:
- **Valgrind:** `valgrind --leak-check=full ./program`
- **Address Sanitizer:** Compile with `-fsanitize=address -fno-omit-frame-pointer`
- **Watch expressions:** Monitor pointer values and array indices during stepping
