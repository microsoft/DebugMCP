# Go Debugging Tips

**GO-SPECIFIC GUIDANCE:**

## Prerequisites:
- Use Go extension for VS Code (by Go Team at Google)
- Ensure Delve debugger is installed (`go install github.com/go-delve/delve/cmd/dlv@latest`)
- Set breakpoints in `.go` files
- Use 'go' debug configuration type
- Check GOPATH and GOROOT environment variables

## Go-Specific Best Practices:
- **Build Tags:** Ensure correct build tags are set for debugging
- **Goroutines:** Be aware that goroutines run concurrently - use breakpoints in each goroutine you want to inspect
- **Interfaces:** When debugging interface values, check both the type and value
- **Defer Statements:** Remember deferred functions execute in LIFO order at function return
- **Channels:** Set breakpoints at channel send/receive operations to debug concurrency

## Common Go Debug Configurations:
```json
{
    "type": "go",
    "request": "launch",
    "name": "Launch Package",
    "mode": "debug",
    "program": "${fileDirname}"
}
```

## Test Debugging:
```json
{
    "type": "go",
    "request": "launch",
    "name": "Launch Test",
    "mode": "test",
    "program": "${fileDirname}",
    "args": ["-test.run", "TestFunctionName"]
}
```

## Debugging Tips:
- Use `fmt.Printf()` or `log.Printf()` for quick debugging
- Watch for `nil` pointer dereferences
- Be aware of value vs pointer receivers on methods
- Check error return values - Go's explicit error handling is a common source of bugs
- Use race detector (`go run -race`) to find data races before debugging

## Common Issues:
- **"could not launch process":** Ensure Delve is installed and in PATH
- **Breakpoints not hit:** Check build mode (debug vs release) and ensure optimizations are disabled
- **Goroutine confusion:** Use the Call Stack panel to switch between goroutines
