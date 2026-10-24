# Meridian Pit Wall agents (Fetch.ai Agentverse)

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Two agents that let a Formula 1 team's books talk to the outside world.

| Agent | Role | Protocols | Address |
| --- | --- | --- | --- |
| **meridian-pit-wall** | Meridian Racing's revenue accountant. Answers questions about the books on ASI:One, and collects bonus invoices from sponsors agent to agent | Agent Chat Protocol; Agent Payment Protocol (seller) | `PITWALL_AGENT_ADDRESS` (printed at start; see below) |
| **sponsor-ap-desk** | A sponsor's accounts-payable agent. Pays a bonus invoice only after checking it against its own contract and the public race result | Agent Payment Protocol (buyer); Agent Chat Protocol | `SPONSOR_AGENT_ADDRESS` (printed at start) |

## What it does

**Ask the books.** On ASI:One, ask "What happened at Spa?" and Pit Wall answers from its ledger:
- At 14:40 the provisional result showed Russell first.
- The FIA summoned car 63 at 16:23, and Pit Wall alerted the controller that about $2.76M of bonuses were at risk.
- At 17:56 the final classification disqualified Russell. Five bonuses were never booked; Hamilton's were booked instead.

Other questions it answers:
- "How much revenue have we booked?"
- "What's waiting for approval?"
- "What does Halcyon owe us?"
- "Run an audit"
- "How much time did you save?"
- "Which invoices are unpaid?"

Every figure comes from the Pit Wall API. ASI:One's model (when a key is set) only works out which question you asked.

**Get paid, agent to agent.**
1. Pit Wall sends each open bonus invoice as a `RequestPayment`, carrying the evidence a payer needs: contract clause, car, round, session, and when the result became final.
2. The sponsor's agent doesn't take Meridian's word for it. It checks:
   - its own copy of the contract (the clause, its scope, the amount)
   - the race result from the public Jolpica-F1 API
   - that the invoice came after the final classification
   - that it hasn't paid this bonus before
3. It then sends `CommitPayment` or `RejectPayment` with the reason.
4. On commit, Pit Wall books the cash **through its kernel** (the same checks as every entry, so an agent can't pay more than is owed or at the wrong FX rate) and replies with `CompletePayment`. If the kernel refuses, it replies with `CancelPayment` and the reason.

**What agents can't do.** Neither agent can approve an entry. Ask Pit Wall to "approve je_..." and it explains that approvals need a named person, and that the ledger refuses agents (kernel check K11).

## Run it

```bash
pip install -r agents/fetchai/requirements.txt
uvicorn finance.api:app --port 8000                                   # Pit Wall API (from the repo root)
curl -s -XPOST localhost:8000/api/runs -H 'content-type: application/json' -d '{"season": 2024, "cash": false}'

cp agents/fetchai/.env.example agents/fetchai/.env                     # set your own seeds
python agents/fetchai/sponsor_agent.py                                 # prints its address
# put that address in agents/fetchai/.env as SPONSOR_AGENT=agent1q...
python agents/fetchai/pitwall_agent.py                                 # prints its address
```

Then, in a fourth terminal, the dispute demo. Someone bills Russell's Spa win on the provisional result, and the sponsor's agent refuses on its own evidence:

```bash
python agents/fetchai/demo_dispute.py
# SPONSOR REJECTED: BR-2024-SPA-EARLY: Not paying: car 63 is classified DSQ (Disqualified), which does not earn a
# win bonus; invoice predates the final classification
```

Each agent prints an Agent Inspector link. Open it, click **Connect → Mailbox**, then **Agent Profile** to see it on Agentverse. Find it from ASI:One by searching "Meridian Pit Wall" or by its address. Offline test without Agentverse: `AGENT_MAILBOX=0`.

Optional: `ASI1_API_KEY` (from asi1.ai) lets ASI:One's `asi1` model parse questions. Without it, a keyword parser does the same job.

## Tested

`python -m pytest agents/fetchai/tests` (12 tests) covers:
- the sponsor's checks (the DSQ win, duplicates, an uncovered sprint, a wrong amount, an unknown clause);
- question parsing;
- answers drawn from the live books;
- recovery after the API restarts;
- a full run of both agents in one uAgents Bureau, settling invoices end to end with every payment booked through the kernel.

## Honest limits

- Meridian Racing, its sponsors and contracts are fictional. The 2024 race results and FIA documents are real.
- Money movement is simulated: the transaction ID is a remittance reference, not a bank or on-chain transfer. The protocol messages and the booking through the kernel are real.

## Agents

- meridian-pit-wall: `agent1...` (fill in after first run)
- sponsor-ap-desk: `agent1...` (fill in after first run)
- ASI:One chat session: (link)
- Demo video: (link)
