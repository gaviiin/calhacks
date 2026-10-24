# Design review: decisions against alternatives

Independent review, Oct 24, 2026. File and line references are to the repo at that time. Verified by the integrator: the re-sync defect (`system_of_work/spacetimedb/src/index.ts:322-343`), the missing supersession check in `standingApprovalViolations` (`transition.ts:261-275`), the Learner running without a recorder (`agents/policy_learner.py:570`) and the analyst's signed materiality comparison (`agents/cap_analyst.py:307`). One claim is partly stale: the world now makes SECD-ISS07 visible from 2025-12-01, though its `published_on` still shows the Issue 07 date.

## Five defects that matter whatever the design

- **Approved amounts can change after approval.** Re-sync refreshes an open item's amount without resetting its state (`index.ts:322-343`). The gateway books the current GL amount (`agents/gateway.py:95,143`). An item approved at $10k, below materiality, can post at $10m.
- **The auto-approver ignores newer policy versions.** `standingApprovalViolations` (`transition.ts:261-275`) lacks the "superseded by a higher version" check that `proposalViolations` has (`transition.ts:224-233`). Version 1 stays GRANTED after version 2 is approved.
- **Policy precedence lives only in Python** (`agents/policy.py:237-261`). The module only checks that the cited policy matches (`transition.ts:234-255`), so citing the general rule when an approved exception applies passes.
- **The Learner records no steps** (`agents/policy_learner.py:570`), contradicting SCHEMA §6b.
- **Materiality sign mismatch.** The analyst flags on the signed amount (`cap_analyst.py:307`); the module uses the absolute value (`transition.ts:164`).

## 1. SpacetimeDB as the system of work

**Chosen.** One TypeScript module; `transition()` writes the audit row in the same transaction (`transition.ts:95-145`). All 15 tables are public (`schema.ts`), including `vendor.bank_iban`, `bill_line.bill_text` and `agent_step`. SQL can't filter on option columns, so agents full-scan (`search_precedents` pulls the whole table per item, `tools.py:269`). Exactly-once posting depends on a local file (`gateway.py:228-236`).

**Alternatives.** Postgres + FastAPI with `transition()` as a SECURITY DEFINER function, row-level security per role and LISTEN/NOTIFY; or an event-sourced log with projections, which makes replay and shadow evaluation free.

**Skeptic.** "A fresh identity with no role can read IBANs." "Who controls `spacetime publish`?" The owner can replace `transition()` outside the roles matrix, and the Makefile wipes data on every publish.

**Recommendation: keep and extend (12-16h).** Private sensitive tables behind role-checked reads; non-option indexed sentinel columns; the module build hash on every audit row; a POSTING state so intent to post lives in the module; a replay test that rebuilds `work_item` and `cap_position` from `audit_log`. Switching to Postgres (15-25h) isn't worth it.

## 2. Work-item granularity

**Chosen.** One item per GL line, one category per item. P01 fails. The interim guard promised in SCHEMA §9 isn't implemented. Other splits the model can't express: Applied Technologies payroll at 60/40 (48 lines), bonus above the $12m limit (P07), power unit above the maximum price (P34). The fair value uplift is already an allocation, hidden in the gateway.

**Alternatives.** One item per bill line (fails for payroll, depreciation and accruals, which have no bills; bill lines don't sum to the GL line after tax and FX); allocations on the line; parent and child items (partial approval complicates posting).

**Recommendation: allocations on the line (8-10h).** `[{basis, basis_ref, category, entry, amount}]` summing exactly to the line, validated in `transition()`. Typed bases: `bill_line`, `share`, `cap_limit_excess`, `fv_uplift`. Materiality on the line total. Precedents per allocation; one journal line per allocation.

## 3. Policy representation

**Chosen.** A conjunctive pattern over seven keys. Precedence (one match, agreeing matches, or one strict refinement) is enforced client-side only. No exceptions. `acct:6410` became CATERING at 98.3% because `_is_canteen` matches the account name "Catering & canteen" (`rule_versions.py:132`), sweeping the wind-tunnel lunches into CATERING. `cap_limit_usd_minor` is stored but never enforced.

| Alternative | Gains | Loses |
|---|---|---|
| Ordered decision list | Total, simple precedence | Global ordering is brittle |
| Ripple-Down Rules | A correction adds a local exception under the rule that fired; its cornerstone case becomes a regression test | Some redundancy; needs a difference-list UI |
| Datalog / Rego / Catala | Joins, negation, provenance; Catala's default logic fits regulations | A Head of Cost Cap can't approve it |
| Similarity to precedents | Handles the long tail | No approvable scope, so no autonomy |

**Recommendation: extend toward RDR (8-10h).** `parent_policy_id` and `cornerstone_refs`; a policy fires only if no approved child exception matches, and `proposalViolations` denies citing the parent when a child matches. On `proposePolicy`, replay precedents and posted items and report "flips N, M in locked periods (refused)". Add `bill_line_regex`, `entity`, `erp_category_code` keys. Enforce category limits as aggregates.

## 4. Policy learning

**Chosen.** Four fixed group families, at least 10 precedents and 95% consistency. 2025 labels mapped by hand-written overrides. Correction-based policies hard-code `consistency=1.0, exceptions=[]` (`policy_learner.py:518`). Human text is parsed to categories by regex. The LLM veto drops candidates silently.

**Core flaw.** Consistency is measured on 2025 labels, but the split that matters is the 2026 rule's (team premises versus offsite). A group can be consistent under ISS22 and mixed under SECD-ISS07.

**Feedback loop.** Every approval, including the auto-approver's, writes a precedent (`index.ts:613-614`), and the analyst cites approved precedents as evidence. The system's own rubber-stamped output becomes its justification.

**Recommendation: extend (6-8h).** Keep majority grouping as the baseline; add tree splits on 2026-mapped labels and code-validated LLM exception proposals stored as RDR children; add `precedent.provenance ∈ {independent, reviewed_proposal, auto}` and learn only from independent decisions and corrections.

## 5. Materiality

**Chosen.** Per item, $250k absolute. P23 (three same-day invoices of about $249k) passes the controller and the auto-approver.

**Alternatives.** Aggregate per vendor over N days or per invoice-number family; per approver or per policy per period (an autonomy budget); cap-impact materiality, the change in Relevant Costs versus headroom.

**Recommendation: extend inside `transition()` (4-6h).** Material if the line, the vendor's 7-day open-plus-approved total, or the approver's period budget crosses the threshold. Any amount change moves APPROVED back to PROPOSED. Per-category running totals in `cap_position` to enforce limits.

## 6. Earned autonomy

**Chosen.** Manual grant and revoke; evidence is any non-empty JSON. No gauntlet or auto-approver job exists yet. No expiry, budget, sampling or drift trigger.

**Alternatives.** Grants boxed by time or volume; statistical gating with a confidence bound on error rate and a sequential test for revocation; drift monitors (match share, new vendors under the pattern, novel memo tokens, amount distribution); audit sampling.

**Recommendation: extend in the module (6-8h, plus 6-10h for a 5-seed gauntlet).** A SUSPENDED state set in the same transaction as a rejection or reversal citing the policy, a higher version's approval, or a rulebook reload; the supersession check; a deterministic sample (`hash(item, salt) mod 100 < p`) to an AUDIT state; grants cite a `sandbox_run` row and expire.

## 7. Human review

**Chosen.** A script approved 238 proposals in a loop; `approve.reason` may be empty; the recorded alternatives are never shown to the reviewer.

**Recommendation: extend (4-6h).** Risk-ranked queue (no policy, conflict, change from ERP coding, first of its kind, material, thin support); canaries at 2-5% that can never post, with reviewer catch rate tracked and their precedents down-weighted; a required reason when the proposal differs from the ERP coding; blind review on a sample.

## 8. Step recording

Volume is not the issue (about 36k calls a month locally). The real problems:
- **Not complete by construction.** The decision step and `propose` are separate transactions, and on any error the recorder switches to a mutable local file for the rest of the run.
- **Weak tamper evidence.** `run_id` and step numbers are client-chosen and unenforced; any role may write steps; `output_digest` hashes an output stored nowhere.
- **Sensitive data in a public table.** Read steps copy IBANs, bill text, payroll and an executive's sign-on payment into `output_excerpt`.

**Recommendation: change (5-7h).** Decision step written inside `propose` and `ask`; batch the rest per item; module-side hash chain with enforced step numbers; content-addressed store for full outputs; steps redacted to row ids plus digests.

## 9. Identity and secrets

All nine tokens in one file; the red team loads all of them. The admin role outlives bootstrap and can mint a Head of Cost Cap invite, raise materiality and rewrite rulebook entries in place. The gateway key is static. `post` stores only the ERP entry id, so nothing checks the posted entry matches what was approved. Their own slide lists "An admin key" under weak.

**Recommendation: change (4-6h).** `sealBootstrap` deletes the admin role; settings and rulebook changes need two humans and the rulebook is insert-only; `approve` stores a canonical hash of the journal entry and `post` must match it; human tokens never live on the agent host.

## 10. Offline path versus the LLM path

The reported run was offline, so 96.1% involved no model calls. Untrusted bill text and memos go straight into the prompt (`cap_analyst.py:407-413`). The guard checks evidence ids, rulebook validity and article numbers, but a no-policy proposal of any category in force passes, so one injected sentence can produce a plausible wrong proposal. No prompt caching. A judge's rule change hits no hand-written override and silently gets the old answer.

**Where the model adds value.** Reading bill lines into allocations; interpreting free-text corrections; proposing exception discriminators; drafting 2026 overrides from a regulation diff; asking better questions. Estimated $0.20-0.40 per LLM line; cost is not the constraint, latency and determinism are.

**Recommendation: extend (6-10h).** Model for allocations, exceptions and rule diffs, always validated by code; a prompt-injection test set; the injector; an online evaluation before Sunday.

## 11. Output

Journal entries carry the "one door" story, but the FIA Cost Cap Reporting Template is what the Head of Cost Cap signs. **Recommendation: both (4-6h).** A deterministic template projection (Total Costs per audited accounts, exclusions by category, adjustments, Relevant Costs, related-party schedule, headroom), with every cell drilling to items and the audit chain, failing if anything is still pending.

## 12. Evaluation integrity

**Leakage is concrete.** `world/PATTERNS.md` calls itself the Learner's checklist; `GP_REGEX` hard-codes the generator's circuit names; the rule overrides target exactly the planted change rows; the Learner's coverage estimate reads generator output not yet visible at the sim date; `/answer_key` is served unauthenticated by the agents' API.

**The number.** No scoring script is committed. With n=256, one seed, one month, offline, the 95% Wilson interval is 93.0-97.9%.

**Independent evaluation.** A second generator written blind by a teammate to the SCHEMA §5 contract; about 40 hand-built adversarial cases written from the rulebook alone; temporal shadow replay (learn on 2025 H1, replay H2); plant recall by expected action, dollar-weighted cap error and ask rate with intervals; a committed `make score` with the answer key off the agents' API.

## Five likely challenges, with answers

1. **"Is 96.1% real?"** One offline month on a world we wrote: a smoke test with a 93-98% interval. We now report on a generator written blind and a 40-case adversarial set, with `make score` reproducing every number.
2. **"Your policies swallow their exceptions."** Policies are Ripple-Down Rules: a correction becomes an exception under the rule that fired, its case becomes a regression test, and the module refuses a proposal citing the parent when an exception matches.
3. **"Your humans rubber-stamp, and you learn from the stamps."** Precedents carry provenance; only independent decisions train policies; the queue is risk-ranked with canaries; autonomy suspends on any rejection, reversal or new version.
4. **"Your demo invoice is the failure case."** Proposals are allocations that must sum to the line, validated in `transition()`; materiality stays on the whole line.
5. **"You have an admin key."** Admin seals itself after bootstrap; two-human changes; private tables; the ERP accepts only an entry whose hash matches the approval.

## What most increases "hard to rebuild in an afternoon"

1. RDR policies with precedence enforced in the module and a flip report.
2. Allocations plus aggregate controls in `transition()`: structuring windows, category limits, cap-impact materiality.
3. Autonomy as a statistical control: suspend triggers, audit sampling, canaries, precedent provenance.
4. A replayable, hash-chained record.
5. An independent evaluation plus the FIA template.
