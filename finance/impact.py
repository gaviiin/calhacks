"""Measurable usefulness: what Pit Wall did for the finance team, in numbers a CFO would ask for.

Everything here is measured from the run's own books, except the two labelled
assumptions (minutes a person spends per manual entry and per billing check),
which come from environment variables so a customer can put in their own.
"""

from __future__ import annotations

import os
import statistics
from datetime import date, datetime, timedelta

from .eval import scorecard
from .money import fmt


def _t(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _close_day(d: date, business_days: int) -> date:
    """The day a manual close would book it: month end plus N business days."""
    nxt = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    day, left = nxt - timedelta(days=1), business_days
    while left:
        day += timedelta(days=1)
        if day.weekday() < 5:
            left -= 1
    return day


def impact(run, env=os.environ) -> dict:
    led, season = run.ledger, run.season
    min_entry = float(env.get("PITWALL_MIN_PER_ENTRY", "6"))
    min_billing = float(env.get("PITWALL_MIN_PER_BILLING_CHECK", "20"))
    close_days = int(env.get("PITWALL_CLOSE_BUSINESS_DAYS", "5"))

    posted = led.entries(status="posted")
    approvals = led.q("SELECT je_id FROM approvals")
    touched = {r["je_id"] for r in approvals}
    no_touch = [e for e in posted if e["je_id"] not in touched]

    finals = {(r["round"], r["session"]): r["finalized_at"] for r in led.q("SELECT * FROM finals WHERE season=?", season)}
    lag_min, manual_lag_days = [], []
    for e in posted:
        if e["kind"] != "bonus":
            continue
        b = e["basis"]
        fin = finals.get((b.get("round"), b.get("session", "race")))
        if fin and e["posted_at"]:
            lag_min.append((_t(e["posted_at"]) - _t(fin)).total_seconds() / 60)
            race_day = _t(fin).date()
            manual_lag_days.append((_close_day(race_day, close_days) - race_day).days)

    billing = led.billings()
    billing_by = {}
    for b in billing:
        billing_by[f"{b['status']}/{b['reason_code']}"] = billing_by.get(f"{b['status']}/{b['reason_code']}", 0) + 1
    held_first = sum(1 for b in billing if any(h["status"] == "hold" for h in b["history"]))
    sc = scorecard(run)
    questions = led.q("SELECT status, COUNT(*) n FROM questions GROUP BY status")
    cost = run.store.costs(run.run_id)
    refused = led.q("SELECT c.check_id, COUNT(*) n FROM checks c JOIN journal_entries j ON j.je_id=c.je_id "
                    "WHERE j.status='refused' AND c.result='fail' GROUP BY c.check_id")
    hours_saved = (len(posted) * min_entry + len(billing) * min_billing) / 60
    people_minutes = len(touched) * min_entry + sum(r["n"] for r in questions) * min_billing / 2

    return {
        "run_id": run.run_id, "season": season, "as_of": led.clock,
        "headline": {
            "entries_posted": len(posted),
            "posted_without_a_person": len(no_touch),
            "straight_through_rate": round(len(no_touch) / len(posted), 4) if posted else None,
            "human_decisions": len(touched) + sum(r["n"] for r in questions),
            "dollars_protected": fmt(sc["dollars_protected_cents"]),
            "dollars_protected_cents": sc["dollars_protected_cents"],
            "bonus_minutes_after_final_median": round(statistics.median(lag_min), 1) if lag_min else None,
            "manual_close_days_after_race_median": statistics.median(manual_lag_days) if manual_lag_days else None,
            "books_tie": sc["books_tie"],
        },
        "accuracy": {
            "bonuses_due": sc["bonuses"]["truth"], "bonuses_booked_correctly": sc["bonuses"]["correct"],
            "bonuses_missing": len(sc["bonuses"]["missing"]), "wrong_postings": len(sc["bonuses"]["wrong_postings"]),
            "billing": {k: sc["billing"].get(k) for k in ("requests", "correct", "planted", "planted_caught", "false_alarms")}
            if sc["billing"].get("graded") else {"graded": False, "note": "answer key not present (keys/ is generated locally)"},
        },
        "control": {
            "billing_requests": len(billing), "held_before_final": held_first, "outcomes": billing_by,
            "overturned_results_not_invoiced": sc["expected_bonuses_avoided"],
            "kernel_refusals_by_check": {r["check_id"]: r["n"] for r in refused},
            "approvals_given": len(approvals), "questions": {r["status"]: r["n"] for r in questions},
        },
        "speed": {
            "bonus_lag_minutes": {"median": round(statistics.median(lag_min), 1) if lag_min else None,
                                  "max": round(max(lag_min), 1) if lag_min else None, "n": len(lag_min)},
            "manual_baseline_days": {"median": statistics.median(manual_lag_days) if manual_lag_days else None,
                                     "assumption": f"booked at month-end close, {close_days} business days after month end"},
        },
        "effort": {
            "analyst_hours_replaced": round(hours_saved, 1),
            "people_minutes_spent": round(people_minutes, 1),
            "assumptions": {"minutes_per_manual_entry": min_entry, "minutes_per_billing_check": min_billing,
                            "set_with": "PITWALL_MIN_PER_ENTRY, PITWALL_MIN_PER_BILLING_CHECK"},
        },
        "cost": {**cost, "per_posted_entry_cents": round(cost["cost_cents"] / len(posted), 4) if posted else 0,
                 "llm_enabled": run.router.agent.llm.enabled},
        "router": run.router.stats,
    }
