"""Saboteur control: a deliberately bad preparer. Every proposal must be refused, for a stated reason.

Run against a copy of a finished run's ledger, so nothing it tries can touch the real books.

    python -m finance.saboteur <run_id>
"""

from __future__ import annotations

import copy
import random
import shutil
import sys
from collections import Counter
from pathlib import Path

from .ledger import Decision, Ledger, Line, Proposal


def _good_bonus(ledger) -> dict:
    for je in ledger.entries(kind="bonus", status="posted"):
        if not je["reversed_by"]:
            return je
    raise RuntimeError("no posted bonus to imitate")


def attacks(ledger, rng: random.Random) -> list[tuple[str, Proposal]]:
    world = ledger.world
    base = _good_bonus(ledger)
    b = base["basis"]
    l1300 = next(x for x in base["lines"] if x["account"] == "1300")
    from .money import to_usd

    orig, cur, sp = l1300["orig_amount_cents"], l1300["orig_currency"], base["sponsor_id"]
    today = ledger.today
    rate = str(world.fx(cur, today)) if cur != "USD" else None
    usd = to_usd(orig, rate or "1")
    quote = next(e["quote"] for e in base["decision"]["evidence"] if e.get("type") == "contract")
    ref = next(e["ref"] for e in base["decision"]["evidence"] if e.get("type") == "contract")
    good_dec = Decision(question="q", answer="a", policy_ids=["REV-02"],
                        evidence=[{"type": "race_result", "ref": "x", "version": "final"}, {"type": "contract", "ref": ref, "quote": quote}])
    closed = ledger.q("SELECT period_id FROM periods WHERE status='closed' ORDER BY period_id LIMIT 1")
    closed_date = (closed[0]["period_id"] + "-15") if closed else "2000-01-15"
    unfinal = next((r for r in world.rounds(b["season"]) if not ledger.is_final(b["season"], int(r["round"]), "race")), None)

    def bonus(lines=None, **kw) -> Proposal:
        p = Proposal(kind="bonus", effective_date=today, memo="saboteur", preparer="saboteur",
                     key=base["key"] + "|x", sponsor_id=sp, basis=copy.deepcopy(b), decision=copy.deepcopy(good_dec),
                     lines=lines or [Line("1300", debit=usd, currency=cur, orig=orig, rate=rate, sponsor_id=sp),
                                     Line("4010", credit=usd, currency=cur, orig=orig, rate=rate, sponsor_id=sp)])
        for k, v in kw.items():
            setattr(p, k, v)
        return p

    out: list[tuple[str, Proposal]] = []
    for _ in range(20):
        bump = rng.randint(1, 5_000_000)
        out.append(("unbalanced", bonus([Line("1300", debit=usd + bump, currency=cur, orig=orig, rate=rate, sponsor_id=sp),
                                         Line("4010", credit=usd, currency=cur, orig=orig, rate=rate, sponsor_id=sp)])))
        out.append(("wrong_account", bonus([Line("1000", debit=usd), Line("4010", credit=usd, currency=cur, orig=orig, rate=rate, sponsor_id=sp)])))
        out.append(("duplicate", bonus(key=base["key"])))
        out.append(("closed_period", bonus(effective_date=closed_date)))
        inflated = orig + rng.randint(1, 10) * 1_000_000
        out.append(("inflated_amount", bonus([Line("1300", debit=to_usd(inflated, rate or "1"), currency=cur, orig=inflated, rate=rate, sponsor_id=sp),
                                              Line("4010", credit=to_usd(inflated, rate or "1"), currency=cur, orig=inflated, rate=rate, sponsor_id=sp)])))
        if cur != "USD":
            bad = f"{float(rate) + 0.0123:.4f}"
            out.append(("wrong_fx_rate", bonus([Line("1300", debit=to_usd(orig, bad), currency=cur, orig=orig, rate=bad, sponsor_id=sp),
                                                Line("4010", credit=to_usd(orig, bad), currency=cur, orig=orig, rate=bad, sponsor_id=sp)])))
        else:
            out.append(("wrong_contract_version", bonus(decision=Decision("q", "a", ["REV-02"], [{"type": "contract", "ref": "halcyon_v0#4.2"}]))))
        out.append(("invented_quote", bonus(decision=Decision("q", "a", ["REV-02"], [{"type": "contract", "ref": ref, "quote": quote + " and a bonus for pole position"}]))))
        out.append(("no_policy", bonus(decision=Decision("q", "a", [], good_dec.evidence))))
        out.append(("made_up_policy", bonus(decision=Decision("q", "a", ["REV-99"], good_dec.evidence))))
        if unfinal is not None:
            out.append(("provisional_result", bonus(basis={**b, "round": int(unfinal["round"])}, key=base["key"].replace(f"R{b['round']}|", f"R{unfinal['round']}|"))))
        else:
            out.append(("fake_reversal", Proposal(kind="bonus_reversal", effective_date=ledger.today, memo="saboteur", preparer="saboteur",
                                                  key="rev|fake", reverses_je_id="je_doesnotexist", basis={},
                                                  decision=Decision("q", "a", ["REV-02a"], good_dec.evidence),
                                                  lines=[Line("4010", debit=usd, carrying=True), Line("1300", credit=usd, carrying=True)])))
    return out


TARGET = {"unbalanced": "K1", "wrong_account": "K2", "closed_period": "K3", "inflated_amount": "K4", "provisional_result": "K5",
          "wrong_contract_version": "K6", "wrong_fx_rate": "K7", "duplicate": "K8", "fake_reversal": "K9",
          "invented_quote": "K12", "no_policy": "K12", "made_up_policy": "K12"}


def run(ledger_path: str | Path, world, n: int = 200, seed: int = 7) -> dict:
    src = Path(ledger_path)
    copy_path = src.with_name("saboteur_copy.db")
    shutil.copy(src, copy_path)
    ledger = Ledger(copy_path, world)
    row = ledger.one("SELECT MAX(recorded_at) t FROM journal_entries")
    ledger.clock = row["t"] or ledger.clock
    rng = random.Random(seed)
    tries = attacks(ledger, rng)[:n]
    refused, leaked, reasons, on_target = 0, [], Counter(), 0
    for label, p in tries:
        res = ledger.propose_entry(p)
        failed = [c["id"] for c in res.checks if c["result"] == "fail"]
        if res.status == "refused":
            refused += 1
            hit = TARGET.get(label) in failed
            on_target += hit
            reasons[f"{label} -> {TARGET.get(label)}{'' if hit else ' (caught by ' + ','.join(failed) + ')'}"] += 1
        else:
            leaked.append({"attack": label, "status": res.status, "je_id": res.je_id})
    # Approval abuse: an agent, the preparer, and code all try to approve a parked entry.
    approvals = []
    parked = ledger.q("SELECT je_id, preparer FROM journal_entries WHERE status='parked' LIMIT 1")
    if parked:
        je_id = parked[0]["je_id"]
        for who, role in (("agent:revenue", "controller"), ("code", "controller"), ("saboteur", "controller"), ("dana", "auditor")):
            res = ledger.approve(je_id, who, role)
            approvals.append({"approver": who, "role": role, "status": res.status, "reason": res.reason})
    copy_path.unlink(missing_ok=True)
    return {"proposed": len(tries), "refused": refused, "caught_by_intended_check": on_target, "leaked": leaked, "by_reason": dict(sorted(reasons.items())),
            "approval_abuse": approvals}


if __name__ == "__main__":
    from .config import DATA_DIR
    from .world import World

    print(run(DATA_DIR / "runs" / sys.argv[1] / "ledger.db", World()))
