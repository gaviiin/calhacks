"""The constructors' prize ladder by season: what one place in the championship is worth.

    prize(2024, 8) -> cents        ladder(2024) -> {1: cents, ..., 10: cents}

Real payouts are confidential (Concorde Agreement). 2024 is The Race's reconstruction of the payments made in
2025 for the 2024 championship: 1st $132.9m, 5th $98.8m, 9th $65.5m, 10th $57.9m, about $8.5m a place
(https://www.the-race.com/formula-1/f1-2025-prize-money-split-revealed-mclaren-only-fourth/); the places it does
not name are interpolated between the named ones. 2026 (11 teams) is the synthetic Meridian ladder
(world/prize_table.json) extended by one step to 11th. Money paid in a year follows the previous year's finish.
"""

from __future__ import annotations

import json
from pathlib import Path

WORLD = Path(__file__).resolve().parents[1] / "world" / "prize_table.json"

PRESS_2024 = {1: 132.9, 5: 98.8, 9: 65.5, 10: 57.9}  # $m, The Race, 12 Mar 2025
SOURCES = {
    2024: "The Race, 12 Mar 2025 (estimates; Concorde terms are confidential); unnamed places interpolated",
    2026: "synthetic ladder (world/prize_table.json), 11th extrapolated",
}


def _interpolate(named: dict[int, float], places: int) -> dict[int, int]:
    keys = sorted(named)
    out: dict[int, int] = {}
    for p in range(1, places + 1):
        lo = max((k for k in keys if k <= p), default=keys[0])
        hi = min((k for k in keys if k >= p), default=keys[-1])
        v = named[lo] if lo == hi else named[lo] + (named[hi] - named[lo]) * (p - lo) / (hi - lo)
        out[p] = int(round(v * 1e6 * 100))
    return out


def ladder(year: int) -> dict[int, int]:
    if year <= 2025:
        return _interpolate(PRESS_2024, 10)
    table = {int(k): int(v) for k, v in json.loads(WORLD.read_text())["by_position"].items()}
    step = table[9] - table[10]
    table[11] = table[10] - step
    return table


def prize(year: int, position: int) -> int:
    t = ladder(year)
    return t[min(max(position, 1), max(t))]


def basis(year: int) -> str:
    return SOURCES[2024 if year <= 2025 else 2026]
