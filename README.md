# Cost Cap Desk

An autonomous cost cap analyst for a Formula 1 constructor, built for the Hyphenate track at Cal Hacks 13.0.

**Seats:** fills the cost cap analyst seat and the policy desk beside it; reports to a human Head of Cost Cap who approves every policy and every material adjustment.

It is built on the three things that make a system hireable rather than a demo:

- **Hireable on day one.** Before its first shift it reads last year's ledger and cost cap submission, drafts the house policies it finds with precedent counts, and asks the Head of Cost Cap to approve them.
- **Self-improving.** Corrections, answers and rule changes become versioned policy proposals that a human approves. It never asks the same question twice.
- **Accountable.** Every transition is an append-only audit row with actor, reason, evidence and policy version, written in the same commit as the change. Denied attempts are logged too.

See `PLAN.md` for the design, `SCHEMA.md` for the contract every component codes against, and `research/` for the sources. `REPLAY.md` is the plan for replaying Williams' 2025 season decision by decision, with its sources in `research/05-williams-replay-sources.md`.

## Layout

| Path | What it is | Stack |
|---|---|---|
| `rulebook/` | FIA Financial Regulations as data: 2025 (Issue 22) and 2026 (Section D Issue 07), built from the regulation text | Python |
| `world/` | The simulated company's systems of record: generator, cursor API, ERP mock | Python, FastAPI, port 8010 |
| `system_of_work/` | Work items, policies, precedents, audit log, roles matrix, `transition()` | SpacetimeDB 2.13 TypeScript module, port 3000 |
| `agents/` | Sync job, gateway, Cap Analyst, Policy Learner, red-team probe | Python, Anthropic SDK |

## Run it

Prerequisites: Python 3.13 with `uv`, Node 22, the SpacetimeDB CLI (`curl -sSf https://install.spacetimedb.com | sh`), and Anthropic credentials for the online agent paths (`ANTHROPIC_API_KEY`). Every agent also has an `--offline` mode that runs the deterministic path with no key.

```bash
make setup
```

```bash
make rulebook
```

```bash
make world
```

Then, each in its own terminal:

```bash
make stdb-start
```

```bash
make api
```

Once both servers are up, this is the sequence verified end to end on Oct 24. Publish a fresh module, then bootstrap identities, roles, the rulebook and settings:

```bash
make stdb-publish
```

```bash
make bootstrap
```

Move the simulated clock through January, then sync the systems of record into the system of work:

```bash
make advance
```

```bash
make sync
```

Onboard from 2025 history. This writes `agents/out/onboarding_report.md` and proposes policies for the Head of Cost Cap:

```bash
make learner
```

Policies take effect only after the Head of Cost Cap approves them. There is no approval screen yet, so approve them from a script that calls `approvePolicy` as that identity. Then run the analyst, approve its proposals the same way as the controller, and post through the gateway:

```bash
make analyst
```

```bash
make gateway
```

```bash
make redteam
```

### Second end-to-end run, January 2026, offline, after the Tier 0 fixes (Oct 24)

| Measure | Result |
|---|---|
| Policies drafted from 2025 history | 100 (99 approved, 1 rejected: "Fuel & lubricants" over-reached) |
| January lines covered by a drafted policy | 257 of 285 (90.2%) |
| Analyst proposals, and share matching the truth file | 248, 96.0% |
| Lines the analyst asked about instead of guessing | 37, of which 8 came from the new duplicate, bank-detail, lookalike and split pre-checks |
| Proposals denied to the controller on materiality, then approved by the Head of Cost Cap | 16 |
| Lines posted to the ERP mock, all balanced, cap effects booked | 248 |
| Red-team probes denied and logged | 10 of 10 |
| Agent steps recorded | 3,077 |
| Tests passing: Python, module | 268, 100 |

The ten defects from `research/review/00-review.md` Tier 0 are fixed, each with the red team's reproduction inverted into a regression test. The ten remaining misses are the same as before and are Tier 1 work: split invoices (the demo hospitality invoice among them), policies that still cover their own learned exceptions, and payroll on-costs absorbed by department policies.

The misses are listed in `SCHEMA.md` section 9. The demo hospitality invoice is one of them: split invoices aren't supported yet.

## Tests

```bash
make test
```

```bash
make stdb-test
```

## What's real and what's simulated

- **Real:** the 2025 and 2026 FIA Financial Regulations text, article by article; the Red Bull 2021 misstatements the planted errors are modelled on; the company's scale, taken from Williams' public FY2025 accounts.
- **Simulated:** the company, its transactions, vendors and contracts, and the humans who approve.
- **How we know it works:** a planted-error answer key in `world/out/answer_key.csv`, unit tests on every component, and a red-team probe that must find every forbidden action denied in the audit log.
