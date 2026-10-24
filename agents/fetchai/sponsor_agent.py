"""A sponsor's accounts-payable agent: pays a Meridian bonus invoice only after checking it independently.

    python agents/fetchai/sponsor_agent.py

Agent Payment Protocol, role buyer. On RequestPayment it checks the claim itself (agents/fetchai/verify.py):
its own copy of the contract, the race result from the public Jolpica-F1 API, timing, and duplicates.
Then it sends CommitPayment, or RejectPayment with the reason ("BR-2024-053: car 63 is classified D ...").

It also speaks the Chat Protocol, so on ASI:One you can ask it "what have you paid?" or "why did you reject BR-2024-061?".

Money movement is simulated: the transaction id is a remittance reference, not a bank or chain transfer.
"""

from __future__ import annotations

import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv  # noqa: E402
from uagents import Agent, Context, Protocol  # noqa: E402
from uagents_core.contrib.protocols.chat import (  # noqa: E402
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.contrib.protocols.payment import (  # noqa: E402
    CancelPayment,
    CommitPayment,
    CompletePayment,
    Funds,
    RejectPayment,
    RequestPayment,
    payment_protocol_spec,
)

from verify import check_invoice  # noqa: E402

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
SPONSORS = [s.strip() for s in os.environ.get("SPONSOR_IDS", "halcyon,volta,arcadia,northwind,ridgeline").split(",") if s.strip()]

agent = Agent(
    name=os.environ.get("SPONSOR_AGENT_NAME", "sponsor-ap-desk"),
    seed=os.environ.get("SPONSOR_AGENT_SEED", "sponsor accounts payable desk: change this seed"),
    port=int(os.environ.get("SPONSOR_AGENT_PORT", "8012")),
    mailbox=os.environ.get("AGENT_MAILBOX", "1") == "1",
    publish_agent_details=True,
    readme_path=str(HERE / "README.md"),
    description="Sponsor accounts-payable agent: verifies F1 bonus invoices against the contract and public race results before paying.",
)
buyer = Protocol(spec=payment_protocol_spec, role="buyer")
chat = Protocol(spec=chat_protocol_spec)


def ledger(ctx: Context) -> dict:
    return ctx.storage.get("ap_ledger") or {"paid": {}, "rejected": {}, "pending": {}}


def ref(meta: dict, fallback: str = "?") -> str:
    """Invoice numbers restart with each Pit Wall run, so the payer keys what it has paid by run and number."""
    rid = meta.get("request_id") or fallback
    return f"{meta['run_id']}:{rid}" if meta.get("run_id") else rid


def decide(meta: dict, book: dict, offline: bool = False):
    inv = {**meta, "reference": ref(meta)}
    return check_invoice(inv, set(book["paid"]), offline=offline)


@buyer.on_message(RequestPayment)
async def on_request(ctx: Context, sender: str, msg: RequestPayment):
    meta = {k: v for k, v in (msg.metadata or {}).items() if isinstance(v, str)}
    rid = msg.reference or meta.get("request_id", "?")
    book = ledger(ctx)
    if meta.get("sponsor_id") not in SPONSORS:
        await ctx.send(sender, RejectPayment(reason=f"{rid}: this desk does not pay for {meta.get('sponsor_id')}"))
        return
    if not msg.accepted_funds:
        await ctx.send(sender, RejectPayment(reason=f"{rid}: no accepted funds"))
        return
    v = decide(meta, book, offline=os.environ.get("VERIFY_OFFLINE", "0") == "1")
    ctx.logger.info(f"[state] {rid} {'PAY' if v.pay else 'REJECT'}: {v.summary()[:200]}")
    if not v.pay:
        book["rejected"][ref(meta, rid)] = v.summary()
        ctx.storage.set("ap_ledger", book)
        await ctx.send(sender, RejectPayment(reason=f"{rid}: {v.summary()}"[:500]))
        return
    funds = msg.accepted_funds[0]
    tx = f"remit-{meta['sponsor_id']}-{uuid4().hex[:10]}"
    book["pending"][ref(meta, rid)] = {"tx": tx, "amount": funds.amount, "currency": funds.currency, "why": v.summary()}
    ctx.storage.set("ap_ledger", book)
    await ctx.send(sender, CommitPayment(funds=Funds(amount=funds.amount, currency=funds.currency, payment_method=funds.payment_method),
                                         recipient=msg.recipient, transaction_id=tx, reference=rid, description=msg.description,
                                         metadata={"verified": v.summary()[:400]}))


@buyer.on_message(CompletePayment)
async def on_complete(ctx: Context, sender: str, msg: CompletePayment):
    book = ledger(ctx)
    rid = next((r for r, p in book["pending"].items() if p["tx"] == msg.transaction_id), None)
    if rid:
        book["paid"][rid] = book["pending"].pop(rid)
        ctx.storage.set("ap_ledger", book)
        ctx.logger.info(f"[state] {rid} settled ({msg.transaction_id})")


@buyer.on_message(CancelPayment)
async def on_cancel(ctx: Context, sender: str, msg: CancelPayment):
    book = ledger(ctx)
    rid = next((r for r, p in book["pending"].items() if p["tx"] == msg.transaction_id), None)
    if rid:
        book["pending"].pop(rid)
        book["rejected"][rid] = f"cancelled by Meridian: {msg.reason}"
        ctx.storage.set("ap_ledger", book)


def chat_answer(text: str, book: dict) -> str:
    t = text.lower()
    rid = next((w.strip(".,?") for w in text.split() if w.upper().startswith("BR-")), None)
    if rid:
        rid = rid.upper()
        for state in ("paid", "rejected", "pending"):
            hits = [k for k in book[state] if k == rid or k.endswith(":" + rid)]
            if hits:
                entry = book[state][hits[-1]]
                return f"{rid} is {state}: " + (entry["why"] if isinstance(entry, dict) else entry)
        return f"I have no invoice {rid}."
    if "reject" in t:
        items = list(book["rejected"].items())[-5:]
        return "Rejected invoices:\n" + "\n".join(f"- {r}: {why[:200]}" for r, why in items) if items else "I haven't rejected anything."
    paid = book["paid"]
    totals: dict[str, float] = {}
    for p in paid.values():
        totals[p["currency"]] = totals.get(p["currency"], 0) + float(p["amount"])
    return (f"I pay Meridian Racing bonus invoices for {', '.join(SPONSORS)} after checking each one against the contract and the public "
            f"race result. Paid {len(paid)} ({', '.join(f'{v:,.2f} {k}' for k, v in totals.items()) or 'nothing yet'}), "
            f"rejected {len(book['rejected'])}, pending {len(book['pending'])}. Ask about one: \"why did you reject BR-2024-SPA-EARLY?\"")


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(UTC), acknowledged_msg_id=msg.msg_id))
    text = " ".join(c.text for c in msg.content if isinstance(c, TextContent))
    await ctx.send(sender, ChatMessage(timestamp=datetime.now(UTC), msg_id=uuid4(),
                                       content=[TextContent(type="text", text=chat_answer(text, ledger(ctx))),
                                                EndSessionContent(type="end-session")]))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


agent.include(buyer, publish_manifest=True)
agent.include(chat, publish_manifest=True)

if __name__ == "__main__":
    print(f"Sponsor AP agent address: {agent.address}")
    agent.run()
