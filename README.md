# Pit Wall

An autonomous race accountant for a Formula 1 team. Built for the Hyphenate track at Cal Hacks 13.0.

**It keeps the books in step with the car.** Every lap, every trip off the track and every crash changes what each part of the car has left. The agent turns that into entries, cost cap timing, spares and a cap forecast within milliseconds of the data, and people approve only what is material.

Every team has this job, and crashes are its biggest swing in the season. Williams in 2024: crash damage squeezed their cost cap, the FIA refused relief, and Vowles said the team would "take a little bit away from next year's cost cap". Today that picture arrives with the parts invoices, weeks later. The demo replays Williams at the 2024 São Paulo Grand Prix: three crashes on one Sunday, a car that did not start, no points.

## Three twists

| | On São Paulo 2024 |
|---|---|
| **The car is the ledger** | Each part on each car has a life. Laps use it; stress events use it (Jev classifies a contact or a trip off the track and the parts it hit); crashes destroy it. Wear is never booked (the cap excludes depreciation, Art. 3.1(o)): it sets when each replacement is fitted, which is when its cost counts. After Albon's crash, 9 parts are replaced and his power unit now runs out by Las Vegas, past its allocation: a grid penalty |
| **The books keep themselves** | Balanced entries saying when the cap counts each line, inventory moves, accruals, adjustments once the garage confirms, ERP postings, the evidence pack, the Sunday-night seal and the true-up. People answer one damage question, make the Team Principal's call, and approve each crash's books in one click ($250k and up for the Head of Cost Cap, $1m and up for the CFO) |
| **Milliseconds** | 2,549 events, each committed in about 1 ms (11 ms at worst); 10,000 seasons re-run in about 80 ms; crashes seen in telemetry 9–26 s before the red flag. Not speed for its own sake: the numbers are never stale when someone decides |

## One crash, through the team

Albon's qualifying crash at 315 km/h, the way the dashboard follows it. A strip on every view walks the incident through these steps; each step opens the view of the person who owns it.

| Step | Who | On Albon's crash |
|---|---|---|
| Seen | the agent | Telemetry sees car 23 go from 315 to 0 km/h at 11:57:19, 9 s before the red flag |
| Hardware | the agent, Jev | Jev reads the impact and the parts it hit; the likely ones are marked damaged at once and replaced once the garage confirms. His power unit, not replaced, now runs out by Las Vegas: a grid penalty |
| Engineering call | Chief Mechanic, Team Principal | The garage confirms heavy damage in one click. The Team Principal sees repair, the spare tub (about 13 h against 3.5 h to the start) or withdraw, priced side by side with no recommendation, and withdraws |
| Race call | Head of Strategy | None: the car does not start. On Colapinto's race the strategist gets stay out, pit now and other compounds, each priced in positions, points, prize and cap |
| Next steps | owners by role | Execution follows the choice: the notice to the Stewards waits for the Sporting Director, the parc fermé list is no longer needed, spares are reserved, the factory's work orders and air freight are raised against the Las Vegas cut-off |
| Books | CFO, Head of Cost Cap | Entries prepared by the agent. The morning's crash books were approved between the sessions and are in the ERP; the race crash waits for one click |
| Season | CFO | 10,000 seasons after every change: the chance of holding P8 falls from 72% to 54% on Albon's withdrawal and to 0% by the flag; expected prize money falls $6.1m; the chance of a cap overspend; the development to defer |

Race-day finance is provisional, and Pit Wall says so. The weekend is sealed on Sunday night under one Merkle root, with a brief for each role that cites the row behind every figure; nothing goes out until the CFO approves. Weeks later the true-up compares the sealed $3.92m with the "nearly $4 million" the press reported.

## A view for each person

The views follow an incident in the order it reaches each person. They read the same live SpacetimeDB rows, and none of them recommends.

| View | For | What it shows |
|---|---|---|
| Garage | pit crew, engineers, Team Principal | Each Williams car as the blueprint drawing, lit by part. Beside it: each part's life (used, due, stress events Jev classified), the spares, the damage question, the start-or-withdraw options, and the next steps with their owners and deadlines |
| Strategy | head of strategy | Varun Sanjeev's decision cockpit, ported. Stay out, pit now, the other compound, or the same stop under green, each with positions, time lost, points, prize and cap effects |
| Accounting | Controller, accountants | A live feed of events, beliefs, decisions and entries beside the books: posted to the ERP journal with its id, or held for review |
| CFO | CFO, Head of Cost Cap | Cost so far, the hardware (parts replaced, replacements due this season and what they bring into the cap, grid penalty risk), the chances of holding the place and of a cap overspend, one approval per crash, the sealed weekend and its briefs |

The pitch deck's seven-stage view is at `#/day/flow`, off the switcher. The 3-minute demo script is [docs/DEMO.md](docs/DEMO.md). Every part-life figure is an assumption stated in `race/life.py`; the laps, race-control messages and crashes it reads are real.

Under each view, pit-wall's own rows show who is watching, how long an event takes from read to commit to screen, and every decision on the record, allowed or refused (the money rules are enforced in the module). The bar above every view says which services the run really used. On the last demo run: OpenF1 live (the REST API, responses cached), SpacetimeDB live (2,927 reducer calls, 0 refused), Jev live (117 decisions, mean 114 ms), Claude live (4 repair plans, 4 of 4 briefs), the ERP live (3 entries posted through the gateway, 7 held for review); notifications are not configured until Slack, email, Teams or SMS credentials are added in Connect (then dry run until `PITWALL_NOTIFY=live`). OpenF1's live MQTT feed needs its paid tier (`race/live.py`).

```bash
make stdb-start                  # SpacetimeDB on :3000 (another terminal)
make api                         # the ERP and systems of record on :8010 (another terminal)
make race-reset BROWSER_ID=<hex> # a clean pit-wall: evidence, roles, 2024 history; the hex seats your browser
make dashboard                   # :5173, Race day is the home page
make race-snapshot BROWSER_ID=<hex>  # the demo's frozen moment: a few minutes after Colapinto's lap-32 crash, earlier decisions replayed
make race-demo                   # or watch it happen: São Paulo 2024 live, Jev, Claude, OpenF1 and the ERP (OFFLINE=1 for none)
```

The same three runs sit in the Race day bar as buttons (Replay São Paulo, Lap 32, Reset): the dashboard's dev server runs the make target on this machine and seats the browser that asked.

The dashboard has four tabs: **Race day** (the views above), **Inbox** (what waits for a person), **Books** (where the entries land: race entries, the cost cap desk, the revenue desk), **Audit** (the log and the FIA evidence). Not affiliated with Williams Racing: timing, telemetry and results are real (OpenF1, Jolpica); money is press estimates and stated assumptions, each with its source in `race/data/`. The race desk's details are in [race/README.md](race/README.md).

## The books behind race day

The two desks behind **Books** are where race day's entries land, and they keep their own story. Two AI seats do the work and people approve what matters:

- the **revenue accountant** books sponsor fees, performance bonuses and prize money from real F1 results and real FIA documents, through one write path a deterministic kernel re-checks (K1 to K12);
- the **cost cap analyst** classifies every cost line under the FIA Financial Regulations against the $215m cap, under house policies a Policy Learner drafted from last year's books and the Head of Cost Cap approved.

Both report to the same people (Dana Okafor, Controller; Priya Raman, CFO; Morgan Hale, Head of Cost Cap) and share one evidence feed and one dashboard. The team behind these desks is Meridian Racing, a fictional constructor whose on-track results are Mercedes' real 2023 and 2024 results.

**Seats line:** fills the revenue accountant seat, the cost cap analyst seat and the policy desk beside it; does the accounting itself and brings people only what it cannot settle, then remembers what they decide.

## How work flows

Code and agents do the accounting. A person sees a line only when no rule a person approved covers it: a new scenario, an estimate, a reversal, an exception to a contract. They decide it once and tick **Remember**, and from then on the desk decides lines like it itself. Every decision, by an agent, by code or by a person, is in the audit log with who decided it and under which rule.

| | Decided without a person | Brought to a person | How one decision is remembered |
|---|---|---|---|
| Cost cap desk | every line an approved policy decides, at any amount (the standing-approval job, `make standing`) | lines no policy covers (Claude drafts the answer), duplicate, bank-detail and lookalike flags, reversals | the person's decision becomes a narrow rule (account plus vendor, department or memo), approved by them in the same click, and queued lines it covers go back to the analyst |
| Revenue desk | everything code books from the contract and the final result, at any amount | estimates, reversals after a stewards' decision, exceptions to a contract or a billing request, anything an agent prepared | one controller ruling on a contract clause becomes the rule for every later case |

Materiality no longer decides whether a person is needed, only which one: a material line no rule covers goes to the Head of Cost Cap, or the Controller and the CFO on the revenue side. The Head of Cost Cap can take any policy's standing approval back from the dashboard, and its lines go back to people.

Three things make it hireable rather than a demo:

- **Hireable on day one.** Before its first shift the cost cap desk reads last year's ledger and cost cap submission, drafts the house policies it finds with precedent counts, and asks the Head of Cost Cap to approve them. The revenue desk trains on the 2023 season: the Controller's rulings on ambiguous contract clauses become rules.
- **Self-improving.** One decision is enough: a person's answer or correction becomes a rule the moment they tick Remember, and the desk never asks the same question twice. Patterns across many corrections still become broader policies through the Policy Learner.
- **Accountable.** Agents only propose; approvals come from a person or from a rule a person approved, and the audit row names which. Every transition is an append-only audit row with actor, reason, evidence and policy version, written in the same transaction as the change; denied attempts are logged too. Every revenue entry is re-performed from its sources before it can post, and an independent auditor with read-only access gives an opinion on the books.

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
| `frontend/` | The dashboard: results tiles, the cap track and trajectory, who decided, the shift on one clock, the inbox with the why pane, both desks, the cap risk model, simulations run from the page, what the agents did, evidence, audit, connections | Vite, React, SpacetimeDB SDK, port 5173 |
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

The cost cap desk, January 2026 end to end: publish a fresh module, bootstrap identities, roles and the rulebook, sync, onboard from 2025 history, have the Head of Cost Cap approve the drafted policies, run the analyst, let the standing-approval job approve what those policies decided, post, probe, score. About 40 minutes online, most of it the analyst's Claude calls; the new scenarios Claude drafted are left for a person in the dashboard.

```bash
make world rulebook cost-cap-run
```

The dashboard:

```bash
make dashboard
```

Open http://localhost:5173. The **Pit wall** tab opens on results (lines decided without a person, decisions by people, posted, open questions, refused, accuracy against the answer key), the cap track with the year's trajectory, who decided what, the shift, the inbox, and a **Simulations** panel that runs any step of the cost cap pipeline or the 2024 season replay from the page (the dev server spawns the Makefile target; online with Claude when `ANTHROPIC_API_KEY` is in `.env`, offline otherwise). **Cap risk** prices a deliberate overspend on the team's own assumptions against the 2026 sanctions (D10.3, D12.1.1): lap time bought, places gained, prize and bonus upside, fine, aero-testing cut and points deduction, expected value across the whole range with the break-even marked. **Connect** shows what is live and lets a team enter Apify, Slack, email, Teams, SMS, Business Central, Claude and Azure OpenAI settings (saved to `.env` by the dev server, secrets masked on the way back), send a test message, and drop contracts for the Contract Reader.

Pick a seat in the top bar (the browser claims it with a one-time code `make bootstrap` minted), and work the inbox. On the Revenue tab, replay 2024 to the Belgian Grand Prix and run the weekend: George Russell finishes first on the road and is disqualified for an underweight car, and the desk holds his bonuses until the FIA's final classification.

The revenue desk on its own: `make revenue-sim` trains on 2023 and scores 2024; `make revenue-demo` narrates the Spa weekend.

## What it did today

Live runs with Claude on Oct 24; the full tables are in [docs/runs.md](docs/runs.md).

| | Result |
|---|---|
| Cost cap lines decided without a person | 260 of 285, under policies the Head of Cost Cap approved, material lines included |
| Cost cap lines brought to a person | 25: 22 new scenarios Claude drafted, 3 questions |
| One correction, remembered | fixed two lines: the second was re-proposed under the taught rule and posted without anyone |
| Cost cap proposals matching the truth file (the agents never see it) | 277 of 282 (98.2%) after that one correction |
| Revenue: sponsor bonuses booked correctly, 2024 season | 90 of 90; trial balance ties; $3.74m kept off invoices for overturned results |
| Independent auditor | unmodified opinion, 0 findings |
| Red-team probes denied and logged | 15 of 15 on the cost cap module; 200 saboteur proposals refused by the revenue kernel |

Claude's drafts go to a person because no rule covered those lines; where it was wrong (the Applied Technologies payroll trap, building maintenance called Property), the person's correction is the fix, and Remember makes it the rule for the next line.

## Tests

```bash
make test
```

```bash
make stdb-test
```

424 Python tests (both desks, the evidence pipeline, the rulebook and world) and the module's 140 vitest tests. The SpacetimeDB integration tests for `pit-wall` run when a local server is up.

## What's real and what's simulated

- **Real:** F1 results (Jolpica-F1), official FIA documents and their publication times (Apify captures of fia.com), the 2025 and 2026 FIA Financial Regulations text, the Red Bull 2021 misstatements the planted errors are modelled on, the cost side's scale (Williams' FY2025 accounts).
- **Simulated:** Meridian Racing, its ledgers, vendors, contracts, sponsors and people, and the answer keys.
- **How we know it works:** planted-error answer keys on both desks (`world/out/truth_2026.csv`, the revenue desk's `keys/`), unit tests on every component, a red team that must find every forbidden action denied in the audit log, and an independent auditor that recomputes the revenue books from source.

See [PLAN.md](PLAN.md) for the cost cap desk's design, [SCHEMA.md](SCHEMA.md) for its contract, [PRODUCT.md](PRODUCT.md) for the product brief, and `research/` for the sources.
