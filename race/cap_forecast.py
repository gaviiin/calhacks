"""Stage 6, re-plan (cap): year-end relevant costs, the chance of an overspend, and what must move.

    forecast(state) -> dict

    relevant costs booked before the weekend   (an assumption, calibrated below)
  + this weekend's cap-relevant cost          (the ledger's entries; else the incidents' assessed bands; else the effects' mid)
  + the rest of the year's plan               (run rate to 31 December; payroll and other spend with capsim's noise)
  + crash damage in the races still to run    (Poisson per race, capsim's severity mix)
  - downward adjustments                      (sprints)
  = year-end Relevant Costs, against the cap

2024 runs under the 2021-25 Financial Regulations, Issue 22 (research/fia/finreg_iss22_2024.txt). Art. 2.3(a)(iii):
$135,000,000 for 21 Competitions plus $1,800,000 for each Competition above 21, adjusted for Indexation. 2024 had 24
Grands Prix, so $140.4m before Indexation. Indexation compounds G7 inflation from 2023 by CCA Determination, which is
not public; we use $140.4m and say so. Press figures for the effective 2024 cap run as high as about $165m (The Race,
quoted in research/01-f1-team-finance.md), which would also fold in the exclusions; we do not use it. Art. 4.1(l)
gives a $300,000 downward adjustment per Competition with a Sprint (six in 2024). Art. 8.10 / 8.12: a Minor
Overspend is under 5% over the cap, a Material Overspend 5% or more. 2026 (Section D): $215m, material at 2%.
"""

from __future__ import annotations

import json
import math
from datetime import date
from pathlib import Path

import numpy as np

from capsim.assumptions import CrashModel, SpendModel

RESULTS = Path(__file__).resolve().parents[1] / "world" / "results"
N = 10_000
CAP_BUCKETS = ("6050", "5200", "6300")
TARGET_P_OVERSPEND = 0.10
DEFER_STEP_CENTS = 50_000 * 100
PAYROLL_SHARE = 0.55  # of the rest-of-year plan; the other 45% is parts, aero, freight and overheads
DEFERRABLE_SHARE = 0.20  # of the rest-of-year plan: 2025-car development work that can slip into January (assumption)

CAP_BASIS = {
    2024: ("FIA 2021-25 Financial Regulations Issue 22, Art. 2.3(a)(iii): $135m for 21 Competitions + $1.8m x 3 for 24 = $140.4m; "
           "Indexation (Art. 2.3, G7 inflation by CCA Determination) not public and not applied. Press puts the effective 2024 "
           "figure near $165m (The Race, research/01); not used."),
    2026: "FIA 2026 Financial Regulations Section D, Art. D4.1.2: $215m for 24 Competitions.",
}
CONTEXT = ("Context: in 2024 Williams asked the FIA to exclude crash costs from a season's 10th major crash onward (up to $1m each); "
           "the request was rejected. https://www.gpblog.com/en/news/318482/remarkable-request-from-williams-rejected-by-the-fia.html")
VOWLES = ("Vowles, Nov 2024: the crashes meant the team would \"take a little bit away from next year's cost cap\". "
          "https://www.formula1.com/en/latest/article/teams-arent-built-to-take-six-major-crashes-vowles-reveals-crucial-impact-of.7nBrYaZhnNjYyMKSgmBhLq")

# Relevant costs booked before the weekend, per replayable weekend. São Paulo 2024 is calibrated: with this weekend's
# three crashes as the desk prices them (about $3.9m of cap-relevant entries in the ledger: spares fitted, labour, freight), the year-end P90 lands
# about $0.4m over the cap, so a few hundred thousand dollars of Nov-Dec development spend moves into 2025, which is
# what Vowles described in November 2024. It is an assumption, not a Williams figure.
CALIBRATED_BEFORE_CENTS = {1249: 114_600_000 * 100}
CALIBRATION_BASIS = ("ASSUMPTION calibrated to Vowles (Nov 2024): set so the São Paulo damage (about $3.9m as the ledger books it) pushes the "
                     "year-end P90 just over the cap and forces a deferral of a few hundred thousand dollars of 2025 work")


# ---------------------------------------------------------------------- interface the other stages read
# race/effects.py (cap headroom) and race/ledger.py call these; this module owns the numbers and their sources.

def cap_level_cents(year: int) -> int:
    """The cost cap for a year, in USD cents, before Indexation."""
    if year >= 2026:
        return 215_000_000 * 100
    if year >= 2024:
        return (135_000_000 + 1_800_000 * (_competitions(year) - 21)) * 100
    return {2021: 145_000_000, 2022: 140_000_000}.get(year, 135_000_000) * 100


def relevant_before_cents(state) -> int:
    """Relevant costs booked this cap year before the weekend started (an assumption, with its basis in `forecast`)."""
    if state.meeting_key in CALIBRATED_BEFORE_CENTS:
        return CALIBRATED_BEFORE_CENTS[state.meeting_key]
    # Elsewhere: a team spending to the cap at an even run rate, 2% under it.
    return int(cap_level_cents(state.year) * 0.98 * _elapsed(state))


# ---------------------------------------------------------------------- pieces

def _season(year: int) -> dict | None:
    f = RESULTS / f"{year}.json"
    return json.loads(f.read_text()) if f.exists() else None


def _competitions(year: int) -> int:
    s = _season(year)
    return len(s["rounds"]) if s else 24


def _sprints(year: int) -> int:
    s = _season(year)
    return sum(1 for r in s["rounds"] if r.get("has_sprint")) if s else 6


def _weekend_date(state) -> date:
    d = str(state.session.get("date_start") or state.now or f"{state.year}-07-01")[:10]
    return date.fromisoformat(d)


def _elapsed(state) -> float:
    d = _weekend_date(state)
    return (d - date(d.year, 1, 1)).days / 365.0


def _remaining_races(state) -> int:
    s = _season(state.year)
    if s:
        return sum(1 for r in s["rounds"] if r["round"] > state.round)
    return (1 if state.info.get("next") else 0) + len(state.info.get("after_next") or [])


def weekend_cost(state) -> dict:
    """This weekend's cap-relevant cost: the ledger's entries when there are any; else per crash, a person's assessed
    band (which includes labour) when the incident was assessed, otherwise the effects' parts, labour and freight lines."""
    ents = [e for e in state.entries.values()]
    if ents:
        amt = sum(e.amount_cents for e in ents if e.cap_relevant)
        return {"low": amt, "mid": amt, "high": amt, "source": "ledger", "items": len(ents)}
    groups: dict[tuple[int, int], dict[str, list[int]]] = {}
    for ev, effs in state.effects:
        for e in effs:
            if e.kind == "cost" and e.bucket in CAP_BUCKETS:
                g = groups.setdefault((ev.session_key, ev.driver_number), {})
                b = g.setdefault(e.bucket, [0, 0, 0])
                b[0] += e.low_cents
                b[1] += e.mid_cents
                b[2] += e.high_cents
    assessed = {}
    for inc in state.incidents.values():
        band = (inc.belief or {}).get("assessed_band")
        if band and len(band) == 3:
            assessed[(inc.session_key, inc.driver_number)] = [int(x) for x in band]
    tot = [0, 0, 0]
    source = "effects"
    for key in set(groups) | set(assessed):
        g = groups.get(key, {})
        if key in assessed:
            lines = [assessed[key], g.get("6300", [0, 0, 0])]
            source = "assessed bands and effects"
        else:
            lines = list(g.values())
        for line in lines:
            for i in range(3):
                tot[i] += line[i]
    return {"low": tot[0], "mid": tot[1], "high": tot[2], "source": source, "items": len(set(groups) | set(assessed))}


def _rest_and_crash(rng, plan_cents: float, races: int, n: int) -> np.ndarray:
    """Rest-of-year plan with capsim's monthly noise, plus crash damage in the races still to run."""
    s, c = SpendModel(), CrashModel()
    payroll = plan_cents * PAYROLL_SHARE * (1 + rng.normal(0, s.payroll_monthly_sd, n))
    other = plan_cents * (1 - PAYROLL_SHARE) * (1 + rng.normal(0, s.other_monthly_sd, n))
    k = rng.poisson(c.incidents_per_race * races, n)
    kmax = int(k.max()) if n else 0
    crash = np.zeros(n)
    if kmax:
        shares = np.cumsum([x[0] for x in c.severity])
        med = np.array([x[1] for x in c.severity]) * 100
        lsd = np.array([x[2] for x in c.severity])
        cat = np.searchsorted(shares / shares[-1], rng.random((n, kmax)), side="right").clip(0, len(med) - 1)
        each = med[cat] * np.exp(rng.normal(0, 1, (n, kmax)) * lsd[cat])
        crash = (each * (np.arange(kmax)[None, :] < k[:, None])).sum(1)
    return payroll + other + crash


def forecast(state) -> dict:
    year = state.year
    cap = cap_level_cents(year)
    material_pct = 0.05 if year <= 2025 else 0.02
    adj = 300_000 * 100 * _sprints(year) if year <= 2025 else 0
    before = relevant_before_cents(state)
    w = weekend_cost(state)
    days_left = (date(_weekend_date(state).year, 12, 31) - _weekend_date(state)).days
    plan = cap * days_left / 365.0
    races = _remaining_races(state)
    rng = np.random.default_rng(state.meeting_key)  # common draws: two weekend costs differ by the cost alone
    rest = _rest_and_crash(rng, plan, races, N)

    def year_end(weekend: float, defer: float = 0.0) -> np.ndarray:
        return before + weekend + rest - adj - defer

    ye = year_end(w["mid"])
    p_over = float(np.mean(ye > cap))
    q = float(np.quantile(ye, 1 - TARGET_P_OVERSPEND))
    defer = max(0, math.ceil((q - cap) / DEFER_STEP_CENTS) * DEFER_STEP_CENTS) if q > cap else 0
    deferrable = int(plan * DEFERRABLE_SHARE)
    after = year_end(w["mid"], defer)
    hi = year_end(w["high"])
    p10, p50, p90 = (int(x) for x in np.percentile(ye, [10, 50, 90]))
    return {
        "year": year, "cap_cents": cap, "cap_basis": CAP_BASIS[2024 if year <= 2025 else 2026],
        "adjustments_cents": adj, "adjustments_basis": f"Art. 4.1(l): $300k per Competition with a Sprint, {_sprints(year)} in {year}" if adj else "",
        "relevant_before_cents": before,
        "relevant_before_basis": CALIBRATION_BASIS if state.meeting_key in CALIBRATED_BEFORE_CENTS else "ASSUMPTION: run rate at 98% of the cap",
        "weekend_cents": w["mid"], "weekend_low_cents": w["low"], "weekend_high_cents": w["high"], "weekend_source": w["source"],
        "rest_of_year_plan_cents": int(plan), "races_left": races,
        "crash_risk_basis": f"Poisson {CrashModel().incidents_per_race}/race x capsim severity mix, {races} races left",
        "year_end": {"p10_cents": p10, "p50_cents": p50, "p90_cents": p90},
        "headroom_p50_cents": cap - p50,
        "p_overspend": round(p_over, 4), "p_material": round(float(np.mean(ye >= cap * (1 + material_pct))), 4),
        "p_overspend_at_high": round(float(np.mean(hi > cap)), 4),
        "material_pct": material_pct, "rules": "Minor Overspend under 5% (Art. 8.10), Material 5% or more (Art. 8.12)" if year <= 2025 else "Minor under 2%, Material 2% or more (Section D)",
        "defer_cents": int(defer), "deferral_cents": int(defer), "year_end_mid_cents": p50, "deferrable_cents": deferrable, "defer_covered": defer <= deferrable,
        "p_overspend_after_defer": round(float(np.mean(after > cap)), 4),
        "defer_basis": f"planned Nov-Dec development spend moved into {year + 1} so P(overspend) <= {TARGET_P_OVERSPEND:.0%}; it then counts against the {year + 1} cap",
        "context": CONTEXT, "vowles": VOWLES,
    }
