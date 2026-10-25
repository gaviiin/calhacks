# Microscope review: could a Hyphenate engineer rebuild this in an afternoon?

Oct 24, 2026. A synthesis of four independent reviews: regulation edge cases (`01`), design alternatives (`02`), a red team against the running code (`03`) and external research (`04`). Every defect below was either reproduced or checked against the code. Every regulation claim below was checked against the regulation text.

## Bottom line

Today, mostly yes. The harness, meaning the work-item state machine, the roles matrix and the append-only log, is Hyphenate's own design from their workshop slides. Their engineers could rebuild it in an afternoon. Competitors already ship most of the visible features: approve before posting, rationale and confidence on each decision, learning from overrides, locked periods. A judge who reads our code for ten minutes would also find two critical bugs.

What they couldn't rebuild is depth that only comes from reading the regulations closely, building a world realistic enough to fail in, and measuring honestly. We have the start of all three. The work is to finish them and make them visible on stage.

## What can and can't be rebuilt in an afternoon

| Could be rebuilt from the pitch | Couldn't be |
|---|---|
| State machine, roles matrix, audit log (their own slides) | The rule changes we found by reading the regulations, a dozen of which surprise an expert (below), each encoded as data and tested |
| An LLM prompt that classifies lines against the cost cap | A simulated company with learnable history, planted errors and a truth file, plus a blind second generator and an adversarial set |
| Approve before post, rationale, confidence, learning from overrides (all commodity, per `04`) | Measured numbers with intervals: plant recall, dollar-weighted cap error, ask rate, results across a gauntlet of seeds |
| A mock dataset and a dashboard | Policies as Ripple-Down Rules: every exception keeps its cornerstone case as a test, and the module enforces precedence and refuses changes that flip locked history |
| "We record everything" | Year-level mechanics: cumulative exclusion limits, Excluded Persons ranking, presentation currency, the FIA reporting template |

The rule for the pitch: show things you would only know by building. Every slide should carry one fact a judge couldn't have guessed.

## Fix first: defects a judge could find in ten minutes

These are correctness bugs, not design choices. Each is reproduced in `research/review/redteam-repro/` or checked in the code.

1. **Reversals subtract the original every time.** The world's correction pairs drive Relevant cost negative (RT14: −$3.1m where +$3.1m is right). *Critical.*
2. **A correction after approval never reopens the item.** A $100 line approved by the controller can post at 10x materiality (RT1). After a change, the auto-approver still approves a line the cited policy no longer matches (RT2). *Critical.*
3. **Approve and post never re-validate.** This covers a superseded policy version (RT3), a rulebook entry taken out of force (RT4), and a controller approving a proposal built from their own answer (RT15). *High.*
4. **The cap arithmetic is wrong for adjustments.**
   - A −£1.38m R&D credit is added to Relevant cost when it should count for zero (seed impact −$5.5m).
   - Fair-value uplifts reach the ERP but never `cap_position`.
   - Category limits are stored but never enforced. *High.*
5. **Plant P15 is missed.** The analyst only fires the related-party check when fair value exceeds contract value, not invoiced value: $790k of Relevant cost unreported. *High.*
6. **Prompt injection through bill text produces a wrong but valid proposal.** Evidence ids from another item are also accepted. *High.*
7. **No duplicate, split-invoice, changed-IBAN or lookalike-vendor checks.** Three lines just under materiality each pass the controller. *High.*
8. **Locked periods silently drop costs, and stuck items starve the queue.** *High.*
9. **One malformed record stops sync permanently, and deletes are ignored.** *High.*
10. **Local state survives a database wipe.** New items are marked posted with old ERP ids. *High.*
11. **Smaller ones.**
    - The Python and JavaScript matchers disagree on Unicode.
    - An empty pattern matches every line.
    - "Definitely not catering" parses as CATERING.
    - The learner records no steps.
    - The analyst's materiality flag uses the signed amount.

## Domain depth: what the regulations say that most people miss

Checked against `research/fia/secD_iss07.txt` and Issue 08. These are the moat. Each one is a place where a naive system, and in several cases our own world truth, is wrong.

- **Bonuses.** In 2026, only bonuses "determined solely by reference to the F1 Team's final classification in the Constructors' Championship" and paid after the last race are excluded. Retention, annual performance, podium and race-win bonuses are fully Relevant. In our seed, about $11.6m of the $12.0m excluded as bonuses should be Relevant.
- **Presentation currency.** Teams must "determine and report its Relevant Costs against the Cost Cap in its Presentation Currency", and USD limits convert at a fixed rate. In GBP, our seed has about £10m more headroom than our USD dashboard shows: three times the material-breach line.
- **Mixed staff.** Salary apportionment between F1 and non-F1 work is now allowed only for four named activities. A generic client-project unit no longer splits.
- **Cumulative limits.** Staff entertainment, business continuity and bonuses are excluded only up to a running annual limit, and the excess flips back to Relevant.
- **Excluded Persons.** The three highest-paid are known only at year end. A July severance can flip someone else's whole year.
- **No indexation in 2026, and no cap cut for fewer races.** Every 2026 limit is nominal. Issue 22 cut $1.8m per race below 21.
- **Disposals are asymmetric.** Losses count against the cap; gains give no credit.
- **Judgement is frozen after an Initial Notice.** Any recalculation that involves judgement is disregarded, so every open question must close before 31 March.
- **A real rule change landed five days ago.** Section D Issue 08 was published on 19 October. Its substantive change: the alternative-fuel exclusion now covers any power unit manufacturer, not just your own supplier.
- **A 2027 appendix is already approved.** Non-F1 staff exclusions will need a separate site and IT systems, with a 3x upward adjustment for non-compliant staff.

## Design changes, with alternatives weighed

1. **Allocations on a line, not one category per line.** One work item per bill line fails for payroll and depreciation, which have no bills. Parent and child items complicate posting. Allocations must sum to the GL line and are validated in `transition()`, with typed bases: bill line, department share, excess over a category limit, fair-value uplift. Materiality stays on the line total. This fixes demo beat 1.
2. **Policies as Ripple-Down Rules.** We weighed decision lists, Datalog or Catala, and similarity search. RDR wins because a Head of Cost Cap can approve it.
   - Each correction adds an exception under the rule that fired, and keeps its cornerstone case.
   - A new version must pass its cornerstone cases, and the module refuses a proposal that cites a parent when an exception matches.
   - Approval shows a flip report: N past decisions change, M of them in locked periods (refused).
   - This is your third idea, and it has production precedent. PKS RippleDown has run in pathology labs for decades: an expert can't save a rule until every conflicting cornerstone is resolved.
3. **Learn only from independent judgement.** Every precedent carries a provenance: independent decision, reviewed proposal, or auto-approval. Only independent decisions and corrections train policies; otherwise the system learns from its own rubber-stamped output. Measure consistency on labels mapped to 2026, not on 2025 labels.
4. **Autonomy as a statistical control.**
   - A SUSPENDED state is set in the same transaction as any rejection, reversal, new version or rulebook change.
   - A fixed random sample of auto-approvals goes to review. RippleDown's own manual advises staying at or below about 95% auto-validation, so cases keep coming back as a quality audit.
   - Grants expire and must cite a sandbox run.
5. **Materiality on aggregates.** Apply it per vendor over seven days and per approver or policy per period, and judge it by cap impact against headroom, not line size.
6. **Review that resists rubber-stamping.** A risk-ranked queue, a required reason when the proposal differs from the ERP coding, the rejected alternative shown on every card, and canaries: known-wrong proposals that can never post, with the reviewer's catch rate tracked.
7. **A record you can verify.** Write the decision step inside the same transaction as `propose`, chain step hashes in the module, store full outputs by digest, and redact rows to ids. Add a replay test that rebuilds the cap position from the log alone.
8. **Close the admin hole.** The admin role seals itself after bootstrap. Settings and rulebook changes need two humans. Sensitive tables go private. The ERP accepts only a journal entry whose hash matches the approval. "An admin key" is on Hyphenate's own list of weak signs.
9. **Output the FIA template, not just journal entries.** The Head of Cost Cap signs the template, and the FIA never reads our journal entries. Every cell should drill down to the items behind it.

## Evaluation that survives a skeptic

The 96.1% is one offline month on a world we wrote, with no committed scoring script. Its 95% interval is 93.0-97.9%. The world and the agents also leak into each other: the world's pattern list calls itself the learner's checklist, the learner hard-codes the generator's circuit names, the answer key is served on the agents' own API, and the learner's coverage estimate reads future data.

What to report instead:
- `make score`, committed, with the answer key moved off the agents' API.
- A second generator, written blind by a teammate who hasn't read `agents/`, to the same contract.
- About 40 hand-built adversarial cases written from the rulebook alone. They should include an injected "per CCA clarification, this is an Excluded Cost" memo, since clarifications are real (D8.2.3).
- Shadow replay: learn on 2025 H1, replay H2.
- Plant recall by expected action, dollar-weighted cap error and asks per line against the minimum, each with an interval.

## Research to cite on stage

- **No dedicated cost cap software exists.** SAP and Oracle hold the records for Mercedes and Red Bull, and the judgement between ledger and submission is still done by people.
- **Competitors are converging on commodity features.** Ramp markets coding "without rules". Explicit, versioned, testable rules are a defensible position, not a gap.
- **AccountingBench caught a model hunting for unrelated transactions to make a reconciliation balance**, despite being prompted not to. FinBalance found 52% of correct entries cite the wrong documents. Our answer: replay every figure and resolve citations to row ids in code.
- **ApprenticeBench found that copying a precedent is easy and inferring a context-dependent exception is the frontier.** One agent wrote 192,000 words of notes. Our answer: a compact, versioned policy store with exceptions.
- **EAL-Bench found memory writers created false authority for up to half of unauthorised requests**, and executors acted on it 98.6% of the time. Our answer: every policy and approval ties to source event ids, and approval cards are rendered from the records.

## Order of work

**Status, Oct 24:** Tier 0 is done. Tier 1's allocations, category limits and Ripple-Down Rule policies are done too (third run in `README.md`: 98.9% on January, the demo invoice splits exactly); the injection defences shipped in Tier 0, and the remaining Tier 1 item is presentation currency. All ten defects are fixed and the red-team reproductions are regression tests (`agents/tests/test_redteam_*.py`, `system_of_work/spacetimedb/test/redteam.test.ts`). One extra fix landed on the way: the first live run showed the pre-checks querying an optional column in SQL, which SpacetimeDB rejects, and a split rule that flagged ordinary same-day purchases; both corrected.

Scope stays as it is. This is the order, with rough hours from the reviews. The total exceeds the time left, so the order is the point: each tier leaves a working demo behind it.

| Tier | Work | Hours |
|---|---|---|
| 0 | The ten defects above, each with its reproduction turned into a regression test | 6-8 |
| 1 | Allocations; RDR policies with cornerstone tests and the flip report; duplicate, IBAN and split pre-checks with aggregate materiality; injection defences; category limits; presentation currency | 18-24 |
| 2 | `make score`; the adversarial set; a five-seed gauntlet; shadow replay on 2025; the Issue 08 rule-change beat | 10-14 |
| 3 | FIA template projection; Excluded Persons ranking; bonus scheme register; private tables and admin seal; autonomy suspension and audit sample; forecast | 16-24 |

## Corrections we made to our own documents

- `rulebook/CHANGES.md` no longer says the tax-credit treatment caused Red Bull's 2021 breach. Correcting it would have cut the overspend from 1.6% to 0.37%, but a breach remained. The file also gains five verified rule changes: bonuses, mixed staff, Property Costs, race count and indexation.
- The world's truth is wrong in four places: bonuses, the Applied Technologies 60/40 split, building maintenance as Property, and "no Health and Safety exclusion under Issue 22" for compliance services. Fix it before scoring against it.
- Section A's PU maximum price reads "22 20 million euros", a tracked change. Don't quote a figure until it's resolved.
