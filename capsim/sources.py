"""Where spend to date comes from.

- "meridian": Meridian's own illustrative 2026 actuals (capsim.plan.EVENTS_2026 on top of the plan).
- "cost_cap_desk": the Cost Cap Desk seat's classified ledger. Its world generator writes truth_2026.csv,
  one row per GL line with the 2026 Relevant Costs in USD cents (relevant_usd_minor) and its period (YYYY-MM).
  The remaining months then follow Meridian's plan scaled to that team's actual run rate, so a smaller or
  bigger team is forecast at its own size. Set COST_CAP_DESK_OUT to the directory (default world/out).
"""

from __future__ import annotations

import csv
import os
from dataclasses import replace
from pathlib import Path

from .plan import Plan, actuals

REPO = Path(__file__).resolve().parent.parent


def truth_path() -> Path:
    return Path(os.environ.get("COST_CAP_DESK_OUT", REPO / "world" / "out")) / "truth_2026.csv"


def cost_cap_desk_actuals(through_month: int, path: Path | None = None) -> dict[int, int]:
    path = Path(path or truth_path())
    if not path.exists():
        raise FileNotFoundError(f"{path.name} not found (set COST_CAP_DESK_OUT, or run the Cost Cap Desk world generator: "
                                "python -m world.generate --out world/out)")
    cents: dict[int, int] = {}
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            year, month = row["period_key"].split("-")
            if int(year) != 2026 or int(month) > through_month:
                continue
            cents[int(month)] = cents.get(int(month), 0) + int(row["relevant_usd_minor"] or 0)
    missing = [m for m in range(1, through_month + 1) if m not in cents]
    if missing:
        raise ValueError(f"truth_2026.csv has no Relevant Costs for month(s) {missing}")
    return {m: round(c / 100) for m, c in sorted(cents.items())}


def scaled_plan(plan: Plan, actual: dict[int, int]) -> tuple[Plan, float]:
    """Meridian's plan scaled so its months to date match the team's actuals (upgrades and crash reserve unscaled)."""
    budget = sum(plan.month_budget(m, with_crash_reserve=False) - sum(u.cost for u in plan.upgrades_in(m)) for m in actual)
    spent = sum(actual.values())
    k = spent / budget if budget else 1.0

    def s(x: int) -> int:
        return round(x * k)

    return replace(plan, payroll_month=s(plan.payroll_month), depreciation_month=s(plan.depreciation_month),
                   overheads_month=s(plan.overheads_month), other_month=s(plan.other_month), sea_freight_month=s(plan.sea_freight_month),
                   manufacturing={m: s(v) for m, v in plan.manufacturing.items()}, aero_year=s(plan.aero_year), race_ops=s(plan.race_ops),
                   freight_flyaway=s(plan.freight_flyaway), freight_europe=s(plan.freight_europe)), k


def load(source: str, through_month: int, plan: Plan | None = None, path: Path | None = None) -> tuple[Plan, dict[int, int], dict]:
    plan = plan or Plan()
    if source == "meridian":
        return plan, actuals(plan, through_month), {"source": "meridian", "note": "illustrative Meridian Racing 2026 actuals"}
    if source == "cost_cap_desk":
        act = cost_cap_desk_actuals(through_month, path)
        p, k = scaled_plan(plan, act)
        return p, act, {"source": "cost_cap_desk", "file": str(path or truth_path()), "run_rate_vs_meridian_plan": round(k, 4),
                        "note": "actuals from the Cost Cap Desk seat's classified ledger; remaining months at that team's run rate "
                                "(the upgrade programme still to come is Meridian's)"}
    raise ValueError("source is meridian or cost_cap_desk")
