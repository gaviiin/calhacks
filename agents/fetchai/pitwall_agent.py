"""Meridian Pit Wall on Agentverse: ask the books anything on ASI:One, and collect bonus invoices agent to agent.

    python agents/fetchai/pitwall_agent.py

Two protocols:
- Agent Chat Protocol (ASI:One compatible): questions about revenue, a race weekend, approvals, sponsors,
  the independent audit, impact, open invoices. Numbers come only from the Pit Wall API.
- Agent Payment Protocol, role seller: every PITWALL_COLLECT_EVERY seconds, each open bonus invoice is sent as a
  RequestPayment to the sponsor's accounts-payable agent, with the evidence it needs to check the claim.
  CommitPayment -> Pit Wall books the cash through its kernel -> CompletePayment (or CancelPayment if the kernel refuses).
  RejectPayment -> recorded against the invoice with the sponsor's reason, for the controller to read.

The agent never approves entries: it has no approval path, and the ledger refuses agents (K11).
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
    StartSessionContent,
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

from brain import respond  # noqa: E402
from pitwall_client import PitWall  # noqa: E402

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

agent = Agent(
    name=os.environ.get("PITWALL_AGENT_NAME", "meridian-pit-wall"),
    seed=os.environ.get("PITWALL_AGENT_SEED", "meridian pit wall revenue agent: change this seed"),
    port=int(os.environ.get("PITWALL_AGENT_PORT", "8011")),
    mailbox=os.environ.get("AGENT_MAILBOX", "1") == "1",
    publish_agent_details=True,
    readme_path=str(HERE / "README.md"),
    description="Revenue accountant for an F1 team: real race results to booked revenue, sponsor bonus invoices, independent audit.",
)

pw = PitWall()
chat = Protocol(spec=chat_protocol_spec)
seller = Protocol(spec=payment_protocol_spec, role="seller")


def llm():
    key = os.environ.get("ASI1_API_KEY")
    if not key:
        return None
    from openai import OpenAI

    return OpenAI(base_url="https://api.asi1.ai/v1", api_key=key)


LLM = llm()


def text_message(text: str, end: bool = False) -> ChatMessage:
    content = [TextContent(type="text", text=text)] + ([EndSessionContent(type="end-session")] if end else [])
    return ChatMessage(timestamp=datetime.now(UTC), msg_id=uuid4(), content=content)


# ------------------------------------------------------------------------------------- chat


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(UTC), acknowledged_msg_id=msg.msg_id))
    text = " ".join(c.text for c in msg.content if isinstance(c, TextContent)).strip()
    if any(isinstance(c, StartSessionContent) for c in msg.content) and not text:
        await ctx.send(sender, text_message(respond("help", pw, LLM)))
        return
    ctx.logger.info(f"[inbound] {sender[:16]}: {text[:120]}")
    reply = respond(text, pw, LLM)
    ctx.logger.info(f"[outbound] {len(reply)} chars")
    await ctx.send(sender, text_message(reply, end=True))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass


# ------------------------------------------------------------------------------------- collecting invoices (seller)


def payer_for(sponsor_id: str) -> str | None:
    """SPONSOR_AGENT_<ID> for one sponsor, else SPONSOR_AGENT for a shared accounts-payable desk."""
    return os.environ.get(f"SPONSOR_AGENT_{sponsor_id.upper()}") or os.environ.get("SPONSOR_AGENT") or None


def request_for(inv: dict, me: str) -> RequestPayment:
    meta = {k: str(inv[k]) for k in ("request_id", "invoice_je_id", "sponsor_id", "season", "round", "session", "car", "clause_id",
                                     "amount_orig", "currency", "contract_ref", "final_classification_at", "invoiced_at")}
    meta["contract_quote"] = (inv.get("contract_quote") or "")[:300]
    meta["run_id"] = pw.ensure_run()
    return RequestPayment(
        accepted_funds=[Funds(amount=f"{inv['amount_orig'] / 100:.2f}", currency=inv["currency"],
                              payment_method=os.environ.get("PITWALL_PAYMENT_METHOD", "bank_transfer"))],
        recipient=me, deadline_seconds=int(os.environ.get("PITWALL_PAYMENT_DEADLINE", "86400")), reference=inv["request_id"],
        description=f"Meridian Racing bonus invoice {inv['request_id']}: {inv['sponsor']} clause {inv['clause_id']}, car {inv['car']}, "
                    f"{inv['season']} R{inv['round']} {inv['session']}, {inv['amount']}",
        metadata=meta)


@agent.on_interval(period=float(os.environ.get("PITWALL_COLLECT_EVERY", "60")))
async def collect(ctx: Context):
    if os.environ.get("PITWALL_COLLECT", "1") != "1":
        return
    key = f"requested:{pw.ensure_run()}"  # per run: a new replay reuses invoice numbers
    sent = ctx.storage.get(key) or []
    try:
        open_invoices = pw.invoices("open")
    except Exception as exc:  # noqa: BLE001
        ctx.logger.warning(f"Pit Wall API not reachable: {exc}")
        return
    batch = int(os.environ.get("PITWALL_COLLECT_BATCH", "3"))
    for inv in [i for i in open_invoices if i["request_id"] not in sent and i["payment"]["status"] == "unpaid"][:batch]:
        to = payer_for(inv["sponsor_id"])
        if not to:
            continue
        ctx.logger.info(f"[outbound] RequestPayment {inv['request_id']} {inv['amount']} -> {inv['sponsor_id']}")
        await ctx.send(to, request_for(inv, ctx.agent.address))
        sent.append(inv["request_id"])
    ctx.storage.set(key, sent)


@seller.on_message(CommitPayment)
async def on_commit(ctx: Context, sender: str, msg: CommitPayment):
    rid = msg.reference or ""
    inv = next((i for i in pw.invoices("all") if i["request_id"] == rid), None)
    if inv is None or msg.funds.currency != inv["currency"] or round(float(msg.funds.amount) * 100) != inv["amount_orig"]:
        await ctx.send(sender, CancelPayment(transaction_id=msg.transaction_id, reason="commit does not match the invoice amount or currency"))
        return
    pw.payment(rid, "committed", payer=sender, transaction_id=msg.transaction_id)
    out = pw.payment(rid, "completed", payer=sender, transaction_id=msg.transaction_id)
    if out.get("ok"):
        ctx.logger.info(f"[state] {rid} paid; {out['text']}")
        await ctx.send(sender, CompletePayment(transaction_id=msg.transaction_id))
    else:
        ctx.logger.warning(f"[state] {rid} not booked: {out['text']}")
        await ctx.send(sender, CancelPayment(transaction_id=msg.transaction_id, reason=out["text"][:200]))


@seller.on_message(RejectPayment)
async def on_reject(ctx: Context, sender: str, msg: RejectPayment):
    reason = msg.reason or "no reason given"
    rid = reason.split(":", 1)[0] if reason.startswith("BR-") else None
    ctx.logger.info(f"[inbound] RejectPayment: {reason[:160]}")
    if rid:
        try:
            pw.payment(rid, "rejected", payer=sender, reason=reason)
        except Exception as exc:  # noqa: BLE001
            ctx.logger.warning(f"could not record rejection: {exc}")


agent.include(chat, publish_manifest=True)
agent.include(seller, publish_manifest=True)

if __name__ == "__main__":
    print(f"Pit Wall agent address: {agent.address}")
    agent.run()
