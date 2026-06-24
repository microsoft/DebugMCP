# Java Debugging Tips

☕ **JAVA-SPECIFIC GUIDANCE:**

## Prerequisites:
- Use Java Extension Pack (includes debugger)
- Ensure Java is compiled before debugging
- Set breakpoints in `.java` files
- Use 'java' debug configuration type
- Check JAVA_HOME environment variable

## Java-Specific Best Practices:
- **Compilation:** Ensure `.class` files are up-to-date with source code
- **Classpath:** Verify all dependencies are in the classpath
- **Main Method:** Set breakpoints inside the `main` method for entry point debugging
- **Exception Handling:** Use breakpoints in `catch` blocks to debug exceptions
- **Static vs Instance:** Be aware of static context when debugging

## Common Java Debug Configurations:
```json
{
    "type": "java",
    "request": "launch",
    "name": "Launch Current File",
    "mainClass": "${file}",
    "console": "integratedTerminal"
}
```

## Maven/Gradle Projects:
```json
{
    "type": "java",
    "request": "launch",
    "name": "Launch Main",
    "mainClass": "com.example.Main",
    "classPaths": ["${workspaceFolder}/target/classes"]
}
```

## Debugging Tips:
- Use `System.out.println()` for quick debugging
- Leverage IDE features like "Evaluate Expression"
- Watch for `NullPointerException` and array index issues
- Be aware of object references vs. primitive types
- Use conditional breakpoints for loops with many iterations
- Check for proper package declarations and imports

## Common Issues:
- **ClassNotFoundException:** Check classpath and package structure
- **NoSuchMethodError:** Ensure method signatures match between source and compiled code
- **OutOfMemoryError:** Monitor heap usage during debugging
