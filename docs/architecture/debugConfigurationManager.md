# DebugConfigurationManager

## Purpose

Manages debug launch configurations - reading from `launch.json`, creating default configurations, and supporting test-specific debugging across multiple languages and test frameworks.

## Motivation

Different languages and test frameworks require different debug configurations. Rather than forcing AI agents to understand these details, `DebugConfigurationManager` auto-detects the appropriate configuration based on file extension and test framework conventions.

## Responsibility

- Read and parse `.vscode/launch.json` configurations
- Prompt users to select from available configurations
- Create default configurations when none exist
- Detect programming language from file extensions
- Generate test-specific configurations for various frameworks
- Validate workspace setup for debugging

## Key Concepts

### Configuration Sources

1. **User's launch.json**: Preferred if available
2. **Default Configuration**: Auto-generated based on file extension
3. **Test Configuration**: Special handling for unit test files

### Language Detection

Maps file extensions to debug types:
- `.py` → `python`
- `.js/.ts/.jsx/.tsx` → `node` (pwa-node)
- `.java` → `java`
- `.cs` → `coreclr`
- `.cpp/.cc/.c` → `cppdbg`
- `.go` → `go`
- `.rs` → `lldb`
- `.php` → `php`
- `.rb` → `ruby`

### Test Framework Support

| Language | Frameworks |
|----------|------------|
| Python | unittest |
| Node.js | Jest, Mocha (auto-detected) |
| Java | JUnit |
| .NET | xUnit, NUnit, MSTest |

### User Prompt Flow

When starting debugging, users are prompted to:
1. Select from existing launch.json configurations, OR
2. Use "Default Configuration" (auto-detected)

## Key Code Locations

- Class definition: `src/utils/debugConfigurationManager.ts`
- Interface: `IDebugConfigurationManager`
- Default configs: `createDefaultDebugConfig()`
- Test configs: `createTestDebugConfig()`
- Language detection: `detectLanguageFromFilePath()`
- User prompt: `promptForConfiguration()`

## JSON Parsing

Handles common launch.json quirks:
- Strips comments (`//` and `/* */`)
- Removes trailing commas before `}` or `]`

## Python Test Name Formatting

For Python tests, the manager auto-detects the class name from the test file to build the full test path (`module.ClassName.test_method`). This allows AI agents to specify just the test method name.
