"""Stage 6, re-plan (cap): year-end relevant costs, the chance of an overspend, and what must move. STUB.

    forecast(state) -> dict
"""

from __future__ import annotations


def forecast(state) -> dict:
    return {}


# ---------------------------------------------------------------------- interface the other stages read
# race/effects.py (cap headroom) and race/ledger.py call these; this module owns the numbers and their sources.

def cap_level_cents(year: int) -> int:
    """The cost cap for a year, in USD cents. STUB: 2026 Section D D4.1.2 is $215m; 2024 to be settled with a citation."""
    return 215_000_000 * 100 if year >= 2026 else 135_000_000 * 100


def relevant_before_cents(state) -> int:
    """Relevant costs booked this cap year before the weekend started (an assumption, with its basis). STUB: 0."""
    return 0
