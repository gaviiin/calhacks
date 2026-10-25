# Hyphenate track + other Cal Hacks 13.0 sponsor tracks

Research memo, 2026-10-23. Event: **Cal Hacks 13.0**, Oct 23-25, 2026, Palace of Fine Arts, SF, presented by Anthropic, Annapurna Labs, SpacetimeDB and Hyphenate. Devpost: https://cal-hacks-13-0.devpost.com/ . Authoritative prize text: https://hive.hackberkeley.org/prizes (client-rendered; Devpost's list is a lossy copy).

## Logistics

- Hard submission deadline **Sun Oct 25, 9:00 AM PDT**. Be at venue by 8 AM. Include image + GitHub repo.
- Pitch: 3 minutes + 2 minutes judge Q&A. Pre-recorded or live demo required.
- Teams 2-4. Overall criteria: Application, Intentionality, Functionality (live demo + clear video for async sponsor judging), Creativity, Technical Complexity.

## Hyphenate

**Who.** NYC; Oct 1, 2026 rebrand of **Maximor** (founded summer 2024). CEO Ramnandan Krishnamurthy (ex-Microsoft digital transformation, finance/data projects for Fortune 500), CTO Ajay Krishna Amudan (revamped Microsoft's internal revenue systems). $9M seed (Sept 2025) led by Foundation Capital; angels incl. Aravind Srinivas, Tien Tzuo, CFOs from Ramp/Gusto/MongoDB/Zoom. Named customers: HiBid, Kiteworks, Dura Software, Rently, Mini Melts USA (SAP), Eightfold, Sierra, Quantum. Target: mid-market $50M+ revenue, NetSuite/Intacct/SAP shops. Stack per job posts: Python/FastAPI, React/TS, Postgres; engineers expected to use Claude Code/Cursor.
Sources: https://techcrunch.com/2025/09/29/former-microsoft-executives-launch-ai-agents-to-end-excel-driven-finance-for-mid-market-enterprise-businesses/ ; https://hyphenate.ai/press/maximor-rebrand-hyphenate ; https://jobs.ashbyhq.com/hyphenate

**Their vocabulary (use it).**
- "The autonomous finance platform for the office of the CFO"; "Audit-ready autonomy that your team can trust"; "90% of routine work runs on its own."
- "Audit-Ready Agents™"; outputs are "deterministic, explainable, and auditable, and each figure traces to its source"; "the ledger remains the system of record. Agents read from it, post approved entries."
- Controller page: **"It proposes. You approve."**; "Every entry arrives prepared, evidenced, and waiting for your approval"; "Your workpapers and past entries become the policies"; material variances "hold the books open."
- GL page: "a person approving, not authoring."
- Name rationale: finance runs on hyphens (order-to-cash, procure-to-pay, record-to-report).
Sources: https://hyphenate.ai ; https://hyphenate.ai/platform ; https://hyphenate.ai/controller ; https://hyphenate.ai/gl-accounting

**Manifesto: "What We Mean by Autonomous Finance"** (Aug 13, 2026, https://hyphenate.ai/blog/what-we-mean-by-autonomous-finance). Finance runs on "human runtime"; autonomous finance replaces it. "Autonomous means the system carries the judgment" vs "Automated is a script." "When it's confident, it acts. When it isn't, it escalates to your team." It "remembers the answer, so it never asks twice." "Every action it takes carries its own evidence: what it did, why, and based on what." "Intelligence is becoming cheap. Accountability is not." "Our product is built around the remaining 1%" (knowing when to stop and how to show the work). "When agents do the work, every single entry is examined" (100% examination vs audit sampling).

**Workflows they emphasize.** Order-to-cash (ASC 606, cash application, collections), Treasury (daily bank rec, cash position, 13-week forecast), GL & close (subledgers, reconciliations, accruals, intercompany, close checklist, flux), Procure-to-pay (AP inbox capture, coding, PO matching, approval routing, accrual proposals), Reporting. Close and reconciliation are the center of gravity. HiBid case study: "flag unfamiliar transactions for finance team review, with context attached. Reviewer guidance is stored so agents can handle similar cases later."

**Engineering doctrine (closest thing published).**
- Investor essay (https://ashugarg.substack.com/p/what-it-takes-to-build-ai-agents): a "system of agents," each narrow and separately evaluated; a **"trust engine"** combining reasoning LLMs, predictive ML and deterministic tools. Rev-rec example: LLM interprets policy → ML predicts → **deterministic calculator applies the formula** → LLM drafts explanation → tool verifies against source. Hand off to another agent or a human "at predefined points" on low confidence rather than guess. "Verifier-centric design" so errors are visible in the process trace. Objective covers outcome (right numbers) and process (right method).
- Job posts: "Verification, guardrails, observability, and evaluation systems for non-deterministic AI"; "Context engineering over transactions, ledgers, contracts, policies, and historical decisions — without bloat, drift, or data leakage"; "Long-running, replay-safe workflows across flaky, stateful enterprise systems"; "Idempotent, audit-ready updates to ERPs… with full traceability"; "knowing when a model is the right tool and when plain code is"; "A 100% solution beats an 80% one."
- Nothing published on red-teaming.

**Track criteria (official).** $8,000 / $5,000 / $3,000, expedited interviews for top 5. Judged on: (1) Is it real enough? (2) **Would you hire it? For which seats, and would it earn them: limited access, a clean record of its work, and knowing when to ask?** (3) Did we see something new? (4) The moment. Deliverables: demo video that opens with the moment, live demo (they may try a scenario of their own), **one line on the seats the system fills**, proof it works (real vs simulated, how you know).

**Workshop.** "Beyond Agentic Harnesses" title not found publicly; only "Hyphenate workshop" Oct 21 online and Fri Oct 23 in person on the Hive schedule. No recording or slides found.

## Microsoft

"Grand Prize: Built for the Real World" and "Microsoft Customer Impact Award" (2nd). Challenge: "Build a production-minded AI agent that solves a meaningful problem in **finance**, productivity, healthcare, or another high-impact domain." Criteria: customer understanding, measurable usefulness, path from prototype to production, responsible design, end-to-end functionality. Prizes: Surface laptop per member (1st), remote tech talk to the Microsoft Frontier Co. forward-deployed-engineering team and 1:1 FDE mentorship. **No requirement to use Azure / Foundry / Agent Framework / Copilot is stated.** No Azure credits found (Hive Starter Packs page is login-gated).

## SpacetimeDB (Clockwork Labs)

Prize: $2,048 / $1,024 / $512 plus a Scrabblebot tournament. Wants Spacetime as "the core real-time backend… live shared state, multiplayer interaction, or instant sync between users/agents/systems"; explicitly lists "AI agent coordination, live dashboards, **trading / financial-style apps**… shared ops dashboard… AI systems coordinating in a persistent world state"; "meaningfully used, not just added on the side." Blog: https://spacetimedb.com/blog/spacetime-at-calhacks

Product: "a database that is also a server." Modules = tables + **reducers** (transactional functions, the only way to write; atomic, rolled back on error; must be deterministic, no network/FS/timers/randomness; `ctx.sender` is the authenticated caller identity) + **procedures** (2.x; can do HTTP, open transactions via `withTx`) + **views** (subscribable computed queries) + scheduled tables. Clients subscribe via SQL/query builder and receive commit-ordered row deltas. **TypeScript server modules fully supported since 2.0 (run on V8)**; also Rust/C#/C++ to WASM. Current release **v2.13.0 (Oct 21, 2026)**. Data in memory, persisted to an append-only commit log. Hosting: Maincloud (`spacetime publish --server maincloud`), free tier. Local: `spacetime start` → `spacetime publish` → `spacetime generate`. Limits: subscription joins capped at two tables, both join columns indexed, no aggregates; row-level security (`clientVisibilityFilter`) is experimental, docs recommend views for access control; standalone server is single-node; commit log stores row changes not reducer inputs, so event sourcing needs your own event table.

Ledger fit: a `post_journal_entry` reducer validates debits = credits and inserts all lines atomically; `ctx.sender` gives an authenticated actor for the audit trail; append-only falls out of simply not exporting update/delete reducers; subscriptions push ledger / balance / exception-queue changes to a live dashboard.
Docs: https://spacetimedb.com/docs/functions/reducers ; https://spacetimedb.com/docs/databases/transactions-atomicity ; https://spacetimedb.com/docs/reference/sql ; https://spacetimedb.com/docs/ai-rules/spacetimedb.mdc

## Creao AI

Cupertino; $25M raised; chat with a cloud "super agent" that writes code/calls APIs in a sandbox, then saves the workflow as a reusable, schedulable "Agent App" with memory; approval gates; OAuth integrations. Cal Hacks prizes: "Best AI-First Disruptor" ($2,500), "Best One-Person Company" ($1,500), "Best Team Empowerment" ($1,000) each with Launchpad (1 yr Pro Max, mentorship). Rules doc is private. **Relevance: only if you build on CREAO itself. Marginal for a custom finance-agent stack.**

## Other stackable tracks

- **Anthropic** (anchor; prize "coming soon"): a named community, a real problem, "It works. One thing done well and usable on Monday," "Thoughtful use of Claude… you know where it could go wrong." Strong alignment.
- **Convex** $5,000 "Best use of Convex": competitor to SpacetimeDB, pick one.
- **Factory Droid SDK** $2,000 + credits: Droid triggered by events/schedules/other agents, scoped permissions, visible plans/diffs; penalizes "chatbot wrapper." Plausible stack but adds a dependency.
- **CRS Credit API** "Best Financial AI Agent" $500 / Best Overall $1,000: must run live against their credit sandbox. Weak fit (consumer credit).
- **Capital One Nessie** $300/person: mock bank API. Weak fit.
- **Fetch.ai** $1,500/$1,000/$500: requires Agentverse registration. Skip.
- **Coinbase x402**, **Visa**, **Mana.space**, **Bright Data**, **Apify**, **Elastic**, **Atlassian**: weak fit.
- MLH: Gemini, Auth0 for AI Agents, MongoDB, Snowflake, Backboard memory, Tiger Data, DigitalOcean, Vultr.

**Unverified:** workshop content; Hyphenate track details doc (plain text reference, no link); Microsoft/Anthropic/SpacetimeDB credit offers; Creao and Atlassian rule docs; exact judging expo times.
