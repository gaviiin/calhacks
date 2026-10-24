# SCHEMA.md: the shared contract

Every component in this repo codes against this file. If you need to change a name here, change it here first, then everywhere else. Ids, enum values and field names below are literal.

Layout:

```
rulebook/        rulebook.json + the script that builds it from research/fia/*.txt
world/           systems of record (mock): generator + cursor API + ERP post endpoint      [Python, FastAPI, :8010]
system_of_work/  SpacetimeDB TypeScript module: golden rows, work items, policies, audit     [spacetimedb 2.13, :3000]
agents/          sync job, gateway, Cap Analyst, Policy Learner, red team                   [Python, anthropic SDK]
```

---

## 1. Money, time, ids

- Amounts are **integer minor units** (pence/cents) in the record's own currency, field suffix `_minor`. USD equivalents use `_usd_minor`. FX rates live in `world` and are applied once, at sync time, with the rate recorded on the golden row.
- Dates are ISO `YYYY-MM-DD` strings. `period_key` is `YYYY-MM`. The cost cap year is the calendar year.
- Simulated time: the world has a clock. Records carry `visible_at` (the sim date on which a system of record first shows them) and may be re-emitted later with the same `id` (a correction). Consumers treat every emitted record as an upsert keyed by `id`.
- Ids are strings, stable, prefixed by kind: `gl-000123`, `bill-00042`, `bl-00042-3`, `ven-017`, `fv-005`, `ctr-003`, `bank-000911`, `acct-6410`, `dept-AERO`. Golden rows keep the same id as the source row and add `raw_ref` = `"<source>:<id>:<cursor>"`.

## 2. Actors and roles

Each actor is a distinct SpacetimeDB identity (token from `POST /v1/identity`). The `role` table maps identity → role. Roles:

| role | who | may do |
|---|---|---|
| `admin` | bootstrap script | `createRoleInvite`, `loadRulebookEntry`, `setSetting` |
| `sync` | sync job | upsert golden rows (which auto-creates work items) |
| `ai_cap_analyst` | agent | `propose`, `ask` on work items |
| `ai_policy_learner` | agent | `propose_policy` |
| `human_controller` | person or persona | `approve`, `reject`, `answer` on work items **below** materiality |
| `human_head_of_cost_cap` | person or persona | `approve`, `reject`, `answer` on any work item; `approve_policy`, `reject_policy`; `lock_period` |
| `gateway` | gateway job | `post` |
| `auto_approver` | standing-approval job | `approve` only, and only under a standing approval (below) |
| `red_team` | harness | nothing (every call it makes must be denied and logged) |

Every role with a known identity may also call `recordStep` (section 6b); recording is never denied.

Separation of duties, enforced in the reducer: `approve`/`reject` is denied when `work_item.proposed_by == ctx.sender`. Materiality: an item with `|amount_usd_minor| >= settings.materiality_usd_minor` can only be approved by `human_head_of_cost_cap`. Nobody can `post` except `gateway`; nothing posts unless state is `APPROVED`.

**Earned autonomy (standing approvals).** A human never approves "the agent"; the Head of Cost Cap approves a *policy* and may later grant that policy autonomy on the strength of its sandbox record (`grantAutonomy`, with the sandbox run as evidence). The `auto_approver` may approve a work item only when all hold: the item's `proposed_policy_id` points at a policy that is APPROVED, in force for the item's period and has `autonomy = "GRANTED"`; `|amount_usd_minor|` is below materiality; the proposer is not the auto_approver. Its audit row records the policy id and version and the identity that granted autonomy, so every autonomous decision traces to a named human's standing approval. `revokeAutonomy` (Head of Cost Cap) turns it off immediately; items already approved stay approved, and later ones go back to human review.

**Denials are committed, not thrown.** A reducer that denies an action writes an `audit_log` row with `allowed=false` and returns normally without changing state (a thrown error would roll back the audit row). Callers confirm success by reading the item's state afterwards. Invalid arguments (unknown id, malformed input) do throw.

## 3. Work item state machine

```
NEW ──propose──▶ PROPOSED ──approve──▶ APPROVED ──post──▶ POSTED
 │                  │  ▲                   
 │                  │  └──propose── REJECTED ◀──reject── PROPOSED
 └──ask──▶ NEEDS_INFO ──answer──▶ NEW
            ▲
PROPOSED ──ask──┘
```

| from | action | to | who |
|---|---|---|---|
| NEW | propose | PROPOSED | ai_cap_analyst |
| NEW | ask | NEEDS_INFO | ai_cap_analyst |
| PROPOSED | ask | NEEDS_INFO | ai_cap_analyst |
| NEEDS_INFO | answer | NEW | human_controller, human_head_of_cost_cap |
| PROPOSED | approve | APPROVED | human_controller (below materiality), human_head_of_cost_cap, auto_approver (standing approval only) |
| PROPOSED | reject | REJECTED | same |
| REJECTED | propose | PROPOSED | ai_cap_analyst |
| APPROVED | post | POSTED | gateway |

No delete, no edit of POSTED. A correction to a POSTED item is a new work item with `kind="reversal"` and `subject_ref` = the original item id. A period with `locked=true` refuses `propose`, `approve`, `post` on items whose `period_key` matches.

Policy state machine: `PROPOSED → APPROVED | REJECTED` (actions `approve_policy`, `reject_policy`, by `human_head_of_cost_cap`; proposer may not approve).

## 4. Rulebook (`rulebook/rulebook.json`)

A list of entries. `category_code` is stable across regulation versions; `article` and `text` change per version.

```json
{
  "id": "CATERING@SECD-ISS07",
  "category_code": "CATERING",
  "treatment": "EXCLUDED",            // EXCLUDED | RELEVANT | ADJUSTMENT
  "rule_version": "SECD-ISS07",       // SECD-ISS07 (2026 regs) | ISS22 (2021-2025 regs)
  "article": "D5.1.1.z",
  "effective_from": "2026-01-01",
  "effective_to": null,
  "title": "Catering at Competitions, Testing and team premises",
  "text": "all costs Directly Attributable to the provision of catering services at ...",
  "cap_limit_usd_minor": null         // e.g. 120000000 for staff entertainment (u)
}
```

Category codes (one row per code per rule version where it exists):

`RELEVANT`, `MARKETING`, `F1_DRIVER`, `OTHER_DRIVER_ACADEMY`, `EXCLUDED_PERSONS`, `HERITAGE`, `FINANCE_COSTS`, `CORP_TAX`, `NON_F1`, `HR_FINANCE_LEGAL`, `PROPERTY`, `BONUS`, `FIA_FEES`, `FINES`, `PU_SUPPLY`, `DEPRECIATION`, `FX`, `SOCIAL_SECURITY`, `COMPETITION_TRAVEL`, `ALT_FUEL_DEV`, `FUEL` (SECD only), `STAFF_ENTERTAINMENT`, `PARENTAL_LEAVE`, `SICK_COVER` (ISS22 only), `INDEFINITE_SICK`, `TERMINATION_2021_22` (ISS22 only), `SUSTAINABILITY`, `HEALTH_SAFETY` (SECD only), `CATERING` (SECD only), `BCDR` (SECD only).

Adjustment codes (treatment `ADJUSTMENT`), present in both versions unless marked: `ADJ_RELATED_PARTY_FAIR_VALUE`, `ADJ_GRANT_GROSS_UP`, `ADJ_RND_TIMING`, `ADJ_CAR_CAPITALISATION`, `ADJ_USED_INVENTORY`, `ADJ_PU_SSC_FAIR_VALUE`, `ADJ_UNRECORDED_COSTS`, `ADJ_FX_RETRANSLATION`, `ADJ_TYRE_TEST_DAYS`, `ADJ_NON_F1_REVERSAL`, `ADJ_SPRINT`, `ADJ_CAPEX_LIMIT` (ISS22 only), `ADJ_TERMINATION_REENGAGED` (ISS22 only), `ADJ_RDEC_EQUIVALENCE` (ISS22 only), `ADJ_DEPRECIATION_IAS16` (SECD only), `ADJ_PE_CLAWBACK` (SECD only), `ADJ_IMPAIRMENT_CLAWBACK` (SECD only), `ADJ_UNUSED_CAP_CARRYFORWARD` (SECD only), `ADJ_CONSIDERATION_FACTOR` (SECD only), `ADJ_PU_INTEGRATION_2027_28` (SECD only).

Built: `rulebook/rulebook.json` has 85 entries (40 ISS22, 45 SECD-ISS07). `rulebook/CHANGES.md` lists the rule changes that make a 2025 precedent wrong in 2026 (catering, R&D grant direction, depreciation, social security, travel, sprint).

The LLM never emits an `article`. It emits a `rulebook_entry_id`; code resolves the citation.

## 5. World records (systems of record)

Served by `world/` at `http://localhost:8010`. Every record has `id`, `source`, `visible_at`, `updated_at`.

**Sources and shapes** (all fields present, nulls allowed where marked):

- `account`: `{id:"acct-6410", code:"6410", name:"Catering & canteen", default_category_code:"CATERING", kind:"expense"}`
- `department`: `{id:"dept-AERO", name:"Aerodynamics", head:"...", f1_activity_share:1.0}` (share < 1 for mixed F1/non-F1 departments)
- `vendor`: `{id, name, country, related_party:bool, related_party_entity:str|null, bank_iban:str, category_hint:str|null}`
- `gl_line` (statutory ledger with ERP coding): `{id, posted_date, period_key, account_id, department_id, vendor_id|null, bill_id|null, amount_minor, currency, fx_rate_to_usd, amount_usd_minor, memo, erp_category_code (what the ERP user coded it as, may be wrong), entity:"RACING"|"TECHNOLOGY", correction_of:str|null}`
- `bill`: `{id, vendor_id, bill_date, due_date, total_minor, currency, bank_iban_on_bill, text:"...free text as scanned..."}`
- `bill_line`: `{id, bill_id, gl_line_id|null, line_no, description, amount_minor}`
- `contract`: `{id, counterparty_vendor_id, kind:"PU_SUPPLY"|"RECHARGE"|"SPONSORSHIP"|"FREIGHT", start, end, terms:{...}}`
- `fair_value`: `{id, counterparty_vendor_id, item, contract_value_minor, fair_value_minor, currency, effective_from, basis:"..."}`
- `bank_txn`: `{id, booked_date, amount_minor, currency, counterparty, memo, matched_bill_id|null}`
- `history_2025_gl_line`: same shape as `gl_line`, for 2025
- `history_2025_cap_classification`: `{id, gl_line_id, category_code, rulebook_entry_id, decided_by:"analyst"|"head_of_cost_cap", reason}` (the 2025 submission at line level)
- `history_2025_approval`: `{id, gl_line_id, amount_usd_minor, escalated_to:"head_of_cost_cap"|null, decision, reason, decided_on}`
- `rulebook_issue`: `{id:"SECD-ISS07", published_on:"2026-06-25", effective_from:"2026-01-01", path:"rulebook/rulebook.json"}` (a rule change arrives as a new record here)

**Cursor API** (change-only, per source):

```
GET  /clock                              -> {"sim_date":"2026-03-14"}
POST /clock/advance   {"days": 7}        -> {"sim_date": ...}
GET  /sources                            -> ["account","department",...]
GET  /changes/{source}?after=0&limit=500 -> {"records":[{"cursor":17,"op":"upsert","record":{...}}], "next_cursor":17, "has_more":false}
GET  /records/{source}/{id}              -> record
POST /erp/journal_entries                -> {"erp_entry_id":"JE-2026-000417"}   header X-Gateway-Key required
     body {"work_item_id":"...", "period_key":"2026-03", "lines":[{"account_id":..,"debit_minor":..,"credit_minor":..}], "memo":"...", "evidence_refs":[...]}
GET  /answer_key                         -> CSV (dev only)
```

Only records with `visible_at <= sim_date` appear in `/changes`. A record emitted again (correction, late posting) gets a new cursor and the same `id`. Cursors are monotonic integers per source.

**Generator**: `python -m world.generate --seed 7 --out world/out` writes `world/out/<source>.jsonl` and `world/out/answer_key.csv`. Deterministic from seed. Scale: 2025 history ~3,000 GL lines; 2026 stream Jan-Nov ~3,000 GL lines; ~40 planted items.

**Answer key** (`world/out/answer_key.csv`): `plant_id, source, record_id, error_class, expected_action, expected_category_code, note`.
`expected_action` ∈ `reclassify | ask | hold | deny | flag`. `error_class` is free text from a fixed list in `world/plants.py` (e.g. `catering_as_marketing`, `pu_below_fair_value`, `sick_pay_not_indefinite`, `tax_credit_not_grossed_up`, `heritage_parts`, `non_competition_travel`, `maintenance_in_hr`, `duplicate_invoice`, `split_under_threshold`, `backdated_locked_period`, `bank_details_changed`, `prior_year_catering_in_jan`).

## 6. System of work tables (SpacetimeDB module `cost-cap-desk`)

All tables `public: true` for the dashboard. Timestamps are `t.timestamp()`; money is `t.i64()`; JSON payloads are `t.string()`.

- `role { identity: identity PK, role: string, label: string }`
- `role_invite { code: string PK, role: string, label: string, used: bool }`
- `setting { key: string PK, value: string }` keys: `materiality_usd_minor`, `cap_usd_minor`, `cap_year`
- `period { key: string PK, locked: bool, locked_by: identity?, locked_at: timestamp? }`
- `rulebook_entry { id: string PK, category_code: string(index), treatment, rule_version, article, effective_from, effective_to: string?, title, text, cap_limit_usd_minor: i64? }`
- `gl_line { id: string PK, raw_ref, posted_date, period_key(index), account_id, account_code, department_id, vendor_id: string?, bill_id: string?, amount_minor, currency, fx_rate_e_6: i64 (SQL column name; reducer arg fxRateE6), amount_usd_minor, memo, erp_category_code, entity, correction_of: string?, synced_at }`
- `bill_line { id PK, raw_ref, bill_id(index), gl_line_id: string?(index), line_no: u32, description, amount_minor, bill_text, vendor_id, bank_iban_on_bill }`
- `vendor { id PK, raw_ref, name, country, related_party: bool, related_party_entity: string?, bank_iban, category_hint: string? }`
- `fair_value { id PK, raw_ref, counterparty_vendor_id(index), item, contract_value_minor, fair_value_minor, currency, effective_from, basis }`
- `work_item { id: u64 PK autoInc, kind: string, subject_ref: string(index), period_key(index), amount_usd_minor, state: string(index), proposed_by: identity?, proposed_category_code: string?, proposed_rulebook_entry_id: string?, proposed_policy_id: u64?, reason: string, evidence_refs: string, question: string?, answer: string?, decided_by: identity?, decided_reason: string?, erp_entry_id: string?, created_at, updated_at }`
- `policy { id: u64 PK autoInc, policy_key: string(index), version: u32, category_code, rulebook_entry_id, pattern: string, rationale, evidence_refs, precedent_count: u32, effective_from, effective_to: string?, state: string, proposed_by: identity, decided_by: identity?, decided_reason: string?, created_at, decided_at: timestamp?, autonomy: string ("NONE" | "GRANTED" | "REVOKED", starts "NONE"), autonomy_by: identity?, autonomy_evidence: string (JSON: sandbox run id, sandboxes, lines, errors, missed plants), autonomy_reason: string?, autonomy_at: timestamp? }`
- `precedent { id: u64 PK autoInc, work_item_id: u64(index), pattern_summary, category_code, decided_by: identity, reason, at }`  (written on approve/reject/answer)
- `audit_log { id: u64 PK autoInc, at, actor: identity, actor_role, action, resource_kind, subject_id: string(index), allowed: bool, from_state, to_state, reason, diff: string, evidence: string, policy_id: u64?, policy_version: u32? }`
- `cap_position { period_key PK, relevant_usd_minor, excluded_usd_minor, pending_usd_minor, posted_items: u32, updated_at }`

`pattern` on a policy is a JSON string with optional keys: `vendor_id`, `account_code`, `department_id`, `memo_regex`, `related_party`, `min_amount_usd_minor`, `max_amount_usd_minor`. A line matches a policy when every present key matches. Matching is done in Python (agents) and mirrored in the module only for validation of `proposed_policy_id` (the policy must be APPROVED and in force for the item's period).

**Reducers** (exported const name = reducer name, camelCase):

| reducer | args | role |
|---|---|---|
| `bootstrapAdmin` | `{}` | anyone, only while `role` is empty; caller becomes admin |
| `createRoleInvite` | `{role, label, code}` | admin; stores a one-time invite code for a role (identities cannot be constructed from strings inside a module, so roles are claimed, not assigned) |
| `claimRole` | `{code}` | anyone holding an unused code; inserts `role{identity: ctx.sender, role, label}` and burns the code |
| `setSetting` | `{key, value}` | admin |
| `loadRulebookEntry` | one entry's fields | admin |
| `lockPeriod` | `{periodKey}` | human_head_of_cost_cap |
| `upsertGlLine` | gl_line fields | sync; creates a `work_item(kind="classification")` on first sight, or `kind="reversal"` if the line is a correction of a POSTED item's subject |
| `upsertBillLine`, `upsertVendor`, `upsertFairValue` | fields | sync |
| `propose` | `{workItemId, categoryCode, rulebookEntryId, policyId?, reason, evidenceRefs}` | ai_cap_analyst |
| `ask` | `{workItemId, question}` | ai_cap_analyst |
| `answer` | `{workItemId, answer}` | human_* |
| `approve` | `{workItemId, reason}` | human_* (materiality, SoD) |
| `reject` | `{workItemId, reason}` | human_* (SoD) |
| `post` | `{workItemId, erpEntryId}` | gateway |
| `proposePolicy` | policy fields minus state/ids | ai_policy_learner |
| `approvePolicy`, `rejectPolicy` | `{policyId, reason}` | human_head_of_cost_cap |
| `grantAutonomy` | `{policyId, evidence, reason}` | human_head_of_cost_cap; policy must be APPROVED; `evidence` is the sandbox record JSON |
| `revokeAutonomy` | `{policyId, reason}` | human_head_of_cost_cap |
| `recordStep` | `{runId, step, kind, name, input, outputDigest, outputExcerpt, workItemId?, model?}` | any role except `none`; never denied; not a state change |

## 6b. Agent steps: record genuinely everything

Transitions are logged in `audit_log`. Everything an agent does *between* transitions is logged in `agent_step`, so a reviewer can see what it read, which tools it called, what the model was asked and answered, and what it decided, for any work item.

- `agent_step { id: u64 PK autoInc, run_id: string(index), actor: identity, actor_role: string, step: u32, kind: string, name: string, input: string, output_digest: string, output_excerpt: string, work_item_id: u64?(index), model: string?, at: timestamp }`
- `kind` ∈ `run_start`, `read`, `tool_call`, `model_call`, `decision`, `note`, `error`, `run_end`. `name` is the tool, reducer, SQL table or model purpose. `input` is the JSON arguments (or prompt digest plus the last user turn for a model call), at most 8 KB. `output_digest` is a SHA-256 of the full output; `output_excerpt` is at most 2 KB. The reducer truncates oversize fields rather than rejecting them, and marks truncation with a trailing `…[truncated]`.
- `run_id` is client-generated: `<actor>-<sim_date>-<8 hex>`. One run = one CLI invocation of an agent. `step` increases by 1 within a run.
- Every agent tool wrapper records a `tool_call` step before returning, including failures (`kind="error"`). Every Anthropic API call records a `model_call` step with the model id, stop reason and token usage in `output_excerpt`. Every proposal or question is preceded by a `decision` step whose `input` lists the candidates considered and why the winner won.
- Append-only: no update or delete reducer exists for `agent_step`.

Every reducer above except `bootstrapAdmin` goes through one `transition()` helper that: resolves the caller's role; checks the roles matrix, SoD, materiality, period lock, and rulebook validity (entry in force for the item's `period_key`); snapshots before/after; writes exactly one `audit_log` row **in the same transaction**; and on denial writes the row with `allowed=false` and returns without changing state.

## 7. Agent tool surface (CRUD on the work, never on records)

Python functions in `agents/tools.py`, each a thin wrapper over an HTTP reducer call or SQL read as the agent's own identity:

- `list_queue(state="NEW", limit=20)` → work items
- `read_item(work_item_id)` → work item + its gl_line + bill_lines + vendor + fair_value rows
- `search_policies(category_code=None, vendor_id=None, account_code=None, in_force_on=None)` → APPROVED policies
- `search_precedents(vendor_id=None, account_code=None, memo_contains=None, limit=20)`
- `search_rulebook(query, in_force_on)` → rulebook entries
- `propose_classification(work_item_id, category_code, rulebook_entry_id, policy_id, reason, evidence_refs)`
- `ask(work_item_id, question)`
- `propose_policy(policy_key, category_code, rulebook_entry_id, pattern, rationale, evidence_refs, precedent_count, effective_from, effective_to)`

The Cap Analyst gets the first seven. The Policy Learner gets `search_*` plus `propose_policy` and read access to the 2025 history via the world API. No agent gets `approve`, `post`, `lock_period`, the gateway key, or the admin token.

**Calling reducers over HTTP.** `POST /v1/database/cost-cap-desk/call/<reducerName>` with `Authorization: Bearer <token>` and a JSON **array** of the arguments in the order the reducer declares them (the same order `spacetime call` takes them). **Argument order is pinned:** for the reducers in the table above, the order is exactly as written in the args column; for `upsertGlLine`, `upsertBillLine`, `upsertVendor`, `upsertFairValue`, `loadRulebookEntry` and `proposePolicy`, the order is the field order of the corresponding table in this section, skipping `synced_at`, `raw_ref` excepted (raw_ref is included, second), auto-inc ids, state, timestamps and identity columns the reducer fills itself. Field names in reducer args are camelCase versions of the snake_case names here. Optional args use SATS-JSON (`{"some": value}` / `{"none": []}`). `system_of_work/REDUCERS.md` lists the final signatures and is authoritative if this paragraph and the code disagree. Reads use `POST /v1/database/cost-cap-desk/sql` with the SQL text as the body; the response is `[{schema, rows}]` and rows are positional arrays matching `schema.elements[i].name`.

## 8. Ports and env

| what | where |
|---|---|
| SpacetimeDB | `spacetime start` on `:3000`; database name `cost-cap-desk` |
| world API | `uvicorn world.api:app --port 8010` |
| env | `STDB_URL=http://localhost:3000`, `STDB_DB=cost-cap-desk`, `WORLD_URL=http://localhost:8010`, `GATEWAY_KEY=...`, `ANTHROPIC_API_KEY` or `ant auth login` |
| identities | `agents/identities.json` written by `python -m agents.bootstrap` (tokens per actor; gitignored) |

## 9. Known gaps (found in the first end-to-end run, Oct 24)

- **Split invoices.** A `work_item` holds one category, so one GL line whose bill lines span several categories cannot be classified correctly. The demo hospitality invoice (`gl-000001`, plant P01: canteen, sponsor dinner, engineering lunch) is exactly this case. In the first run the analyst applied the account-level hospitality policy to the whole line and proposed MARKETING. Planned fix: `propose` takes an optional allocation list `[{billLineId, categoryCode, rulebookEntryId, amountUsdMinor}]` whose amounts must sum to the line, validated in `transition()`; the gateway posts one journal line per allocation. Until then, a line with more than one bill line should never be auto-proposed from an account-level policy.
- **Policies swallow their own exceptions.** A policy learned at 98% consistency still applies to the 2% it was learned against. The learner records the exceptions but the pattern has no way to exclude them. This is what typed rules with precedents as tests would fix.
- **Payroll on-costs.** Department-level payroll policies absorbed employer social security lines, which 2026 excludes in full (D5.1.1.q). The learner should treat social security as its own pattern ahead of department rules.
- **Over-broad rule mapping.** The learner mapped the whole "Fuel & lubricants" account to FUEL, but only FIA homologated fuel is excluded (D5.1.1.t). The Head of Cost Cap rejected it in the run; the learner should ask instead when an account's name covers more than the rulebook entry does.

## 10. Tier 0 contract changes (Oct 24, from `research/review/00-review.md`)

These fix the ten confirmed defects. Field and argument names are literal; `system_of_work/REDUCERS.md` stays authoritative for final signatures.

**Corrections and reversals (defect 1).**
- A *new* GL line that carries `correction_of` is an ordinary `classification` work item. The statutory ledger already nets delta pairs (a −A "Reversal of gl-X" plus a +A repost), so the module must not subtract anything for them. `correction_of` is kept on the golden row as evidence only.
- A `reversal` work item is created only when the sync re-emits an existing GL line whose latest work item is POSTED with a changed `amount_usd_minor`, `account_code`, `period_key`, `vendor_id`, `department_id` or `memo`. The reversal's `reverses_item_id` is that latest POSTED item (new column, `u64?`), never an older one. Posting a reversal subtracts exactly the reversed item's posted cap effect once, marks it `superseded = true` (new column), and applies the reversal's own classification; the reversal is then the latest posted state of the line. Work items also record `posted_cap_effect_usd_minor` and `posted_treatment` at post time so a later reversal backs out what was actually booked.
- Only one open (non-POSTED) reversal may exist per GL line; a further re-sync refreshes it (rule below) instead of creating another.

**Reopen on correction (defect 2).** A re-sync that changes any of `amount_usd_minor`, `amount_minor`, `currency`, `account_code`, `vendor_id`, `department_id`, `memo`, `posted_date`, `period_key` on an item in PROPOSED, NEEDS_INFO or APPROVED moves it back to NEW, clears `proposed_*`, `reason`, `evidence_refs`, `question`, `answer`, `decided_*`, and writes an audit row `action = "reopen"` with reason `reopened by correction: <changed fields>`. An item in NEW is refreshed in place as today.

**Re-validate at approve and post (defect 3).** `approve` (every role) and `post` re-run the full proposal checks against the current rows: cited rulebook entry in force for the period, cited policy APPROVED, in force, matching the line and not superseded by a higher approved version. `work_item.answered_by: identity?` records who answered the last question; `approve`/`reject` by that identity is denied as `separation_of_duties`. Approving policy version n+1 sets `autonomy = "SUSPENDED"` on version n (new autonomy state; the Head may re-grant) and reopens its open items (PROPOSED → NEW with audit `reopen`, reason `policy superseded`).

**Cap effect on adjustments (defect 4, arithmetic part).** `propose` gains two arguments after `evidenceRefs`: `capEffectUsdMinor: i64?` and `proposalSource: string` (`deterministic` | `llm` | `human_text`). For RELEVANT and EXCLUDED treatments `capEffectUsdMinor` must be absent (the line amount is used). For ADJUSTMENT treatment it is required and is the signed amount added to `relevant_usd_minor` at post: a grant or tax-credit gross-up on a −£1.38m credit is `0`; a related-party fair-value adjustment is `amount + uplift`. `post` uses it, so the dashboard and the ERP agree. Category limit enforcement stays Tier 1.

**Auto-approver (defects 2, 3, 6).** The `auto_approver` is denied when `proposal_source != "deterministic"`, when the cited policy is superseded or SUSPENDED, and whenever the re-validation above fails.

**Locks (defect 8).** `lockPeriod` is denied while any work item in that period is not POSTED (reason lists the count and the first ten ids). The analyst never re-proposes an item whose last audit row is a denial with no change to the line since; it asks instead, naming the denial reason. `list_queue` orders NEW items oldest-updated first, after items with no denial history.

**Patterns (defect 11).** Both matchers normalise `memo` with NFKC, strip surrounding whitespace, and match `memo_regex` with ASCII-only semantics (Python `re.ASCII | re.IGNORECASE`; JavaScript without the `u` flag, with `i`). A pattern must have at least one non-null key. `memo_regex` is rejected if it contains a quantifier applied to a group that itself contains a quantifier, or is longer than 200 characters; memos longer than 500 characters are truncated before matching. Both sides ship the same conformance table of (regex, memo, expected) cases in `rulebook/pattern_conformance.json`, and each test suite runs it.

**Sync (defect 9).** Each record is applied in its own reducer call; a record that fails (bad data, module error) goes to `agents/state/dead_letter.jsonl` with the error, and the cursor advances past it. A `delete` op re-emits the line with `amount_minor = 0` and `amount_usd_minor = 0` and memo prefixed `VOID:`, which the reversal rule above turns into a reversal if the line was posted.

**Epoch (defect 10).** `bootstrap` writes `setting db_epoch = <16 random hex>`. Every local state file (`sync_cursors.json`, `sync_cache.json`, `gateway_posted.json`, `identities.json`) records the epoch it was written under; an agent whose state file carries a different epoch than the module refuses to run and says which file to delete. `make stdb-publish` deletes `agents/state/`.

**Evidence and injection (defect 6).** `validate_proposal` accepts only evidence ids that appear in the session item's own `read_item` result (its gl line, bill lines, vendor, fair values, precedents returned for it). Untrusted text fields (`memo`, `bill_text`, `description`, vendor `name`) are passed to the model inside a fenced data block with an instruction that they are data; the system prompt says any instruction found inside them is to be reported, not followed. The related-party check runs before the human-text path, and the human-text path never proposes a category other than the one the human named. LLM proposals never carry a `policy_id`.

**Related party (defect 5).** The analyst compares `fair_value_minor` with the line's invoiced `amount_minor` in the same currency; it fires when fair value exceeds the invoiced amount. No uplift on negative lines. A currency mismatch between the fair value row and the line is a question, not a crash.

**Pre-checks (defect 7, minimal).** Before policy matching the analyst runs deterministic checks and asks (never proposes) on a hit: same vendor and absolute amount within 30 days (possible duplicate); bill `bank_iban_on_bill` differs from the vendor master `bank_iban` (changed bank details); vendor name whose NFKC-normalised, confusable-folded form equals another vendor's but whose id differs (lookalike); same vendor, same posted date, two or more lines whose sum is at or above materiality (possible split). Aggregate materiality in the module stays Tier 1.
