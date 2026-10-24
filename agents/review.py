"""Review: the human reviewers' desk from the command line. Identities: head_of_cost_cap, controller.

This is the human side of the system of work, for runs without the dashboard. Nothing here is an
agent: it acts only when a person runs it, and every call still goes through the module's roles
matrix, so a controller approval above materiality is denied and logged like any other.

  policies                       list PROPOSED policies (parents first)
  policies --approve-all         approve them all as the Head of Cost Cap, except any named in
                                 --reject KEY=REASON (repeatable), which are rejected with REASON
  items                          list PROPOSED work items
  items --approve-all            approve them: the controller below materiality, the Head of Cost
                                 Cap at or above it (SCHEMA §2)

Usage:
  uv run python -m agents.review policies --approve-all --reject "acct:6110=lubricants are not FIA fuel"
  uv run python -m agents.review items --approve-all
"""

from __future__ import annotations

import argparse
import sys

from . import identities
from . import reducers as R
from .stdb import StdbClient


def _setting(stdb: StdbClient, token: str, key: str) -> str | None:
    rows = stdb.sql(token, f"SELECT value FROM setting WHERE key = '{key}'")
    return rows[0]["value"] if rows else None


def proposed_policies(stdb: StdbClient, token: str) -> list[dict]:
    rows = stdb.sql(token, "SELECT * FROM policy WHERE state = 'PROPOSED'")
    return sorted(rows, key=lambda r: int(r["id"]))


def proposed_items(stdb: StdbClient, token: str) -> list[dict]:
    rows = stdb.sql(token, "SELECT * FROM work_item WHERE state = 'PROPOSED'")
    return sorted(rows, key=lambda r: int(r["id"]))


def review_policies(stdb: StdbClient, approve_all: bool, rejects: dict[str, str]) -> int:
    head = identities.get("head_of_cost_cap")
    rows = proposed_policies(stdb, head.token)
    approved = rejected = 0
    for p in rows:
        key = p["policy_key"]
        line = f"{int(p['id']):>5} {key:<44} -> {p['category_code']:<28} n={p['precedent_count']}"
        if not approve_all:
            print(line)
            continue
        if key in rejects:
            stdb.call(head.token, R.REJECT_POLICY, R.reject_policy(int(p["id"]), rejects[key]))
            rejected += 1
            print(f"{line}  REJECTED: {rejects[key]}")
        else:
            stdb.call(head.token, R.APPROVE_POLICY,
                      R.approve_policy(int(p["id"]), "reviewed against 2025 practice and the rulebook"))
            approved += 1
    unknown = set(rejects) - {p["policy_key"] for p in rows}
    for key in sorted(unknown):
        print(f"warning: --reject {key!r} matched no PROPOSED policy", file=sys.stderr)
    print(f"{len(rows)} proposed" + (f", {approved} approved, {rejected} rejected" if approve_all else ""))
    return 0


def review_items(stdb: StdbClient, approve_all: bool) -> int:
    controller = identities.get("controller")
    head = identities.get("head_of_cost_cap")
    materiality = int(_setting(stdb, controller.token, "materiality_usd_minor") or 0)
    rows = proposed_items(stdb, controller.token)
    by_role = {"controller": 0, "head_of_cost_cap": 0}
    for it in rows:
        amount = int(it["amount_usd_minor"])
        line = f"{int(it['id']):>6} {it['subject_ref']:<14} {amount / 100:>14,.2f} -> {it.get('proposed_category_code')}"
        if not approve_all:
            print(line)
            continue
        actor = head if materiality and abs(amount) >= materiality else controller
        stdb.call(actor.token, R.APPROVE, R.approve(int(it["id"]), f"reviewed by {actor.name}"))
        by_role[actor.name] += 1
    if approve_all:
        left = len(proposed_items(stdb, controller.token))
        print(f"{len(rows)} proposed: {by_role['controller']} approved by the controller, "
              f"{by_role['head_of_cost_cap']} by the Head of Cost Cap, {left} still PROPOSED")
    else:
        print(f"{len(rows)} proposed")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.review",
                                 description="Human review of proposed policies and work items.")
    ap.add_argument("what", choices=["policies", "items"])
    ap.add_argument("--approve-all", action="store_true")
    ap.add_argument("--reject", action="append", default=[], metavar="KEY=REASON",
                    help="policies only: reject this policy_key with REASON instead of approving it")
    args = ap.parse_args(argv)
    stdb = StdbClient()
    if args.what == "policies":
        rejects = dict(r.split("=", 1) for r in args.reject)
        return review_policies(stdb, args.approve_all, rejects)
    if args.reject:
        ap.error("--reject applies to policies only")
    return review_items(stdb, args.approve_all)


if __name__ == "__main__":
    sys.exit(main())
