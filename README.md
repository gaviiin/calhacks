# Pit Wall

The finance desk of a Formula 1 constructor, built for the Hyphenate track at Cal Hacks 13.0. Two AI seats do the work and people approve what matters:

- the **revenue accountant** books sponsor fees, performance bonuses and prize money from real F1 results and real FIA documents, through one write path a deterministic kernel re-checks (K1 to K12);
- the **cost cap analyst** classifies every cost line under the FIA Financial Regulations against the $215m cap, under house policies a Policy Learner drafted from last year's books and the Head of Cost Cap approved.

Both report to the same people (Dana Okafor, Controller; Priya Raman, CFO; Morgan Hale, Head of Cost Cap) and share one evidence feed and one dashboard. The team is Meridian Racing, a fictional constructor whose on-track results are Mercedes' real 2023 and 2024 results.

**Seats line:** fills the revenue accountant seat, the cost cap analyst seat and the policy desk beside it; reports to a human Controller, CFO and Head of Cost Cap who approve every policy and everything material.

Three things make it hireable rather than a demo:

- **Hireable on day one.** Before its first shift the cost cap desk reads last year's ledger and cost cap submission, drafts the house policies it finds with precedent counts, and asks the Head of Cost Cap to approve them. The revenue desk trains on the 2023 season: the Controller's rulings on ambiguous contract clauses become rules.
- **Self-improving.** Corrections, answers and rule changes become versioned policy proposals that a person approves. It never asks the same question twice.
- **Accountable.** Agents only propose. Every transition is an append-only audit row with actor, reason, evidence and policy version, written in the same transaction as the change; denied attempts are logged too. Every revenue entry is re-performed from its sources before it can post, and an independent auditor with read-only access gives an opinion on the books.

```
 real FIA documents ──► Apify actor ──► ingestion/ ──► SpacetimeDB pit-wall ────────────────┐
 real results (Jolpica) ─► finance/ revenue desk ──► kernel K1-K12 ──► SQLite ledger ─┐     │
                                 │  Claude: drafts, reads answers                     ├─ mirror
 synthetic ledgers ──► world/ ──► agents/ sync ──► SpacetimeDB cost-cap-desk ◄────────┘     │
                                 │  Cap Analyst, Policy Learner (Claude),                   │
                                 │  roles matrix + audit log inside the module              │
                                 ▼                                                          ▼
                     frontend/: the dashboard (live subscriptions to both databases, the revenue API)
                     people approve here, or in Slack, email, Teams (finance/notify)
```

## Layout

| Path | What it is | Stack |
|---|---|---|
| `frontend/` | The dashboard: the shift on one clock, the inbox with the why pane, both desks, evidence, audit | Vite, React, SpacetimeDB SDK, port 5173 |
| `finance/` | Revenue desk: sim, router, engine, revenue agent, ledger, kernel, independent auditor, notifications, Business Central and Outlook ([finance/README.md](finance/README.md)) | Python, FastAPI, port 8000 |
| `ingestion/` | FIA document monitor (Apify actor), decision reader, bridge into SpacetimeDB ([ingestion/README.md](ingestion/README.md)) | Python, Apify |
| `spacetimedb/` | `pit-wall` module: FIA documents, decision extracts, the revenue ledger mirror | SpacetimeDB 2.13 TypeScript |
| `agents/` | Cost cap desk: sync job, Cap Analyst, Policy Learner, gateway, red team, review and score CLIs ([agents/README.md](agents/README.md)) | Python, Anthropic SDK |
| `system_of_work/` | `cost-cap-desk` module: work items, policies as Ripple-Down Rules, allocations, audit log, agent steps, roles matrix, `transition()` ([SCHEMA.md](SCHEMA.md)) | SpacetimeDB 2.13 TypeScript, port 3000 |
| `rulebook/` | FIA Financial Regulations as data: 2025 (Issue 22) and 2026 (Section D Issue 07) | Python |
| `world/` | Both desks' worlds: the cost side's systems of record (generator, cursor API on port 8010) and the revenue side's contracts, sponsors, results and people | Python, JSON |
| `landing/` | Marketing page | Vite, React, three.js, port 5175 |
| `deploy/azure/`, `docs/microsoft/` | Azure deployment and the Microsoft track write-up | Bicep |

## Run it

Prerequisites: Python 3.13 with `uv`, Node 22, the SpacetimeDB CLI (`curl -sSf https://install.spacetimedb.com | sh`). Put `ANTHROPIC_API_KEY` in `.env` (see `.env.example`); every agent also runs offline without it (`OFFLINE=1`).

```bash
make setup
```

In three terminals, the servers: SpacetimeDB, the cost side's systems of record, and the revenue desk API.

```bash
make stdb-start
```

```bash
make api
```

```bash
make revenue-api
```

The evidence feed: publish the `pit-wall` module and replay the 24 saved Apify captures (200 real FIA documents) and the decision extract for the 2024 Belgian Grand Prix.

```bash
make evidence-publish evidence-replay
```

The cost cap desk, January 2026 end to end: publish a fresh module, bootstrap identities, roles and the rulebook, sync, onboard from 2025 history, have the Head of Cost Cap approve the drafted policies, run the analyst, have the Controller approve the routine proposals, post, probe, score. About 40 minutes online, most of it the analyst's Claude calls; material and Claude-decided proposals are left for a person in the dashboard.

```bash
make world rulebook cost-cap-run
```

The dashboard:

```bash
make dashboard
```

Open http://localhost:5173, pick a seat in the top bar (the browser claims it with a one-time code `make bootstrap` minted), and work the inbox. On the Revenue tab, replay 2024 to the Belgian Grand Prix and run the weekend: George Russell finishes first on the road and is disqualified for an underweight car, and the desk holds his bonuses until the FIA's final classification.

The revenue desk on its own: `make revenue-sim` trains on 2023 and scores 2024; `make revenue-demo` narrates the Spa weekend.

## What it did today

Live runs with Claude on Oct 24; the full tables are in [docs/runs.md](docs/runs.md).

| | Result |
|---|---|
| Cost cap proposals matching the truth file (the agents never see it) | 274 of 280 (97.9%); code 255 of 258, Claude 19 of 22 |
| Cost cap lines asked about instead of guessed | 5 |
| Revenue: sponsor bonuses booked correctly, 2024 season | 90 of 90; trial balance ties; $3.74m kept off invoices for overturned results |
| Independent auditor | unmodified opinion, 0 findings |
| Red-team probes denied and logged | 12 of 12 on the cost cap module; 200 saboteur proposals refused by the revenue kernel |

Claude's one material miss is a planted trap: Applied Technologies payroll that 2025 practice split 60/40, which the 2026 rules put wholly inside the cap. It proposed Non-F1, said why it was unsure, and the module routed the $636k line to the Head of Cost Cap. Offline, the analyst asks about that line instead.

## Tests

```bash
make test
```

```bash
make stdb-test
```

418 Python tests (both desks, the evidence pipeline, the rulebook and world) and the module's vitest suite. The SpacetimeDB integration tests for `pit-wall` run when a local server is up.

## What's real and what's simulated

- **Real:** F1 results (Jolpica-F1), official FIA documents and their publication times (Apify captures of fia.com), the 2025 and 2026 FIA Financial Regulations text, the Red Bull 2021 misstatements the planted errors are modelled on, the cost side's scale (Williams' FY2025 accounts).
- **Simulated:** Meridian Racing, its ledgers, vendors, contracts, sponsors and people, and the answer keys.
- **How we know it works:** planted-error answer keys on both desks (`world/out/truth_2026.csv`, the revenue desk's `keys/`), unit tests on every component, a red team that must find every forbidden action denied in the audit log, and an independent auditor that recomputes the revenue books from source.

See [PLAN.md](PLAN.md) for the cost cap desk's design, [SCHEMA.md](SCHEMA.md) for its contract, [PRODUCT.md](PRODUCT.md) for the product brief, and `research/` for the sources.
