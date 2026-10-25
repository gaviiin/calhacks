"""Should we spend it? The overspend calculus for one decision, run on the same simulated seasons with and without it.

For each simulated season (paired: same crashes, same overruns), the decision changes:
  1. Relevant Costs, so the breach category (regulations: D10.3), and
  2. points scored (the option's expected gain), so the constructors' position and its prize money,
and, if the season ends in a breach:
  3. a fine (cash; FIA fines are Excluded Costs, D5.1.1.m),
  4. a points deduction from that same season (mandatory if material: D10.3.4, D12.1.1.c.i),
  5. a testing restriction costing performance next year (assumption, Red Bull FY2021 precedent),
and if it ends under the cap from 2027 onwards:
  6. carry-forward room into next year, up to USD 2m (D6.1.1.n; first usable in FY2027 for FY2026 underspend).

Items 3-5 come from SanctionModel, which is assumptions, not rules. The output keeps each part separate
so nobody mistakes the net figure for a prediction.
"""

from __future__ import annotations

import json
import random
import statistics
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import regulations as R
from .assumptions import Assumptions
from .plan import Plan
from .sim import Scenario, forecast

REPO = Path(__file__).resolve().parent.parent


@dataclass
class Team:
    name: str
    points: float  # at the as-of date
    per_race: float  # expected points per remaining race weekend (both cars, sprints included)
    sd_per_race: float = 7.0


@dataclass
class Standings:
    """The constructors' fight. Default: the real 2026 table at the as-of date (see real_standings); this
    hand-made fallback is used only when world/race_data/2026.json is missing."""

    teams_ahead_fixed: int = 2  # teams out of reach above the fight
    teams: list[Team] = field(default_factory=lambda: [
        Team("Rival A", 312, 15.4), Team("Meridian Racing", 296, 15.0), Team("Rival B", 281, 14.2)])
    us: str = "Meridian Racing"
    source: str = "hypothetical"


RACE_DATA = REPO / "world" / "race_data" / "2026.json"


def real_standings(as_of_month: int, team: str = "mercedes", path: Path = RACE_DATA) -> Standings:
    """The real 2026 constructors' table after the last race in or before the as-of month, every team with its
    average points per round and round-to-round spread so far. Meridian mirrors Mercedes; any team can be 'us'."""
    data = json.loads(Path(path).read_text())
    rounds = sorted((r for r in data["rounds"] if int(r["date"][5:7]) <= as_of_month), key=lambda r: r["round"])
    if not rounds:
        raise ValueError(f"no 2026 races before the end of month {as_of_month}")
    names = {}
    for r in rounds:
        for c in r["classification"]:
            names[c["constructor"]] = c["constructor_name"]
    if team not in names:
        raise ValueError(f"unknown constructor {team!r}; known: {sorted(names)}")
    prev: dict[str, float] = {}
    hist: dict[str, list[float]] = {t: [] for t in names}
    for r in rounds:
        for t in names:
            hist[t].append(r["standings_after"].get(t, 0) - prev.get(t, 0))
        prev = r["standings_after"]
    teams = []
    for t, h in hist.items():
        mean = statistics.fmean(h)
        sd = statistics.stdev(h) if len(h) > 2 else max(5.0, mean / 2)
        teams.append(Team(names[t], prev.get(t, 0), round(mean, 2), round(max(2.0, sd), 2)))
    return Standings(0, sorted(teams, key=lambda x: -x.points), names[team],
                     source=f"real 2026 standings after R{rounds[-1]['round']} {rounds[-1]['name']} (TracingInsights RaceData, CC0)")


def default_standings(as_of_month: int, team: str = "mercedes") -> Standings:
    return real_standings(as_of_month, team) if RACE_DATA.exists() else Standings()


@dataclass
class Option:
    key: str = "U5"  # a proposed upgrade in the plan
    points_per_race: float = 2.0  # expected extra points per race weekend once it runs
    points_sd_per_race: float = 1.5
    extra_cost: int = 0  # any spend not in the plan (USD), booked in the option's month


def prize_table() -> dict[int, int]:
    path = REPO / "world" / "prize_table.json"
    data = json.loads(path.read_text())["by_position"]
    return {int(k): int(v) // 100 for k, v in data.items()}  # cents -> USD


def value_per_point(table: dict[int, int], typical_gap: float = 40.0) -> float:
    steps = [table[i] - table[i + 1] for i in range(1, max(table))]
    return statistics.fmean(steps) / typical_gap


def _position(points: dict[str, float], standings: Standings) -> int:
    us = points[standings.us]
    return standings.teams_ahead_fixed + 1 + sum(1 for n, p in points.items() if n != standings.us and p > us)


def evaluate(plan: Plan, base: Scenario, option: Option, standings: Standings | None = None, a: Assumptions | None = None,
             max_material_risk: float = 0.01) -> dict:
    a = a or Assumptions()
    standings = standings or default_standings(base.as_of_month)
    year = plan.season
    upg = next((u for u in plan.upgrades if u.key == option.key), None)
    if upg is None:
        raise ValueError(f"no upgrade {option.key} in the plan")
    first_round = upg.round
    remaining = [r for r in plan.calendar if r.day.month > base.as_of_month]
    with_rounds = [r for r in remaining if r.round >= first_round]
    extra = dict(base.extra_spend or {})
    if option.extra_cost:
        m = next(r.day.month for r in plan.calendar if r.round == first_round)
        extra[m] = extra.get(m, 0) + option.extra_cost
    alt = Scenario(base.as_of_month, base.actuals, set(base.include) | {option.key}, base.pu_integration_2026, base.tyre_test_days,
                   base.tyre_day_amount, extra, label=f"{base.label}+{option.key}")
    f0 = forecast(plan, base, a, keep_runs=True)
    f1 = forecast(plan, alt, a, keep_runs=True)
    cap = f0["cap"]
    table = prize_table()
    vpp = value_per_point(table)
    sm = a.sanction

    def season(i: int, relevant: int, with_option: bool) -> dict:
        rng = random.Random(f"{a.seed}|{i}|points")
        pts = {}
        for t in standings.teams:
            pts[t.name] = t.points + sum(t.per_race + rng.gauss(0, t.sd_per_race) for _ in remaining)
        grng = random.Random(f"{a.seed}|{i}|gain")
        gain = sum(option.points_per_race + grng.gauss(0, option.points_sd_per_race) for _ in with_rounds)
        if with_option:
            pts[standings.us] += gain
        pos_raw = _position(pts, standings)
        pos = R.classify(year, relevant, cap)
        fine, deduction, next_year_pts = 0.0, 0.0, 0.0
        trng = random.Random(f"{a.seed}|{i}|sanction")
        if pos.category == "minor_overspend":
            fine = max(sm.minor_fine_floor, sm.minor_fine_multiple * pos.overspend)
            if trng.random() < sm.minor_testing_cut_probability:
                next_year_pts = sm.minor_testing_cut_points_next_year
        elif pos.category == "material_overspend":
            fine = max(sm.minor_fine_floor, sm.material_fine_multiple * pos.overspend)
            deduction = sm.material_points_deduction
            next_year_pts = sm.material_testing_cut_points_next_year
        pts[standings.us] -= deduction
        position = _position(pts, standings)
        carry = min(R.SECD_ISS08.unused_carry_max, max(0, cap - relevant)) if year >= 2026 else 0
        return {"position_before_sanction": pos_raw, "position": position, "prize": table.get(position, table[max(table)]),
                "fine": fine, "deduction": deduction, "next_year_points": next_year_pts, "carry": carry, "category": pos.category}

    s0 = [season(i, x, False) for i, x in enumerate(f0["_relevant"])]
    s1 = [season(i, x, True) for i, x in enumerate(f1["_relevant"])]
    n = len(s0)

    def mean(rows, k):
        return statistics.fmean(r[k] for r in rows)

    d_prize = mean(s1, "prize") - mean(s0, "prize")
    d_fine = mean(s1, "fine") - mean(s0, "fine")
    d_next = mean(s1, "next_year_points") - mean(s0, "next_year_points")
    d_carry = mean(s1, "carry") - mean(s0, "carry")
    net_cash = d_prize - d_fine
    net_with_next_year = net_cash - d_next * vpp
    p_mat = f1["probability"]["material_overspend"]
    reasons = []
    if p_mat > max_material_risk:
        reasons.append(f"P(material overspend) {p_mat:.1%} is above the {max_material_risk:.0%} limit: a points deduction would be mandatory (D10.3.4)")
    if net_with_next_year < 0:
        reasons.append("expected prize money gained is less than expected fines and next-year testing cost")
    verdict = "do_it" if not reasons else "do_not"
    if verdict == "do_it":
        reasons.append("expected prize money gained exceeds expected sanctions, and material-overspend risk is within the limit")

    def positions(rows):
        out = {}
        for r in rows:
            out[r["position"]] = out.get(r["position"], 0) + 1
        return {f"P{k}": v / n for k, v in sorted(out.items())}

    strip = {k: v for k, v in f0.items() if not k.startswith("_")}
    strip1 = {k: v for k, v in f1.items() if not k.startswith("_")}
    return {
        "decision": {"option": option.key, "name": upg.name, "planned_cost": upg.cost + option.extra_cost, "first_round": first_round,
                     "races_it_runs": len(with_rounds), "expected_points_gain": round(option.points_per_race * len(with_rounds), 1)},
        "without": {"forecast": strip, "positions": positions(s0), "expected_prize": round(mean(s0, "prize")),
                    "expected_fine": round(mean(s0, "fine"))},
        "with": {"forecast": strip1, "positions": positions(s1), "expected_prize": round(mean(s1, "prize")),
                 "expected_fine": round(mean(s1, "fine"))},
        "delta": {"breach_probability": f1["probability"]["breach"] - f0["probability"]["breach"],
                  "material_probability": p_mat - f0["probability"]["material_overspend"],
                  "expected_prize_money": round(d_prize), "expected_fine": round(d_fine),
                  "expected_next_year_points_lost": round(d_next, 2), "next_year_points_valued_at": round(d_next * vpp),
                  "carry_forward_room_2027": round(d_carry), "net_cash": round(net_cash), "net_including_next_year": round(net_with_next_year)},
        "verdict": verdict, "reasons": reasons,
        "value_per_point": round(vpp), "standings": asdict(standings), "assumptions": a.to_dict(),
        "regulations": {k: asdict(R.SECD_ISS08.provisions[k]) for k in ("minor", "material", "material_sanction", "fine_case_by_case",
                                                                          "points_year", "fines_excluded", "unused_carry")},
    }


def headroom(plan: Plan, base: Scenario, a: Assumptions | None = None, target_breach: float = 0.10, month: int | None = None) -> dict:
    """The most extra spend (booked in `month`) that keeps P(breach) at or below target_breach."""
    a = a or Assumptions()
    month = month or (base.as_of_month + 1)
    lo, hi = 0, 20_000_000

    def p(extra: int) -> float:
        sc = Scenario(base.as_of_month, base.actuals, base.include, base.pu_integration_2026, base.tyre_test_days, base.tyre_day_amount,
                      {**(base.extra_spend or {}), month: (base.extra_spend or {}).get(month, 0) + extra}, label=f"{base.label}+{extra}")
        return forecast(plan, sc, a)["probability"]["breach"]

    now = p(0)
    if now > target_breach:
        return {"target_breach": target_breach, "extra_spend_allowed": 0, "month": month, "breach_at_that_spend": now,
                "note": "already above the target breach probability: the plan needs cuts, not additions"}
    while hi - lo > 50_000:
        mid = (lo + hi) // 2
        lo, hi = (mid, hi) if p(mid) <= target_breach else (lo, mid)
    return {"target_breach": target_breach, "extra_spend_allowed": lo, "month": month, "breach_at_that_spend": p(lo)}


def pu_allocation(plan: Plan, base: Scenario, a: Assumptions | None = None,
                  options: tuple[int, ...] = (0, 1_000_000, 1_500_000, 2_000_000, 3_000_000)) -> list[dict]:
    """How splitting the D6.1.1.q USD 3m between 2026 and 2027 changes this year's breach risk (declare by 30 Nov 2026)."""
    out = []
    for x in options:
        sc = Scenario(base.as_of_month, base.actuals, base.include, x, base.tyre_test_days, base.tyre_day_amount, base.extra_spend,
                      label=base.label)
        f = forecast(plan, sc, a)
        out.append({"to_2026": x, "to_2027": 3_000_000 - x, "p_breach_2026": f["probability"]["breach"],
                    "p_material_2026": f["probability"]["material_overspend"], "p50": f["relevant_costs"]["p50"]})
    return out
