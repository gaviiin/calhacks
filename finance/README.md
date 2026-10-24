# Pit Wall finance core

Meridian Racing's autonomous revenue accountant. Real F1 results and real FIA documents drive a double-entry ledger; agents can only propose entries; a deterministic kernel re-checks every one; people approve what matters, from the UI, Slack, email or Teams.

```
FIA captures (Apify) ─┐
Jolpica-F1 results ───┼─► sim (events in real time order) ─► router ─► engine (code tier) ─┐
billing requests ─────┘                                         └──► revenue agent ────────┤
                                                                                           ▼
                                               propose_entry ─► kernel K1-K12 ─► post | park | refuse
                                                                                           │
                    SpacetimeDB mirror (live UI) ◄── ledger listeners ──► notifier (Slack, email, Teams, SMS, webhook)
```

## Setup

```bash
uv pip install --python .venv/bin/python -r finance/requirements.txt
python scripts/fetch_results.py 2023 2024     # needs internet once; caches world/results/*.json
#   -> confirm the printed DSQ candidates match world/result_changes.json, set verified: true
python -m finance.eval generate 2023 2024     # billing requests (world/requests) + hidden answer keys (keys/)
python -m pytest -q finance/tests             # 33 tests on a synthetic fixture season
```

## Run

```bash
python -m finance.sim 2023 --fresh            # training season: each controller ruling becomes the rule for its clause
python -m finance.sim 2024                    # test season: scorecard printed at the end
python -m finance.demo --round 14 --pace 120  # Act 1: replay the real Spa 2024 weekend, narrated
uvicorn finance.api:app --reload --port 8000  # API for the frontend
```

### Demo over HTTP
```
POST /api/runs {"season": 2024, "stop_before_round": 14, "auto_people": false}
POST /api/runs/{id}/advance {"round": 14}              # Spa: hold, alert, reject, book Hamilton's win
GET  /api/runs/{id}/weekend/14                         # FIA documents + Pit Wall's actions on one time axis
POST /api/runs/{id}/scenario {"round": 12, "car": 44}  # Act 2: judge's stewards' decision -> reversals park
POST /api/runs/{id}/approve {"je_id": "...", "approver": "dana", "role": "controller"}
GET  /api/runs/{id}/scorecard | /saboteur | /tape | /queue | /timeline | /sponsors | /outbox
```

## Communication integrations (`finance/notify`, `finance/integrations_api.py`)

| Who | Gets | Can do |
| --- | --- | --- |
| Controller (Dana) | parked judgment entries (estimates, reversals, exceptions, agent-prepared, at any amount), questions, at-risk alerts, credit-note drafts | approve / reject, answer (one ruling becomes the clause's rule), send or discard a sponsor email |
| CFO (Priya) | parked judgment entries of $1M or more, after the controller (SMS too) | approve / reject |
| Commercial (Luis) | billing requests held, rejected, corrected or credited | read why |
| Sponsors | credit notes, **only after the controller approves the draft** | |

Channels: **Slack** (bot token: buttons + reply-in-thread answers; or webhook: text + links), **email** over SMTP (Gmail works with an app password), **Microsoft Teams** Adaptive Cards via a Workflows webhook, **SMS** via Twilio for urgent items, and a **signed generic webhook**.

Safety: `PITWALL_NOTIFY=dry` (default) renders everything into the outbox and sends nothing. Every message is sent once per person per channel. Slack requests are signature-checked with a 5-minute replay window. Email and Teams links are HMAC-signed, expire after 72 hours, open a confirmation page and only act on POST. Whatever the link says, the ledger still enforces K11 (no agent approves, no one gives two approvals).

Slack setup: create the app from `integrations/slack_manifest.yml`, expose port 8000 with a tunnel, fill the Slack variables in `.env`.

## Independent auditor, impact and Microsoft integrations (`finance/audit`, `finance/erp`, `finance/microsoft`)
```
POST /api/runs/{id}/audit                  A1-A7 audit, read-only; Azure OpenAI second opinion when configured
POST /api/runs/{id}/audit/drill            four direct-database attacks on a copy; which ones the auditor catches
POST /api/runs/{id}/audit/share            audit summary to controller and CFO (Teams card, Outlook, Slack)
GET  /api/runs/{id}/audit/findings.csv     workpaper for Excel
GET  /api/runs/{id}/impact                 straight-through rate, dollars protected, speed, effort, cost
POST /api/runs/{id}/erp/business-central/export {"mode": "dry" | "live", "post": false}
GET  /api/microsoft/status
```
Every posted entry is sealed into a hash chain in `seals.db` (separate from the books), with chain heads anchored to an append-only file or Azure Confidential Ledger. Email can go through Outlook via Microsoft Graph (`EMAIL_TRANSPORT=graph`). Azure deployment: `deploy/azure/`. Track write-up: `docs/microsoft/`.

## Outside agents (`finance/agent_api.py`, `agents/fetchai/`)
```
GET  /api/runs/{id}/summary                         revenue, receivables, waiting items, latest audit
GET  /api/runs/{id}/invoices?status=open|all        bonus invoices with the evidence a payer needs
POST /api/runs/{id}/invoices/{request_id}/payment   {"event": "committed" | "rejected" | "completed", ...}
```
A completed payment is a `cash_received` event through the router, engine and kernel, booked exactly once. Start runs with `"cash": false` so agents, not the simulator, settle invoices. The Fetch.ai agents (ASI:One chat plus the Payment Protocol) are in `agents/fetchai/`.

## Red-team sandbox (for an external attacker agent)
```
POST /api/runs/{id}/redteam {"attacker": "name"}      -> session_id (a copy of the books)
POST /api/redteam/{sid}/propose   (journal entry JSON)  -> kernel verdict + failed checks
POST /api/redteam/{sid}/approve   (approval abuse)
POST /api/redteam/{sid}/billing   (fake bonus request as a rogue commercial team)
GET  /api/redteam/{sid}/report    -> attempts, refused, reached a person, leaked
```

## What's real, what's simulated
| Real | Simulated |
| --- | --- |
| F1 results, sprints, disqualifications (Jolpica-F1); FIA documents and their publication times (Apify captures) | Meridian Racing, sponsors, contracts, policies, FX rates, prize table, billing requests, people |

## Limits, stated plainly
- Policies are simplified and written by us; fastest-lap points are ignored when a scenario re-awards points.
- A judge's stewards' decision is a labelled hypothetical overlay on a real final result.
- The scripted agent and personas run without a model; set `PITWALL_AGENT=claude` for model-drafted questions, answer reading and explanations.
- Tests run on a synthetic fixture season; run the real 2023/2024 seasons after `fetch_results.py`.
- The SpacetimeDB mirror typechecks but hasn't been run against a live server here; regenerate frontend bindings after publishing.
