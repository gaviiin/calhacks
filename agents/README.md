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
| `cap_analyst` | `cap_analyst` (ai_cap_analyst) | read; `propose`, `proposeAllocations`, `ask` | approve, reject, answer, post, lock, propose_policy, any record write |
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

**policy.py.** Pattern matching and effective windows, mirroring the module: every present key
must match (`entity`, `erp_category_code` exact; `description_regex` against one bill line in
bill-line context, else against every bill line, never on a line without bill lines); a policy
or rulebook entry is in force for a period only if its window covers the whole month. Resolution
is the Ripple-Down Rule resolver of SCHEMA §11.2 (`resolve`): a policy applies when its pattern
matches and its parent applies; conclusions are applicable policies with no applicable child;
agreeing conclusions cite the deepest (ties: lowest id); disagreeing ones resolve to the one whose
effective pattern strictly refines all others, else conflict. It passes
`rulebook/rdr_conformance.json`, which the module runs too. The analyst cites exactly what it returns.

**rule_versions.py.** 2025 (ISS22) category -> 2026 (SECD-ISS07): explicit overrides from
`rulebook/CHANGES.md` (employer social security, now for every 2025 answer except Excluded
Persons; canteen RELEVANT -> CATERING, except a line whose own text says offsite; plant and
equipment DEPRECIATION -> inside the cap as `ADJ_DEPRECIATION_IAS16` (D6.1.1.k); the 2026 bonus
definition: BONUS only for a scheme determined solely by the final Constructors' classification,
annual / retention / podium / points bonuses RELEVANT, an unclear memo asked, and the policy
narrowed by memo so unclear 2026 memos are asked too; race-weekend road transport; sporting fines;
grant gross-up direction flip -> ask), a generic new-exclusion rule driven by master data, else
the same code, else a question. `map_to_2026(..., line_text=)` maps one line (the learner maps
every 2025 case on its own).

**cap_analyst.py.** Deterministic first: reversal items, human answers / rejection reasons that
name one category, the related-party fair value rule (FV > contract -> `ADJ_RELATED_PARTY_FAIR_VALUE`
or a question, never contract value), then the approved policy tree (reason `pol-<id> v<version>:
<rationale>`, evidence = gl line + bill lines + precedents; material items are still proposed,
flagged, and the module routes approval to the Head of Cost Cap). A line with two or more bill
lines is resolved per bill line: all agree -> the whole line; they differ -> `proposeAllocations`
with one `bill_line` allocation each (P01: canteen CATERING, sponsor dinner MARKETING, wind tunnel
lunch RELEVANT); any unresolved -> a question naming the split (offline) or the model's
`propose_allocations` (online, validated in code: sum, bases, own evidence, no policy, no
adjustments, `share` only for NON_F1 / HERITAGE). Category limits: before proposing an EXCLUDED
category with a cap limit the analyst reads `limit_ledger` (and open proposals) and splits the
excess as a `cap_limit_excess` RELEVANT allocation beside a bill-line sibling; a line with no bill
lines over a limit is asked. Allocated proposals always go to a human (the auto-approver cannot
approve them). No or conflicting policy: offline asks a templated question naming what is missing;
online runs Claude through `client.beta.messages.tool_runner` over the allowlisted tools.

**policy_learner.py.** `--onboard`: reads the 2025 gl lines and, when present,
`history_2025_bill_line` + `history_2025_bill_line_classification` (a mixed invoice teaches each
bill line). Every 2025 case gets its own 2026 answer from the rule-version step, groups by
(vendor, account), account, (account, department), Grand Prix memos (and department with
`--department-policies`) are judged in 2026 terms, and exceptions become RDR children: a memo
word, department, bill line description word, entity (or the account, under a parent that does
not pin one) covering >= 3 exceptions with one 2026 answer and none of the parent's own cases.
On the seed-7 world this gives `acct:6410 -> CATERING` with `description ~ offsite -> RELEVANT`
and `memo ~ partner -> MARKETING`, `acct:6420 -> MARKETING` with `description ~ canteen ->
CATERING` and `~ engineering -> RELEVANT` (so P01 splits three ways), and `acct:5040 ->
SOCIAL_SECURITY` with `memo ~ executive -> EXCLUDED_PERSONS`. Parents are proposed first
(cornerstones = a sample of their cases), then children with `parentPolicyId` (cornerstones =
their exception cases; checked client-side against history, which the module does not hold).
`agents/out/onboarding_report.md` shows the tree with cornerstone counts. Online, Claude writes
parent rationales and may veto a too-broad pattern (structured output); categories and rule
versions stay code. `--from-corrections`: precedents whose reason starts `reject:` or `answer:`
and names one category, >= 3 alike; a rejection of a line a policy decided becomes a child of that
policy (the first shared memo word, department, vendor, entity or ERP code that avoids the
parent's cornerstones; cornerstones = the corrected lines), the rest a top-level policy.

**gateway.py.** Balanced entries in the cost cap sub-ledger, USD minor units:
`Dr capcat-<CATEGORY> / Cr <source account_id>`; fair value adjustments add a pro rata uplift
`Dr capcat-ADJ_RELATED_PARTY_FAIR_VALUE / Cr capadj-NOTIONAL_OFFSET`; an allocated item posts one
pair per `allocation` row; reversals back out what was posted (per allocation) and book the
corrected line. A post that would break a category limit is not sent to the ERP. Posts at most
once per item: re-reads state and period lock first, records `{erp_entry_id, lines}` in
`agents/state/gateway_posted.json` before calling `post`, and sends `work_item_id` as the ERP
idempotency key.

**auto_approver.py.** The standing-approval job (identity `auto_approver`, `make standing`). For every
PROPOSED item it asks the module to approve what a rule backs: a deterministic proposal citing approved
policies (each bill-line allocation's, for a split invoice), or a proposal built from a person's answer
on that line. The module re-checks each one, at any amount, and logs the policy and the person behind
it; everything else (Claude's drafts for lines no rule covered, reversals, related-party adjustments)
waits for a person, who may teach a rule from their decision (`teachPolicy`).

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
simulates the roles matrix, SoD, materiality, period lock, rulebook validity, RDR precedence (`exception_applies`, `policy_conflict`), cornerstones, allocations, category limits and denial audit
rows), a `FakeWorld` on `httpx.MockTransport` (so the real `WorldClient` is exercised), and a
`FakeAnthropic` that plays scripted tool calls through the real `beta_tool` objects.
