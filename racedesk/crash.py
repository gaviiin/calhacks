"""When a car crashes, the finance desk books the damage against the cost cap and re-runs the season forecast.

Only for 2026, the season capsim models (Section D Issue 08). Damage is an estimate by kind of incident:
crash repairs are Relevant Costs. A power unit failure is different: Power Unit Supply Perimeter costs are
Excluded Costs up to the regulated price (D5.1.1.n), so it does not use cap.
"""

from __future__ import annotations

from capsim.assumptions import Assumptions
from capsim.plan import Plan, actuals
from capsim.sim import Scenario, forecast

HEAVY = {"Accident", "Collision", "Spun off"}
LIGHT = {"Collision damage", "Damage", "Puncture"}
PU = {"Engine", "Power loss", "Power Unit", "ERS", "Turbo", "MGU-K", "Energy store", "Overheating", "Water pressure"}
ESTIMATE = {"heavy": 900_000, "light": 200_000}  # USD; heavy follows Vowles: "If a wheel hits the wall, you can almost certainly expect a million"


def cap_note(status: str) -> str | None:
    if status in PU:
        return "Power unit failure: PU supply costs are excluded from the cap up to the regulated price (D5.1.1.n), so no cap cost."
    return None


def cost_cap_hook(year: int, race: dict, car: int, status: str, runs: int = 1500) -> dict | None:
    if status not in HEAVY | LIGHT:
        return None
    damage = ESTIMATE["heavy" if status in HEAVY else "light"]
    if year != 2026:  # the season forecast models the 2026 rules only; still book the damage estimate
        return {"damage_estimate": damage, "text": f"Damage estimate ${damage / 1e6:.1f}m against the cost cap (repairs are Relevant Costs)."}
    month = int(race["date"][5:7])
    as_of = max(1, month - 1)
    plan = Plan()
    act = actuals(plan, as_of)
    a = Assumptions(runs=runs)
    before = forecast(plan, Scenario(as_of, act, set(), label="before"), a)
    after = forecast(plan, Scenario(as_of, act, set(), extra_spend={month: damage}, label="after"), a)
    with_u5 = forecast(plan, Scenario(as_of, act, {"U5"}, extra_spend={month: damage}, label="after+U5"), a)
    p0, p1, p5 = (x["probability"]["breach"] for x in (before, after, with_u5))
    text = (f"Damage estimate ${damage / 1e6:.1f}m against the cost cap (repairs are Relevant Costs). Season breach risk "
            f"{p0:.0%} -> {p1:.0%}; with the planned final package it would be {p5:.0%}.")
    return {"damage_estimate": damage, "month": month, "p_breach_before": p0, "p_breach_after": p1, "p_breach_after_with_final_package": p5,
            "median_after": after["relevant_costs"]["p50"], "cap": after["cap"], "text": text}
