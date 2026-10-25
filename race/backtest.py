"""The 2024 backtest: would the desk have been right, learning only from what came before?

    uv run python -m race.backtest            # writes race/data/backtest_2024.json and prints the scores

Three questions, each scored in time order so nothing is learned from its own future:

1. What happened? Every Williams event of 2024 before São Paulo (OpenF1 race sessions, plus the press-sourced practice
   crashes) is decided the way the live desk decides it: a licensed policy drafted from earlier sessions, else the
   nearest precedents from earlier sessions, else the offline classifier (Jev's rule table; no model). The answer is the
   event's recorded outcome (heavy, moderate, light, no damage). Strict mode hides what is only known later (whether the
   car retired or pitted within two laps); recorded mode scores the cases as the store keeps them.
2. Which parts? The six 2024 crashes whose destroyed parts the press reported (race/data/operations_2024.jsonl): the
   parts the desk would reserve from the fixed severity template, against the parts learned from the earlier crashes of
   the same severity. Scored as precision, recall and the share of the damage's value reserved.
3. What did it cost? The São Paulo weekend replayed offline, per crash and in total, against the press figures
   (race/data/actuals_2024_brazil.json). The total is not independent: two part prices in race/prices.py were raised
   to land São Paulo near the press figure, and the report says so; the split between crashes is.

Every figure is stated with its n. Small samples are small samples.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from race import jev, prices as P
from race.events import RaceEvent
from race.policy_learner import Case as LCase, GROUPS, draft_policies, era_precedents
from race.precedents import Case as PCase, PrecedentStore, wilson_lower

DATA = Path(__file__).resolve().parent / "data"
OUT = DATA / "backtest_2024.json"
LICENCE_LB, LICENCE_N = 0.75, 5
SEVERITIES = ("heavy", "moderate", "light", "none")
DAMAGE_KINDS = ("incident", "car_stopped", "retirement_suspected", "retirement_confirmed")
USD_PER_EUR = 1.08  # as actuals_2024_brazil.json states it


def norm(outcome: str) -> str:
    """Outcomes in the money's terms: a tyre set or a cheap stop costs nothing."""
    return outcome if outcome in ("heavy", "moderate", "light") else "none"


# ---------------------------------------------------------------------- 1. what happened

def _cases() -> list[PCase]:
    return sorted(era_precedents("2024").cases, key=lambda c: (c.session_key, c.lap, c.case_id))


def _visible(c: PCase, strict: bool) -> PCase:
    """The case as the desk would see it at the moment of the event."""
    if not strict:
        return c
    return PCase(**{**c.row(), "retired_within_laps": 0 if c.kind == "car_stopped" else None, "pit_within_laps": None})


def _lcase(c: PCase) -> LCase:
    return LCase(session_key=c.session_key, car=c.car, kind=c.kind, reason=c.reason or "", retired_within_laps=c.retired_within_laps,
                 pit_within_laps=c.pit_within_laps, under=c.under or "green", outcome=c.outcome, summary=c.summary, lap=c.lap,
                 compound=c.compound or "", tyre_age=c.tyre_age, damage_likely=c.damage_likely)


def _licensed(prior: tuple[PCase, ...]) -> list[tuple[str, callable, str, int, float]]:
    """Policies drafted from the earlier sessions that clear the licence: (id, predicate, outcome, n, lower bound)."""
    preds = {f"race-{pid}": pred for pid, _t, pred, _p in GROUPS}
    out = []
    for d in draft_policies([_lcase(c) for c in prior]):
        n = len(d.cases)
        k = sum(1 for c in d.cases if norm(c.outcome) == norm(max(Counter(x.outcome for x in d.cases).items(), key=lambda kv: kv[1])[0]))
        lb = wilson_lower(k, n)
        if n >= LICENCE_N and lb >= LICENCE_LB:
            outcome = Counter(norm(c.outcome) for c in d.cases).most_common(1)[0][0]
            out.append((d.policy_id, preds[d.policy_id], outcome, n, round(lb, 3), bool(d.parent_policy_id)))
    out.sort(key=lambda x: not x[5])  # a child (more specific) is tried before its parent
    return out


def _offline(c: PCase) -> str:
    kind = c.kind if c.kind in ("incident", "car_stopped", "retirement_suspected", "retirement_confirmed", "pit_stop") else "incident"
    ev = RaceEvent(kind=kind, at="2024-01-01T00:00:00Z", session_key=c.session_key, meeting_key=0, lap=c.lap, driver_number=c.car or 23,
                   team_name="Williams", payload={"reason": c.reason or "", "team_involved": True, "under": c.under, "damage_likely": c.damage_likely})
    ctx = {"team_cars": [c.car or 23]}
    if c.retired_within_laps is not None:
        ctx["retired_within_laps"] = c.retired_within_laps
    if c.pit_within_laps is not None:
        ctx["pit_within_laps"] = c.pit_within_laps
    return jev.offline_decide(ev, ctx).severity


def _view(c: PCase) -> dict:
    v = {"kind": c.kind, "reason": c.reason or "", "under": c.under or "green", "damage_likely": c.damage_likely, "compound": c.compound or "", "tyre_age": c.tyre_age}
    if c.retired_within_laps is not None:
        v["retired_within_laps"] = c.retired_within_laps
    if c.pit_within_laps is not None:
        v["pit_within_laps"] = c.pit_within_laps
    return v


def events(strict: bool = True) -> dict:
    cases = _cases()
    rows = []
    for i, c in enumerate(cases):
        prior = tuple(x for x in cases if x.session_key < c.session_key)  # earlier sessions only
        seen = _visible(c, strict)
        truth = norm(c.outcome)
        tier, pred, why = "", "", ""
        for pid, pred_fn, outcome, n, lb, _child in _licensed_cached(prior):
            if pred_fn(_lcase(seen)):
                tier, pred, why = "policy", outcome, f"{pid} ({n} cases, lower bound {lb})"
                break
        if not tier:
            m = PrecedentStore(list(prior)).match(_view(seen))
            if m is not None:
                tier, pred, why = "precedent", norm(m.outcome), f"{len(m.cases)} cases at {m.similarity:.2f}, {m.agreement:.0%} agree"
        if not tier:
            tier, pred, why = "classifier", _offline(seen), "nothing learned covers it"
        rows.append({"case": c.case_id, "kind": c.kind, "summary": c.summary[:90], "truth": truth, "tier": tier, "predicted": pred,
                     "baseline": _offline(seen), "right": pred == truth, "why": why})
    return {"strict": strict, "rows": rows, "score": _score(rows), "score_damage": _score([r for r in rows if r["kind"] in DAMAGE_KINDS])}


_LICENSED: dict[tuple[str, ...], list] = {}


def _licensed_cached(prior: tuple[PCase, ...]):
    key = tuple(c.case_id for c in prior)
    if key not in _LICENSED:
        _LICENSED[key] = _licensed(prior)
    return _LICENSED[key]


def _score(rows: list[dict]) -> dict:
    n = len(rows)
    if not n:
        return {"n": 0}
    learned = [r for r in rows if r["tier"] in ("policy", "precedent")]
    rest = [r for r in rows if r["tier"] == "classifier"]
    missed = [r for r in rows if r["truth"] in ("heavy", "moderate") and r["predicted"] in ("light", "none")]
    false = [r for r in rows if r["truth"] in ("light", "none") and r["predicted"] in ("heavy", "moderate")]
    pct = lambda a, b: round(a / b, 3) if b else None
    return {
        "n": n,
        "accuracy": pct(sum(r["right"] for r in rows), n),
        "baseline_accuracy": pct(sum(r["baseline"] == r["truth"] for r in rows), n),
        "decided_by_learning": pct(len(learned), n),
        "learned_n": len(learned),
        "learned_accuracy": pct(sum(r["right"] for r in learned), len(learned)),
        "classifier_n": len(rest),
        "classifier_accuracy": pct(sum(r["right"] for r in rest), len(rest)),
        "by_tier": dict(Counter(r["tier"] for r in rows)),
        "missed_damage": len(missed),
        "false_alarms": len(false),
        "confusion": {t: dict(Counter(r["predicted"] for r in rows if r["truth"] == t)) for t in SEVERITIES if any(r["truth"] == t for r in rows)},
    }


# ---------------------------------------------------------------------- 2. which parts

PART_OF = {"chassis_repair": "chassis"}  # a tub repaired or replaced is the tub


def _crashes() -> list[dict]:
    by: dict[str, dict] = {}
    for line in (DATA / "operations_2024.jsonl").read_text().splitlines():
        r = json.loads(line)
        cid = r["case_id"].split(":")[0]
        c = by.setdefault(cid, {"crash": cid, "weekend": r.get("weekend", ""), "at": r.get("at", ""), "parts": set(), "summary": ""})
        if r["kind"] in ("entry", "spares_reserve", "work_order") and r.get("part"):
            c["parts"].add(PART_OF.get(r["part"], r["part"]))
        c["at"] = min(c["at"], r.get("at", "")) or c["at"]
    out = sorted(by.values(), key=lambda x: x["at"])
    for c in out:
        c["severity"] = "heavy" if ({"chassis", "gearbox"} & c["parts"] or len(c["parts"]) >= 6) else "moderate" if len(c["parts"]) >= 3 else "light"
    return out


def _template(sev: str) -> set[str]:
    p: dict[str, float] = defaultdict(float)
    for part, prob in P.SEVERITY_TEMPLATES.get(sev, []):
        p[PART_OF.get(part, part)] += prob
    return {k for k, v in p.items() if v >= 0.5}


def _value(parts: set[str]) -> int:
    return sum(P.PARTS[p].usd_cents()[1] for p in parts if p in P.PARTS)


def parts() -> dict:
    crashes = _crashes()
    rows = []
    for i, c in enumerate(crashes):
        truth = c["parts"]
        tpl = _template(c["severity"])
        earlier = [x for x in crashes[:i] if x["severity"] == c["severity"]]
        if earlier:
            freq = Counter(p for x in earlier for p in x["parts"])
            learned = {p for p, k in freq.items() if k / len(earlier) >= 0.5}
            basis = f"{len(earlier)} earlier {c['severity']} crash{'es' if len(earlier) != 1 else ''}"
        else:
            learned, basis = tpl, "no earlier crash like it: the template"
        rows.append({"crash": c["crash"], "weekend": c["weekend"], "severity": c["severity"], "truth": sorted(truth),
                     "template": _pr(tpl, truth), "learned": {**_pr(learned, truth), "basis": basis}})
    agg = {}
    for k in ("template", "learned"):
        tp = sum(r[k]["tp"] for r in rows)
        fp = sum(r[k]["fp"] for r in rows)
        fn = sum(r[k]["fn"] for r in rows)
        got = sum(r[k]["value_reserved"] for r in rows)
        need = sum(r[k]["value_needed"] for r in rows)
        agg[k] = {"precision": round(tp / (tp + fp), 3) if tp + fp else None, "recall": round(tp / (tp + fn), 3) if tp + fn else None,
                  "value_recall": round(got / need, 3) if need else None}
    return {"crashes": rows, "score": agg, "n": len(rows), "note": "severity per crash from what it destroyed: the test is whether the parts follow from the severity"}


def _pr(pred: set[str], truth: set[str]) -> dict:
    tp, fp, fn = len(pred & truth), len(pred - truth), len(truth - pred)
    return {"predicted": sorted(pred), "tp": tp, "fp": fp, "fn": fn, "precision": round(tp / (tp + fp), 3) if tp + fp else None,
            "recall": round(tp / (tp + fn), 3) if tp + fn else None, "value_reserved": _value(pred & truth), "value_needed": _value(truth)}


# ---------------------------------------------------------------------- 3. what did it cost

def cost() -> dict:
    """São Paulo replayed offline to the end, measured the way the seal measures it (race/close.py)."""
    from race import close, people
    from race.weekend import Weekend

    w = Weekend(1249, pace=0, sink=None, offline=True, forecast=False, quiet=True, script=people.load_script(1249))
    w.run()
    t = close.compute_totals(w.state, [])
    actuals = json.loads((DATA / "actuals_2024_brazil.json").read_text())["actuals"]
    pf = next(a for a in actuals if a["id"] == "planetf1-weekend")
    amus = next(a for a in actuals if a["id"] == "amus-weekend")
    sessions = {9627: "Qualifying", 9636: "Race"}
    rows = []
    for inc in t["incidents"]:
        session = sessions.get(int(str(inc["key"]).split("-")[1]), inc.get("session", ""))
        press = next((p for p in pf["per_incident"] if p["driver"] == inc["driver"] and p["session"] == session), None)
        # PlanetF1 gives one figure for car 43's race; the desk splits it into the lap-5 contact and the lap-31 crash
        rows.append({"incident": inc["key"], "car": inc["driver"], "session": session, "severity": inc.get("severity"),
                     "estimate_cents": inc["mid_cents"], "booked_cents": inc["cap_relevant_cents"],
                     "press_cents": int(round(press["eur"] * USD_PER_EUR * 100)) if press else None})
    by_press: dict[tuple, dict] = {}
    for r in rows:
        if r["press_cents"]:
            g = by_press.setdefault((r["car"], r["session"]), {"car": r["car"], "session": r["session"], "estimate_cents": 0, "booked_cents": 0, "press_cents": r["press_cents"]})
            g["estimate_cents"] += r["estimate_cents"]
            g["booked_cents"] += r["booked_cents"]
    compare = []
    for g in by_press.values():
        compare.append({**g, "estimate_error": round(g["estimate_cents"] / g["press_cents"] - 1, 3), "booked_error": round(g["booked_cents"] / g["press_cents"] - 1, 3)})
    est, booked = t["race_cost"]["mid_cents"], t["cap_relevant_cents"]
    against = []
    for src, cents in (("Auto Motor und Sport", amus["usd"] * 100), ("PlanetF1 (F1Maximaal per-part tally)", int(round(pf["eur"] * USD_PER_EUR * 100)))):
        against.append({"source": src, "cents": cents, "estimate_error": round(est / cents - 1, 3), "booked_error": round(booked / cents - 1, 3)})
    return {"estimate_cents": est, "estimate_band_cents": [t["race_cost"]["low_cents"], t["race_cost"]["high_cents"]], "booked_cents": booked,
            "incidents": rows, "per_crash": compare, "against": against, "independent": False,
            "note": "Estimate: each crash's cost weighted by how likely each part is damaged, the figure the seal reports. Booked: every part the "
                    "garage replaced at its price-book mid, the entries in the books. The weekend total is not an independent test (two part prices "
                    "were raised to land it near the AMuS figure), and the two press sources differ by 61%. The split between crashes is the real test."}


def run() -> dict:
    report = {"events_strict": events(True), "events_recorded": events(False), "parts": parts(), "cost": cost()}
    OUT.write_text(json.dumps(report, indent=1, default=str))
    return report


def _pct(x) -> str:
    return "—" if x is None else f"{x * 100:.0f}%"


def main() -> None:
    argparse.ArgumentParser(description=__doc__.split("\n")[0]).parse_args()
    r = run()
    for key, label in (("events_strict", "What happened (strict: nothing known after the event)"), ("events_recorded", "What happened (as recorded)")):
        for sub, name in (("score", "all events"), ("score_damage", "incidents, stops, retirements")):
            s = r[key][sub]
            print(f"{label}, {name}: n={s['n']} accuracy {_pct(s['accuracy'])} (no learning {_pct(s['baseline_accuracy'])}); "
                  f"decided by learning {_pct(s['decided_by_learning'])} at {_pct(s['learned_accuracy'])}, classifier {_pct(s['classifier_accuracy'])} on {s['classifier_n']}; "
                  f"missed damage {s['missed_damage']}, false alarms {s['false_alarms']}")
    p = r["parts"]["score"]
    print(f"Which parts (n={r['parts']['n']} crashes): template precision {_pct(p['template']['precision'])} recall {_pct(p['template']['recall'])} value {_pct(p['template']['value_recall'])}; "
          f"learned precision {_pct(p['learned']['precision'])} recall {_pct(p['learned']['recall'])} value {_pct(p['learned']['value_recall'])}")
    c = r["cost"]
    print(f"What it cost (São Paulo): estimate ${c['estimate_cents'] / 1e8:.2f}m, booked ${c['booked_cents'] / 1e8:.2f}m; "
          + "; ".join(f"{a['source']} ${a['cents'] / 1e8:.2f}m: estimate {a['estimate_error'] * 100:+.0f}%, booked {a['booked_error'] * 100:+.0f}%" for a in c["against"]))
    for g in c["per_crash"]:
        print(f"  car {g['car']} {g['session']}: estimate ${g['estimate_cents'] / 1e8:.2f}m ({g['estimate_error'] * 100:+.0f}%), booked ${g['booked_cents'] / 1e8:.2f}m ({g['booked_error'] * 100:+.0f}%) vs PlanetF1 ${g['press_cents'] / 1e8:.2f}m")
    print(f"written to {OUT}")


if __name__ == "__main__":
    main()
