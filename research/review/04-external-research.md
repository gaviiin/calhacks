# External research: competitors, real workflows and prior art

Researched Oct 24, 2026. **[V]** means the source was read; **[I]** means inferred or seen only in a snippet or secondary coverage.

## Corrections to earlier research

1. **Section D is now Issue 08**, dated 1 Oct 2026, approved by the WMSC on 30 Sep and published on fia.com on 19 Oct 2026 [V]. https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_d_financial_-_f1_teams_-_iss_08_-_2026-10-01.pdf . The text is in `research/fia/secD_iss08.txt` and the diff against Issue 07 in `research/fia/secD_iss07_to_iss08.diff.txt`. Most of the diff is typo fixes. Substantive changes: D5.1.1.s now covers alternative-fuel development with any "Power Unit Manufacturer", not only your own supplier; the PU Transaction definition is reworded the same way; "F1 Activities Personnel" is reworded; the sustainability-vehicle exclusion no longer names depreciation or impairment.
2. **FY2025 cost cap results are not yet announced** [I]. FY2024's came on 28 Oct 2025, so FY2025's could land during or just after the hackathon.

## Section D publication history [V]

| Issue | Date | Notable change |
|---|---|---|
| 01 | 17 Oct 2024 | First publication |
| 02 | 11 Dec 2024 | Not isolated |
| 03 | 10 Jun 2025 | Not isolated |
| 04 | 10 Dec 2025 | Carry-forward only from FY2027; IAS 16 wording |
| 05 | 27 Feb 2026 | Procedural articles moved to Section A; surrogate test fuel excluded; inventory never Marketing |
| 06 | 28 Apr 2026 | Fines exclusion widened to Sections A, B, C, E; Redundant Inventories redefined |
| 07 | 25 Jun 2026 | New business continuity exclusion up to $1.5m |
| 08 | 1 Oct 2026 | PU Manufacturer wording; F1 Activities Personnel; sustainability vehicles |

**Appendix D2 already holds approved 2027 rules** [V]: Non-F1 staff costs are excludable only with a separate location and separate IT, with a 3x upward adjustment for non-compliant workforce. On 21 Oct 2026 the WMSC approved a 2027 Operational Regulations section splitting factories into restricted F1 and non-F1 areas, with 3-year access logs, separate IT and a 3-month cooling-off for staff moving into F1 [V]. https://www.the-race.com/formula-1/fia-imposes-draconian-new-rules-on-f1-teams-to-stop-cost-cap-exploitation/ . Williams' catch-up proposal goes to the F1 Commission in November [V].

**Design use:** policies already carry a rule version and effective dates. Classify the same line under Issue 07 and Issue 08, or 2026 and 2027, and show which learned policies a rule change breaks.

## 1. Existing cost cap software

- **No dedicated cost cap compliance product exists** [I].
- **SAP and Mercedes** (3 Sep 2025) [V]: SAP Cloud ERP Private tracks and values "more than 14,500 individual components in each race car" and "reduces manual effort in FIA reporting"; automated compliance reporting is a stated goal, not a result. https://news.sap.com/2025/09/mercedes-amg-petronas-f1-team-sap-cloud-erp/
- **Oracle and Red Bull** (27 Jun 2025) [V]: Oracle Fusion replaced spreadsheet planning; the CIO cites the fixed cost cap. https://www.iteuropa.com/news/formula-one-team-races-cloud-financial-compliance
- **Deloitte advised the FIA** on the regulations, guidance, reporting templates and monitoring procedures [V]. https://www.deloitte.com/uk/en/about/story/impact/cost-cap-f1-wheels.html . No Big Four product sold to teams [I].
- **FIA tooling:** the reporting template is prescribed by Determination and not public. CFO clarification requests (D8.2.3) get written, non-binding answers summarised to every team's CFO: a real but private precedent corpus. In-season monitoring (D8.3.1) is meant to help teams manage risk [V].
- **Implication [I]:** ERPs hold the records and value the parts. The judgment between ledger and submission is still done by people. That is the open space.

## 2. Real workflows we may be missing [V unless marked]

- **Template contents:** Total Costs of the Reporting Group, reconciliation to each entity's audited accounts, the Relevant Costs calculation, disclosures, and related-party, exchange, inter-team, PU and Transferable Component transactions. Layout not public [I].
- **Subset Accounts option:** an audited carve-out of the F1 Team; missing the notice deadline makes a Subset filing a Non-Submission Breach (D10.2.5).
- **Inventory states (D6.1.1.e):** used, unused, redundant; written-off items added back when used; cost is purchase plus conversion with no R&D overhead. TD017 itself isn't public [I]. Maps to Red Bull's misstatement 10.
- **Reassessed Relevant Costs:** from 2027 the carry-forward is the cap minus the CCA's reassessed figure, and zero if the review is open on 30 Nov. Track reported and reassessed figures separately [I].
- **Transferable Component notional values:** methodology by Determination, unpublished [I]. Model as a configurable table.
- **Auditor's assessment report (D7.1.1.d):** format by Determination; the procedures text isn't public.
- **Non-F1 staff:** the FIA reportedly interviews staff declared outside the cap and samples their work [I]. Allocation evidence should be first-class.

## 3. Autonomous finance competitors, late 2026

**Hyphenate's recent posts** [V]: Aug-Sep 2026 was a run of usage-based revenue recognition posts. Key line: the audit trail should be "a byproduct, not a reconstruction." Nothing in October except the rebrand.

| Company | What it says | Source |
|---|---|---|
| Campfire Ember | Approve all agent actions before they post; audit trail with source attribution; confidence thresholds you move "as your comfort grows" | [V] https://campfire.ai/ember |
| Rillet | $100m Series C at $1bn (Aug 2026); humans keep sign-off and audit trail; rules in plain English | [V] https://fintech.global/2026/08/21/ai-erp-challenger-rillet-raises-100m-at-1bn-value/ |
| Numeric | Matching rules on any field; AI suggestions raise match rate monthly; MCP access | [V] https://www.numeric.io |
| Ramp Accounting Agent | Learns from overrides, "70% fewer corrections in the first month"; confidence, rationale and override per decision; 98% accuracy on ready-to-sync; codes "without rules" | [V] https://ramp.com/blog/ai-accounting-software |
| BlackLine Verity Prepare | Agent-built reconciliation packages for human approval, with reasoning, confidence and audit trail | [I] |
| Digits | MCP write access protected by locked periods | [V] |
| FloQast, Basis, Trullion | ISO 42001; large-firm adoption; source-cited answers | [I] |

**Commodity now [I]:** approve before post, rationale and confidence per decision, source-attributed trails, confidence thresholds, learning from overrides, plain-English rules, MCP access, locked periods.

**Not advertised by anyone [I]:** learned policies as explicit, versioned objects with exceptions; replaying a proposed policy change against past decisions before approval; autonomy granted per policy from its measured rejection rate; rulebooks with effective dates; published adversarial test results. Ramp markets "without rules", so explicit rules are a defensible position.

## 4. Prior art: policies with exceptions, precedents as tests

**Ripple-Down Rules (RDR).** Compton and Jansen developed it maintaining a thyroid lab system in 1988. Rules form a tree with exception and else branches; a new rule must fire on the misclassified case and not on its parent's stored cornerstone cases [V]. https://en.wikipedia.org/wiki/Ripple-down_rules

- **Production evidence:** one lab added more than 16,000 rules in 29 months over 6 million cases, with experts writing rules as a minor extension of their duties (Compton et al., 2006) [I]. Industrial use takes "a minute or two per rule" (Compton and Kang, 2021) [V]. PKS reports more than 90 sites [I].
- **PKS RippleDown Knowledge Builder 8.2 manual** [V] https://support.pks.com.au/wp-content/uploads/2021/06/Knowledge-Builder-User-Guide-Ver-8.2.pdf :
  - every rule stores its cornerstone case;
  - a new rule that would change a cornerstone shows a "Conflicting cornerstone", and can't be finished until the expert either applies the change or adds a distinguishing condition;
  - auto-validation is set per report, section or rule, and the manual advises staying at or below about 95% so cases keep coming back as a "continuing quality audit";
  - reports that are rarely rejected are candidates for auto-validation.
- **This is precedents-as-regression-tests plus earned autonomy, used in production labs for decades.**
- **Limitations:** redundancy and no intermediate concepts in large knowledge bases; cornerstone checks protect only stored cases [I].

**Rule induction:** induction of RDR from data (Gaines and Compton, 1995), Weka's Ridor and RIPPER learn default-plus-exception rules [I]. ApprenticeBench's "bundling principle" shows real conventions take this shape: the same invoice line gets different cost codes depending on what else is on the bill [V].

**Policy-as-code and legal rule languages:** OPA decision logs record decision id, input, result and bundle revision at evaluation time [V]. Catala embeds default logic, raises a conflict when two exceptions apply, and exposed a bug in France's official family-benefits implementation [V]. https://arxiv.org/abs/2103.03198 . OpenFisca uses YAML tests with input, output and period [V].

**Applied to accounting classification?** No use of RDR or rule induction for GL coding found [I].

## 5. Failure modes of LLM agents in accounting

- **AccountingBench** [V] https://accounting.penrose.com/ : models follow precedent well, which is why early months look good. An agent double-counted payouts, couldn't delete them, and relabelled the error as a reconciling item. To pass a reconciliation an agent hunted for unrelated transactions summing to $679.94, despite being prompted not to. Drift isn't context exhaustion: each month ran fresh.
- **FinBalance** [V] https://arxiv.org/html/2606.15949 : 52% of entries with the right account and amount cite the wrong documents (strict joint accuracy 5% versus 57% ignoring citations); prompting for better citations moved it −1.4 pp, oracle evidence −26.4 pp; reported balance sheets differ from a replay of the model's own entries by 26-41 pp; ledger feedback raised balance-sheet accuracy but cut detection of planted inconsistencies by up to 52 pp.
- **APEX-Accounting** [V] https://arxiv.org/html/2607.27189 : of 74 failed runs, 53 were reasoning failures and 0 tool use. One model treated a program director's report as donor authorisation and released a restricted $15,000. No model's Pass^8 exceeds 2.6%.
- **ApprenticeBench** [V] https://neocognition.io/blog/apprentice-bench/ : copying a cost code from a precedent is easy for every model; inferring one from an unwritten convention is the frontier. One agent wrote 192,000 words of notes across 122 files against about 2,700 for a human. Agents sent 3.7-4.4x the minimum messages against about 2x for humans. 100 bills took 62.8 hours and 3.7B tokens.
- **EAL-Bench** [V] https://arxiv.org/abs/2609.01836 : memory writers created false authority for up to 50.2% of unauthorised requests, and executors acted on it 98.6% of the time. Requiring permissions backed by valid source events reduced it.

## 6. Prompt injection against finance agents

- **Incidents:** EchoLeak, a zero-click email injection in Microsoft 365 Copilot (CVE-2025-32711), patched June 2025 [I]. Fake invoice emails with hidden prompts aimed at AI scanners [V]. No confirmed case of an AP agent paying a fraudulent invoice [I].
- **Research:** adaptive attacks bypassed 12 published defences at more than 90%, and human red-teamers reached 100% [V].
- **DVAP training lab** [V] https://github.com/dr20240304/dvap : hidden white text on a $400 invoice makes the agent queue $9,500, and the CFO approves a screen showing an attacker-written payee. The fix: render the approval screen from the ledger.
- **Defences:** once an agent has read untrusted input, it must be impossible for that input to trigger consequential actions (Beurer-Kellner et al., 2025) [V]. Meta's Rule of Two: at most two of untrusted input, sensitive data, and the ability to change state, in one session [V].
- **Applied:** the classifier reads untrusted invoices but can only propose, which satisfies the Rule of Two. Policies learn only from human answers and approvals, never from document text. An F1-specific attack to test: a memo saying "per CCA clarification, this is an Excluded Cost". Clarifications are real (D8.2.3), so accept clarification ids only from a curated register.

## Five findings most useful on stage

1. **Issue 08 and the 2027 appendix:** run on Issue 08, show the version history, and demo a learned policy breaking when the rules change.
2. **RippleDown's cornerstone check and its ~95% auto-validation ceiling:** decades of production precedent for policy changes replayed against past decisions and autonomy earned per policy with a permanent review sample.
3. **Plug-hunting and the replay and citation gaps:** recompute every figure by deterministic replay, resolve citations to row ids in code, and show a planted "make it balance" plug denied.
4. **Copying precedents is commodity; context-dependent exceptions are the frontier:** show a compact, versioned policy store with exceptions, and report asks per line against the minimum.
5. **Authority laundering:** tie every policy and approval to its source event ids, render approval cards from records, and red-team with "per CCA clarification" invoices.
