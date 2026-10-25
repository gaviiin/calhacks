"""Monte Carlo forecast of a season's Relevant Costs: closed months are fact, the rest is simulated.

    actuals (booked)  +  simulated remaining months  -  downward adjustments  =  year-end Relevant Costs

Simulated per remaining month: payroll and other fixed costs (small noise), manufacturing and aero (plan),
per race: operations, freight (noise) and crash damage (Poisson count x severity mixture), and every
upgrade package still to land (overrun lognormal). Proposed packages are included only when a scenario
says so. Results are classified with the regulations (capsim.regulations), never with assumptions.
"""

from __future__ import annotations

import math
import random
import statistics
from dataclasses import dataclass

from . import regulations as R
from .assumptions import Assumptions
from .plan import Plan


@dataclass
class Scenario:
    as_of_month: int  # last closed month (actuals through the end of it)
    actuals: dict[int, int]  # month -> booked Relevant Costs
    include: set[str]  # proposed upgrades to include
    pu_integration_2026: int = R.PU_INTEGRATION_DEFAULT_2026  # share of the mandatory D6.1.1.q.i USD 3m in 2026 (1.5m if undeclared)
    tyre_test_days: int = 0
    tyre_day_amount: int | None = None
    extra_spend: dict[int, int] | None = None  # month -> USD, any other change to test (positive = more spend)
    label: str = "baseline"


def poisson(rng: random.Random, lam: float) -> int:
    # Knuth; lam is small (< 5) here
    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


def crash_damage(rng: random.Random, a: Assumptions) -> float:
    total = 0.0
    for _ in range(poisson(rng, a.crash.incidents_per_race)):
        u, acc = rng.random(), 0.0
        for share, median, logsd in a.crash.severity:
            acc += share
            if u <= acc:
                total += median * math.exp(rng.gauss(0, logsd))
                break
    return total


def one_run(plan: Plan, sc: Scenario, a: Assumptions, i: int) -> dict:
    """Run i. Every random stream is keyed by (seed, run, what), so two scenarios that differ only in a decision
    see exactly the same crashes, overruns and noise: the difference between them is the decision alone."""
    s = a.spend
    rng = random.Random(f"{a.seed}|{i}|base")
    remaining = 0.0
    crash = 0.0
    upgrades = 0.0
    for m in range(sc.as_of_month + 1, 13):
        remaining += plan.payroll_month * (1 + rng.gauss(0, s.payroll_monthly_sd))
        remaining += (plan.other_month + plan.overheads_month) * (1 + rng.gauss(0, s.other_monthly_sd))
        remaining += plan.depreciation_month + plan.sea_freight_month + plan.manufacturing.get(m, 0) + plan.aero(m)
        for race in plan.races_in(m):
            remaining += plan.race_ops * (1 + rng.gauss(0, 0.05))
            remaining += plan.freight(race) * (1 + rng.gauss(0, s.freight_per_race_sd))
            c = crash_damage(rng, a)
            crash += c
        for u in plan.upgrades_in(m, sc.include):
            urng = random.Random(f"{a.seed}|{i}|upgrade|{u.key}")
            upgrades += u.cost * math.exp(urng.gauss(math.log(1 + s.upgrade_overrun_bias), s.upgrade_overrun_logsd))
        remaining += (sc.extra_spend or {}).get(m, 0)
    total = sum(sc.actuals.values()) + remaining + crash + upgrades
    return {"total": total, "crash": crash, "upgrades": upgrades}


def pct(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    i = min(len(xs) - 1, max(0, int(round(q * (len(xs) - 1)))))
    return xs[i]


def forecast(plan: Plan, sc: Scenario, a: Assumptions | None = None, keep_runs: bool = False) -> dict:
    a = a or Assumptions()
    year = plan.season
    cap = R.cost_cap(year, len(plan.calendar))
    adj = R.adjustments(year, sum(r.sprint for r in plan.calendar), sc.tyre_test_days, sc.tyre_day_amount, sc.pu_integration_2026)
    runs = [one_run(plan, sc, a, i) for i in range(a.runs)]
    relevant = [round(r["total"]) - adj.total for r in runs]
    cats = [R.classify(year, x, cap).category for x in relevant]
    n = len(relevant)
    material_line = R.classify(year, cap, cap).material_line
    out = {
        "label": sc.label, "season": year, "as_of_month": sc.as_of_month, "runs": n,
        "cap": cap, "material_line": material_line, "rule_set": R.rules_for(year).rule_set,
        "actuals_to_date": sum(sc.actuals.values()),
        "adjustments": {"sprint": adj.sprint, "tyre_tests": adj.tyre_tests, "pu_integration": adj.pu_integration, "total": adj.total},
        "included_proposals": sorted(sc.include),
        "relevant_costs": {"mean": round(statistics.fmean(relevant)), "p5": round(pct(relevant, 0.05)), "p50": round(pct(relevant, 0.50)),
                           "p80": round(pct(relevant, 0.80)), "p95": round(pct(relevant, 0.95)), "max": round(max(relevant))},
        "probability": {"compliant": cats.count("compliant") / n, "minor_overspend": cats.count("minor_overspend") / n,
                        "material_overspend": cats.count("material_overspend") / n},
        "expected_overspend": round(sum(max(0, x - cap) for x in relevant) / n),
        "headroom_at_p95": cap - round(pct(relevant, 0.95)),
        "crash_damage_remaining": {"mean": round(statistics.fmean(r["crash"] for r in runs)),
                                   "p95": round(pct([r["crash"] for r in runs], 0.95))},
    }
    out["probability"]["breach"] = 1 - out["probability"]["compliant"]
    if keep_runs:
        out["_relevant"] = relevant
    return out


def histogram(relevant: list[int], cap: int, width: int = 500_000, lo: int | None = None, hi: int | None = None) -> list[dict]:
    lo = lo if lo is not None else (min(relevant) // width) * width
    hi = hi if hi is not None else (max(relevant) // width + 1) * width
    bins = []
    for start in range(lo, hi, width):
        n = sum(1 for x in relevant if start <= x < start + width)
        bins.append({"from": start, "to": start + width, "share": n / len(relevant),
                     "zone": "compliant" if start + width <= cap else "over" if start >= cap else "straddles cap"})
    return bins
