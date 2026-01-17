# JavaScript Debugging Tips

🟨 **JAVASCRIPT-SPECIFIC GUIDANCE:**

## Prerequisites:
- Use Node.js debugger for server-side JS
- Use browser debugger for client-side JS
- Set breakpoints in `.js`, `.ts`, `.jsx`, `.tsx` files
- Use 'pwa-node' debug configuration type
- Check that Node.js is installed

## JavaScript-Specific Best Practices:
- **Async/Await:** Be careful with asynchronous code - breakpoints in async functions
- **Callbacks:** Set breakpoints inside callback functions to debug async operations
- **Closures:** Watch for variable scope issues in nested functions
- **Event Handlers:** Debug event-driven code by setting breakpoints in handlers
- **Promises:** Use breakpoints in `.then()` and `.catch()` blocks

## Common JavaScript Debug Configurations:
```json
{
    "type": "pwa-node",
    "request": "launch",
    "name": "Launch Program",
    "program": "${file}",
    "console": "integratedTerminal"
}
```

## Browser Debugging:
```json
{
    "type": "pwa-chrome",
    "request": "launch",
    "name": "Launch Chrome",
    "url": "http://localhost:3000",
    "webRoot": "${workspaceFolder}"
}
```

## Debugging Tips:
- Use `console.log()`, `console.error()`, `console.table()` for quick debugging
- Leverage browser developer tools for client-side debugging
- Watch for `undefined` and `null` values
- Be aware of hoisting and variable scope rules
- Use source maps for debugging transpiled code (TypeScript, Babel)
