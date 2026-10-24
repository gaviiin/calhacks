"""'Why?': a plain-English account of an entry, built only from what was stored when it was made.

The explainer adds no new reasoning. With PITWALL_AGENT=claude it may smooth the
wording, but the facts, numbers and citations come from the decision record.
"""

from __future__ import annotations

from .agents.llm import LLM
from .money import fmt

LABEL = {"race_result": "Race result", "contract": "Contract", "policy": "Policy", "fia_document": "FIA document",
         "stewards_decision": "Stewards' decision", "billing_request": "Billing request", "journal_entry": "Earlier entry",
         "standings": "Championship standings", "person": "Person", "fx": "FX rate", "schedule": "Race schedule"}


def explain(ledger, je_id: str, llm: LLM | None = None) -> dict:
    e = ledger.entry(je_id)
    d = e["decision"] or {}
    lines = [f"{x['account']} {'Dr' if x['debit_cents'] else 'Cr'} {fmt(x['debit_cents'] or x['credit_cents'])}"
             + (f" ({fmt(x['orig_amount_cents'], x['orig_currency'])} at {x['fx_rate']})" if x["fx_rate"] else "") for x in e["lines"]]
    evidence = []
    for ev in d.get("evidence", []):
        bits = [LABEL.get(ev["type"], ev["type"]), ev.get("ref") or ev.get("url", "")]
        if ev.get("version"):
            bits.append(f"({ev['version']})")
        if ev.get("quote"):
            bits.append(f'"{ev["quote"]}"')
        if ev.get("text"):
            bits.append(ev["text"])
        evidence.append(" ".join(b for b in bits if b))
    failed = [c for c in e["checks"] if c["result"] != "pass"]
    status = {
        "posted": f"Posted {e['posted_at']}.",
        "parked": f"Waiting for {' and '.join(e['needs'])} approval: {e['reason']}",
        "refused": f"Refused by the kernel: {e['reason']}",
        "rejected": f"Rejected: {e['reason']}",
    }.get(e["status"], e["status"])
    approvals = [f"{a['role']} {a['approver']} {a['decision']}d at {a['at']}" + (f": {a['reason']}" if a["reason"] else "") for a in e["approvals"]]
    text = (f"{e['memo']}. {d.get('answer', '')} "
            f"Policy {', '.join(d.get('policy_ids', []))}. "
            f"Prepared by {e['preparer']} at {e['recorded_at']} (world date {e['effective_date']}). {status}")
    if approvals:
        text += " " + "; ".join(approvals) + "."
    if not failed:
        text += f" All {len(e['checks'])} kernel checks passed."
    backend = "scripted"
    if llm is not None and llm.enabled:
        res = llm.complete("Rewrite for a controller in 3 sentences. Keep every number, ID and quote exactly:\n" + text,
                           fallback=text, purpose="explain", at=ledger.clock)
        text, backend = res.text, res.backend
    return {"je_id": je_id, "text": text, "lines": lines, "evidence": evidence, "checks": e["checks"],
            "policy_ids": d.get("policy_ids", []), "status": e["status"], "backend": backend}
