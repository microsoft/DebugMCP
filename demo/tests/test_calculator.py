# Copyright (c) Microsoft Corporation.

"""
Tests for the calculator module.
Run with: python -m pytest demo/tests/test_calculator.py -v
"""

import pytest
from demo.calculator import (
    add,
    subtract,
    multiply,
    divide,
    factorial,
    fibonacci,
    is_prime,
)


class TestBasicOperations:
    """Tests for basic arithmetic operations."""

    def test_add_positive_numbers(self):
        """Test adding two positive numbers."""
        result = add(5, 3)
        assert result == 8

    def test_add_negative_numbers(self):
        """Test adding negative numbers."""
        result = add(-5, -3)
        assert result == -8

    def test_subtract(self):
        """Test subtraction."""
        result = subtract(10, 4)
        assert result == 6

    def test_multiply(self):
        """Test multiplication."""
        result = multiply(6, 7)
        assert result == 42

    def test_divide(self):
        """Test division."""
        result = divide(20, 4)
        assert result == 5.0

    def test_divide_by_zero(self):
        """Test that dividing by zero raises an error."""
        with pytest.raises(ValueError, match="Cannot divide by zero"):
            divide(10, 0)


class TestFactorial:
    """Tests for the factorial function."""

    def test_factorial_zero(self):
        """Test factorial of 0."""
        assert factorial(0) == 1

    def test_factorial_one(self):
        """Test factorial of 1."""
        assert factorial(1) == 1

    def test_factorial_five(self):
        """Test factorial of 5."""
        # 5! = 5 * 4 * 3 * 2 * 1 = 120
        result = factorial(5)
        assert result == 120

    def test_factorial_negative(self):
        """Test that negative input raises an error."""
        with pytest.raises(ValueError):
            factorial(-1)


class TestFibonacci:
    """Tests for the Fibonacci function."""

    def test_fibonacci_zero(self):
        """Test Fibonacci with n=0."""
        assert fibonacci(0) == []

    def test_fibonacci_one(self):
        """Test Fibonacci with n=1."""
        assert fibonacci(1) == [0]

    def test_fibonacci_ten(self):
        """Test first 10 Fibonacci numbers."""
        expected = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
        result = fibonacci(10)
        assert result == expected


class TestIsPrime:
    """Tests for the is_prime function."""

    def test_is_prime_two(self):
        """Test that 2 is prime."""
        assert is_prime(2) is True

    def test_is_prime_seventeen(self):
        """Test that 17 is prime."""
        assert is_prime(17) is True

    def test_is_not_prime_four(self):
        """Test that 4 is not prime."""
        assert is_prime(4) is False

    def test_is_not_prime_one(self):
        """Test that 1 is not prime."""
        assert is_prime(1) is False

    def test_is_not_prime_negative(self):
        """Test that negative numbers are not prime."""
        assert is_prime(-5) is False


# A test that's good for stepping through - HAS A BUG!
def test_complex_calculation():
    """
    A more complex test that's good for debugging step-by-step.
    Calculates: sum of factorials of first 5 Fibonacci numbers.

    BUG: Uses fibonacci(4) instead of fibonacci(5), causing wrong result.
    """
    # Get first 5 Fibonacci numbers: [0, 1, 1, 2, 3]
    fib_numbers = fibonacci(5)

    # Calculate factorial of each
    factorials = []
    for num in fib_numbers:
        fact = factorial(num)
        factorials.append(fact)

    # Sum them up
    total = 0
    for f in factorials:
        total = add(total, f)

    # Expected: 0! + 1! + 1! + 2! + 3! = 1 + 1 + 1 + 2 + 6 = 11
    # But we get: 0! + 1! + 1! + 2! = 1 + 1 + 1 + 2 = 5
    assert total == 11, f"Expected 11 but got {total}"
