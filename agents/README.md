# agents/: the agent runtime

Sync job, gateway, Cap Analyst, Policy Learner and red team for the cost cap desk. Every process
runs as its **own** SpacetimeDB identity (tokens in `agents/identities.json`, gitignored, mode 600),
and the module's roles matrix is the real enforcement. Agent tools are CRUD on the work, never on
records (SCHEMA.md §7). Run everything from the repo root with `uv run`.

Argument order for every reducer lives in one file, `agents/reducers.py`, reconciled with
`system_of_work/REDUCERS.md` (authoritative).

## Environment

| var | default | used by |
|---|---|---|
| `STDB_URL` | `http://localhost:3000` | all |
| `STDB_DB` | `cost-cap-desk` (hyphens: 2.13 rejects underscores) | all |
| `WORLD_URL` | `http://localhost:8010` | sync, learner, gateway |
| `GATEWAY_KEY` | none (gateway refuses to start without it) | gateway only |
| `CCD_MODEL` | `claude-opus-5-5` | analyst, learner (online) |
| `ANTHROPIC_API_KEY` | none: without it, online mode falls back to offline with a warning | analyst, learner |

## Run order

```bash
uv run python -m agents.bootstrap                  # identities, roles, rulebook, settings (idempotent)
uv run python -m agents.sync --once                # world -> golden rows -> NEW work items
uv run python -m agents.policy_learner --onboard   # 2025 history -> PROPOSED 2026 policies + report
#   ... Head of Cost Cap approves policies (UI / approvePolicy) ...
uv run python -m agents.cap_analyst --once         # propose / ask on NEW items  (add --offline for no LLM)
#   ... controller / head approve, reject or answer ...
GATEWAY_KEY=... uv run python -m agents.gateway --once
uv run python -m agents.policy_learner --from-corrections
uv run python -m agents.redteam --probe            # exit 1 if any forbidden call was not denied+logged
```

Every CLI has `--help`. `cap_analyst` and `policy_learner` take `--dry-run` (decide and print, call
no reducers).

## Who does what

| module | identity (role) | may | may not |
|---|---|---|---|
| `bootstrap` | `admin` (admin), then each actor claims its own role | `bootstrapAdmin`, `createRoleInvite`, `loadRulebookEntry`, `setSetting`; each actor `claimRole` with its own token | anything on work items or policies |
| `sync` | `sync` (sync) | `upsertGlLine`, `upsertBillLine`, `upsertVendor`, `upsertFairValue` | work items, policies |
| `cap_analyst` | `cap_analyst` (ai_cap_analyst) | read; `propose`, `ask` | approve, reject, answer, post, lock, propose_policy, any record write |
| `policy_learner` | `policy_learner` (ai_policy_learner) | read (system of work + world 2025 history); `proposePolicy` | approve its own (or any) policy, work item actions |
| `gateway` | `gateway` (gateway) | read; POST `/erp/journal_entries` with `X-Gateway-Key`; `post` | propose, approve, anything else |
| `redteam` | `red_team` (red_team) plus other actors' tokens, as the test harness | attempt forbidden calls, read `audit_log` | (every call it makes must be denied and logged) |

The LLM tool lists are built only from explicit allowlists in `agents/tools.py`
(`CAP_ANALYST_TOOLS`, `POLICY_LEARNER_TOOLS`), and `tests/test_tools_allowlist.py` asserts them.
`AgentTools` has no approve/post/lock/upsert method at all.

## The pieces

**sync.py.** Change-only, one cursor per source in `agents/state/sync_cursors.json`; re-running
with the same cursor file sends nothing. `raw_ref = "<source>:<id>:<cursor>"`. gl lines get
`account_code` from the account master and `fx_rate_e6 = round_half_up(fx_rate_to_usd * 1e6)`.
Bill lines are joined with their bill (text, vendor, IBAN); a re-emitted bill with changed bank
details re-upserts its cached lines so the change reaches the work.

**policy.py.** Pattern matching and effective windows, mirroring the module's `patternMismatches`
and `windowCoversPeriod`: every present key must match; `memo_regex` is a case-sensitive search
unless it starts with `(?i)`; `related_party` needs a vendor row; amounts inclusive; a policy or
rulebook entry is in force for a period only if its window covers the whole month. One deliberate
difference: an empty pattern matches nothing here. Resolution of several matches: agree -> cite the
most specific; disagree but one strictly refines all others (e.g. a correction-learned exception
over an account rule) -> cite it; otherwise -> conflict -> ask.

**rule_versions.py.** 2025 (ISS22) category -> 2026 (SECD-ISS07): explicit overrides from
`rulebook/CHANGES.md` (canteen RELEVANT -> CATERING; plant and equipment DEPRECIATION -> inside the
cap as `ADJ_DEPRECIATION_IAS16` (D6.1.1.k); employer social security; race-weekend road transport;
sporting fines; grant gross-up direction flip -> ask), a generic new-exclusion rule driven by
master data, else the same code, else (codes only in ISS22, read from rulebook.json) a question.

**cap_analyst.py.** Deterministic first: reversal items, human answers / rejection reasons that
name one category, the related-party fair value rule (FV > contract -> `ADJ_RELATED_PARTY_FAIR_VALUE`
or a question, never contract value), then approved policies (reason `pol-<id> v<version>:
<rationale>`, evidence = gl line + bill lines + precedents; material items are still proposed,
flagged, and the module routes approval to the Head of Cost Cap). No or conflicting policy: offline
asks a templated question naming what is missing; online runs Claude through
`client.beta.messages.tool_runner` over the allowlisted tools. Code validates every model proposal
(entry in force with the same category, evidence ids actually seen, no article numbers, policy
valid and matching, one decision per item, this item only); if the model refuses, runs out of
tokens or decides nothing, the analyst asks.

**policy_learner.py.** `--onboard`: groups 2025 lines by (vendor, account), by account, and by
Grand Prix / circuit names in memos; >= 10 precedents and >= 95% consistent become candidates;
each goes through the rule-version step and is proposed with `effective_from 2026-01-01`
(`version 0` = module assigns the next version). Writes `agents/out/onboarding_report.md`: what I
learned, what changed from 2025, what I'm confident on, what I'll ask about, the escalation envelope,
and coverage of January 2026 lines. Online, Claude writes rationales and may veto a too-broad
pattern (structured output); categories and rule versions stay code. `--from-corrections`:
precedents whose reason starts `reject:` or `answer:` and names one category, >= 3 alike ->
a general policy citing the precedent ids.

**gateway.py.** Balanced entries in the cost cap sub-ledger, USD minor units:
`Dr capcat-<CATEGORY> / Cr <source account_id>`; fair value adjustments add a pro rata uplift
`Dr capcat-ADJ_RELATED_PARTY_FAIR_VALUE / Cr capadj-NOTIONAL_OFFSET`; reversals back out what was
posted and book the corrected line. Posts at most once per item: re-reads state and period lock
first, records `{erp_entry_id, lines}` in `agents/state/gateway_posted.json` before calling `post`,
and sends `work_item_id` as the ERP idempotency key.

**redteam.py.** Analyst approves own proposal, analyst / red_team post, red_team proposes and
approves, controller approves above materiality, every non-head actor locks a period, analyst and
learner approve a policy. Each must leave state unchanged and add an `allowed=false` audit row for
that actor. Data-mutation red-teaming is a TODO with the planned mutation classes in the docstring.

## Claude API usage

Official `anthropic` SDK (2.3.0), model from `CCD_MODEL`. No forced `tool_choice`, no `thinking`,
no temperature/top_p/top_k, no assistant prefill; `output_config={"effort": "medium"}`; strict
tool schemas (all params required, nullable where optional, `additionalProperties: false`);
`betas=["server-side-fallback-2026-07-01"], fallbacks="default"` on every beta call (both kwargs
exist on `client.beta.messages.create/parse/tool_runner` in 2.3.0); `stop_reason` checked for
`refusal`, `max_tokens`, `model_context_window_exceeded`.

## Tests

```bash
uv run pytest agents/tests -q
```

No services or API key needed: `tests/fakes.py` has a `FakeStdb` (records calls, serves SQL,
simulates the roles matrix, SoD, materiality, period lock, rulebook validity and denial audit
rows), a `FakeWorld` on `httpx.MockTransport` (so the real `WorldClient` is exercised), and a
`FakeAnthropic` that plays scripted tool calls through the real `beta_tool` objects.
