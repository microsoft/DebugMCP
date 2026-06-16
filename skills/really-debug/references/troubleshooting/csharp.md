# C# Debugging Tips

## Overview
DebugMCP provides enhanced support for debugging C# applications using the C# Dev Kit. This guide covers configuration options and best practices for C# debugging.

## Supported C# Project Types

### Console Applications
- **File Extension**: `.cs`
- **Debug Type**: `coreclr`
- **Requirements**: C# Dev Kit extension installed

### Unit Test Projects
- **Test Frameworks**: MSTest, NUnit, xUnit
- **File Patterns**: `*.test.cs`, `*Test.cs`, `*Tests.cs`
- **Debug Strategy**: Uses `dotnet test` with filtering

### Web Applications
- **Project Types**: ASP.NET Core, Blazor
- **Debug Type**: `coreclr`
- **Additional Configuration**: May require specific launch settings

## Best Practices

### Project Setup
1. Ensure C# Dev Kit extension is installed
2. Open projects at the solution or project root level
3. Use standard .NET project structures

### Debugging Configuration
1. Place launch.json in `.vscode` directory for custom configurations
2. Use descriptive configuration names
3. Set appropriate working directories

### Breakpoint Management
1. Use line content matching for reliable breakpoint placement
2. Clear breakpoints when stopping debug sessions
3. Verify breakpoints are hit in the expected files

## Troubleshooting

### Common Issues

#### Debugger Won't Start
- **Cause**: Missing C# Dev Kit extension
- **Solution**: Install the C# Dev Kit extension from VS Code marketplace

#### Breakpoints Not Hit
- **Cause**: Debug symbols not generated or path mismatch
- **Solution**: Ensure project builds in Debug mode and paths are correct

#### Test Discovery Issues  
- **Cause**: Test framework not properly configured
- **Solution**: Verify test project references and naming conventions

### Performance Optimization
- Use filtered test execution for large test suites
- Configure appropriate timeout values
- Limit scope of variable inspection during debugging

## Advanced Features

### Expression Evaluation
DebugMCP supports evaluating C# expressions during debugging:
- Property access: `myObject.Property`
- Method calls: `myObject.Method()`
- LINQ expressions: `list.Where(x => x > 5)`
- Object instantiation: `new List<int>()`

### Variable Scope Management
- **Local Variables**: Current method scope
- **Global Variables**: Static members and fields
- **All Scope**: Complete variable context

### Test Method Filtering
When running specific test methods:
- Use exact method names for precision
- Supports pattern matching with `Name~` filter
- Works with parameterized tests

## Integration with C# Dev Kit

### Enhanced Features
- IntelliSense during debugging
- Advanced breakpoint types
- Call stack navigation
- Exception handling configuration

### Project Templates
DebugMCP works seamlessly with C# Dev Kit project templates:
- Console applications
- Class libraries  
- Test projects
- Web applications

## External Project Support

### Opening C# Projects Outside Workspace
DebugMCP can debug C# files that are part of external projects:
1. Specify the full path to the C# source file
2. Set appropriate working directory
3. Use custom launch configurations if needed

### Multi-Project Solutions
For solutions with multiple projects:
1. Configure debugging at the solution level
2. Use project-specific launch configurations
3. Set breakpoints across multiple projects as needed
