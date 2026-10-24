"""Demo: someone bills a bonus on the provisional result. The sponsor's agent refuses, on its own evidence.

    python agents/fetchai/demo_dispute.py            # needs SPONSOR_AGENT in agents/fetchai/.env

Sends one RequestPayment, the kind a hurried commercial team would send at 14:45 on Sunday at Spa 2024:
Russell's win, $2,000,000 from Halcyon, before the FIA disqualified him. Pit Wall itself would never send
this (it holds billing until the Final Classification); the point is that the payer checks independently too.
Prints the sponsor agent's RejectPayment reason, then exits.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.payment import (
    CommitPayment,
    Funds,
    RejectPayment,
    RequestPayment,
    payment_protocol_spec,
)

load_dotenv(Path(__file__).resolve().parent / ".env")
TO = os.environ.get("SPONSOR_AGENT")
if not TO:
    sys.exit("set SPONSOR_AGENT (the sponsor agent's address) in agents/fetchai/.env")

agent = Agent(name="hurried-billing-clerk", seed=os.environ.get("DISPUTE_AGENT_SEED", "hurried billing clerk demo seed"),
              port=int(os.environ.get("DISPUTE_AGENT_PORT", "8013")), mailbox=os.environ.get("AGENT_MAILBOX", "1") == "1")
proto = Protocol(spec=payment_protocol_spec, role="seller")
INVOICE = {"request_id": "BR-2024-SPA-EARLY", "sponsor_id": "halcyon", "season": "2024", "round": "14", "session": "race", "car": "63",
           "clause_id": "4.1", "amount_orig": "200000000", "currency": "USD", "contract_ref": "halcyon_v2",
           "final_classification_at": "2024-07-28T17:56:00Z", "invoiced_at": "2024-07-28T14:45:00Z"}


@agent.on_event("startup")
async def send(ctx: Context):
    ctx.logger.info("Billing Halcyon $2,000,000 for Russell's Spa win, on the provisional result...")
    await ctx.send(TO, RequestPayment(accepted_funds=[Funds(amount="2000000.00", currency="USD", payment_method="bank_transfer")],
                                      recipient=ctx.agent.address, deadline_seconds=3600, reference=INVOICE["request_id"],
                                      description="Win bonus, Belgian GP 2024, car 63 (Russell)", metadata=INVOICE))


@proto.on_message(RejectPayment)
async def rejected(ctx: Context, sender: str, msg: RejectPayment):
    print(f"\nSPONSOR REJECTED: {msg.reason}\n")
    os._exit(0)


@proto.on_message(CommitPayment)
async def committed(ctx: Context, sender: str, msg: CommitPayment):
    print("\nSponsor committed payment (unexpected for this claim)\n")
    os._exit(1)


agent.include(proto)

if __name__ == "__main__":
    agent.run()
