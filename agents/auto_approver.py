"""Standing approvals: approve what an approved rule decided, so people see only what no rule covers.
Identity: auto_approver (role auto_approver).

The module decides; this job only asks. For every PROPOSED work item a rule backs it calls approve as
the auto_approver:

  * a deterministic proposal citing an approved policy (for a split invoice, every bill-line
    allocation's policy), which the Head of Cost Cap approved at onboarding or a person taught; or
  * a proposal built from a person's answer on that very line (human_text).

The module re-checks each one (the policy is APPROVED, in force and keeps its standing approval; the
head revokes it to send that policy's lines back to people) and logs the approval with the policy and
the person behind it. Everything else waits for a person: a Claude proposal on a line no rule covered,
a reversal, a related-party adjustment. Amount is not a reason to wait: every decision is in the audit
log for the Head of Cost Cap to review.

Usage:
  uv run python -m agents.auto_approver --once
"""

from __future__ import annotations

import argparse
import sys

from . import identities
from . import reducers as R
from .cap_analyst import sim_date_or_unknown
from .recorder import Recorder
from .stdb import StdbClient


def backing(item: dict) -> str | None:
    """Why a rule backs this proposal ('policy', 'allocations', 'answer'), or None: a person decides."""
    source = item.get("proposal_source")
    if source == "human_text":
        return "answer" if item.get("answered_by") else None
    if source != "deterministic" or item.get("kind") != "classification":
        return None
    if item.get("proposed_category_code") == "ALLOCATED":
        return "allocations"
    return "policy" if item.get("proposed_policy_id") is not None else None


def run_once(stdb: StdbClient, rec: Recorder, actor: identities.Actor) -> dict:
    tok = actor.token
    items = sorted(stdb.sql(tok, "SELECT * FROM work_item WHERE state = 'PROPOSED'"), key=lambda r: int(r["id"]))
    policies = {int(p["id"]): p for p in stdb.sql(tok, "SELECT * FROM policy")}
    labels = {r["identity"]: r["label"] for r in stdb.sql(tok, "SELECT * FROM role")}
    counts = {"approved": 0, "refused": 0, "left": 0}
    for it in items:
        wid = int(it["id"])
        why = backing(it)
        if why is None:
            counts["left"] += 1
            rec.record("decision", "leave_for_a_person", {"work_item_id": wid, "proposal_source": it.get("proposal_source"),
                                                          "why": "no approved rule decided this line"}, work_item_id=wid)
            continue
        if why == "policy":
            pol = policies.get(int(it["proposed_policy_id"])) or {}
            by = labels.get(pol.get("decided_by"), "a person")
            reason = f"standing approval: {pol.get('policy_key')} v{pol.get('version')} (approved by {by})"
        elif why == "allocations":
            reason = "standing approval: every split of this invoice is decided by an approved policy"
        else:
            reason = f"standing approval: proposal built from {labels.get(it.get('answered_by'), 'a person')}'s answer on this line"
        rec.record("decision", "standing_approval", {"work_item_id": wid, "backing": why, "reason": reason}, work_item_id=wid)
        stdb.call(tok, R.APPROVE, R.approve(wid, reason))
        after = stdb.sql(tok, f"SELECT * FROM work_item WHERE id = {wid}")
        if after and after[0]["state"] == "APPROVED":
            counts["approved"] += 1
        else:
            counts["refused"] += 1
    return counts


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.auto_approver",
                                 description="Approve what an approved rule decided (identity: auto_approver).")
    ap.add_argument("--once", action="store_true", help="go through the PROPOSED queue once and exit (default)")
    ap.parse_args(argv)
    stdb = StdbClient()
    actor = identities.get("auto_approver")
    rec = Recorder(actor, stdb, sim_date_or_unknown())
    with rec.run("auto_approver", {}):
        counts = run_once(stdb, rec, actor)
    print(f"{counts['approved']} approved under standing approval, {counts['refused']} refused by the module, "
          f"{counts['left']} left for a person")
    return 0


if __name__ == "__main__":
    sys.exit(main())
