# REDUCERS.md: calling the system of work

This file is authoritative for anyone calling the `system_of_work` SpacetimeDB module (SCHEMA.md section 7 says so). Everything below was verified against SpacetimeDB 2.13 on a local server; the curl commands under [Smoke test](#smoke-test) are the exact ones that ran (updated for the Tier 0 contract, see [Tier 0 changes](#tier-0-changes-schemamd-section-10)).

## Tier 0 changes (SCHEMA.md section 10)

What changed for callers on Oct 24, in one place. Details are in the sections below.

- **`propose` has two new trailing arguments:** `capEffectUsdMinor: i64?` and `proposalSource: string`. Positional order is now `workItemId, categoryCode, rulebookEntryId, policyId?, reason, evidenceRefs, capEffectUsdMinor?, proposalSource`. Sending six arguments is a 400. `proposalSource` must be `deterministic`, `llm` or `human_text` (else 530). `capEffectUsdMinor` is **required** when the cited rulebook entry's treatment is `ADJUSTMENT` (it is the signed amount `post` adds to `relevant_usd_minor`; `0` is a value, send `{"some":0}`) and must be `{"none":[]}` for `RELEVANT` and `EXCLUDED` (the line amount is used); otherwise the proposal is denied `cap_effect_invalid`.
- **New `work_item` columns:** `answered_by: identity?`, `cap_effect_usd_minor: i64?`, `proposal_source: string` (`""` until proposed), `reverses_item_id: u64?`, `superseded: bool`, `posted_cap_effect_usd_minor: i64?`, `posted_treatment: string?`.
- **New audit action `reopen`** (resource `work_item`, `allowed=true`, `from_state` → `NEW`). Written by the module itself inside a `sync_upsert` (reason `reopened by correction: <changed fields>`) or an `approve_policy` (reason `policy superseded`). Those two reducers can therefore write more than one audit row per call.
- **Corrections:** a *new* line with `correction_of` is a plain `classification`. A reversal is created only by a re-sync of a line whose latest work item is POSTED with a changed `amount_usd_minor`, `account_code`, `period_key`, `vendor_id`, `department_id` or `memo`; it reverses that latest POSTED item (`reverses_item_id` = `subject_ref` = its id, which may itself be a reversal). One open reversal per line.
- **Reopen:** a re-sync that changes `amount_usd_minor`, `amount_minor`, `currency`, `account_code`, `vendor_id`, `department_id`, `memo`, `posted_date` or `period_key` on a PROPOSED, NEEDS_INFO or APPROVED item moves it back to NEW and clears the proposal, question, answer and decision.
- **Re-validation:** `approve` (every role) and `post` re-run the propose checks against the current rows (`rulebook_invalid`, `policy_invalid`, `cap_effect_invalid`). The identity that answered the item's last question may not approve or reject it (`separation_of_duties`).
- **Policy autonomy has a fourth state `SUSPENDED`:** approving version n+1 of a `policy_key` sets it on every lower APPROVED version that was GRANTED, and reopens the PROPOSED/APPROVED items citing those versions (where the new version is in force for the item's period). The head may `grantAutonomy` again (SUSPENDED → GRANTED) or `revokeAutonomy` (SUSPENDED → REVOKED).
- **`auto_approver`** approves only what an approved rule decided (see [Earned autonomy](#earned-autonomy-standing-approvals)); it is denied for `llm` proposals, when a cited policy is SUSPENDED, REVOKED or superseded, and whenever re-validation fails. Materiality does not bind it.
- **`lockPeriod`** is denied `period_not_ready` while any work item in the period is not POSTED (the reason gives the count and the first ten ids).
- **Patterns:** `memo_regex` and the memo are NFKC-normalised, the memo is stripped and cut to 500 code points, matching is always case-insensitive with ASCII `\d \w \b` (no `u` flag). `(?i)` and other inline flags, lookbehind, named groups, nested quantifiers, more than 200 characters and non-BMP characters are refused (530 at `proposePolicy`; `policy_invalid: … unparsable pattern` for an older stored policy). A pattern with no non-null key is refused. The shared cases are `rulebook/pattern_conformance.json`.

## Tier 1 changes (SCHEMA.md section 11)

What changed for callers on Oct 24 (allocations, category limits, Ripple-Down Rule policies). Verified by the in-memory suite (`npm test`) and `spacetime build`; **not yet run against a live server** (the SATS-JSON below follows the same rules as the top-level arguments, which were verified).

- **New reducer `proposeAllocations`**, positional args `workItemId: u64, allocations: Allocation[], reason: string, evidenceRefs: string, proposalSource: string`, where `Allocation = {basis: string, basisRef: string, categoryCode: string, rulebookEntryId: string, policyId: u64?, amountUsdMinor: i64, capEffectUsdMinor: i64?}` (SATS type name `AllocationInput`; field order as written). Same roles (`ai_cap_analyst`), states (`NEW|REJECTED → PROPOSED`) and audit action (`propose`) as `propose`. Details in [Allocations](#allocations-and-category-limits).
- **`proposePolicy` has two new trailing arguments:** `parentPolicyId: u64?` and `cornerstones: string` (JSON array). Positional order is now `policyKey, version, categoryCode, rulebookEntryId, pattern, rationale, evidenceRefs, precedentCount, effectiveFrom, effectiveTo?, parentPolicyId?, cornerstones`. Sending ten arguments is a 400. Send `{"none":[]}` and `"[]"` for a top-level policy with no cornerstones.
- **New tables:** `allocation`, `limit_ledger`. **New `policy` columns:** `parent_policy_id: u64?`, `cornerstones: string`, `flip_report: string`.
- **New pattern keys:** `description_regex`, `entity`, `erp_category_code`.
- **Allocation bases:** `bill_line`, `share`, `cap_limit` (within the limit), `cap_limit_excess` (above it).
- **Category limits are checked at propose, proposeAllocations, approve and post** (`cap_limit_exceeded`).
- **New denial codes:** `allocation_invalid`, `allocation_sum_mismatch`, `apportionment_not_permitted`, `cap_limit_exceeded`, `exception_applies`, `policy_conflict`, `cornerstone_mismatch`, `conflicting_cornerstone`. `exception_applies` and `policy_conflict` apply to `propose` too, and to `approve` and `post` (re-validation), for every cited policy.
- **Resolution is strict:** when several policies agree on a line, the module accepts only the one resolution cites (deepest, ties lowest id). Citing another agreeing policy is `policy_conflict`. Use the agents' resolver (it runs the same `rulebook/rdr_conformance.json`) to pick the policy.
- **New `reopen` reason** `exception approved: pol-<id>`, and `approvePolicy` may now create `reversal` work items (see [Policies as Ripple-Down Rules](#policies-as-ripple-down-rules)).
- **`propose_policy` audit evidence is now a JSON object** (it was the `evidenceRefs` string): `{"evidence_refs": "<the evidenceRefs string>", "cornerstones": {...}, "flip_report": {...}}`.
- **Gateway:** for an item with `proposed_category_code = "ALLOCATED"`, post one journal line pair per `allocation` row (`SELECT * FROM allocation WHERE work_item_id = <id>`; `work_item_id` is a plain u64, so it can be filtered). The module books `cap_position` per allocation by its treatment, so that is what the ERP must show.

## Database name: `cost-cap-desk` (not `cost_cap_desk`)

SpacetimeDB 2.13 rejects underscores in database names (`/^[a-z0-9]+(-[a-z0-9]+)*$/`, "invalid characters in database name"). The module is published as **`cost-cap-desk`**. Use `STDB_DB=cost-cap-desk`. Table and column names are snake_case as in SCHEMA.md; reducer names are camelCase.

```bash
cd system_of_work
spacetime build
spacetime publish cost-cap-desk --server local --yes           # add --delete-data=always to wipe and reload
cd spacetimedb && npm test                                      # in-memory unit tests (vitest)
```

**Local login.** The CLI was not logged in. On the first `spacetime publish ... --server local`, the CLI logged in directly to the local server by itself ("We have logged in directly to your target server. WARNING: This login will NOT work for any other servers.") and saved the token to `~/.config/spacetime/cli.toml`. No spacetimedb.com login is needed. Never omit `--server local`: the CLI's default server is maincloud.

## HTTP basics

| what | how |
|---|---|
| new identity | `POST http://localhost:3000/v1/identity` returns `{"identity":"c200…","token":"eyJ…"}` |
| call a reducer | `POST http://localhost:3000/v1/database/cost-cap-desk/call/<reducerName>`, headers `Authorization: Bearer <token>`, `Content-Type: application/json`, body = JSON **array** of args in the order below |
| read | `POST http://localhost:3000/v1/database/cost-cap-desk/sql`, same auth header, body = raw SQL text |

### Responses

| status | meaning | audit row? |
|---|---|---|
| `200`, empty body | The reducer committed. **That includes denials.** A denied action writes `audit_log.allowed=false` and returns normally. Confirm success by reading the item's state (or the newest audit row) afterwards. | yes, exactly one |
| `530`, body is the error text (e.g. `unknown work item 424242`) | `SenderError`: malformed input (unknown work item/policy id, bad date or period key, empty required string, bad pattern JSON). The transaction rolled back. | no |
| `400`, body explains | Arguments did not decode (wrong count, wrong type, u64 sent as a string). | no |
| `404`, `No such procedure` | Wrong reducer name. Names are camelCase: `bootstrapAdmin`, not `bootstrap_admin`. | no |

### Argument encoding (SATS-JSON)

- **Positional array** in the order listed below. (An object keyed by the **camelCase** argument names also works: `{"workItemId":1,"reason":"ok"}`. snake_case keys are rejected with 400.)
- `u64`, `u32`, `i64`: JSON **numbers**: `914400`, not `"914400"` (a string gets 400). All amounts here fit in 2^53.
- `bool`: `true` / `false`.
- `Option<T>`: `{"some": value}` or `{"none": []}`. `null` was also accepted for none on this server, but use `{"none": []}`.
- No reducer takes an Identity argument; the caller is always `ctx.sender` (the bearer token). Roles are claimed with invite codes, never assigned by identity.
- Strings that carry JSON (`evidenceRefs`, `pattern`) are JSON **strings containing JSON**: `"[\"gl-000123\",\"bill-00042\"]"`.

### SQL result encoding

The response is `[{"schema":{"elements":[…]},"rows":[[…],…]}]`. Rows are positional; a column's name is `schema.elements[i].name.some` (the name is itself wrapped as an option). Values:

| column type | in SQL rows | example |
|---|---|---|
| string, bool | as is | `"PROPOSED"`, `false` |
| u64, u32, i64 | number | `914400` |
| `Option<T>` | **`[0, value]` for some, `[1, []]` for none** (tag index, not `{"some":…}`) | `[0,"CATERING"]`, `[1,[]]` |
| identity | one-element array with 0x-hex | `["0xc200…cd7"]` |
| timestamp | one-element array, microseconds since Unix epoch | `[1792827492538188]` |

Filter by identity with a bare hex literal: `SELECT role, label FROM role WHERE identity = 0xc200c8eb…3e`. `key` is usable as a column name: `SELECT * FROM setting WHERE key = 'materiality_usd_minor'`.

**You can't filter on an `Option` column in SQL.** `WHERE work_item_id = 1`, `= '1'`, `= some(1)` and `IS NOT NULL` all fail (`The literal expression 1 cannot be parsed as type (some: U64 | none: ())`). That covers `agent_step.work_item_id`, `bill_line.gl_line_id`, `work_item.proposed_policy_id`, `gl_line.vendor_id`, `audit_log.policy_id`, and so on. Filter on a non-option column (`agent_step.run_id`, `bill_line.bill_id`, `work_item.subject_ref`, `audit_log.subject_id`) and finish the filter in Python.

Python unwrapping, for `agents/`:

```python
def col(resp, name):           # index of a column by name
    return [e["name"]["some"] for e in resp[0]["schema"]["elements"]].index(name)
def opt(v):                    # Option from SQL: [0, x] -> x, [1, []] -> None
    return v[1] if v[0] == 0 else None
def ident(v): return v[0]      # ["0x..."] -> "0x..."
def ts_micros(v): return v[0]  # [micros] -> micros
```

## Reducers

`?` marks `Option<T>`. Args are listed in exact positional order.

| reducer | positional args (types) | who may call | effect |
|---|---|---|---|
| `bootstrapAdmin` | *(none)*: body `[]` | anyone, only while `role` is empty | caller becomes `admin`. Not routed through `transition()`, but it writes one audit row either way; a second call is denied (`already_bootstrapped`) and logged |
| `createRoleInvite` | `role: string, label: string, code: string` | admin | stores a one-time invite. `role` must be one of `admin, sync, ai_cap_analyst, ai_policy_learner, human_controller, human_head_of_cost_cap, gateway, auto_approver, red_team` (else 530). Reusing a code is denied |
| `claimRole` | `code: string` | an identity **with no role** | inserts `role{identity: caller, role, label}` and burns the code. Unknown or used code: denied and logged. One identity holds one role for life |
| `setSetting` | `key: string, value: string` | admin | upsert. `materiality_usd_minor`, `cap_usd_minor`, `cap_year` must be integer strings (else 530) |
| `loadRulebookEntry` | `id: string, categoryCode: string, treatment: string, ruleVersion: string, article: string, effectiveFrom: string, effectiveTo: string?, title: string, text: string, capLimitUsdMinor: i64?` | admin | upsert. `treatment` ∈ `EXCLUDED, RELEVANT, ADJUSTMENT`; dates `YYYY-MM-DD` |
| `lockPeriod` | `periodKey: string` | human_head_of_cost_cap | `OPEN → LOCKED` (no unlock). Denied `period_not_ready` while any work item with that `period_key` is not POSTED (NEW, PROPOSED, NEEDS_INFO, APPROVED or REJECTED); the reason gives the count and the first ten ids. Locking twice is denied |
| `upsertGlLine` | `id: string, rawRef: string, postedDate: string, periodKey: string, accountId: string, accountCode: string, departmentId: string, vendorId: string?, billId: string?, amountMinor: i64, currency: string, fxRateE6: i64, amountUsdMinor: i64, memo: string, erpCategoryCode: string, entity: string, correctionOf: string?` | sync | upserts the golden row (`synced_at` = now) and creates or refreshes work items, see [Sync semantics](#sync-semantics) |
| `upsertBillLine` | `id: string, rawRef: string, billId: string, glLineId: string?, lineNo: u32, description: string, amountMinor: i64, billText: string, vendorId: string, bankIbanOnBill: string` | sync | upsert |
| `upsertVendor` | `id: string, rawRef: string, name: string, country: string, relatedParty: bool, relatedPartyEntity: string?, bankIban: string, categoryHint: string?` | sync | upsert (a bank IBAN change shows in the audit diff) |
| `upsertFairValue` | `id: string, rawRef: string, counterpartyVendorId: string, item: string, contractValueMinor: i64, fairValueMinor: i64, currency: string, effectiveFrom: string, basis: string` | sync | upsert |
| `propose` | `workItemId: u64, categoryCode: string, rulebookEntryId: string, policyId: u64?, reason: string, evidenceRefs: string, capEffectUsdMinor: i64?, proposalSource: string` | ai_cap_analyst | `NEW|REJECTED → PROPOSED`. Sets `proposed_*`, `reason`, `evidence_refs`, `cap_effect_usd_minor`, `proposal_source`; clears `decided_by/decided_reason`. `proposalSource` ∈ `deterministic, llm, human_text` (else 530). `capEffectUsdMinor` required iff the entry's treatment is `ADJUSTMENT` (else denied `cap_effect_invalid`) |
| `proposeAllocations` | `workItemId: u64, allocations: Allocation[], reason: string, evidenceRefs: string, proposalSource: string` with `Allocation = {basis: string, basisRef: string, categoryCode: string, rulebookEntryId: string, policyId: u64?, amountUsdMinor: i64, capEffectUsdMinor: i64?}` | ai_cap_analyst | `NEW|REJECTED → PROPOSED` with `proposed_category_code = proposed_rulebook_entry_id = "ALLOCATED"`, `proposed_policy_id`/`cap_effect_usd_minor` null; replaces the item's `allocation` rows (`line_no` 1..n in argument order). 530 for an unknown `basis` (not `bill_line`, `share`, `cap_limit`, `cap_limit_excess`), an empty `basisRef`/`categoryCode`/`rulebookEntryId`/`reason`, or a bad `proposalSource`; every other failure is a denial, see [Allocations](#allocations-and-category-limits). A whole-line `propose` deletes an item's earlier allocation rows |
| `ask` | `workItemId: u64, question: string` | ai_cap_analyst | `NEW|PROPOSED → NEEDS_INFO`. Sets `question`, clears `answer` |
| `answer` | `workItemId: u64, answer: string` | human_controller (below materiality), human_head_of_cost_cap | `NEEDS_INFO → NEW`. Sets `answer` and `answered_by = caller`; writes a precedent. The answerer may not later approve or reject the item |
| `approve` | `workItemId: u64, reason: string` | human_controller (below materiality), human_head_of_cost_cap, auto_approver (what an approved rule decided, any amount, see [Earned autonomy](#earned-autonomy-standing-approvals)); never the proposer or the answerer | `PROPOSED → APPROVED`. **Re-validates the stored proposal** against the current rows (same `rulebook_invalid` / `policy_invalid` / `cap_effect_invalid` checks as propose). Sets `decided_by/decided_reason`; writes a precedent |
| `reject` | `workItemId: u64, reason: string` | same as approve (no re-validation) | `PROPOSED → REJECTED`. Same fields; writes a precedent |
| `post` | `workItemId: u64, erpEntryId: string` | gateway | `APPROVED → POSTED`. **Re-validates the stored proposal** like approve (allocated items: every allocation), then re-checks category limits (`cap_limit_exceeded`; also checked at propose and approve). Records `erp_entry_id`, `posted_treatment` and `posted_cap_effect_usd_minor` (the line amount, or `cap_effect_usd_minor` for an ADJUSTMENT; for an allocated item `"ALLOCATED"` and the sum of its allocations' effects, with each `allocation` row recording its own `posted_treatment`/`posted_cap_effect_usd_minor`); updates `cap_position` and `limit_ledger`; for a reversal, subtracts what the reversed item booked (per allocation if it was allocated) once and sets its `superseded = true`. See [Sync semantics](#sync-semantics) |
| `proposePolicy` | `policyKey: string, version: u32, categoryCode: string, rulebookEntryId: string, pattern: string, rationale: string, evidenceRefs: string, precedentCount: u32, effectiveFrom: string, effectiveTo: string?, parentPolicyId: u64?, cornerstones: string` | ai_policy_learner | inserts `policy{state: PROPOSED, proposed_by: caller, parent_policy_id, cornerstones, flip_report}`. **`version: 0` means "next version for this policy_key"** (the `propose_policy` tool in SCHEMA section 7 has no version, so send 0). An explicit version that already exists is a 530. `parentPolicyId` makes the policy an exception (child) of that policy; unknown id is a 530. `cornerstones` is a JSON array string of `{"ref": "<gl_line id or history ref>", "category_code": "..."}` (`""` is read as `[]`; anything else malformed is a 530). Denied `cornerstone_mismatch` / `conflicting_cornerstone`, see [Policies as Ripple-Down Rules](#policies-as-ripple-down-rules). Computes and stores the flip report |
| `approvePolicy` | `policyId: u64, reason: string` | human_head_of_cost_cap; never the proposer | `PROPOSED → APPROVED`, sets `decided_by/decided_reason/decided_at`. **Supersedes lower versions:** every APPROVED policy with the same `policy_key` and a lower `version` that has `autonomy = GRANTED` becomes `SUSPENDED` (`autonomy_by/_reason/_at` record it), and every PROPOSED or APPROVED work item citing one of them, in a period the new version is in force for, is reopened to NEW (audit `reopen`, reason `policy superseded`). The audit diff lists them as `policy[<id>].autonomy` and `work_item[<id>].state`. Supersession now also reopens items citing an old version in any allocation. **Approving a child or a new version** additionally reopens open items citing an ancestor the policy overrides (reason `exception approved: pol-<id>`), creates a `reversal` for each POSTED item in an unlocked period that the line now resolves to this policy with another category, and leaves POSTED items in locked periods alone (added to the policy's `flip_report.posted_locked` and to the audit diff as `flip_report.posted_locked`) |
| `rejectPolicy` | `policyId: u64, reason: string` | human_head_of_cost_cap | `PROPOSED → REJECTED` |
| `grantAutonomy` | `policyId: u64, evidence: string, reason: string` | human_head_of_cost_cap | autonomy `NONE|REVOKED|SUSPENDED → GRANTED`. The policy must be `APPROVED`, or the call is denied. `evidence` is the sandbox record as a JSON string and must be a non-empty JSON object or array (else 530). Sets `autonomy_by/autonomy_evidence/autonomy_reason/autonomy_at` |
| `revokeAutonomy` | `policyId: u64, reason: string` | human_head_of_cost_cap | autonomy `GRANTED|SUSPENDED → REVOKED`. Sets `autonomy_by/autonomy_reason/autonomy_at` to the revoke and keeps `autonomy_evidence` from the grant. Takes effect for the next approve attempt |
| `teachPolicy` | `workItemId: u64, categoryCode: string, rulebookEntryId: string, pattern: string, reason: string` | human_controller (pattern bounded inside ±materiality), human_head_of_cost_cap | policy `ABSENT → APPROVED` with `autonomy = GRANTED`; see [Teaching](#teaching) |
| `recordStep` | `runId: string, step: u32, kind: string, name: string, input: string, outputDigest: string, outputExcerpt: string, workItemId: u64?, model: string?` | any identity that holds a role (red_team included) | appends one `agent_step` row. Never denied, writes **no** audit row. See [Agent steps](#agent-steps-recordstep) |

Required non-empty strings (530 if empty): `proposeAllocations.reason` and each allocation's `basisRef/categoryCode/rulebookEntryId`, `propose.categoryCode/rulebookEntryId/reason` (and `propose.proposalSource` must be one of `deterministic, llm, human_text`), `ask.question`, `answer.answer`, `reject.reason`, `rejectPolicy.reason`, `grantAutonomy.reason`, `revokeAutonomy.reason`, `teachPolicy.categoryCode/rulebookEntryId/reason`, `recordStep.runId`, `post.erpEntryId`, `proposePolicy.policyKey/categoryCode/rulebookEntryId/rationale`, every upsert `id`, `createRoleInvite.code`. `approve.reason` may be empty.

## What `transition()` checks

Every reducer except `bootstrapAdmin` goes through `transition()` in `spacetimedb/src/transition.ts`. It evaluates **all** checks below and denies if any fail; the denial reason lists every failure, joined by `; `.

| code | rule |
|---|---|
| `role_not_permitted` | the roles matrix (`ROLES` in `spacetimedb/src/rules.ts`) doesn't grant this role this action on this resource. An identity without a role is role `none` and may only `claim_role` |
| `invalid_transition` | `(from_state, action)` is not an edge of the state machine (`TRANSITIONS` in `rules.ts`) |
| `separation_of_duties` | approve/reject a work item the caller proposed **or answered the last question on** (`answered_by`); approve a policy the caller proposed |
| `materiality` | `approve`, `reject` or `answer` by a person other than `human_head_of_cost_cap` when **`|amount_usd_minor|`** `>= materiality_usd_minor` (a large credit is as material as a large charge). **If `materiality_usd_minor` is unset or not an integer, every item counts as material** (fails closed), so the controller can decide nothing. Not applied to the auto_approver |
| `standing_approval` | `approve` by `auto_approver` when no approved rule backs the proposal: an `llm` proposal; a citation (whole line or allocation) without a policy, or with one that isn't `APPROVED`, in force or `GRANTED`; a `human_text` proposal with no `answered_by` |
| `teach_too_broad`, `teach_beyond_authority` | `teachPolicy` with a pattern that doesn't pin the account plus a vendor, department or memo, or (controller) isn't bounded inside ±materiality |
| `autonomy_invalid` | `grantAutonomy` on a policy whose `state` isn't `APPROVED` |
| `period_locked` | `propose`, `approve`, `post` on an item whose `period_key` is locked |
| `rulebook_invalid` | propose (and each allocation, prefixed `allocation <n>: `), **approve and post** (the stored proposal is re-checked against the current rows): `rulebookEntryId` must exist, its `category_code` must equal `categoryCode`, and it must be in force for the whole period (`effective_from <= first day` and `effective_to` null or `>= last day`). proposePolicy: entry exists, same category, in force on the policy's `effectiveFrom` |
| `policy_invalid` | propose, **approve and post** with a cited policy: the policy exists, is `APPROVED`, has the same `category_code`, is in force for the whole period, is not superseded by a higher APPROVED version of the same `policy_key` in force for the period, has a parsable pattern under the current rules, and that pattern matches the item's gl line (as it is now) |
| `cap_effect_invalid` | propose, approve and post: `capEffectUsdMinor` is present for an `ADJUSTMENT` entry and absent for a `RELEVANT` or `EXCLUDED` one |
| `exception_applies` | propose, proposeAllocations, approve and post citing policy P: an APPROVED, in-force, non-superseded child of P applies to the line (to the allocation's bill line for a `bill_line` allocation). Reason: `exception_applies: pol-<child>[, pol-<child2>]` (allocations append ` (allocation <n>)`). Only checked when the citation is otherwise valid |
| `policy_conflict` | same calls: the resolution for the line (or bill line) is a conflict, or resolves to a policy other than the cited one. Reasons: `policy_conflict: resolution for gl line <id> is a conflict between pol-1 (CATERING), pol-2 (MARKETING); ask instead`, or `... cites pol-7 (CATERING), not pol-5`. A child cited where an ancestor does not apply is `policy_invalid: … applies only where its parent does, and ancestor pol-<id> does not apply to …` |
| `allocation_invalid` | proposeAllocations (and approve/post re-validation of the rows): fewer than two allocations; a `bill_line` basisRef that is not a bill line of this gl line, used twice, or bill-line allocations that do not cover every bill line; a malformed share basisRef or a share amount that is not the share of the line total (within 1 minor unit); a `cap_limit` whose category is not its basisRef; a `cap_limit_excess` that is not RELEVANT or has no within-limit sibling (`cap_limit`, or `bill_line` in that category); a `cap_limit`/`cap_limit_excess` basisRef category with no cap limit in force; more than one `cap_limit` or `cap_limit_excess` per category, or a `cap_limit` without its `cap_limit_excess` |
| `allocation_sum_mismatch` | the allocations do not sum exactly to the item's `amount_usd_minor` |
| `apportionment_not_permitted` | a `share` allocation in a category other than `NON_F1`, `HERITAGE` or `RELEVANT`; or a RELEVANT share with no NON_F1/HERITAGE share beside it |
| `cap_limit_exceeded` | propose, proposeAllocations, **approve and post**: the proposal's EXCLUDED bookings in a category with a `cap_limit_usd_minor` (whole line, `bill_line` or `cap_limit` allocations; net of what a reversal backs out) would take `limit_ledger[<year>|<category>]` past the limit. Reason: `cap_limit_exceeded: remaining <limit − posted> (<CATEGORY> <year>: limit L, posted P, this proposal\|post adds A); split the excess with cap_limit + cap_limit_excess allocations`. Checked only for an otherwise valid proposal. Approve re-checks because other items may have posted since propose; post re-checks because they may have posted since approve |
| `cornerstone_mismatch` | proposePolicy: the policy does not apply to one of its own cornerstones that is a gl_line in the module (own pattern + ancestors; refs listed) |
| `conflicting_cornerstone` | proposePolicy of a child: the child applies to a cornerstone of its parent whose `category_code` equals the parent's category (refs listed) |
| `reversal_invalid` | post of a `reversal`: its `reverses_item_id` must name a work item that is `POSTED` and not yet `superseded` |
| `period_not_ready` | `lockPeriod` while any work item in that period is not POSTED. Reason: `period_not_ready: 3 work items in period 2026-02 are not POSTED: 4, 5, 6` (first ten ids, then `, …`) |
| `already_bootstrapped` | `bootstrapAdmin` after the role table has rows |

Example denied reason: `role_not_permitted: role 'ai_cap_analyst' may not approve on work_item; separation_of_duties: caller proposed work item 1 and may not approve it`.

### Policy `pattern`

A JSON object string with optional keys `vendor_id`, `account_code`, `department_id`, `memo_regex`, `description_regex`, `entity`, `erp_category_code` (strings), `related_party` (bool), `min_amount_usd_minor`, `max_amount_usd_minor` (integers, inclusive). `entity` and `erp_category_code` are exact matches on the gl line. `description_regex` follows every `memo_regex` rule below (NFKC, strip, 500 code points, `i` without `u`, same refusals) and is matched against bill line descriptions: for a `bill_line` allocation, that bill line's; for a whole-line proposal (and any other basis), **every** bill line of the line must match, and a line with no bill lines never matches. **At least one key must be non-null** (`{}` or `{"memo_regex":null}` is a 530: it would match every line). Unknown keys or wrong types are a 530 at `proposePolicy`. Matching is against the item's gl line as it is now: `related_party` is read from the vendor row (no vendor row means no match), amounts use the line's `amount_usd_minor`, `memo_regex` is a search, not a full match.

`memo_regex` rules (SCHEMA.md section 10, defect 11; the Python matcher in `agents/` applies the same ones with `re.ASCII | re.IGNORECASE`, and both suites run `rulebook/pattern_conformance.json`):

- The regex source and the memo are **NFKC-normalised** (`ｃanteen` = `canteen`, Kelvin sign = `K`, no-break space = space); the memo is then stripped of surrounding whitespace and cut to **500 code points**.
- Matching is **always case-insensitive** (JS `i` flag) and uses **ASCII semantics** (no `u` flag): `\d` is `[0-9]`, `\w` is `[A-Za-z0-9_]`, `\b` sits between those and anything else, `.` is one UTF-16 unit, `$` is the end of the whole memo (no multiline).
- A memo containing a character outside the Basic Multilingual Plane (an emoji) matches **no** `memo_regex`.
- Refused (530 at `proposePolicy`, and `policy_invalid: … unparsable pattern` if an older stored policy is cited): inline flags such as `(?i)` (the `i` flag is implied; **drop the `(?i)` prefix**), lookbehind `(?<=`/`(?<!`, named groups `(?<n>`/`(?P<n>`, a quantifier applied to a group that itself contains a quantifier (`(a+)+`, `(\w+\s?)+`), a source longer than 200 code points, a non-BMP character, and anything that does not compile as a JavaScript RegExp. `(?:…)`, `(?=…)`, `(?!…)`, lazy quantifiers and escaped or bracketed `+*?` are fine.

## Allocations and category limits

SCHEMA.md section 11.1. One GL line split across categories; the line stays the unit that reconciles to the ledger, and **materiality is judged on the line total** (`work_item.amount_usd_minor`).

### `allocation` table

`allocation { id: u64 PK autoInc, work_item_id: u64 (index), line_no: u32, basis: string, basis_ref: string, category_code: string, rulebook_entry_id: string, policy_id: u64?, amount_usd_minor: i64, cap_effect_usd_minor: i64?, posted_treatment: string?, posted_cap_effect_usd_minor: i64? }`. Rows of an open item are replaced by the next `proposeAllocations`, deleted by a whole-line `propose`, and deleted when the item is reopened. `post` fills the two `posted_*` columns; posted rows are never edited or deleted.

### Validation (each failure a denial, all listed in one reason)

- at least two allocations; amounts sum **exactly** to the item's `amount_usd_minor`;
- every allocation: rulebook entry exists, is of the allocation's category and in force for the whole period; `capEffectUsdMinor` present iff the entry is an ADJUSTMENT; a cited policy is valid for the allocation (`policy_invalid`, `exception_applies`, `policy_conflict`, matched in the allocation's context);
- `bill_line`: `basisRef` is a bill line whose `gl_line_id` is this item's line, each used once, and the bill-line allocations together cover every bill line of the line. (Bill line amounts are in the bill's currency and are not compared with `amountUsdMinor`.)
- `share`: `basisRef = "<department_id>:<share>"`, share a decimal in [0, 1]; the amount must be `line total × share` to within one minor unit; category `NON_F1` or `HERITAGE`, or `RELEVANT` as their complement; anything else `apportionment_not_permitted`;
- `cap_limit`: the within-limit part of a split at a category limit. `basisRef` = `categoryCode` = the limited EXCLUDED category (one with `cap_limit_usd_minor` in force for the period). At most one per category, and it needs exactly one `cap_limit_excess` with the same `basisRef`. No bill lines needed, so any line can be split.
- `cap_limit_excess`: category `RELEVANT`, `basisRef` = the limited category; the rest above the limit. At most one per category; its within-limit sibling is the `cap_limit` allocation, or `bill_line` allocation(s) in that category.
- **Limit:** the EXCLUDED amount the proposal books in a limited category (its `cap_limit` and `bill_line` allocations there, or the whole line) must not exceed `limit − limit_ledger[<year>|<category>]`, else `cap_limit_exceeded: remaining <amount> …`. This is checked at propose/proposeAllocations, approve and post.

`approve` and `post` re-run all of it against the stored rows. The `auto_approver` approves an allocated item only when every `bill_line` allocation cites an approved, GRANTED policy.

### Posting, limits, reversals

- `post` books each allocation by its treatment: `RELEVANT`/`EXCLUDED` at `amount_usd_minor`, `ADJUSTMENT` at `cap_effect_usd_minor`, into `cap_position[period].relevant_usd_minor` (RELEVANT, ADJUSTMENT) or `excluded_usd_minor` (EXCLUDED). `pending -= line total`, `posted_items += 1` (one per work item, not per allocation). The audit diff has `allocation[<id>].posted_treatment` / `.posted_cap_effect_usd_minor` per row.
- `limit_ledger { key: string PK "<cap_year>|<category_code>", cap_year: u32, category_code: string, excluded_usd_minor: i64 }`. Every EXCLUDED booking (whole line or allocation) adds to its category's row, for the calendar year of the item's `period_key`. **Every** EXCLUDED category is tracked (not only limited ones), so reversals always net exactly; only categories whose cited rulebook entry has `cap_limit_usd_minor` are enforced. A post that would take a limited category past its limit is denied `cap_limit_exceeded: remaining <limit − posted> (<CATEGORY> <year>: limit L, posted P, this post adds A); split the excess with a cap_limit_excess allocation`. The same check runs at propose and approve, so an over-limit proposal is denied up front. Post only refuses an item when the limit was consumed between its approve and its post; such an item stays `APPROVED` until a correction or a superseding policy reopens it.
- A reversal of an allocated POSTED item backs out each allocation's `posted_cap_effect_usd_minor` from its `posted_treatment` bucket once (in the reversal's period) and subtracts its EXCLUDED amounts from `limit_ledger` (in the cap year they were booked). A reversal may itself be allocated.

### SATS-JSON for HTTP callers

`allocations` is a JSON array of `Allocation` values. Encode each one as a **positional array in field order** `[basis, basisRef, categoryCode, rulebookEntryId, policyId?, amountUsdMinor, capEffectUsdMinor?]`, options as `{"some": v}` / `{"none": []}`, integers as JSON numbers. This is the same product encoding the top-level argument array uses, so it does not depend on field naming. (A JSON object keyed by field names should also decode, but under the module's SnakeCase policy the host may expect `basis_ref`-style keys for a nested type; this was not checked against a live server, so prefer arrays.)

```bash
curl -sS -X POST http://localhost:3000/v1/database/cost-cap-desk/call/proposeAllocations \
  -H "Authorization: Bearer $ANALYST" -H 'Content-Type: application/json' \
  -d '[1,
       [["bill_line","bl-00001-1","CATERING","CATERING@SECD-ISS07",{"some":7},1200000,{"none":[]}],
        ["bill_line","bl-00001-2","MARKETING","MARKETING@SECD-ISS07",{"some":3},2500000,{"none":[]}],
        ["bill_line","bl-00001-3","RELEVANT","RELEVANT@SECD-ISS07",{"none":[]},300000,{"none":[]}]],
       "P01: canteen, sponsor dinner, wind tunnel lunch","[\"gl-000001\",\"bill-00001\"]","deterministic"]'
```

A $300k staff entertainment line split at the limit ($200k remaining, no bill lines needed): `[["cap_limit","STAFF_ENTERTAINMENT","STAFF_ENTERTAINMENT","STAFF_ENTERTAINMENT@SECD-ISS07",{"none":[]},20000000,{"none":[]}],["cap_limit_excess","STAFF_ENTERTAINMENT","RELEVANT","RELEVANT@SECD-ISS07",{"none":[]},10000000,{"none":[]}]]`. Note: `rulebook/rulebook.json` carries `cap_limit_usd_minor` only for STAFF_ENTERTAINMENT, BCDR and ADJ_UNUSED_CAP_CARRYFORWARD, so `cap_limit` splits on BONUS or PU_SUPPLY (world truth P07, P34) are denied `allocation_invalid: … has no cap limit in force` until the rulebook gives those categories a limit.

## Policies as Ripple-Down Rules

SCHEMA.md section 11.2. The module's resolver is `resolve(ctx, line, period, billLineId?)` in `spacetimedb/src/rdr.ts`; `test/rdr_conformance.test.ts` runs every case of `rulebook/rdr_conformance.json` through it.

- **Takes part:** `state = APPROVED`, in force for the whole period, and not superseded by a higher APPROVED version of the same `policy_key` in force for the period.
- **Applies:** takes part, its own pattern matches, and its parent applies (recursively). A child of a superseded or unapproved parent applies nowhere.
- **Resolution:** conclusions = applicable policies with no applicable child. None: `none`. All one category: that category, citing the deepest (ties: lowest id). Disagreeing: the conclusion whose effective pattern (own + ancestors' key=value pairs) is a strict superset of every other conclusion's, else `conflict`.
- **Precedence at propose/proposeAllocations/approve/post:** see `exception_applies` and `policy_conflict` above.

### Cornerstones (at `proposePolicy`)

For each own cornerstone whose `ref` is a `gl_line` id in the module, the new policy must apply to that line (own pattern and ancestors, in the line's period; the draft's own state and window are ignored), else `cornerstone_mismatch: the policy does not apply to its own cornerstones <refs>`. For a child, each parent cornerstone with `category_code` = the parent's category that is a gl_line in the module must **not** be matched by the child, else `conflicting_cornerstone: the exception matches cornerstones of parent pol-<id> (<CATEGORY>): <refs>`. Any other ref (history) is stored and listed under `checked_by_proposer`. Cornerstone refs are matched as whole lines (`description_regex` must match every bill line).

The `propose_policy` audit evidence (allowed or denied):

```json
{"evidence_refs":"[\"hist-2025-0001\"]",
 "cornerstones":{"checked":["gl-000123"],"checked_by_proposer":["hist-2025-0042"],
                 "parent":{"policy_id":3,"checked":["gl-000077"],"checked_by_proposer":[]}},
 "flip_report":{"open":[12,14],"posted_open_period":[9],"posted_locked":[4],
                "usd_minor_by_state":{"PROPOSED":100000,"APPROVED":250000,"POSTED":1200000}}}
```

`parent` is `null` for a top-level policy.

### Flip report

Computed at `proposePolicy` and stored in `policy.flip_report` (JSON string, same object as `evidence.flip_report`): the work items in `PROPOSED`, `APPROVED` or `POSTED` (not superseded) whose line would, with the new policy approved, resolve **to the new policy** with a category different from the one the item carries. Allocated items are checked per `bill_line` allocation (`share` and `cap_limit_excess` allocations are not line-level classifications and are skipped). `open` = PROPOSED/APPROVED ids; `posted_open_period` / `posted_locked` = POSTED ids by whether the item's period is locked; `usd_minor_by_state` = sum of the listed items' `amount_usd_minor` per state (only states that occur). Ids and amounts are JSON numbers. NEW, NEEDS_INFO and REJECTED items carry no category and are not listed.

### On approval of a child or a new version

In the `approvePolicy` transaction, after the Tier 0 supersession step:

1. every PROPOSED/APPROVED item citing (whole line or any allocation) an ancestor of the approved policy, where the approved policy applies in that citation's context, is reopened (audit `reopen`, reason `exception approved: pol-<id>`, allocation rows deleted);
2. every POSTED, not superseded item in an **unlocked** period whose line now resolves to the approved policy with another category, and which is still its line's latest work item, gets a `reversal` work item (reason `reversal: exception approved: pol-<id> reclassifies gl line <gl> <FROM> -> <TO> after work item <n> was POSTED`; amount and period from the line; pending moves as for any new item);
3. POSTED items in **locked** periods are left alone; their ids are merged into `policy.flip_report.posted_locked` and the audit diff carries `flip_report.posted_locked`.

A brand-new top-level policy (no parent, no older version) triggers none of this.


## The audit log

Exactly one `audit_log` row per reducer call that returns 200, in the same transaction as the change, **plus** one `reopen` row per work item the call reopened (`upsertGlLine` and `approvePolicy` only). A `reopen` row has `actor`/`actor_role` = the caller whose reducer caused it (the sync job, the head), `resource_kind = work_item`, `subject_id` = the item id, `allowed = true`, `from_state` = `PROPOSED | NEEDS_INFO | APPROVED`, `to_state = NEW`, `reason` = `reopened by correction: <changed gl_line fields, snake_case, comma-separated>`, `policy superseded` or `exception approved: pol-<id>`, `diff` = the cleared columns, `evidence` = the item's new `evidence_refs` (`["<raw_ref>"]`), `policy_id/policy_version` = the policy the dropped proposal cited, if any. It is written before the caller's own row, whose `diff` carries `work_item[<id>].state: {from, to: "NEW"}`.

| column | allowed row | denied row |
|---|---|---|
| `actor`, `actor_role` | caller and its role at call time (`none` if it has none) | same |
| `action` | `bootstrap_admin`, `create_role_invite`, `claim_role`, `set_setting`, `load_rulebook_entry`, `lock_period`, `sync_upsert`, `propose`, `ask`, `answer`, `approve`, `reject`, `post`, `propose_policy`, `approve_policy`, `reject_policy`, `grant_autonomy`, `revoke_autonomy`, `reopen` (`recordStep` writes no audit row) | same (never `reopen`) |
| `resource_kind` | `role`, `role_invite`, `setting`, `rulebook_entry`, `period`, `gl_line`, `bill_line`, `vendor`, `fair_value`, `work_item`, `policy` | same |
| `subject_id` | work item: its id as a decimal string. policy: its **`policy_key`** (the exact policy is in `policy_id`/`policy_version`). records: the record id. setting: the key. period: the period key. invite: `invite:<first 16 hex of sha256(code)>`. bootstrap: caller hex | same |
| `from_state` → `to_state` | the state machine states; for `grant_autonomy`/`revoke_autonomy`, the policy's **autonomy** states (`NONE`, `GRANTED`, `REVOKED`), not its `state`; for records `ABSENT|SYNCED → SYNCED`, settings `ABSENT|SET → SET`, rulebook `ABSENT|LOADED → LOADED` | `to_state` is the **attempted** target; nothing changed |
| `reason` | the caller's reason / question / answer (sync rows say what happened, e.g. `sync gl_line:gl-000123:17: created work_item 1 (classification)`) | the denial reason(s) |
| `diff` | JSON: `{"<column>": {"from": x, "to": y}}` for changed columns of the subject row (snake_case names; `updated_at`/`synced_at` omitted), plus side effects keyed `work_item[7]`, `cap_position[2026-03].pending_usd_minor`, `precedent[3]`, `role[<hex>].role` | `{}` |
| `evidence` | propose: the `evidenceRefs` sent; approve **by auto_approver**: the standing-approval JSON (below, now also carrying `proposal_source`); other work item actions: the item's current `evidence_refs`; sync: `["<raw_ref>"]`; `reopen`: the item's reset `evidence_refs`; `propose_policy`: `{"evidence_refs", "cornerstones", "flip_report"}` (see [Policies as Ripple-Down Rules](#policies-as-ripple-down-rules)); `grant_autonomy`: the sandbox evidence sent; `revoke_autonomy`: the grant's evidence; other policy actions: the policy's `evidence_refs` | same |
| `policy_id`, `policy_version` | set when the action concerns a policy, or a work item that cites one | set to the attempted policy, if it exists |

In diffs, u64/i64 values are JSON numbers, identities are hex strings without `0x`, timestamps are ISO strings, and none is `null`.

## Earned autonomy (standing approvals)

People decide only what no rule covers. Approving a policy gives it standing approval (`autonomy = "GRANTED"`, `autonomy_by` = the approver, reason `standing approval comes with approval`); a taught policy is born with it. The `auto_approver` role may then `approve`, and do nothing else, at any amount, when:

1. the proposal is `deterministic` and every citation is a policy that is `APPROVED`, in force for the item's whole period, not superseded, and `GRANTED` (not `REVOKED` or `SUSPENDED`): the whole line's `proposed_policy_id`, or for an allocated item each `bill_line` allocation's `policy_id` (`cap_limit_excess` splits are computed by rule and pass; a `share` split without a policy fails); or
2. the proposal is `human_text` and the item has `answered_by` (a person's answer on this very line);
3. the re-validation at approve passes (rulebook entry in force, pattern still matches, cap effect consistent);
4. the auto_approver didn't propose the item, and the period isn't locked.

Materiality does not bind the auto_approver: it picks which person decides when a person is needed. An `llm` proposal (a line no rule covered) always needs a person.

`autonomy` states: `NONE` → `GRANTED` (approval, or grant) → `REVOKED` (revoke) → `GRANTED` (grant again); and `GRANTED` → `SUSPENDED` when a higher version of the same `policy_key` is approved. Items the superseded version was cited on are reopened at the same time (audit `reopen`, reason `policy superseded`).

Each auto-approval's audit row carries `policy_id` and `policy_version`, and its `evidence` names who stands behind it:

```json
{"standing_approval":{"policy_id":1,"policy_key":"grove-canteen-catering","policy_version":1,"autonomy":"GRANTED",
  "autonomy_granted_by":"c2006885…9350","autonomy_granted_at":"2026-10-24T08:00:15.596504Z"},
 "allocations":[],
 "answered_by":null,
 "proposal_source":"deterministic",
 "evidence_refs":"[\"gl-000123\"]"}
```

`allocations` lists each split's policy the same way; `answered_by` names the person whose answer a `human_text` proposal was built from. Denied auto_approver attempts carry the same shape.

### Teaching

`teachPolicy(workItemId, categoryCode, rulebookEntryId, pattern, reason)`, by `human_controller` or `human_head_of_cost_cap`: inserts a policy `taught:<account>|<vendor or department or memo>` (next version for the key), `state = APPROVED`, `autonomy = GRANTED`, `proposed_by = decided_by = caller`, one cornerstone (the work item's gl line), `effective_from` = the item's period start, `parent_policy_id` = the item's cited policy when the taught category differs (a correction becomes an exception). Denied (audit `teach_policy`, allowed=false) when the pattern doesn't pin `account_code` plus one of `vendor_id`, `department_id`, `memo_regex`, `description_regex` (`teach_too_broad`), when a controller's pattern isn't bounded inside ±materiality by `min/max_amount_usd_minor` (`teach_beyond_authority`), or when the RDR draft checks fail. On success the same effects as approving apply (superseding older versions, exceptions reopening items citing ancestors), and queued `llm` proposals and `NEEDS_INFO` items the rule now covers go back to NEW (audit `reopen`, reason `rule now covers it: pol-<id>`).

## Agent steps (`recordStep`)

`agent_step` records everything an agent does between transitions (SCHEMA section 6b). It's append-only: no reducer updates or deletes it.

- **Who:** any identity with a role. An identity with no role gets a **530** (`recordStep requires a role…`). That's a throw, not a denial, because there is no audit row for steps.
- **Never denied, no audit row.** The row stores `actor` = caller, `actor_role` = its role, `at` = server time.
- **Validation (530):** `runId` non-empty; `kind` ∈ `run_start, read, tool_call, model_call, decision, note, error, run_end`; `workItemId`, if given, must exist. `step` is stored as sent; the module doesn't enforce +1 ordering.
- **Truncation, never rejection.** Limits are UTF-8 bytes: `input` 8192, `outputExcerpt` 2048, `outputDigest` 128, `runId`/`name`/`model` 256. An oversize value is cut on a code-point boundary and ends with `…[truncated]`, and the whole value including the marker fits the limit. Values at or under the limit are stored unchanged.
- **Reading steps for a work item:** SQL can't filter `work_item_id` (an Option). Use `SELECT * FROM agent_step WHERE run_id = '…'`, or select everything and filter in Python.

## Sync semantics

`upsertGlLine` (SCHEMA.md section 10, defects 1 and 2):

- **First sight** of a line id always creates `work_item{kind: "classification", state: NEW, subject_ref: <gl id>, period_key, amount_usd_minor, reason: "", evidence_refs: "[\"<raw_ref>\"]", proposal_source: "", superseded: false}` and adds the amount to `cap_position.pending_usd_minor`. **`correctionOf` no longer creates a reversal:** the ledger nets its own delta pairs (a −A "Reversal of gl-X" plus a +A repost), so both are plain classifications; `correction_of` stays on the golden row as evidence.
- **The line's work items form a chain:** its classification item, then each reversal whose `subject_ref` (= `reverses_item_id`) is the previous item's id. The last one is the line's *latest* work item; everything below depends on its state. To get from any work item to its gl line, follow `reverses_item_id` down to the classification item and read its `subject_ref` (one hop for a first reversal, more for a reversal of a reversal).
- **Re-sync when the latest item is `POSTED`** and `amount_usd_minor`, `account_code`, `period_key`, `vendor_id`, `department_id` or `memo` changed: creates one `work_item{kind: "reversal", subject_ref: "<latest POSTED item id>", reverses_item_id: <same>, period_key/amount_usd_minor from the re-synced line, evidence_refs: "[\"<gl id>\",\"<raw_ref>\"]", reason: "reversal: re-sync of gl line … changed <fields> after work item N was POSTED"}` and adds the line amount to pending in the reversal's period. The reversal carries the corrected **full** amount (what the line now says), not a delta. A second POSTED-and-changed re-sync reverses the first reversal (never the original again). Other field changes just update the golden row.
- **Re-sync when the latest item is open** (classification or reversal, any state but POSTED): if `amount_usd_minor`, `amount_minor`, `currency`, `account_code`, `vendor_id`, `department_id`, `memo`, `posted_date` or `period_key` changed and the item is `PROPOSED`, `NEEDS_INFO` or `APPROVED`, it is **reopened**: state `NEW`; `proposed_by`, `proposed_category_code`, `proposed_rulebook_entry_id`, `proposed_policy_id`, `cap_effect_usd_minor`, `question`, `answer`, `decided_by`, `decided_reason` → null; `proposal_source`, `reason` → `""`; `evidence_refs` → `["<new raw_ref>"]`; `answered_by` is kept. One `reopen` audit row (reason `reopened by correction: <fields>`) precedes the `sync_upsert` row. Then, for any open item, `amount_usd_minor` and `period_key` are refreshed in place and pending moves with them (NEW and REJECTED items are only refreshed). So there is **at most one open reversal per line**: a further correction refreshes or reopens it instead of creating another.
- Every call writes one `sync_upsert` audit row, even when nothing changed (diff `{}`), plus the `reopen` row when it reopened something.

`post` first re-validates the proposal, then records `posted_treatment` (the entry's treatment) and `posted_cap_effect_usd_minor` (= `amount_usd_minor` for `RELEVANT` and `EXCLUDED`, = `cap_effect_usd_minor` for `ADJUSTMENT`), and updates `cap_position[period_key]`: `pending -= amount_usd_minor`, `posted_items += 1`, `relevant_usd_minor += posted_cap_effect` (treatment `RELEVANT` or `ADJUSTMENT`) or `excluded_usd_minor += posted_cap_effect` (`EXCLUDED`). A grant or tax-credit gross-up proposed with `capEffectUsdMinor = 0` therefore moves the cap by 0; a related-party uplift proposed as `amount + uplift` moves it by that. Posting a **reversal** additionally subtracts the reversed item's `posted_cap_effect_usd_minor` from its `posted_treatment` bucket, exactly once, **in the reversal's period** (the reversed item's period may be locked), and sets the reversed item's `superseded = true` (`work_item[<id>].superseded` in the diff). The reversal is then the line's latest posted state. Posting a reversal whose reversed item is not POSTED or is already superseded is denied `reversal_invalid`.

For the gateway: the ERP entry for a reversal should back out the reversed item's booking and re-book the line under the reversal's own category and cap effect, so the ERP and `cap_position` agree.

## Precedents

Written on `approve`, `reject` and `answer`, in the same transaction:

- `category_code`: the item's `proposed_category_code` (`""` if never proposed).
- `reason`: `"approve: <reason>"`, `"reject: <reason>"`, or `"answer: Q: <question> A: <answer>"`. The prefix is the decision, since the table has no decision column.
- `pattern_summary`: a JSON string from the item's gl line (for reversals, the re-synced line reached through `reverses_item_id`): `{"gl_line_id","vendor_id","account_code","department_id","related_party","amount_usd_minor","memo"}` with `memo` cut to 120 characters.
- `decided_by`: the caller.

## Invite codes

`role_invite.code` stores the **SHA-256 hex digest** of the code, not the code: the table is public, so a plaintext code could be read and claimed by anyone, the red team included. Callers are unaffected: send the plaintext code to both `createRoleInvite` and `claimRole`.

## `spacetime call` example

The CLI calls as its own logged-in identity, which has no role in this database, so this call is **denied and logged** (role `none`). That's still a good test of argument encoding: each argument is one shell word of SATS-JSON.

```bash
cd system_of_work
spacetime call --server local cost-cap-desk propose 1 '"CATERING"' '"CATERING@SECD-ISS07"' '{"none":[]}' '"cli test"' '"[\"gl-000123\"]"' '{"none":[]}' '"deterministic"'
spacetime sql  --server local cost-cap-desk "SELECT id, actor_role, action, allowed, reason FROM audit_log WHERE allowed = false"
```

## curl example (one reducer)

Proposes work item 1 citing policy 3, deterministically, with no cap effect (CATERING is EXCLUDED, so the line amount is used). It returns 200 either way; the item only moves to PROPOSED if policy 3 exists, is APPROVED, and matches the line.

```bash
curl -sS -w 'HTTP %{http_code}\n' -X POST http://localhost:3000/v1/database/cost-cap-desk/call/propose \
  -H "Authorization: Bearer $ANALYST" -H 'Content-Type: application/json' \
  -d '[1,"CATERING","CATERING@SECD-ISS07",{"some":3},"Grove Catering is the factory canteen, pol-3 v1","[\"gl-000123\",\"bill-00042\"]",{"none":[]},"deterministic"]'
```

An ADJUSTMENT proposal carries its signed cap effect (here a related-party uplift on a 914,400 line: amount + 85,600 uplift), and an LLM proposal says so (it can then never be auto-approved):

```bash
curl -sS -X POST http://localhost:3000/v1/database/cost-cap-desk/call/propose \
  -H "Authorization: Bearer $ANALYST" -H 'Content-Type: application/json' \
  -d '[1,"ADJ_RELATED_PARTY_FAIR_VALUE","ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07",{"none":[]},"fair value fv-005 exceeds invoice","[\"gl-000123\",\"fv-005\"]",{"some":1000000},"llm"]'
```

## curl examples: grantAutonomy and recordStep

These ran against the local server; `$PID` is a policy id and `$WID` a work item id, read back with SQL as in the smoke test below.

```bash
STDB=http://localhost:3000; DB=cost-cap-desk

# grantAutonomy(policyId, evidence, reason) as the head of cost cap. evidence is JSON inside a string.
curl -sS -w 'grantAutonomy HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/grantAutonomy" \
  -H "Authorization: Bearer $HEAD" -H 'Content-Type: application/json' \
  -d '['"$PID"',"{\"sandbox_run_id\":\"sbx-2026-03-01-a1b2c3d4\",\"sandboxes\":5,\"lines\":1200,\"errors\":0,\"missed_plants\":0}","0 errors over 5 sandboxes"]'

# revokeAutonomy(policyId, reason)
curl -sS -w 'revokeAutonomy HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/revokeAutonomy" \
  -H "Authorization: Bearer $HEAD" -H 'Content-Type: application/json' \
  -d '['"$PID"',"catering rule change pending"]'

# recordStep(runId, step, kind, name, input, outputDigest, outputExcerpt, workItemId?, model?) as any role.
curl -sS -w 'recordStep HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/recordStep" \
  -H "Authorization: Bearer $ANALYST" -H 'Content-Type: application/json' \
  -d '["cap_analyst-2026-03-14-0a1b2c3d",1,"decision","propose_classification","{\"candidates\":[\"CATERING\",\"MARKETING\"],\"winner\":\"CATERING\",\"why\":\"policy grove-canteen-catering v1 matches vendor and account\"}","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","CATERING via policy 1",{"some":'"$WID"'},{"some":"claude-opus-5-5"}]'

# Read the run back (filter on run_id; work_item_id is an Option and can't be filtered in SQL).
curl -sS -X POST "$STDB/v1/database/$DB/sql" -H "Authorization: Bearer $ANALYST" \
  -d "SELECT id, run_id, actor_role, step, kind, name, work_item_id, model FROM agent_step WHERE run_id = 'cap_analyst-2026-03-14-0a1b2c3d'" | jq -c '.[0].rows'
# -> [[1,"cap_analyst-2026-03-14-0a1b2c3d","ai_cap_analyst",1,"decision","propose_classification",[0,1],[0,"claude-opus-5-5"]]]
```

The full standing-approval flow (6 identities: admin, sync, analyst, learner, head, auto_approver → proposePolicy → approvePolicy → grantAutonomy → upsertGlLine → recordStep → propose citing the policy → approve as auto_approver) ran over curl (before the Tier 0 change; `smoke_autonomy.sh` has since been updated to the eight-argument `propose`, but has not been re-run against a server) and gave `approve(auto) HTTP 200`, work item `APPROVED`, and audit row `[19,"auto_approver","approve",true,"PROPOSED","APPROVED",[0,1],[0,1],"{\"standing_approval\":{…\"autonomy_granted_by\":\"c2006885…\"…}"]`. The script is `system_of_work/smoke_autonomy.sh`.

## Smoke test

Run against a freshly published database (`spacetime publish cost-cap-desk --server local --yes --delete-data=always`, then `spacetime start` running). Needs `curl` and `jq`. These are the commands that ran, verbatim:

```bash
STDB=http://localhost:3000
DB=cost-cap-desk

# 1. Three identities: admin, analyst, sync job.
ADMIN=$(curl -sS -X POST "$STDB/v1/identity" | jq -r .token)
ANALYST=$(curl -sS -X POST "$STDB/v1/identity" | jq -r .token)
SYNC=$(curl -sS -X POST "$STDB/v1/identity" | jq -r .token)

# 2. The first caller becomes admin (only works while the role table is empty).
curl -sS -w 'bootstrapAdmin HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/bootstrapAdmin" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '[]'

# 3. Roles are claimed with one-time invite codes (identities can't be passed in as strings).
curl -sS -w 'createRoleInvite HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/createRoleInvite" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '["ai_cap_analyst","Cap Analyst","invite-analyst-7f3a"]'
curl -sS -w 'claimRole HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/claimRole" \
  -H "Authorization: Bearer $ANALYST" -H 'Content-Type: application/json' \
  -d '["invite-analyst-7f3a"]'
curl -sS -w 'createRoleInvite HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/createRoleInvite" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '["sync","Sync job","invite-sync-91c2"]'
curl -sS -w 'claimRole HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/claimRole" \
  -H "Authorization: Bearer $SYNC" -H 'Content-Type: application/json' \
  -d '["invite-sync-91c2"]'

# 4. Admin loads one rulebook entry and the materiality threshold ($50,000.00).
curl -sS -w 'loadRulebookEntry HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/loadRulebookEntry" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '["CATERING@SECD-ISS07","CATERING","EXCLUDED","SECD-ISS07","D5.1.1.z","2026-01-01",{"none":[]},"Catering at Competitions, Testing and team premises","all costs Directly Attributable to the provision of catering services ...",{"none":[]}]'
curl -sS -w 'setSetting HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/setSetting" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '["materiality_usd_minor","5000000"]'

# 5. The sync job upserts a GL line; the module creates a NEW classification work item.
curl -sS -w 'upsertGlLine HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/upsertGlLine" \
  -H "Authorization: Bearer $SYNC" -H 'Content-Type: application/json' \
  -d '["gl-000123","gl_line:gl-000123:17","2026-03-14","2026-03","acct-6410","6410","dept-AERO",{"some":"ven-017"},{"none":[]},720000,"GBP",1270000,914400,"Grove Catering - factory canteen March","MARKETING","RACING",{"none":[]}]'

# 6. Find the work item for that line.
WID=$(curl -sS -X POST "$STDB/v1/database/$DB/sql" -H "Authorization: Bearer $ANALYST" \
  -d "SELECT id, state FROM work_item WHERE subject_ref = 'gl-000123'" | jq '.[0].rows[0][0]')
echo "work item id: $WID"

# 7. The analyst proposes a classification (policyId none; evidenceRefs is a JSON string;
#    capEffectUsdMinor none because CATERING is EXCLUDED; proposalSource deterministic).
curl -sS -w 'propose HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/propose" \
  -H "Authorization: Bearer $ANALYST" -H 'Content-Type: application/json' \
  -d '['"$WID"',"CATERING","CATERING@SECD-ISS07",{"none":[]},"Grove Catering is the factory canteen: catering at team premises, D5.1.1.z","[\"gl-000123\"]",{"none":[]},"deterministic"]'

# 8. The analyst tries to approve its own proposal. HTTP 200: the denial is committed, not thrown.
curl -sS -w 'approve HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/approve" \
  -H "Authorization: Bearer $ANALYST" -H 'Content-Type: application/json' \
  -d '['"$WID"',"looks right to me"]'

# 9. Confirm by reading state: still PROPOSED.
curl -sS -X POST "$STDB/v1/database/$DB/sql" -H "Authorization: Bearer $ANALYST" \
  -d "SELECT id, kind, state, proposed_category_code FROM work_item WHERE subject_ref = 'gl-000123'" | jq -c '.[0].rows'

# 10. The audit log, with the allowed=false row.
curl -sS -X POST "$STDB/v1/database/$DB/sql" -H "Authorization: Bearer $ANALYST" \
  -d 'SELECT * FROM audit_log' | jq -r '.[0] | (.schema.elements | map(.name.some) | join(" | ")), (.rows[] | tojson)'
curl -sS -X POST "$STDB/v1/database/$DB/sql" -H "Authorization: Bearer $ANALYST" \
  -d 'SELECT id, actor_role, action, subject_id, from_state, to_state, reason FROM audit_log WHERE allowed = false' | jq -c '.[0].rows'

# 11. Malformed input throws: unknown work item id -> non-2xx, body is the error text, nothing logged.
curl -sS -w '\napprove(unknown id) HTTP %{http_code}\n' -X POST "$STDB/v1/database/$DB/call/approve" \
  -H "Authorization: Bearer $ANALYST" -H 'Content-Type: application/json' -d '[424242,"x"]'
```

Output from the pre-Tier 0 run (identities shortened; the full `SELECT * FROM audit_log` printed 10 rows, the last two shown). The propose diff now also carries `proposal_source: {"from": "", "to": "deterministic"}`:

```
bootstrapAdmin HTTP 200
createRoleInvite HTTP 200
claimRole HTTP 200
createRoleInvite HTTP 200
claimRole HTTP 200
loadRulebookEntry HTTP 200
setSetting HTTP 200
upsertGlLine HTTP 200
work item id: 1
propose HTTP 200
approve HTTP 200
[[1,"classification","PROPOSED",[0,"CATERING"]]]
id | at | actor | actor_role | action | resource_kind | subject_id | allowed | from_state | to_state | reason | diff | evidence | policy_id | policy_version
...
[9,[1792827492523140],["0xc2003eee…cd7"],"ai_cap_analyst","propose","work_item","1",true,"NEW","PROPOSED","Grove Catering is the factory canteen: catering at team premises, D5.1.1.z","{\"state\":{\"from\":\"NEW\",\"to\":\"PROPOSED\"},\"proposed_by\":{\"from\":null,\"to\":\"c2003eee…cd7\"},\"proposed_category_code\":{\"from\":null,\"to\":\"CATERING\"},\"proposed_rulebook_entry_id\":{\"from\":null,\"to\":\"CATERING@SECD-ISS07\"},\"reason\":{\"from\":\"\",\"to\":\"Grove Catering is the factory canteen: catering at team premises, D5.1.1.z\"},\"evidence_refs\":{\"from\":\"[\\\"gl_line:gl-000123:17\\\"]\",\"to\":\"[\\\"gl-000123\\\"]\"}}","[\"gl-000123\"]",[1,[]],[1,[]]]
[10,[1792827492538188],["0xc2003eee…cd7"],"ai_cap_analyst","approve","work_item","1",false,"PROPOSED","APPROVED","role_not_permitted: role 'ai_cap_analyst' may not approve on work_item; separation_of_duties: caller proposed work item 1 and may not approve it","{}","[\"gl-000123\"]",[1,[]],[1,[]]]
[[10,"ai_cap_analyst","approve","1","PROPOSED","APPROVED","role_not_permitted: role 'ai_cap_analyst' may not approve on work_item; separation_of_duties: caller proposed work item 1 and may not approve it"]]
unknown work item 424242
approve(unknown id) HTTP 530
```

## Deviations from SCHEMA.md

1. **Database name `cost-cap-desk`**, because 2.13 rejects underscores. `STDB_DB` and the root `Makefile`'s `stdb-publish` target (which says `cost_cap_desk`) need updating.
2. **`gl_line.fx_rate_e_6`**, not `fx_rate_e6`. The host's SnakeCase conversion splits letter→digit, and 2.13 has no per-column name override. Every other column name matches SCHEMA.md.
3. **`role_invite.code` holds `sha256(code)`**, so the public table doesn't leak claimable codes.
4. **`proposePolicy.version`**: `0` = auto-increment per `policy_key`.
5. **Audit `subject_id` for policies is `policy_key`**; the row's `policy_id`/`policy_version` say which version.
6. **Materiality also gates `reject` and `answer`** for the controller, per the SCHEMA section 2 roles table ("approve, reject, answer on work items **below** materiality"). It compares `|amount_usd_minor|`.
7. **`bootstrapAdmin` writes an audit row** (allowed or denied) even though it bypasses `transition()`.
8. **`recordStep` by an identity with no role throws** (530) instead of writing a denial, since steps have no audit row. Unknown `kind` or `workItemId` also throws.
9. **`autonomy_by/_reason/_at` describe the latest grant, revoke or suspension**; `autonomy_evidence` keeps the latest grant's evidence. The auto-approval evidence names the granter (`autonomy_granted_by`).
10. **A reversal's `subject_ref` is the reversed item's id** (SCHEMA section 3 says "the original item id"): with chained corrections that is the latest POSTED item, which may itself be a reversal. `reverses_item_id` carries the same value as a `u64?`.
11. **`reopen` is an audit action, not a reducer**, so `upsertGlLine` and `approvePolicy` may write more than the one audit row SCHEMA section 6 describes: one `reopen` row per reopened item plus their own.
12. **Reopen keeps `answered_by`** (SCHEMA section 10 lists what is cleared; the answerer stays excluded from deciding the item).
13. **`cap_effect_invalid`, `reversal_invalid` and `period_not_ready`** are denial codes SCHEMA section 10 describes without naming.
14. **Policy supersession reopens APPROVED items too**, not only PROPOSED ones (SCHEMA section 10 names PROPOSED → NEW): an APPROVED item under the old version would otherwise fail re-validation at post forever and block its period's lock. Only items in a period the new version is in force for are reopened.
15. **`rulebook/pattern_conformance.json` has one case that contradicts its own rule:** `"kelvin"` against `"\u212aELVIN probe"` expects `false`, but NFKC maps the Kelvin sign to ASCII `K`, so both matchers return `true`. The module follows the rule; `test/pattern_conformance.test.ts` documents the case and asserts `true` until the file is corrected.
16. **`limit_ledger` tracks every EXCLUDED category**, not only limited ones (SCHEMA 11.1 says posting in a limited category adds to it); enforcement is still only for categories with `cap_limit_usd_minor`. Tracking all of them lets a reversal always subtract what it backed out.
17. **Cap year = the year of the item's `period_key`**, not the `cap_year` setting.
18. **Resolution is enforced strictly:** citing an agreeing but non-deepest policy is `policy_conflict`. The Tier 0 test that cited two overlapping CATERING policies was changed to non-overlapping ones.
19. **The `Allocation` argument type's SATS name is `AllocationInput`** (the `allocation` table's row type already owns `Allocation`). Field names and order are as SCHEMA 11.1.
20. **`propose_policy` audit evidence is a JSON object** carrying `evidence_refs`, the cornerstone check and the flip report (SCHEMA 11.2 asks for the flip report and `checked_by_proposer` in the evidence).
21. **Allocated items record `posted_treatment = "ALLOCATED"`** and `posted_cap_effect_usd_minor` = the sum of their allocations' effects (mixed buckets); the per-bucket truth is on the `allocation` rows.
