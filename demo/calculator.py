# Copyright (c) Microsoft Corporation.

"""
Simple calculator module for demonstrating DebugMCP.
"""


def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b


def subtract(a: int, b: int) -> int:
    """Subtract b from a."""
    return a - b


def multiply(a: int, b: int) -> int:
    """Multiply two numbers."""
    return a * b


def divide(a: int, b: int) -> float:
    """Divide a by b."""
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b


def factorial(n: int) -> int:
    """Calculate factorial of n (with a bug for demo purposes)."""
    if n < 0:
        raise ValueError("Factorial not defined for negative numbers")
    if n <= 1:
        return 1

    result = 1
    for i in range(2, n + 1):
        result *= i
    return result


def fibonacci(n: int) -> list[int]:
    """Return first n Fibonacci numbers."""
    if n <= 0:
        return []
    if n == 1:
        return [0]

    fib = [0, 1]
    for i in range(2, n):
        fib.append(fib[i - 1] + fib[i - 2])
    return fib


def is_prime(n: int) -> bool:
    """Check if n is a prime number."""
    if n < 2:
        return False
    if n == 2:
        return True
    if n % 2 == 0:
        return False

    for i in range(3, int(n**0.5) + 1, 2):
        if n % i == 0:
            return False
    return True


if __name__ == "__main__":
    # Quick demo
    print(f"5 + 3 = {add(5, 3)}")
    print(f"10 - 4 = {subtract(10, 4)}")
    print(f"6 * 7 = {multiply(6, 7)}")
    print(f"20 / 4 = {divide(20, 4)}")
    print(f"5! = {factorial(5)}")
    print(f"First 10 Fibonacci: {fibonacci(10)}")
    print(f"Is 17 prime? {is_prime(17)}")
