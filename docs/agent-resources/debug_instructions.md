# DebugMCP - Debugging Instructions Guide

⚠️  **CRITICAL INSTRUCTIONS - FOLLOW THESE STEPS:**
1. **FIRST:** Use 'add_breakpoint' to set an initial breakpoint at a starting point
2. **THEN:** Optionally use 'add_breakpoint' to set breakpoints at strategic points
3. **THEN:** Use 'start_debugging' tool to start debugging
4. **THEN:** Use repetitively all the other tools to navigate and inspect step by step
5. **FINALLY:** Get to the problematic line to fully understand the root cause. If needed, restart the debug session using restart_debugging.

## 🚨 ROOT CAUSE ANALYSIS - CRITICAL FRAMEWORK

### **NEVER STOP AT SYMPTOMS - ALWAYS FIND THE ROOT CAUSE**

When you encounter an issue during debugging (e.g., null variable, unexpected value, error), you MUST apply this systematic approach:

#### **SYMPTOM vs ROOT CAUSE - Key Distinction:**
- **SYMPTOM:** What you observe is wrong (e.g., "variable X is null")  
- **ROOT CAUSE:** WHY the symptom occurred (e.g., "variable X is null because function Y failed to initialize it due to missing parameter Z")

#### **ROOT CAUSE INVESTIGATION PROCESS:**

1. **IDENTIFY THE SYMPTOM**
   - What exactly is wrong? (null value, wrong type, unexpected behavior)
   - Record the current line and variable state

2. **ASK THE CRITICAL QUESTION: "WHY?" e.g**
   - Why is this variable null/undefined/wrong?
   - Why did this function return an unexpected value?
   - Why did this condition evaluate incorrectly?

3. **TRACE BACKWARDS TO THE SOURCE**
   - Set breakpoint at the problematic point
   - Restart the session to step in it.

4. **CONTINUE UNTIL YOU FIND THE ORIGIN**
   - Keep asking "why" until you reach the original source of the problem
   - The root cause is typically where data enters the system incorrectly or where a fundamental assumption is violated

#### **⚠️ WARNING SIGNS YOU'RE STOPPING TOO EARLY:**
- You found a null/undefined variable but didn't check why it's null
- You see an error but didn't trace where the error originates
- You identify "bad data" but didn't find why the data is bad
- You found a failed condition but didn't check why it fails

#### **✅ SIGNS YOU'VE FOUND THE ROOT CAUSE:**
- You can explain the COMPLETE chain from root cause to symptom
- Fixing this issue would prevent the symptom from occurring
- The issue is at a fundamental level (data input, configuration, logic error)
- You understand not just WHAT is wrong, but WHY it's wrong

### **🔍 PRACTICAL EXAMPLES - SYMPTOM vs ROOT CAUSE**

#### **Example 1: Null Variable**
❌ **STOPPING AT SYMPTOM:** "The user object is null on line 45"  
✅ **FINDING ROOT CAUSE:** "The user object is null because the getUserById() function returned null, which happened because the database query failed due to an incorrect connection string in the configuration file"

**Investigation Steps:**
1. Found user object is null → Set breakpoint in getUserById()
2. Found getUserById() returns null → Set breakpoint inside the function
3. Found database query fails → Check connection parameters
4. Found incorrect connection string → ROOT CAUSE IDENTIFIED

#### **Example 2: Function Exits Early**
❌ **STOPPING AT SYMPTOM:** "The processOrder() function exits early due to invalid payment status"  
✅ **FINDING ROOT CAUSE:** "The processOrder() function exits early because the payment validation fails when the payment service doesn't receive the required 'currency' field, which wasn't included in the request due to a missing form field in the UI"

**Investigation Steps:**
1. Function exits early → Set breakpoint at validation check
2. Payment status is invalid → Debug payment validation logic
3. Currency field is missing → Trace back to request formation
4. UI form missing currency field → ROOT CAUSE IDENTIFIED

#### **Example 3: Unexpected Value**
❌ **STOPPING AT SYMPTOM:** "The calculation result is NaN"  
✅ **FINDING ROOT CAUSE:** "The calculation result is NaN because one of the input parameters contains a string instead of a number, which occurs because the parseFloat() conversion fails when the input data contains currency symbols that weren't stripped by the data sanitization function"

**Investigation Steps:**
1. Result is NaN → Check input parameters
2. Parameter contains string → Find where conversion should happen
3. parseFloat() fails → Check what's being parsed
4. Currency symbols not stripped → ROOT CAUSE IDENTIFIED

#### **🎯 ROOT CAUSE INVESTIGATION CHECKLIST**

Before stopping your debug session, ensure you can answer:

- [ ] What is the immediate symptom?
- [ ] What function/code caused this symptom?
- [ ] What input/condition caused that function to behave incorrectly?
- [ ] Where did that incorrect input/condition originate?
- [ ] Can I trace this back further to a more fundamental cause?
- [ ] If I fix this root cause, will it prevent the symptom from occurring?

## 📋 DETAILED INSTRUCTIONS:
- **Before debugging:** Set at least one breakpoint in a starting point of the code. Optionally add more breakpoints in points you found as strategic points.
- **Start debugging:** Launch the debug session with proper configuration (the program will immediately start on the first breakpoint)
- **During debugging:**
    - **Navigate:** Use stepping commands and continue command to move through code execution
    - **Inspect:** Check variables and evaluate expressions when needed
- **Root Cause Investigation:** If you encounter any issue - DON'T SPECULATE! Apply the systematic root cause analysis:
    1. Identify if what you found is a symptom or root cause
    2. If it's a symptom, set breakpoints to trace backwards to the source
    3. Restart the debug session to investigate the deeper cause
    4. Continue until you find the root cause

## Breakpoint Strategy Guide

🎯 **BREAKPOINT STRATEGY:**
- Set breakpoints inside the function body and not on the signature or definition line itself (e.g "def" in python)
- Place breakpoints only on executable lines (avoid comments, empty lines)
- Set breakpoints before loops or conditionals  
- Set breakpoints at variable assignments you want to inspect
- Set breakpoints at error-prone areas
- Set breakpoints at the start of functions to inspect parameters
- Use conditional breakpoints for loops that iterate many times
- Set breakpoints before and after critical operations

## Common Patterns:
❌ **COMMON MISTAKE:** Starting debugging without breakpoints
✅ **BEST PRACTICE:** Always set an initial breakpoint before starting debugging
❌ **COMMON MISTAKE:** Set breakpoint in a method signature/definition line like 'def func()'
✅ **BEST PRACTICE:** Set breakpoint in the method body
❌ **COMMON MISTAKE:** Set breakpoint on commented line e.g '//', '#' and ect.
✅ **BEST PRACTICE:** Set breakpoint only on executable lines.
❌ **COMMON MISTAKE:** Step over the problematic line without fully understanding why the issue occured.
✅ **BEST PRACTICE:** Stop the session, set breakpoint in the problematic line and restart the session.

## 🧹 CLEANUP AFTER ROOT CAUSE VERIFICATION

Once you have:
- ✅ Identified the ROOT CAUSE (not just the symptom)
- ✅ Verified your understanding by tracing the complete chain
- ✅ Confirmed the fix addresses the root cause

Use clean all breakpoints before concluding your debugging session. This ensures a clean slate for the next debugging task.
