# Reference tooling, sandboxes and benchmarks

Research memo, 2026-10-23. Orientation: what stands up in under 2 hours and holds for the weekend.

## Ledgers / systems of record

**Formance Ledger v2.4.16** (2026-10-21; v3 is an RC, avoid). Open-source double-entry ledger (Go, Postgres). Postings are `source -> destination, amount, asset`, so books balance by construction. Local: clone and `docker compose -f examples/standalone/docker-compose.yml up` at the v2.4.16 tag → API `:8080/api/ledger/v2/...`, console `:3000`. REST: `POST /v2/{ledger}/transactions` with `postings` or Numscript, `reference` (unique, dedup), `metadata` k/v on txns and accounts, `timestamp` backdating, `Idempotency-Key` header, `/revert`. Multi-asset (`USD/2`, `EUR/2`). `HASH_LOGS=SYNC` chains log hashes for a tamper-evident audit log. SDKs Python/TS/Go. **Verdict: best "real ledger for free" option.** https://github.com/formancehq/ledger/releases

**TigerBeetle 0.17.9.** Single static binary, 2 minutes to boot (`./tigerbeetle format ... --development; ./tigerbeetle start --addresses=3000 --development`). Accounts + Transfers only; two-phase pending transfers (great "invoice approval hold" primitive), linked transfers, balance-limit flags. **No strings anywhere**: metadata is `user_data_128/64/32`; you need a side DB for vendor names. Binary protocol only; clients Python/Node/Go/Java/.NET/Rust. Multi-currency = one ledger per currency. **Verdict: bulletproof but poor for human-readable audit; only if you want the two-phase story.** https://docs.tigerbeetle.com/start/

**Blnk v0.15.7** (2026-10-24). Go ledger with Balances (one currency each), Transactions (`reference` required+unique, `meta_data`, inflight/two-phase, scheduled, split), Identities, **Reconciliation module** (`POST /reconciliation/upload` CSV, then matching rules one-to-one / one-to-many / many-to-one), hash chain, webhooks. `docker compose up` → `:5001` (5-6 containers). Use `skip_queue: true` for demos. **Verdict: strongest feature match if you want built-in reconciliation; heavier stack.** https://docs.blnkfinance.com/home/install

**Beancount 3.2.3 + Fava 1.30.16.** `pip install beancount fava beanquery`; `bean-check ledger.beancount`; `fava ledger.beancount` (:5000). Strict double-entry, balance assertions, multi-currency, plain text (git-diffable = free audit history). v3: `bean-query` moved to `beanquery`; `bean-report`/`bean-web` removed. **Verdict: use `bean-example` to seed a chart of accounts and `bean-check` + balance assertions as the independent judge of your agents' journal. Fava = zero-effort human audit UI. Not a runtime ledger.**

**Lago v1.55.0.** Billing/metering; only relevant for generating outbound sponsorship invoices. Skip unless the demo needs invoice PDFs.

**Odoo 20 / ERPNext.** Both boot in 15-30 min (Odoo: `docker run ... odoo` with Postgres; ERPNext: `frappe_docker` `pwd.yml`). Hours to learn the accounting data model. ERPNext REST: `/api/resource/{DocType}` with Purchase Invoice, Journal Entry, Payment Entry. **Verdict: only if "posts to a real ERP" is a judging point; otherwise mock the ERP.**

## Mocks and bank-feed data

- **Mockoon v9.9.0**: `docker run -v ./data.json:/data -p 3000:3000 mockoon/cli:latest -d /data -p 3000`. OpenAPI import, stateful data buckets, templating. Good ERP/vendor-portal mock.
- **Prism v5.16.0**: `docker run -p 4010:4010 stoplight/prism:5 mock -h 0.0.0.0 /spec.yaml`. Stateless.
- **stripe-mock**: stateless fixtures, no error simulation. Skip.
- **Increase sandbox (recommended bank feed)**: no signup; unauthenticated `POST https://sandbox.increase.com/groups` returns a sandbox API key. Accounts, Transactions, Pending Transactions (holds), ACH/Wire transfers, inbound ACH/wire. Simulations: `/simulations/inbound_ach_transfers`, `/simulations/inbound_wire_transfers`, `/simulations/ach_transfers/{id}/submit|acknowledge|settle|return`, release holds. `Idempotency-Key`, webhooks. USD only. SDKs TS/Python/Go/Java. https://increase.com/documentation/sandbox
- **Stripe test mode**: Treasury received-credit test helpers; slower to set up than Increase.

## Benchmarks / evaluation references

- **AccountingBench** (Penrose, July 2025): one year of real SaaS books, close each month sequentially, scored vs CPA. Claude 4 within ~1% in month 1, >95% early, then **drift**: below 85% by mid-year; balances off >15% (~$0.5M) by year end because early misclassifications compound. Models "plugged" bank gaps with unrelated transactions rather than flagging, and reverted to cash basis. **Dataset not published.** Design lesson: multi-period sequential, score drift and "unexplained plug" count. https://accounting.penrose.com/
- **APEX-Accounting** (Mercor + Ramp, 2026-07): 160 tasks, 10 simulated companies, month-end close; best ~56-62%; 58% of tasks never fully solved. Closed dataset. https://arxiv.org/abs/2607.27189
- **Finance Agent Benchmark** (Vals AI): 537 questions over SEC EDGAR; research-oriented, not bookkeeping. https://vals.ai/benchmarks/finance_agent
- **DABstep** (Adyen + HF): 450+ data-analysis tasks over 138k payments, 1k fee rules; **fully downloadable** with answers. Payments CSVs reusable as a transaction feed. https://huggingface.co/datasets/adyen/DABstep
- **FinBalance** (arXiv 2606.15949, 2026-06): multi-document reconciliation (invoices, bank statements, contracts → cited journal entries → balance sheet), 710 records, 23 inconsistency codes; best model 46%. **Code + data public**, directly adaptable as a planted-error harness: https://github.com/Devansh1105/finbalance (not opened; verify).
- **ApprenticeBench** (2026-09): AP clerk at a simulated construction company; 100 vendor bills vs POs/policies posted to Odoo; best model 72% vs best human 51%. Availability not stated. https://benchlm.ai/md/benchmarks/apprenticebench.md
- **BenchRec, Invoice Sandbox Benchmark**: not found; the names in the track brief appear mistaken.

## Agent frameworks

- **Claude Agent SDK** (Python `claude-agent-sdk` 0.2.x; TS `@anthropic-ai/claude-agent-sdk`): per-agent allowlists via `AgentDefinition(tools=[...], disallowedTools, mcpServers, model, permissionMode, maxTurns)`; omitted tools are absent from the subagent entirely. Permission pipeline (hooks → deny → ask → mode → allow → `can_use_tool`); `PreToolUse`/`PostToolUse` hooks give an interceptable, auditable tool-call log. HITL via `can_use_tool`. Resumable sessions. Structured outputs via `output_format` JSON schema. `max_budget_usd`. **Tightest per-agent permissions with the least code.** https://code.claude.com/docs/en/agent-sdk/permissions
- **Microsoft Agent Framework 1.0** (GA 2026-04; Python `agent-framework`): AutoGen + Semantic Kernel merger. Graph workflows with checkpointing, HITL via `RequestInfoExecutor`, middleware hooks, OpenTelemetry. Heavier conceptual surface for 36h, and the Microsoft track does not require it.
- **OpenAI Agents SDK**: `needs_approval` on tools, `RunState.to_json()` durable pause. Fine, but Anthropic is the anchor sponsor.
- **LangGraph 1.2**: explicit graph + checkpointer, `interrupt()` / `Command(resume=...)`. Most boilerplate, most control; node re-runs on resume so side effects must be idempotent.

## SpacetimeDB as system of record

v2.13.0 (2026-10-21). Modules in Rust/C#/TypeScript/C++. `spacetime start` (:3000) → `spacetime publish` → `spacetime generate`; 2.12 added in-memory module unit tests. Reducers are atomic (throw rolls back everything), deterministic (no network); procedures can do HTTP and open transactions. Scheduled reducers via schedule tables. Subscriptions: SQL subset, joins limited to exactly two indexed tables, no aggregates. Row-level security experimental; use views. Ledger fit: `journal_entry` + `journal_line` written only through a `post_entry` reducer asserting Σdebits = Σcredits; append-only by not exporting update/delete reducers; maintain a `balance` table in the reducer since subscriptions cannot aggregate. Live subscriptions make an excellent "watch the agents post" dashboard backend.

## Quick fit summary

| Need | Pick | Fallback |
|---|---|---|
| System of record | SpacetimeDB TS module (sponsor track + live dashboard) | Formance v2 (double-entry for free) |
| Independent verifier | Beancount `bean-check` on an exported journal | Python assertion suite |
| Bank feed | Increase sandbox (USD) or generated CSV | Mockoon |
| ERP / procurement mock | Own FastAPI + SQLite simulator | Mockoon |
| Agents | Claude Agent SDK (per-agent tools, hooks) | Raw Anthropic tool-use loop |
| Test harness design | AccountingBench-style multi-period drift + planted errors | FinBalance inconsistency codes |
