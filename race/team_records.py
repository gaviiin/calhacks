"""Accuracy at the time of hire: a team's own damage reports and work orders, simulated, learned from and tested on.

    uv run python -m race.team_records       # writes race/data/team_records.json and race/data/hire_accuracy.json

Public data taught the desk Williams' routine, not its damage (race/backtest.py: one season holds too few crashes). A
team that hires Anneal hands over its records: the chief mechanic's damage report for every incident (which parts the
impact took) and the work orders behind every repair (what each part cost, the hours, the days Grove took). We do not
have Williams' records, so this module SIMULATES them from a hidden "true team": its own damage odds by impact speed
and direction, its own prices, hours and lead times, none of which the desk is told.

    train   2022 and 2023: the records the team hands over at hire
    test    2024: incidents the desk has not seen

The desk is scored twice on 2024, on the same incidents: with what it has today (the price book's severity template,
its prices, its hours and lead times) and with what it learned from the team's records. The learning is the simplest
honest kind: counts per impact band and direction shrunk toward the template, and medians of the work orders.

What this proves, and what it does not: that the learner recovers a team's own damage pattern and costs from two seasons
of records, measured against the team that produced them. It is not a measurement on Williams' real records.
"""

from __future__ import annotations

import json
import math
import random
from collections import defaultdict
from pathlib import Path
from statistics import median

from race import prices as P

DATA = Path(__file__).resolve().parent / "data"
RECORDS = DATA / "team_records.json"
OUT = DATA / "hire_accuracy.json"
SEED = 1249

PARTS = ["front_wing", "floor", "rear_wing", "front_suspension", "rear_suspension", "gearbox", "chassis", "bodywork", "brakes", "electronics", "power_unit"]
ZONES = ("front", "side", "rear")
TEMPLATE_HOURS = {"front_wing": 0.5, "rear_wing": 1.0, "floor": 3.0, "front_suspension": 2.5, "rear_suspension": 2.5, "gearbox": 4.0, "bodywork": 1.0,
                  "brakes": 1.0, "electronics": 2.0, "power_unit": 5.0, "chassis": 12.0}  # race/data/williams_2024.json; the tub: a spare build

# ---------------------------------------------------------------------- the hidden team (never shown to the desk)

# P(part damaged) for this team's car, by impact band and the direction the accident data recorder gives
TRUE_ODDS = {
    ("heavy", "front"): {"front_wing": .97, "floor": .85, "front_suspension": .9, "bodywork": .9, "chassis": .5, "electronics": .55, "brakes": .4, "rear_wing": .15, "rear_suspension": .2, "gearbox": .2, "power_unit": .12},
    ("heavy", "side"): {"front_wing": .6, "floor": .9, "front_suspension": .75, "rear_suspension": .7, "bodywork": .95, "chassis": .35, "electronics": .6, "brakes": .35, "rear_wing": .3, "gearbox": .4, "power_unit": .2},
    ("heavy", "rear"): {"front_wing": .25, "floor": .7, "rear_wing": .95, "rear_suspension": .9, "gearbox": .85, "bodywork": .7, "chassis": .2, "electronics": .5, "power_unit": .45, "brakes": .3, "front_suspension": .15},
    ("moderate", "front"): {"front_wing": .95, "floor": .45, "front_suspension": .55, "bodywork": .65, "brakes": .2, "electronics": .15, "chassis": .04, "rear_wing": .05, "rear_suspension": .05, "gearbox": .03, "power_unit": .02},
    ("moderate", "side"): {"front_wing": .35, "floor": .65, "front_suspension": .4, "rear_suspension": .35, "bodywork": .85, "electronics": .2, "brakes": .15, "rear_wing": .1, "gearbox": .08, "chassis": .03, "power_unit": .03},
    ("moderate", "rear"): {"rear_wing": .9, "rear_suspension": .55, "gearbox": .35, "floor": .45, "bodywork": .5, "front_wing": .08, "electronics": .15, "power_unit": .08, "brakes": .1, "chassis": .02, "front_suspension": .04},
    ("light", "front"): {"front_wing": .9, "bodywork": .35, "brakes": .05, "floor": .1},
    ("light", "side"): {"bodywork": .7, "floor": .3, "front_wing": .25, "front_suspension": .08},
    ("light", "rear"): {"rear_wing": .6, "bodywork": .4, "floor": .15, "rear_suspension": .08},
}
# what this team really pays and takes, against the price book
PRICE_FACTOR = {"front_wing": .82, "floor": 1.35, "rear_wing": .9, "front_suspension": 1.1, "rear_suspension": 1.1, "gearbox": 1.18, "chassis": 1.25,
                "bodywork": .7, "brakes": .9, "electronics": 1.45, "power_unit": 1.0}
HOURS_FACTOR = {"front_wing": 1.6, "floor": .8, "rear_wing": 1.3, "front_suspension": 1.2, "rear_suspension": 1.4, "gearbox": .9, "chassis": 1.1,
                "bodywork": 1.5, "brakes": 1.2, "electronics": 1.8, "power_unit": .85}
LEAD_SHIFT = {"front_wing": -1, "floor": 2, "rear_wing": 0, "front_suspension": 1, "rear_suspension": 1, "gearbox": -2, "chassis": 3, "bodywork": -1,
              "brakes": 0, "electronics": 1, "power_unit": 2}


def band(kph: float) -> str:
    return next((sev for floor, sev in P.IMPACT_SEVERITY if kph >= floor), "light")


def _mid(part: str) -> int:
    return P.PARTS[part].usd_cents()[1]


def simulate(seed: int = SEED) -> list[dict]:
    """Three seasons of the team's incidents: the damage report and the work orders for each."""
    r = random.Random(seed)
    out = []
    for season, n in ((2022, 32), (2023, 32), (2024, 30)):
        for i in range(n):
            u = r.random()
            kph = r.uniform(60, 150) if u < 0.6 else r.uniform(150, 250) if u < 0.88 else r.uniform(250, 320)
            zone = r.choices(ZONES, weights=(55, 30, 15))[0]
            sev = band(kph)
            odds = TRUE_ODDS[(sev, zone)]
            damaged = [p for p in PARTS if r.random() < odds.get(p, 0.0)]
            if not damaged:
                damaged = [max(odds, key=odds.get)]
            orders = []
            for p in damaged:
                cost = int(_mid(p) * PRICE_FACTOR[p] * math.exp(r.gauss(0, 0.12)))
                hours = round(TEMPLATE_HOURS[p] * HOURS_FACTOR[p] * math.exp(r.gauss(0, 0.2)), 1)
                lead = max(1, P.LEAD_DAYS.get(p, (3, 5, 8))[1] + LEAD_SHIFT[p] + r.choice((-1, 0, 0, 1)))
                orders.append({"order": f"WO-{season}-{i + 1:03d}-{p}", "part": p, "cost_cents": cost, "hours": hours, "lead_days": lead})
            out.append({"incident": f"{season}-{i + 1:02d}", "season": season, "impact_kph": round(kph), "zone": zone, "band": sev,
                        "damage_report": {"by": "Chief Mechanic", "parts": damaged}, "work_orders": orders})
    return out


# ---------------------------------------------------------------------- what the desk knows, and what it learns

def _template(sev: str) -> dict[str, float]:
    p: dict[str, float] = defaultdict(float)
    for part, prob in P.SEVERITY_TEMPLATES.get(sev, []):
        p["chassis" if part == "chassis_repair" else part] += prob
    return {k: min(v, 1.0) for k, v in p.items()}


class Today:
    """The desk as it stands: the price book's template, prices, hours and lead times."""

    name = "public data"

    def odds(self, inc: dict) -> dict[str, float]:
        return _template(inc["band"])

    def price(self, part: str) -> int:
        return _mid(part)

    def hours(self, part: str) -> float:
        return TEMPLATE_HOURS[part]

    def lead(self, part: str) -> int:
        return P.LEAD_DAYS.get(part, (3, 5, 8))[1]


class Reported:
    """A desk once the chief mechanic's damage report is in: the parts are known; only the prices, hours and days are the desk's."""

    def __init__(self, desk: Today):
        self.desk = desk
        self.name = f"{desk.name}, after the damage report"
        self._truth: set[str] = set()

    def odds(self, inc: dict) -> dict[str, float]:
        return {p: 1.0 if p in inc["damage_report"]["parts"] else 0.0 for p in PARTS}

    def __getattr__(self, name):
        return getattr(self.desk, name)


class Learned(Today):
    """The desk after reading the team's records: damage counts by band and direction, shrunk toward the template
    (two pseudo-incidents of it), and the medians of the work orders, falling back to the book where the team has none."""

    name = "the team's records"
    PRIOR = 2.0  # pseudo-incidents of the template behind each band

    def __init__(self, records: list[dict]):
        self.n: dict[tuple, int] = defaultdict(int)
        self.k: dict[tuple, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self.nb: dict[str, int] = defaultdict(int)
        self.kb: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        cost, hours, lead = defaultdict(list), defaultdict(list), defaultdict(list)
        for inc in records:
            key = (inc["band"], inc["zone"])
            self.n[key] += 1
            self.nb[inc["band"]] += 1
            for p in inc["damage_report"]["parts"]:
                self.k[key][p] += 1
                self.kb[inc["band"]][p] += 1
            for wo in inc["work_orders"]:
                cost[wo["part"]].append(wo["cost_cents"])
                hours[wo["part"]].append(wo["hours"])
                lead[wo["part"]].append(wo["lead_days"])
        self._cost = {p: int(median(v)) for p, v in cost.items()}
        self._hours = {p: median(v) for p, v in hours.items()}
        self._lead = {p: int(round(median(v))) for p, v in lead.items()}

    def odds(self, inc: dict) -> dict[str, float]:
        """Two levels: the band's rate across directions shrunk toward the template, then the band and direction's rate
        shrunk toward that, so a direction the team rarely crashes in borrows from the others."""
        b, key = inc["band"], (inc["band"], inc["zone"])
        prior = _template(b)
        band_p = {p: (self.kb[b].get(p, 0) + self.PRIOR * prior.get(p, 0.0)) / (self.nb.get(b, 0) + self.PRIOR) for p in PARTS}
        return {p: (self.k[key].get(p, 0) + 3.0 * band_p[p]) / (self.n.get(key, 0) + 3.0) for p in PARTS}

    def price(self, part: str) -> int:
        return self._cost.get(part, super().price(part))

    def hours(self, part: str) -> float:
        return self._hours.get(part, super().hours(part))

    def lead(self, part: str) -> int:
        return self._lead.get(part, super().lead(part))


# ---------------------------------------------------------------------- scoring

def score(desk: Today, test: list[dict]) -> dict:
    tp = fp = fn = 0
    brier, cost_abs, hour_err, lead_err = [], [], [], []
    est_total = act_total = 0
    for inc in test:
        truth = set(inc["damage_report"]["parts"])
        odds = desk.odds(inc)
        pred = {p for p in PARTS if odds.get(p, 0.0) >= 0.5}
        tp, fp, fn = tp + len(pred & truth), fp + len(pred - truth), fn + len(truth - pred)
        brier += [(odds.get(p, 0.0) - (p in truth)) ** 2 for p in PARTS]
        actual = sum(wo["cost_cents"] for wo in inc["work_orders"])
        estimate = sum(odds.get(p, 0.0) * desk.price(p) for p in PARTS)  # the expected cost the desk books provisionally
        cost_abs.append(abs(estimate - actual))
        est_total, act_total = est_total + estimate, act_total + actual
        actual_h = sum(wo["hours"] for wo in inc["work_orders"])
        hour_err.append(abs(sum(desk.hours(p) for p in truth) / actual_h - 1) if actual_h else 0.0)  # hours for the parts the report names
        lead_err += [abs(desk.lead(wo["part"]) - wo["lead_days"]) for wo in inc["work_orders"]]
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    return {
        "parts_precision": prec, "parts_recall": rec, "parts_f1": 2 * prec * rec / (prec + rec) if prec + rec else 0.0,
        "brier": sum(brier) / len(brier), "cost_error_per_crash_cents": median(cost_abs), "season_cost_error": abs(est_total / act_total - 1),
        "hours_error": median(hour_err), "lead_error_days": sum(lead_err) / len(lead_err), "incidents": len(test),
    }


def _mean(rows: list[dict]) -> dict:
    return {k: round(sum(r[k] for r in rows) / len(rows), 4) for k in rows[0]}


TEAMS = 20  # simulated teams: each its own records and its own unseen season, so one lucky season does not decide it


def run(seed: int = SEED, teams: int = TEAMS, write: bool = True) -> dict:
    records = simulate(seed)
    if write:
        RECORDS.write_text(json.dumps({"_note": "SIMULATED team records (race/team_records.py): a hidden team's damage reports and work orders, "
                                                "not Williams' data", "seed": seed, "incidents": records}, indent=1))
    today, learned, curve = [], [], defaultdict(list)
    rep_today, rep_learned = [], []
    for t in range(teams):
        recs = simulate(seed + t)
        train = [x for x in recs if x["season"] < 2024]
        test = [x for x in recs if x["season"] == 2024]
        today.append(score(Today(), test))
        learned.append(score(Learned(train), test))
        rep_today.append(score(Reported(Today()), test))
        rep_learned.append(score(Reported(Learned(train)), test))
        for n in (8, 16, 32, 64):
            curve[n].append(score(Learned(train[:n]), test))
    t0 = _mean(today)
    report = {
        "simulated": True,
        "what": "Accuracy at the time of hire: the desk scored on an unseen season, before and after reading two seasons of the team's damage reports and work orders.",
        "teams": teams, "train": {"seasons": [2022, 2023], "incidents_per_team": 64}, "test": {"season": 2024, "incidents_per_team": 30},
        "today": t0, "after_hire": _mean(learned),
        "with_report": {"today": _mean(rep_today), "after_hire": _mean(rep_learned)},
        "curve": [{"incidents_learned": 0, **{k: t0[k] for k in ("parts_f1", "brier", "season_cost_error")}}]
        + [{"incidents_learned": n, **{k: _mean(rows)[k] for k in ("parts_f1", "brier", "season_cost_error")}} for n, rows in sorted(curve.items())],
        "caveat": "Simulated records from a hidden team model: this shows the learner recovers a team's own damage pattern and costs; it is not a measurement on Williams' records.",
    }
    if write:
        OUT.write_text(json.dumps(report, indent=1))
    return report


def main() -> None:
    r = run()
    t, a = r["today"], r["after_hire"]
    pct = lambda x: f"{x * 100:.0f}%"
    print(f"{r['teams']} simulated teams: each learned from 64 incidents of its own records, tested on 30 unseen")
    print(f"  parts: F1 {pct(t['parts_f1'])} -> {pct(a['parts_f1'])} (precision {pct(t['parts_precision'])} -> {pct(a['parts_precision'])}, recall {pct(t['parts_recall'])} -> {pct(a['parts_recall'])})")
    print(f"  damage odds calibration (Brier, lower is better) {t['brier']:.3f} -> {a['brier']:.3f}")
    print(f"  cost error per crash, median ${t['cost_error_per_crash_cents'] / 1e8:.2f}m -> ${a['cost_error_per_crash_cents'] / 1e8:.2f}m")
    print(f"  season cost error {pct(t['season_cost_error'])} -> {pct(a['season_cost_error'])}")
    print(f"  repair hours error {pct(t['hours_error'])} -> {pct(a['hours_error'])};  lead time error {t['lead_error_days']:.2f} -> {a['lead_error_days']:.2f} days")
    rt, ra = r["with_report"]["today"], r["with_report"]["after_hire"]
    print(f"  once the engineer's report is in: cost per crash ${rt['cost_error_per_crash_cents'] / 1e8:.2f}m -> ${ra['cost_error_per_crash_cents'] / 1e8:.2f}m, "
          f"season {pct(rt['season_cost_error'])} -> {pct(ra['season_cost_error'])}")
    print("  learning curve (F1, season cost error): " + ", ".join(f"{c['incidents_learned']}: {pct(c['parts_f1'])}, {pct(c['season_cost_error'])}" for c in r["curve"]))


if __name__ == "__main__":
    main()
