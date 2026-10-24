"""Exact money helpers. Amounts are integer cents; FX rates are Decimal (USD per unit)."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal


def to_usd(orig_cents: int, rate: Decimal | str) -> int:
    """Translate an amount in cents of a foreign currency to USD cents."""
    return int((Decimal(orig_cents) * Decimal(rate)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def prorate(total_cents: int, part: int, whole: int) -> int:
    """total * part / whole, rounded half up, exact for whole numbers of cents."""
    if whole <= 0:
        raise ValueError("whole must be positive")
    return int((Decimal(total_cents) * part / whole).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def fmt(cents: int, currency: str = "USD") -> str:
    sign = "-" if cents < 0 else ""
    symbol = {"USD": "$", "EUR": "€", "GBP": "£"}.get(currency, currency + " ")
    return f"{sign}{symbol}{abs(cents) / 100:,.2f}"
