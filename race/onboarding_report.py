"""What the desk knows before its first race: what it learned, from what, how sure it is, and what is still assumed.

    uv run python -m race.onboarding_report        # writes race/data/onboarding_report.json (reads backtest_2024.json)

The report a Head of Cost Cap and a chief mechanic read before they let the desk work: every learned rule with its case
count and licence, the team's operations history it will match plans against, every number that is still a stated
assumption and the team system that would replace it, and the 2024 backtest's scores.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from race import life, prices as P
from race.backtest import LICENCE_LB, LICENCE_N, OUT as BACKTEST, norm
from race.policy_learner import Case as LCase, draft_policies, era_precedents
from race.precedents import wilson_lower

DATA = Path(__file__).resolve().parent / "data"
OUT = DATA / "onboarding_report.json"


def _policies() -> list[dict]:
    cases = era_precedents("2024").cases
    lc = [LCase(session_key=c.session_key, car=c.car, kind=c.kind, reason=c.reason or "", retired_within_laps=c.retired_within_laps,
                pit_within_laps=c.pit_within_laps, under=c.under or "green", outcome=c.outcome, summary=c.summary, lap=c.lap,
                compound=c.compound or "", tyre_age=c.tyre_age, damage_likely=c.damage_likely) for c in cases]
    out = []
    for d in draft_policies(lc):
        n = len(d.cases)
        top = Counter(norm(c.outcome) for c in d.cases).most_common(1)[0]
        lb = wilson_lower(top[1], n)
        out.append({"id": d.policy_id.replace("race-", "race-y2024-"), "title": d.title.split(" (mixed")[0], "cases": n, "agree": top[1],
                    "outcome": top[0], "lower_bound": round(lb, 2), "licensed": n >= LICENCE_N and lb >= LICENCE_LB})
    return out


def _operations() -> dict:
    rows = [json.loads(line) for line in (DATA / "operations_2024.jsonl").read_text().splitlines() if line.strip()]
    crashes = sorted({r["case_id"].split(":")[0] for r in rows})
    replaced = Counter(r["part"] for r in rows if r["kind"] == "entry" and r.get("part"))
    return {"cases": len(rows), "crashes": len(crashes), "weekends": sorted({r.get("weekend") for r in rows if r.get("weekend")}),
            "by_kind": dict(Counter(r["kind"] for r in rows).most_common()),
            "parts_replaced": [{"part": p, "label": P.PART_LABELS.get(p, p), "times": k} for p, k in replaced.most_common()]}


def _assumptions() -> list[dict]:
    basis = Counter(p.basis for p in P.PARTS.values())
    spares = json.loads((DATA / "williams_2024.json").read_text())
    return [
        {"what": "Part life", "now": f"{len(life.LIFE_KM)} parts, kilometres per part (race/life.py)", "basis": "assumption",
         "replace_with": "the team's lifing system: mileage per part number"},
        {"what": "Life used at the weekend start", "now": "per car, per part (race/life.py)", "basis": "assumption", "replace_with": "the lifing system at the start of the weekend"},
        {"what": "Wear per stress event", "now": "1, 5, 15 or 25% of life by severity (race/life.py)", "basis": "assumption",
         "replace_with": "damage reports joined to telemetry: what a kerb strike or a contact actually cost each part"},
        {"what": "Part prices", "now": f"{len(P.PARTS)} lines: {basis.get('press', 0)} press figures, {basis.get('assumption', 0)} assumptions (race/prices.py)",
         "basis": "press and assumption", "replace_with": "the ERP: what each part number cost the last time it was made or bought"},
        {"what": "Lead times", "now": f"{len(P.LEAD_DAYS)} parts, days to make (race/prices.py)", "basis": "assumption", "replace_with": "work orders: how long each rebuild actually took at Grove"},
        {"what": "Repair hours", "now": "hours per part for the garage (race/data/williams_2024.json)", "basis": "assumption", "replace_with": "work orders and the garage's timesheets"},
        {"what": "Spares", "now": f"{len((spares.get('spares') or {}))} parts at the track and at Grove (race/data/williams_2024.json)", "basis": "assumption",
         "replace_with": "the stores system: the manifest for each event"},
        {"what": "Power unit and gearbox allocation used", "now": "per car (race/data/williams_2024.json)", "basis": "assumption", "replace_with": "the team's allocation log"},
        {"what": "Freight cut-offs", "now": "per event (race/data/williams_2024.json)", "basis": "assumption", "replace_with": "the logistics team's booking history"},
        {"what": "Damage by severity", "now": "which parts a light, moderate or heavy crash takes, with probabilities (race/prices.py)", "basis": "assumption",
         "replace_with": "damage reports: which parts each past crash actually destroyed"},
    ]


def _accuracy() -> dict | None:
    if not BACKTEST.exists():
        return None
    b = json.loads(BACKTEST.read_text())
    s, sd = b["events_strict"]["score"], b["events_strict"]["score_damage"]
    no_telemetry = sum(1 for r in b["events_strict"]["rows"] if not r["right"] and r["kind"] == "car_stopped")
    p = b["parts"]["score"]
    c = b["cost"]
    return {
        "events": {"n": s["n"], "accuracy": s["accuracy"], "baseline": s["baseline_accuracy"], "decided_by_learning": s["decided_by_learning"],
                   "learned_accuracy": s["learned_accuracy"], "damage_n": sd["n"], "damage_accuracy": sd["accuracy"], "damage_by_learning": sd["learned_n"],
                   "missed_damage": sd["missed_damage"], "false_alarms": sd["false_alarms"], "missed_without_telemetry": no_telemetry,
                   "recorded_accuracy": b["events_recorded"]["score"]["accuracy"], "recorded_damage_accuracy": b["events_recorded"]["score_damage"]["accuracy"]},
        "parts": {"n": b["parts"]["n"], **p},
        "cost": {"estimate_cents": c["estimate_cents"], "booked_cents": c["booked_cents"], "against": c["against"], "per_crash": c["per_crash"], "note": c["note"]},
    }


def _at_hire() -> dict | None:
    """The simulated team's records (race/team_records.py): accuracy before and after the desk reads them."""
    from race import team_records

    path = team_records.OUT
    return json.loads(path.read_text()) if path.exists() else None


def build() -> dict:
    cases = era_precedents("2024").cases
    sessions = sorted({c.session_key for c in cases if c.source == "history"})
    report = {
        "team": "Williams Racing",
        "learned_from": {
            "race_sessions": len(sessions), "events": len(cases), "press_cases": sum(1 for c in cases if c.source != "history"),
            "by_kind": dict(Counter(c.kind for c in cases).most_common()), "by_outcome": dict(Counter(norm(c.outcome) for c in cases).most_common()),
            "window": "2024 races before São Paulo: nothing from the weekend it is tested on",
        },
        "policies": _policies(),
        "operations": _operations(),
        "assumptions": _assumptions(),
        "accuracy": _accuracy(),
        "at_hire": _at_hire(),
    }
    OUT.write_text(json.dumps(report, indent=1))
    return report


def main() -> None:
    r = build()
    lf = r["learned_from"]
    print(f"Learned from {lf['race_sessions']} race sessions and {lf['press_cases']} press cases: {lf['events']} events")
    for p in r["policies"]:
        print(f"  {'LICENSED' if p['licensed'] else 'shadow  '} {p['title']}: {p['agree']} of {p['cases']}, lower bound {p['lower_bound']}")
    o = r["operations"]
    print(f"Operations history: {o['cases']} cases from {o['crashes']} crashes over {len(o['weekends'])} weekends")
    print(f"Still assumed: {len(r['assumptions'])} inputs, each with the team system that replaces it")
    print(f"written to {OUT}")


if __name__ == "__main__":
    main()
