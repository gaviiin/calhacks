"""Live demo, Act 1: replay a real race weekend at speed and narrate what Pit Wall does.

    python -m finance.demo --season 2024 --round 14 --pace 120

Runs the season instantly up to the chosen round, then plays that weekend's
events with real gaps between them, divided by --pace (120 = two hours in a minute).
With SPACETIME_MIRROR=1 every entry also streams to the frontend as it happens.
"""

from __future__ import annotations

import argparse
import time
from datetime import datetime

from .money import fmt
from .sim import new_run


def _t(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def narrate(event: dict, results: list) -> list[str]:
    p = event["payload"]
    lines = []
    if event["type"] == "race_provisional":
        lines.append(f"FIA: provisional {p['session']} classification published ({p.get('source')})")
    elif event["type"] == "fia_document":
        lines.append(f"FIA: {p['title']}")
    elif event["type"] == "race_final":
        lines.append(f"FIA: FINAL {p['session']} classification published")
    elif event["type"] == "billing_request":
        lines.append(f"Commercial team: invoice {p['sponsor_id']} clause {p['clause_id']} for car {p['car']} "
                     f"({fmt(p['amount_orig'], p['currency'])}) - \"{p.get('note', '')}\"")
    for r in results:
        if hasattr(r, "status") and r.status in ("posted", "parked", "refused"):
            lines.append(f"   ledger: {r.status.upper()} {r.je_id}" + (f" - {r.reason}" if r.reason else ""))
        elif isinstance(r, dict) and r.get("type") == "billing" and not r.get("unchanged"):
            lines.append(f"   billing review: {r['status'].upper()} ({r['reason']})")
        elif isinstance(r, dict) and r.get("type") == "alert":
            lines.append(f"   ALERT to controller: {r['text']}")
        elif isinstance(r, dict) and r.get("type") == "question":
            lines.append(f"   question to controller ({r['q_id']})")
    return lines


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2024)
    ap.add_argument("--round", type=int, default=14)
    ap.add_argument("--pace", type=float, default=120.0)
    ap.add_argument("--people", action="store_true", help="let Dana and Priya answer automatically")
    args = ap.parse_args()
    run = new_run(args.season, auto_people=True)  # Dana and Priya clear the backlog while history fast-forwards
    weekend = ("race_provisional", "fia_document", "race_final")
    run.run_until(lambda e: e["type"] in weekend and e["payload"]["round"] >= args.round)
    run.router.auto_people = args.people  # from here on, a person approves (UI, Slack, email) unless --people
    print(f"Season {args.season} booked through R{args.round - 1}. Books tie: {run.ledger.trial_balance()['ties']}\n")
    prev = None
    while run.cursor < len(run.events):
        nxt = run.events[run.cursor]
        if nxt["type"] in weekend and nxt["payload"]["round"] > args.round:
            break
        if prev:
            time.sleep(min(10.0, max(0.0, (_t(nxt["at"]) - _t(prev)).total_seconds() / args.pace)))
        event, results = run.step()
        prev = event["at"]
        for line in narrate(event, results):
            print(f"{event['at'][11:16]}Z  {line}")
    print(f"\nRun {run.run_id}. Books tie: {run.ledger.trial_balance()['ties']}")


if __name__ == "__main__":
    main()
