"""Endpoints for outside agents (Fetch.ai Agentverse, ASI:One): invoices, agent payments, and a compact summary.

    GET  /api/runs/{id}/summary                         revenue, receivables, what's waiting, latest audit: one call
    GET  /api/runs/{id}/invoices?status=open            bonus invoices with the evidence a payer needs to check them
    POST /api/runs/{id}/invoices/{request_id}/payment   a payer agent's answer: committed | rejected | completed

A completed payment becomes a cash receipt through the normal write path
(engine -> kernel K1-K12), so an agent can never put money on the books that
the kernel would not accept: it cannot pay more than is owed (K4), and the FX
is re-checked (K7). Payment events are kept in their own table, not in the books.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .ledger import new_id
from .money import fmt

SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_payments (payment_id TEXT PRIMARY KEY, request_id TEXT, event TEXT, payer TEXT,
  transaction_id TEXT, amount_orig INTEGER, currency TEXT, reason TEXT, cash_je_id TEXT, at TEXT);
"""


class PaymentEvent(BaseModel):
    event: str  # committed | rejected | completed
    payer: str = ""
    transaction_id: str | None = None
    reason: str | None = None


def _db(run):
    run.ledger.db.executescript(SCHEMA)
    return run.ledger


def payment_state(led, request_id: str) -> dict:
    rows = led.q("SELECT * FROM agent_payments WHERE request_id=? ORDER BY at, rowid", request_id)
    events = [dict(r) for r in rows]
    status = events[-1]["event"] if events else "unpaid"
    return {"status": "paid" if status == "completed" else status, "events": events}


def invoice(run, b: dict) -> dict:
    led = run.ledger
    je = led.entry(b["je_id"])
    line = next(x for x in je["lines"] if x["account"] == "1200")
    p = b["payload"]
    bonus = led.active_by_key(je["basis"]["bonus_key"]) or {}
    quote = next((e.get("quote") for e in (bonus.get("decision") or {}).get("evidence", []) if e.get("type") == "contract"), None)
    fin = led.one("SELECT finalized_at, source FROM finals WHERE season=? AND round=? AND session=?", p["season"], p["round"], p["session"])
    sponsor = run.world.sponsor(p["sponsor_id"])
    return {
        "request_id": b["request_id"], "invoice_je_id": je["je_id"], "sponsor_id": p["sponsor_id"], "sponsor": sponsor["name"],
        "amount_orig": line["orig_amount_cents"], "currency": line["orig_currency"],
        "amount": fmt(line["orig_amount_cents"], line["orig_currency"]),
        "season": p["season"], "round": p["round"], "session": p["session"], "car": p["car"], "clause_id": p["clause_id"],
        "contract_ref": run.world.contract_for(p["sponsor_id"], p["round"])["contract_ref"], "contract_quote": quote,
        "final_classification_at": fin["finalized_at"] if fin else None, "invoiced_at": je["posted_at"],
        "status": b["status"], "payment": payment_state(led, b["request_id"]),
        "sponsor_receivable_orig": led.ar(p["sponsor_id"])[1],
    }


def build_router(get_run) -> APIRouter:
    r = APIRouter()

    @r.get("/api/runs/{run_id}/summary")
    def summary(run_id: str):
        run = get_run(run_id)
        led = _db(run)
        rev = {"base": 0, "bonus": 0, "prize": 0}
        for e in led.entries(status="posted"):
            stream = {"base_recognition": "base", "bonus": "bonus", "bonus_reversal": "bonus"}.get(
                e["kind"], "prize" if e["kind"].startswith("prize") else None)
            if stream:
                rev[stream] += sum(x["credit_cents"] - x["debit_cents"] for x in e["lines"] if x["account"].startswith("4"))
        from .audit.auditor import latest
        from pathlib import Path

        audit = latest(Path(led.path).parent)
        last = led.last_final_round(run.season)
        rounds = {int(x["round"]): x["name"] for x in run.world.rounds(run.season)}
        return {
            "run_id": run_id, "season": run.season, "clock": led.clock, "last_final_round": last,
            "last_final_race": rounds.get(last), "revenue_cents": rev, "revenue": {k: fmt(v) for k, v in rev.items()},
            "total_revenue": fmt(sum(rev.values())),
            "receivables": {s["id"]: fmt(led.ar(s["id"])[1], s["currency"]) for s in run.world.sponsors},
            "waiting": {"parked_entries": len(led.entries(status="parked")),
                        "open_questions": led.one("SELECT COUNT(*) n FROM questions WHERE status='open'")["n"],
                        "held_billing": len(led.billings("hold"))},
            "books_tie": led.trial_balance()["ties"],
            "audit": {"opinion": audit["opinion"], "findings": audit["summary"]["findings"], "as_of": audit["as_of"]} if audit else None,
            "rounds": rounds,
        }

    @r.get("/api/runs/{run_id}/invoices")
    def invoices(run_id: str, status: str = "open", sponsor_id: str | None = None):
        run = get_run(run_id)
        led = _db(run)
        out = []
        for b in led.billings("billed"):
            if sponsor_id and b["payload"]["sponsor_id"] != sponsor_id:
                continue
            inv = invoice(run, b)
            settled = inv["sponsor_receivable_orig"] < inv["amount_orig"]  # paid by an ordinary remittance already
            if status == "open" and (inv["payment"]["status"] in ("paid", "rejected") or settled):
                continue
            out.append(inv)
        return out

    @r.post("/api/runs/{run_id}/invoices/{request_id}/payment")
    def payment(run_id: str, request_id: str, body: PaymentEvent):
        run = get_run(run_id)
        led = _db(run)
        if body.event not in ("committed", "rejected", "completed"):
            raise HTTPException(400, "event is committed, rejected or completed")
        b = led.billing(request_id)
        if b is None or b["status"] != "billed":
            raise HTTPException(404, f"{request_id} is not an open invoice")
        inv = invoice(run, b)
        state = inv["payment"]["status"]
        if state == "paid":
            return {"ok": False, "status": "paid", "text": "already paid; nothing booked twice"}
        if body.event == "completed" and state != "committed":
            raise HTTPException(409, "a payment must be committed before it completes")
        cash_je, text = None, ""
        if body.event == "completed":
            event = {"id": f"agentpay-{request_id}-{new_id('p')[2:]}", "type": "cash_received", "at": led.clock,
                     "payload": {"sponsor_id": inv["sponsor_id"], "paid_orig": inv["amount_orig"], "source": "agent_payment",
                                 "transaction_id": body.transaction_id, "request_id": request_id}}
            results = run.router.dispatch(event, led)
            res = next((x for x in results if hasattr(x, "status")), None)
            if res is None or res.status != "posted":
                why = res.reason if res is not None else "nothing is owed on this sponsor's account (already settled)"
                return {"ok": False, "status": "refused", "text": f"the kernel did not book the payment: {why}"}
            cash_je, text = res.je_id, f"booked as cash receipt {res.je_id}"
        led.db.execute("INSERT INTO agent_payments VALUES (?,?,?,?,?,?,?,?,?,?)",
                       (new_id("pay"), request_id, body.event, body.payer, body.transaction_id, inv["amount_orig"], inv["currency"],
                        body.reason, cash_je, datetime.now(UTC).isoformat(timespec="seconds")))
        led.db.commit()
        led.emit("agent_payment", {"request_id": request_id, "event": body.event, "payer": body.payer, "cash_je_id": cash_je,
                                   "transaction_id": body.transaction_id, "reason": body.reason})
        return {"ok": True, "status": payment_state(led, request_id)["status"], "cash_je_id": cash_je, "text": text or body.event,
                "invoice": json.loads(json.dumps(invoice(run, led.billing(request_id)), default=str))}

    return r
