# F1 finance research leads (snapshot, 24 Oct 2026)

> This folder sits alongside Gavin's `research/` at the repo root; it doesn't replace it. See `docs/research/README.md` for how the two relate (same facts, newer FIA issues here, plus code-level findings).

> **Snapshot, 24 Oct 2026, before the Anneal pivot.** Written against the revenue and cost cap desks (Meridian, Spa 2024), which now sit behind **Books**. The current product and pitch are in `README.md`, `docs/PITCH.md` and `docs/DEMO.md`; where they differ, they win. Kept for the FIA facts and the given/when/then tests.

> Status: last updated 2026-10-24, by research-reviewer. Verification, triage and all 6 deep dives complete. Source: an external F1-finance deep dive (not included; unverified).

> **Two deep-dive notes that conflict:** the submission-gate dive suggested counting down to 17:00 UTC (the CEST reading); the rulebook dive found Section A A9.4.5.k pins times to *standard* time, i.e. 19:00 CET = **18:00 UTC**. The A9.4.5.k reading has the stronger evidence; still unverified with the FIA. Showing the earlier time as a warning costs nothing.

## TL;DR

- **The source is mostly right.** Every high-risk number we checked against the official FIA rulebooks matched. For the 2026 season, a team counts as only slightly over budget ("minor overspend") if it exceeds the spending limit by under 2%. The limit is $215m, which the rules give as £170.09m or €198.663m. Teams can carry over unused budget only from 2027, and only up to $2m. A customer engine costs at most €22m. ([2026 financial rules, Section D][SD], [2026 general rules, Section A][SA])
- **It leaves out three rules that matter to our code.** First, when a sponsor pays in goods or services instead of cash, the cap must count them at fair value, meaning a realistic market price, or at the contract price if that is higher. This rule governs our planned sponsor handoff. Second, the €22m engine price is already set to drop to €20.75m from 2029. Third, teams may subtract fixed amounts for extra Sprint races (short Saturday races) and for 2027–28 engine updates. ([SD D6.1.1.a/p/q][SD], [SA Appendix A9][SA])
- **The Spa (Belgian Grand Prix 2024) times are not a conflict.** Each FIA document prints the time it was issued: 16:40, 18:48 and 19:55. The FIA website listing shows when the PDF was posted: 16:40, 18:53 and 19:56. The demo should show the printed time, because that is what a judge sees in the PDF. ([Doc 41][D41], [Doc 44][D44], [Doc 46][D46])
- **Two lines in the teammate's pitch are wrong.** Red Bull's 2021 penalty limited wind-tunnel and computer-simulation testing, not just wind-tunnel time. A points deduction is not the only penalty above 2%. Red Bull was only 1.6% over and still paid $7m plus the testing cut. ([Red Bull settlement][RBR])
- **Deep-dive these 6 leads next.** (1) The Spa evidence timeline, (2) the sponsor payment-in-kind handoff, (3) pinning the rulebook by year and issue, (4) the 2021 settlement error lists as test cases, (5) the US GP 2023 summons as an "at risk" state, (6) a submission gate. The engine-maker cases and the McLaren–Google lead are dropped.

## Verification of the source

**Verdict: Usable with fixes.**

Terms used below:
- **Cost cap:** the FIA's yearly spending limit.
- **Relevant Costs:** the spending the cap counts, after exclusions and adjustments.
- **ABA (Accepted Breach Agreement):** a settlement where a team admits a breach and accepts a penalty.
- **CCA (Cost Cap Administration):** the FIA body that runs the cap.

### Findings (most serious first)

| # | Claim (source location) | Problem | Evidence | Severity | Fix |
|---|---|---|---|---|---|
| 1 | Part 4 sponsor example: "January cloud services consumed: $6,000 expense … proposed Relevant Costs $4,800" | Leaves out the rule that matters most. Under the cap, a barter deal (an **Exchange Transaction**, where goods or services are swapped instead of paid for in cash) counts at "the higher of the contracted cost and the Fair Value". In 2025 the wording was "not less than Fair Value". The source uses the accounting expense, which can be lower. | [SD D6.1.1.a.i and the "Exchange Transaction" definition][SD]; [2025 FR Art. 4.1(a)(i)][FR25] | Major | Value the cap-side amount at the higher of the contract price and fair value, and record which one won. See Corrections #8. |
| 2 | §3.4 "2026 maximum is €22m before applicable indexation" | Correct for 2026, but incomplete. Section A Issue 03 already approves €20.75m for future years. This issue moved that change from 2027 to 2029. The source warns that "an approved future-year appendix must not silently become a current-year rule", then misses this very case. | [SA Appendix A7 §1.4 and Appendix A9][SA] | Major (for code) | Store the price as dated rows: €22m for 2026–2028 and €20.75m from 2029. Both are subject to indexation, an FIA inflation uplift. |
| 3 | §3.1–3.2 (cap mechanics) | Leaves out cap adjustments that change the numbers for 2026: −$300k for each Sprint beyond 6, a −$3m allowance for 2027–28 engine updates split across 2026/2027 (declared by 30 Nov 2026, otherwise 50:50), and the tyre-test-day deduction. | [SD D6.1.1.i, p, q][SD] | Major (for code) | Add these to the rulebook as versioned adjustments. |
| 4 | §6 "provisional 16:40 → disqualification 18:48 → final 19:55, as printed on the documents" | The printed times are correct. Our capture records 18:53 and 19:56, which are listing (publication) times, a different field. Both are real. Spa in July runs on CEST (UTC+2), so a field labelled "CET" may be off by an hour if code reads it as UTC+1. | PDFs read directly: [Doc 41][D41], [Doc 44][D44], [Doc 46][D46]. Listing times from `ingestion/captures/2024-belgian-grand-prix-*.json`. | Minor | Store `issued_at` (printed on the document) and `published_at` (listing time) separately, both in Europe/Brussels time. Show `issued_at` in the demo. |
| 5 | §3.1 "$215m … subject to indexation" (2026) | Only partly applies. The 2026 definition of Indexation covers reporting years from 2027 onward, so 2026 has no indexation in practice. | [SD Appendix D1 "Indexation"][SD] | Minor | Mark 2026 indexation as not applicable. |
| 6 | Part 5 links to the Red Bull ABA and the Saudi review | Both `www.fia.com/sites/default/files/...` links now return 404. The same files work on `api.fia.com`. | Fetched both hosts | Minor | Use the `api.fia.com` links cited in this file. |
| 7 | §2 Mercedes 2025 revenue (£633.378m, etc.) and the Liberty 10-K description of prize money | Not verified. The Companies House link redirects to a signed S3 URL that couldn't be fetched, and the 10-K wasn't opened. | — | Minor (not used in code) | Treat as background only, or have someone check them by hand. |

### Verified (primary source opened)

- **Spa 2024:** Russell's car weighed 796.5 kg against a 798.0 kg minimum, and he was disqualified. Doc 46 lists Hamilton P1 and Russell DQ. Provisional Doc 41 lists Russell P1. ([D44][D44], [D46][D46], [D41][D41])
- **Red Bull 2021:** it overspent by £1,864,000 (1.6%) against a 2021 cap of **£118,036,000**. It paid a $7m fine and took a 10% cut to "Coefficient C" (the factor that sets each team's allowance) for **both** wind tunnel and simulation testing (RWTT and RCFD) for 12 months. The settlement lists **13** cost items treated wrongly. With correct tax-credit treatment the overspend would have been £432,652 (0.37%). ([RBR ABA][RBR])
- **Aston Martin 2021:** spent below the cap but paid a $450,000 procedural penalty. Item 9 was factory catering. Item 11 was unrecorded costs of services provided by sponsors. ([AMR 2021 ABA][AMR21])
- **Williams 2021:** missed the 31 March 2022 deadline for a complete submission. Penalty $25,000, plus a fix due by 31 May 2022. ([Williams ABA][WIL])
- **Alpine:** $400,000. Its 2023 assessment report was deficient. This was under the **engine-maker (Power Unit) financial rules**, and its costs were below that cap. ([Alpine ABA][ALP])
- **Honda (HRC):** $600,000 over dyno maintenance and inventories. Also under the engine-maker rules, and below that cap. ([HRC ABA][HRC])
- **Aston Martin 2024 reporting:** signed audited statements arrived late (15 Apr 2025, inside an extended deadline). No sanction; the team paid only the costs of the settlement. ([AMR 2024 ABA][AMR24])
- **Cap baselines:** $145m (2021), $140m (2022), $135m (2023–25), $215m (2026). ([F1 cap guide][F1CAP])
- **2025 rules:** $135m at 21 races, plus or minus $1.8m for each race above or below 21. Minor overspend is under 5%. "Human Resources Activities" includes health and safety. ([2025 FR Issue 25, Art. 2.3, 8.10, App. 1][FR25])
- **2022 inflation relief:** 3.1%, compounding from 2023. ([FIA statement][INF])
- **2023 compliance review:** announced 11 Sept 2024 after a five-month review. All 10 teams complied; Alpine and HRC were in procedural breach. ([FIA][REV23])
- **Saudi 2023:** the 10-second penalty on Alonso was reversed after a right of review (a request for the stewards to reconsider) brought new video evidence. Doc 53 was issued 20 Mar 2023 at 01:02. ([Decision][SAU])
- **US GP 2023:** Hamilton (P2) and Leclerc (P6) were disqualified for excess plank wear. ([F1 explainer][USGP])
- **2026 Section D Issue 08** (dated 01/10/2026), all checked in the text:
  - D4.1.3 currency table: $215,000k = £170,090k = €198,663k = CHF 189,992k.
  - D6.1.1.n: unused-budget relief starts in 2027 and is capped at $2m.
  - D10.3: minor overspend is under 2%; material overspend is 2% or more.
  - D5.1.1.n: engine supply costs are excluded up to the maximum price.
  - Deadline: 31 March at 19:00 CET.

  ([SD][SD])
- **2026 Section A Issue 03** (25/06/2026): engine price €22m (A7 §1.4); points 25-18-15-12-10-8-6-4-2-1 for races and 8-7-6-5-4-3-2-1 for Sprints, with no fastest-lap point; at most 24 races. ([SA][SA])
- **PR #4 merged at 756ad87 (correction 9):** confirmed in git. The status PDF does call PR #4 "open". (team status doc, 24 Oct).

### Couldn't check

- Mercedes-Benz Grand Prix 2025 accounts: the Companies House redirect could not be fetched.
- Liberty Media 10-K text about the Concorde Agreement (F1's commercial contract with teams).
- The 2025 Technical Regulations' €15m engine price.
- The Leclerc summons PDF itself. Its outcome is confirmed by F1.com and by `world/result_changes.json`.
- The Oracle and McLaren–Google announcements, the IFRS text and the Sprint guide.
- The `cost-cap-desk` branch rulebook (not checked out in this clone).

## Corrections that affect our code

1. **Overspend thresholds depend on the year.**
   - Correct values: 2025 and earlier, minor is under 5% and material is 5% or more ([FR25 Art. 8.10/8.12][FR25]). 2026 Issue 08, minor is under 2% and material is 2% or more ([SD D10.3][SD]).
   - Hits: the Cost Cap Desk breach classifier and the rulebook.
2. **The cap is set in the team's presentation currency, not always GBP.** The presentation currency is the currency of the team's audited accounts.
   - 2026 values: $215,000k, £170,090k (at 1.2640 $/£), €198,663k (at 1.0822), CHF 189,992k (at 1.1316) ([SD D4.1.3 and "Initial Applicable Rate"][SD]).
   - 2025 values: $135,000k or £106,375k (at 1.2691) at 21 races ([FR25 Art. 2.4][FR25]).
   - Note: Meridian's policy book sets functional currency to USD (`policy/revenue_policy.md`). If Meridian is the merged company, its cap is $215m, not £170.09m.
   - Hits: Cost Cap Desk presentation currency (not built yet) and the status doc's wording.
3. **Unused-budget carryforward.**
   - Correct value: from the 2027 reporting year only. Capped at $2m, indexed. The amount is set by the FIA and is **zero** if the FIA has not finished reviewing the prior year by 30 Nov. ([SD D6.1.1.n and "Unused Cost Cap Amount"][SD])
   - Hits: the rulebook's carryforward entry (already a known defect).
4. **Engine (power unit) maximum supply price.**
   - Correct value: €22m for 2026–2028 (indexation "if applicable", using the Section E App. 1 method, not Section D's); the approved future value is €20.75m from 2029 ([SA A7 §1.4 and A9][SA]).
   - The status doc calls this "an unresolved tracked change", but the pink text only marks edits since Issue 02, and Issue 03 is published and approved by the World Motor Sport Council (WMSC, the FIA body that approves rule changes).
   - Hits: the unset engine supply limit in Cost Cap Desk.
5. **Sprint adjustment.**
   - Correct values: 2026, −$300k for each Sprint beyond 6 ([SD D6.1.1.p][SD]). 2025, −$300k for every competition that included a Sprint ([FR25 Art. 4.1(l)][FR25]).
   - Hits: rulebook adjustments. Not confirmed whether they are present today.
6. **Engine-update allowance.**
   - Correct value: −$3m in total, split between 2026 and 2027, declared by 30 Nov 2026. A second $3m applies across 2027 and 2028. ([SD D6.1.1.q][SD])
   - The "otherwise split 50:50" default is green, non-binding "content for inclusion in Determination" text. Treat it as a proposed default (`binding=false`) until the Determination is issued. (Rulebook deep dive.)
   - Hits: rulebook adjustments.
7. **Health and safety (H&S) and catering depend on the year.**
   - 2025: "Human Resources Activities" includes H&S matters ([FR25 App. 1][FR25]).
   - 2026: H&S costs (D5.1.1.y) and catering (D5.1.1.z) are separate exclusions ([SD][SD]).
   - Factory catering was not excludable in 2021 (Aston Martin item 9, [AMR21][AMR21]).
   - Consequences: the two January "H&S labelled HR" lines are right or wrong depending on the year the cost was incurred. The December 2025 canteen invoice follows 2025 rules, so it counts toward the cap.
   - Hits: Cost Cap Desk labels and "rule version by period incurred".
8. **Sponsor goods and services (value-in-kind).**
   - Correct rule: barter counts at the higher of the contract price and fair value ([SD D6.1.1.a.i][SD]). Unrecorded costs must be added back ([SD D6.1.1.g][SD]).
   - Sponsor hospitality and similar services count as "Marketing Services" and are excluded ([SD App. D1][SD]). "Marketing Services" is a 2026-only definition; 2025 covers the same ground under "servicing of sponsorship agreements".
   - The Aston Martin 2021 item 11 precedent is the **unrecorded-costs add-back** (2021 Art. 4.1(h)), not the barter fair-value clause.
   - The source's $4,800 CloudCo figure is right only if the marketing share is separately metered; an estimated 80/20 split fails "Directly Attributable". See the VIK deep dive.
   - Hits: the handoff in status-doc step 7.
9. **Spa timestamps.**
   - Correct values: issued (printed) 16:40, 18:48, 19:55; published (listing) 16:40, 18:53, 19:56; time zone CEST (UTC+2). ([D41][D41], [D44][D44], [D46][D46])
   - Printed times are in the **circuit's local time** (Austin 2023 printed times are CDT, 7 hours behind the listing). Store `issued_at` with the event's time zone, not Europe/Brussels. `classify.py` already parses listing "CET" correctly as Europe/Paris (CEST in summer); the remaining problem is that the UI shows the word "CET" for summer times. (Spa and US GP deep dives.)
   - Hits: the `fia_documents` table, `ingest.py` and the frontend evidence feed.
10. **The "+$1.8m per extra race" rule cannot apply in 2026.** Section A caps the calendar at 24 races, and the 2026 cap already covers up to 24. ([SA A2.1.2][SA], [SD D4.1.2][SD])
    - Hits: avoid a dead code path, or label it as "for future calendars".

## Teammate pitch check

| Pitch claim | Verdict | What's actually true | Source |
|---|---|---|---|
| "Every transaction must be classified as Relevant or Excluded under one of 27 categories." | **Partly right; framing wrong** | 2026 D5.1.1 does list exactly 27 exclusion sub-clauses (a–z plus aa); 2025 Art. 3.1 lists 25 (a–y). But Relevant is the default. A cost leaves the cap only if it is "Directly Attributable" to an exclusion, meaning it would not exist without that activity and can be identified without splitting it up. Several exclusions have limits, such as the bonus cap and the €22m engine price. Then 17 adjustments (D6.1.1 a–q) change the totals, for example fair value for barter, inventories and Sprints. | [SD D5.1.1, D6.1.1, "Directly Attributable"][SD]; [FR25 Art. 3.1][FR25] |
| "Hard ceiling of $215m." | **Misleading** | It is the 2026 baseline, but not a fixed number. It is converted into the team's presentation currency (£170.09m for a GBP team). Indexation applies from 2027. Downward adjustments raise real headroom: Sprints over 6, the $3m engine-update allowance, tyre tests, and unused-budget relief from 2027. A sanction can also lower a future cap. Red Bull's 2021 cap was $145m, which was £118,036,000 in its accounts. | [SD D4.1, D6.1.1, D12.1.1][SD]; [RBR][RBR] |
| "A points deduction if you miss by more than 2%." | **Imprecise** | A material overspend is **2% or more**. If the independent Cost Cap Adjudication Panel confirms it, a constructors' points deduction is mandatory ("shall impose"), plus a fine. Below 2% is still punishable: a fine plus optional minor sporting penalties. Red Bull's 1.6% (a minor breach under the 2021 rule of under 5%, and also under 2%) cost $7m and a testing cut. | [SD D10.3.2–D10.3.4][SD]; [RBR][RBR] |
| "Red Bull got that classification wrong 13 ways in 2021." | **Correct count; slight framing issue** | The settlement lists 13 items, but not all were classification errors. They include a clerical error on recharges and missed adjustments (power units, inventories, gain on disposal). | [RBR][RBR] |
| "It cost them $7m and 10% of their wind tunnel time." | **Half wrong** | The $7m is right. The 10% cut applied to Coefficient C for **both** restricted wind-tunnel (RWTT) and simulation (RCFD) testing, for 12 months. Say "10% of their aerodynamic testing". | [RBR][RBR] |
| "Two sets of books." | **Framing, not literal** | The submission is a reporting template built from the team's audited accounts. Relevant Costs are total costs in the books, minus exclusions, plus adjustments. The template must reconcile to the audited statements. Teams may also submit separately audited "Subset Accounts", but that is optional. Say "a regulatory view reconciled to the statutory accounts". | [SD "Cost Cap Reporting Template", "Relevant Costs", "Subset Accounts"][SD] |

## Lead triage

Rows 1–11 are the source's Part 5 cases. Rows A–F are leads implied elsewhere.

| # | Lead | Seat | MVP value | Effort | Verified? | Bucket | Why |
|---|---|---|---|---|---|---|---|
| 7 | Belgium 2024: Russell disqualified, Spa evidence timeline | Pit Wall | High | S | Yes (PDFs) | **Deep-dive now** | This is the demo's opening. The decisions left are which timestamps to show and how the bonus hold, reassessment and final booking appear in the ledger. |
| A | Sponsor value-in-kind handoff (goods or services instead of cash; fair-value rule plus Aston Martin item 11) | Both | High | M | Rule yes; synthetic values | **Deep-dive now** | It is the only link between the two seats (status-doc step 7). The fair-value rule changes the numbers in the source's example. |
| B | Rulebook pinning by season and issue: 2026 Issue 08 numbers, currency, thresholds, carryforward, engine €22m→€20.75m, Sprint and engine-update adjustments, H&S and catering by year | Cost Cap | High | M | Yes | **Deep-dive now** | Fixes several known defects and the "rule version by period incurred" item. Absorbs the inflation-relief lead (#11). |
| 1+2 | 2021 settlement error lists (Red Bull's 13 items, Aston Martin's 12) as classifier test cases | Cost Cap | High | M | Yes | **Deep-dive now** | Real, citable examples for the classifier and the red-team set. Shows "under budget ≠ compliant". |
| 9 | US GP 2023: Leclerc summons → disqualification as an "at risk" state | Pit Wall | Med-High | S | Positions yes; summons PDF not opened | **Deep-dive now** | The data is already in `world/result_changes.json`, and the policy (REV-02a) defines "at risk". It cheaply adds "a summons is not guilt". |
| 3+6 | Submission and declaration gate (Williams 2021, Aston Martin 2024) | Cost Cap | Med | S | Yes | **Deep-dive now** | The "submission gate" is on the status doc's not-built list. The rules require named signatories (D3.1.1) and an auditor's assessment (D7.1.1.d). |
| 8 | Saudi 2023: Alonso's review reversed | Pit Wall | Med | M | Yes | Later | A good test for a reversal posted after the final result. Not needed for the 60-second story. |
| 11 | Inflation relief 2022 (3.1%) | Cost Cap | Low alone | S | Yes | Later (folded into B) | It is one row in the versioned rulebook. |
| C | Prize money / Concorde (REV-03) | Pit Wall | Low-Med | M | Couldn't verify the 10-K | Later | The table is synthetic by design. Keep the disclaimer. |
| D | Excluded Persons ranking (the three highest-paid staff, recomputed) | Cost Cap | Med | M | Rule yes (D5.1.1.d) | Later | Listed as not built. Its demo value is below the handoff's. |
| E | Sprint bonus clause ambiguity (REV-06) | Pit Wall | Low-Med | S | n/a (synthetic) | Later | Already handled by escalation in the policy. |
| 4 | Alpine assessment deficiencies | Engine maker | Low | M | Yes | Drop | Different regime (engine-maker rules, Section E); not the team ledger. |
| 5 | Honda adjustments | Engine maker | Low | M | Yes | Drop | Same reason as Alpine. |
| 10 | McLaren–Google partnership | Both | Low | S | Values unverifiable | Drop | Lead A covers the idea with a synthetic sponsor. A real brand with made-up values risks looking like an invented record. |
| F | Mercedes 2025 revenue scale | Pit Wall | Low | S | Couldn't verify | Drop | Background only; not needed for the MVP. |

## Deep dives

### Belgium 2024 Spa evidence timeline (issued vs published times)

> Deep dive by research-reviewer, 2026-10-24. Code paths are traced from the source, not run. Listing times below were confirmed against `ingestion/captures/2024-belgian-grand-prix-jeBUcLrEOqPZZipgi.json` by the main session.

**What happened**

Race day was Sunday 28 July 2024. Spa is on CEST (UTC+2), so the circuit's local time and the FIA listing's time are the same clock. "Printed" is the time on the PDF; "Listed" is the time the FIA website shows next to the document.

| Doc | What it is | Printed (local) | Listed ("CET") | UTC (from listing) | Source |
|---|---|---|---|---|---|
| 41 | Provisional Race Classification: Russell P1, Hamilton P2 | 16:40 | 16:40 | 14:40Z | [D41] |
| 42 | "Weight of Car Number 63" (Technical Delegate's report) | not opened | 17:52 | 15:52Z | [FIA listing, Spa][LSPA] |
| 43 | **Summons, Car 63.** "Alleged breach of Article 4.1 … Non-compliance with weight regulations." Team to report to the stewards at **18:10** | **18:00** | **18:23** | 16:23Z | [D43] |
| 44 | Infringement, Car 63: underweight (796.5 kg vs 798.0 kg), disqualified | 18:48 | 18:53 | 16:53Z | [D44] |
| 45 | Race Scrutineering | not opened | 19:49 | 17:49Z | [LSPA] |
| 46 | Final Race Classification: Hamilton P1, Russell DSQ | 19:55 | 19:56 | 17:56Z | [D46] |
| 47 | Championship Points | not opened | 20:00 | 18:00Z | [LSPA] |

The listing trails the printed time by 0–23 minutes, and the order is the same on both clocks.

**What it means for us**

- **Goal (demo opener).** Russell crosses the line first, so Meridian expects a $2,000,000 Halcyon win bonus. The summons arrives, Russell is disqualified, and Hamilton is promoted to the win. We book Hamilton's $2,000,000 win and never the Russell one, and we never post a reversal, because nothing was booked while the result was provisional.
  - Meridian mirrors Mercedes (`world/meridian.json:4`).
  - Halcyon contract v2 applies from round 12, so it covers round 14: win $2,000,000, podium other than a win $1,000,000 (`world/sponsors.json:28-39`).
- **Money on Russell (car 63) at the provisional stage, all "expected" memos:** Halcyon 4.1 win $2,000,000; Arcadia 4.2 podium £400,000; Northwind 6.3 top six $150,000; Volta 5.1 points finish €100,000 (`sponsors.json:54-55,72-73,90-91`; `finance/bonuses.py:54-66`).
- **Money on Hamilton (car 44):** at P2 he expects Halcyon **4.2 podium** ($1,000,000). At the final he earns **4.1 win** ($2,000,000) instead, so his podium memo becomes "avoided". He keeps Arcadia, Northwind and Volta.
- **Bad billing requests in the data:** BR-2024-094 to 098 are submitted at 14:45Z, five minutes after the provisional. BR-095 is Halcyon 4.1 for car 63 at $2,000,000 ("Podium's basically confirmed, invoice it now…"). BR-096 is Halcyon 4.2 for car 44 (`world/requests/2024.json:1307-1376`). The good request is BR-2024-051, Halcyon 4.1 for car 44, submitted 29 Jul 00:56Z (`:705-718`).
- **Timestamp constraint.** Act on the listing time (when we could first have seen the document). Show the printed time, with the listing time beside it.
- **Correction to Corrections #9:** printed times are in the **circuit's local time**, not "Europe/Brussels". For Spa the two match by coincidence; for Austin they don't (next lead). Store `issued_at` as local time plus the event's time zone.
- **Correction to Finding #4:** the code does **not** read "CET" as UTC+1 (see below). The remaining risk is only what the UI shows.

**How our code handles it today**

- **"CET" parsing is correct.** `classify.py:18-22` maps the label to `ZoneInfo("Europe/Paris")`, so summer dates resolve to CEST. Tests confirm Spa "28.07.24 16:40 CET" → 14:40Z, Austin 22 Oct 2023 still CEST, 8 Dec 2024 CET (`ingestion/tests/test_classify.py:13-21`).
- **Only one time is stored.**
  - `fia_documents` has only `publishedAt`, the raw listing string such as "28.07.24 18:53 CET" (`spacetimedb/src/index.ts:19-20`).
  - The frontend shows it under "Published (FIA)" (`frontend/src/App.tsx:140,160-162`). In summer it says "CET" when the time is really CEST.
  - The printed issue time isn't captured anywhere: not in the Actor schema, `fia_bridge.py:34-47`, or the weekend endpoint (`finance/api.py:196-197` gives one `at`, the listing time in UTC).
  - Doc 42 ("Car Number 63") gets no car number: `_CARS` needs a digit right after "Car" (`classify.py:26`). It's classed "other" and ignored. No money effect, but it's the first public signal.
- **Event order** (`finance/sim.py:42-73,102`; events sort by time then type rank, `sim.py:31`). Expected sequence:
  1. **14:40Z provisional.** Base-fee shares post. Expected-bonus memos are memos only (`engine.py:48-61`).
  2. **14:45Z BR-094 to 098.** All **hold / provisional** (`engine.py:272-273`).
  3. **16:23Z summons.** Car 63's four memos become `at_risk`; the controller gets an alert ("…nothing has been booked or billed (REV-02a)…") (`engine.py:63-81`, `agents/revenue.py:113-124`). No journal entry.
  4. **16:53Z infringement.** Same memos re-marked; a **second** alert is sent (same path).
  5. **17:56Z final.** Round marked final. Halcyon 4.1 for car 44 at $2,000,000 is code-prepared and routine, so K10 doesn't park it (`kernel.py:230-237`). Car 63's memos and Hamilton's 4.2 memo become `avoided` (`engine.py:83-102`). Re-review rejects BR-094 to 098 as **overturned** (`engine.py:283-284`).
  6. **29 Jul 00:56Z BR-051.** Approved and billed, Dr 1200 / Cr 1300 (`engine.py:289-310`).
- **What a judge sees in `finance/demo.py`:** `narrate()` prints entries, billing decisions, alerts and questions (`demo.py:24-45`). **Memo changes are invisible**: "expected", "at risk" and "avoided" are skipped, so the $2,000,000 Russell bonus that was never booked isn't shown. Times print as UTC ("16:23Z", `demo.py:70`).
- **Weekend endpoint** (`api.py:190-208`) returns memos with **current status only**. `ledger.memo()` overwrites status in place (`ledger.py:269-281`), so the expected → at risk → avoided history can't be rebuilt afterwards. Only the live mirror stream (`ledger.py:280`) sees each step.
- **Backstops:** K5 refuses bonus or billing entries while provisional (`kernel.py:165-172`); K9 allows a reversal only against a posted bonus (`kernel.py:210-228`).

**Gaps and proposed acceptance tests**

1. **Issued vs listed time.** Given Doc 44, printed "28 July 2024 18:48" with event time zone Europe/Brussels and listed "28.07.24 18:53 CET", when ingested, then the row stores `issued_at_utc=2024-07-28T16:48:00Z` and `published_at_utc=2024-07-28T16:53:00Z`, with `issued_at_utc ≤ published_at_utc`. The UI renders "18:48 CEST (printed) · 18:53 CEST (listed)" and never "CET" for a summer date.
2. **Order and no early bookings.** Given a 2024 run stopped before round 14, when it advances through round 14, then events arrive: provisional 14:40Z, BR-094–098 14:45Z, summons 16:23Z, infringement 16:53Z, final 17:56Z; and no `journal_entries` row of kind `bonus` or `bonus_billing` with an R14 key has `recorded_at` before 17:56Z.
3. **The summons changes memos only.** Given the summons at 16:23Z, then the four car 63 memos are `at_risk`, car 44's are still `expected`, and the journal-entry count is unchanged.
4. **Final booking.** Given the final, then exactly one Halcyon bonus posts: key `bonus|2024|R14|race|halcyon|4.1|car44`, $2,000,000, `posted`, citing `halcyon_v2#4.1`. Memos `…|4.1|car63` and `…|4.2|car44` are `avoided`. No `bonus_reversal` exists for round 14.
5. **Billing.** BR-2024-095's history is exactly [hold/provisional, rejected/overturned]. BR-2024-051 ends `billed` with Dr 1200 / Cr 1300 of 200,000,000 cents.
6. **The demo shows the moment that matters.** `GET /weekend/14` returns each memo's full status history with timestamps (expected 14:40Z, at_risk 16:23Z, avoided 17:56Z), and `demo.py` prints e.g. "AVOIDED: Halcyon 4.1 car 63 $2,000,000, never booked". **Fails today.**

**Sources**

- [D43] Summons, Car 63, Doc 43 (printed 18:00, hearing 18:10).
- [LSPA] FIA listing, Spa 2024 (listing times for Docs 36–47).
- [D41], [D44], [D46] as linked at the bottom of this file.
- Repo: `ingestion/actor/src/classify.py`, `ingestion/tests/test_classify.py`, `finance/{fia_bridge,sim,engine,kernel,ledger,demo,api,bonuses}.py`, `finance/agents/revenue.py`, `world/{sponsors,meridian,result_changes}.json`, `world/requests/2024.json`, `spacetimedb/src/index.ts`, `frontend/src/App.tsx`.
- **Couldn't check:** printed times of Docs 42, 45 and 47; an actual run of the sequence (traced from code).

### Sponsor value-in-kind handoff (fair value for barter, D6.1.1.a)

> Deep dive by research-reviewer, 2026-10-24. **Verdict: usable with fixes.** The source's CloudCo answer ($4,800 in the cap) holds in only one scenario (A′ below). It is wrong if the 80/20 split is an estimate, and also wrong if the contract states a value higher than fair value.

Terms: **Value-in-kind (VIK)** = a sponsor pays in goods or services instead of cash. **Barter** = the FIA's "Exchange Transaction". **Fair value** = a realistic market price.

#### What the rules say

| Topic | 2025 Financial Regulations, Issue 25 | 2026 Section D, Issue 08 |
|---|---|---|
| Is sponsor barter covered? | Yes. "Exchange Transaction" means a transaction "that results in one of the parties acquiring assets or services … by surrendering other assets or services" (App. 1, p.35). | Same definition (App. D1, p.D46). |
| How barter is valued in the cap | Art. 4.1(a)(i): included "at **not less than Fair Value**" (p.8). | D6.1.1.a.i: "must be included in Relevant Costs at **the higher of the contracted cost and the Fair Value**" (p.D14). |
| What "Fair Value" means | "the price that would have been received to sell an asset or paid to transfer a liability in an orderly transaction between market participants at the transaction date" (p.36). | The same wording, plus "determined applying the valuation techniques set out in the Appendix B to IFRS13" (p.D47). |
| Costs missing from the books | Art. 4.1(h): costs "not recognised within its Total Costs, which under the applicable accounting standards should have been recognised" must be added back (p.11). | D6.1.1.g, same wording (p.D16). |
| Netting income against costs | Art. 4.1(b)(i): netted amounts must be grossed up, unless the accounting standards permit the offset (p.9). | D6.1.1.b.i, same rule (p.D14). |
| Marketing exclusion | Art. 3.1(a) excludes "costs Directly Attributable to Marketing Activities". Marketing Activities include "servicing of sponsorship agreements" (App. 1, p.41). 2025 has **no** "Marketing Services" definition. | D5.1.1.a, same exclusion. Marketing Activities (c) is "the undertaking of Marketing Services". "Marketing Services" means providing a sponsor with "branding rights, display rights, hospitality rights …" (p.D53–54). |
| "Directly Attributable" | "(a) the cost would have been avoided if that particular activity was not undertaken; and (b) the cost is separately identifiable **without apportionment**" (p.34). | Identical (p.D45). |
| Disclosure | The Cost Cap Reporting Template must "include details of relevant … Exchange Transactions" (p.33). Art. 6.12(b) lets the CCA review them. | Same (p.D44). D8.3.1.b lets the CCA review them. |

**The real anchor: the Aston Martin 2021 settlement ([AMR21]).** Dated 25 Oct 2022. Item 11 reads, verbatim: *"Understatement of Relevant Costs in respect of provisions set forth by Article 4.1(h) of the Financial Regulations (concerning unrecorded costs and losses in respect of the cost of services rendered by sponsors)"*.
- It cites the **unrecorded-costs add-back** (4.1(h)), not the barter fair-value clause.
- It gives no amount and no type of service.
- It was one of 12 items in a single Procedural Breach (Art. 8.2(e)), settled for $450,000. Aston Martin was below the 2021 cap.

So the precedent is narrow: sponsor-provided services that never reached the books had to be added back. Anything more specific is not public.

#### What it means for us

- **Goal:** one sponsor deal that shows two different correct numbers, one in each seat. Revenue uses fair value. The cap uses the higher of contract price and fair value, and only counts usage that is not marketing.
- **Constraints:**
  - The 80/20 split is not automatically excludable. "Without apportionment" means the marketing share leaves the cap only if it is separately metered (e.g. a separate cloud project for the team website, which counts as a Marketing Output, p.D54).
  - The 2025 and 2026 valuation rules differ when the contract states a value above fair value.
  - "Contracted cost" is **not defined** in App. D1. Reading it as "the value the contract assigns to the usage" is an interpretation. The CCA can clarify on request (D8.2.3).
  - The order in which exclusions and adjustments apply is set by the CCA in the reporting template (D6.1.2), which we don't have.
- **Demo beat:** "One sponsor deal: Pit Wall books $10,000 of January revenue. The cap seat counts $6,000 or $7,500, depending on what the contract says. The marketing slice is excluded only because it was metered. Aston Martin was fined for leaving exactly this kind of sponsor service out of its books."

**Reworked CloudCo example** (all inputs synthetic): a $120,000 cloud entitlement at fair value, for 12 months of advertising; January usage $6,000 at fair value; 80% engineering, 20% marketing.

*Revenue side (Pit Wall).* Under IFRS 15, non-cash consideration is measured at fair value, and the advertising is delivered evenly over the year (IFRS 15 ¶66–69 cited from memory, not reopened).

| Event | Entry (USD cents) | Notes |
|---|---|---|
| Entitlement received (team controls the credits) | Dr 1400 Prepaid sponsor services 12,000,000 / Cr 2300 Contract liability: sponsor VIK 12,000,000 | No revenue yet. |
| January advertising delivered | Dr 2300 1,000,000 / Cr 4020 Sponsorship revenue: VIK 1,000,000 | Any rounding remainder goes in the last month, as in REV-01. |
| January usage | Dr 6400 Cloud services expense 600,000 / Cr 1400 600,000 | Only if this ledger owns the expense; otherwise the cost seat's ERP books it. |

Revenue stays at $10,000 even if the contract states a higher "face value", because revenue follows fair value.

*Cap side (January, Relevant Costs).*

| Scenario | Books | 2026 (Issue 08) | 2025 (Issue 25) |
|---|---|---|---|
| A. Contract value equals fair value; 80/20 is an estimate | $6,000 | **$6,000** (no exclusion: apportionment fails "Directly Attributable") | **$6,000** |
| A′. Same, but the marketing $1,200 is metered on its own project | $6,000 | **$4,800** ($1,200 excluded under D5.1.1.a) | **$4,800** (Art. 3.1(a)) |
| B. Credits have a $150k face value, $120k fair value; January at face value is $7,500 | $6,000 | **$7,500** (+$1,500 under D6.1.1.a.i, higher-of); $6,000 if A′ metering applies | **$6,000** (the "not less than Fair Value" floor is met; 2025 never mentions contracted cost) |
| C. Expense never recorded (the Aston Martin case) | $0 | Add back under D6.1.1.g, then value as in A or B | Add back under Art. 4.1(h) |
| D. Revenue netted against the cloud cost (shows $0) | $0 net | Gross up under D6.1.1.b | Gross up under Art. 4.1(b)(i) |

**Side note on backups.** Cloud used solely and exclusively for backup copies can be excluded up to $1.5m, indexed (business continuity and disaster recovery, D5.1.1.aa, p.D42). It does not exist in 2025.

**Smallest handoff payload.** Pit Wall sends one record per sponsor per service month to Cost Cap Desk:

| Field | Why |
|---|---|
| `handoff_id`, `sponsor_id`, `contract_ref`, `clause_id` | Traceability; K6-style check of which contract version was in effect |
| `service_month` (YYYY-MM) | Selects the rule year. **Never the posting date** (see the rulebook lead). |
| `fair_value_cents`, `currency`, `valuation_basis`, `valuation_date`, `valuation_evidence_ref`, `approved_by` | D6.1.1.a.i and the IFRS 13 basis. D8.6.4 means an estimate supplied after the deadline is ignored. |
| `contracted_value_cents` (nullable) | The other half of "higher of" |
| `usage_lines[]`: `{cost_object, amount_fv_cents, metered: bool, evidence_ref}` | Drives the Directly Attributable test |
| `expense_je_id` (nullable), `revenue_je_id` | A null expense entry triggers the D6.1.1.g add-back |

Cost Cap Desk acknowledges with `{handoff_id, rule_ids[], relevant_cost_cents, excluded_cents, status}`.

**Who owns fair value: Pit Wall (the revenue seat), with controller sign-off.** One valuation feeds both books, so the cap template can reconcile to the audited accounts ("Cost Cap Reporting Template", p.D44). Cost Cap Desk owns the higher-of test, the exclusions and the add-backs. It may park a handoff whose fair value lacks evidence, but may not overwrite the number. Timing gap: IFRS 15 values consideration at contract inception; the FIA's fair value is "at the transaction date". Record both dates.

#### How our code handles it today

- **No VIK support anywhere in Pit Wall.**
  - The chart of accounts has no prepaid-services, contract-liability, VIK revenue or expense account (`finance/config.py:20-29`).
  - The account map per entry kind has no VIK kind (`finance/config.py:32-40`). Kernel check K2 refuses unknown kinds (`finance/kernel.py:79-81`).
  - Sponsors carry only cash fees (`world/sponsors.json:9-105`). Northwind Cloud is cash-only (`world/contracts/northwind_v1.md:9-15`).
  - The policy book has no VIK rule (`policy/revenue_policy.md:14-57`).
- **Trap 1: K4 silently skips new kinds.** `_expected_lines` returns `[]` for any kind it doesn't know (`finance/kernel.py:149`), and `k4` passes when expected lines are empty (`finance/kernel.py:160-163`). Adding a `vik_*` kind without a re-performance branch would bypass K4 without warning.
- **Trap 2: K12 has no evidence type for a valuation.** The source-type list (`finance/kernel.py:247`) has nothing for a fair-value appraisal.
- **Trap 3: materiality wouldn't stop it.** $120,000 is below the $250k threshold (`finance/config.py:14`, `finance/kernel.py:230-237`), so a code-prepared VIK entry would post with no human review, even though fair value is a judgment.
- **Useful for service-month tagging.** The ledger separates `effective_date` from `recorded_at` (`finance/ledger.py:25,179`). But `posting_date()` moves an entry to today when its month is closed (`finance/ledger.py:150-152`), and K3 refuses closed periods (`finance/kernel.py:85-89`). A late December usage report would carry a January `effective_date`, so the payload needs a separate `service_month`.
- **Cost Cap Desk: couldn't tell** (branch not in this clone). Per the status doc, the handoff (step 7) is not built.

#### Gaps and proposed acceptance tests

1. **Given** a CloudCo VIK contract with a $120,000 fair value and 12 months of advertising, **when** the entitlement is received, **then** Pit Wall posts Dr 1400 / Cr 2300 for 12,000,000 cents with no revenue, and K4 re-computes the amount from the contract's fair-value field (a test that fails if K4 returns no expected lines).
2. **Given** each month of advertising is delivered, **when** month-end runs, **then** Dr 2300 / Cr 4020 is 1,000,000 cents per month, and the 12-month total is exactly 12,000,000 cents.
3. **Given** January usage of $6,000 at fair value with a contracted value of $7,500, **when** Cost Cap Desk computes Relevant Costs for 2026, **then** it uses $7,500 and cites D6.1.1.a.i with reason "contracted > fair value". **When** the same input carries a 2025 service month, **then** it uses $6,000 and cites FR25 4.1(a)(i).
4. **Given** usage lines of 80/20 with `metered=false`, **when** the classifier runs, **then** no marketing exclusion is taken ($6,000 counts) and the line parks with the reason "apportioned, not Directly Attributable". **Given** `metered=true`, **then** $1,200 is excluded under D5.1.1.a and $4,800 counts.
5. **Given** a handoff with `expense_je_id = null`, **when** Cost Cap Desk processes it, **then** it adds back the fair-value amount under D6.1.1.g (2026) or 4.1(h) (2025), and the decision cites the Aston Martin 2021 settlement, item 11.
6. **Given** a handoff with no `valuation_evidence_ref`, or `approved_by` empty, **when** it arrives, **then** Cost Cap Desk parks it for the controller and posts nothing. **Given** a December 2025 usage report that arrives after December has closed, **then** Pit Wall's correction posts in January but `service_month` stays `2025-12`.

#### Sources
- [SD] 2026 Section D Issue 08: D5.1.1.a/aa, D5.1.2, D6.1.1.a/b/g, D6.1.2, D8.3.1, D8.6.4; App. D1 pp.D42–D54.
- [FR25] 2025 Financial Regulations Issue 25: Art. 3.1(a), 4.1(a)(b)(h), 6.12; App. 1 pp.33–41.
- [AMR21] Aston Martin 2021 settlement, items 9 and 11.
- [IFRS 15](https://www.ifrs.org/issued-standards/list-of-standards/ifrs-15-revenue-from-contracts-with-customers/), non-cash consideration ¶66–69 (**paragraph numbers from memory, not reopened**).
- Repo files as cited; status doc pp.5–7.

### Rulebook pinning by season and issue (2026 Issue 08 and Section A Issue 03)

> Deep dive by research-reviewer, 2026-10-24. **Verdict: usable with fixes.** Values in this file hold up. One correction: the 50:50 fallback for the engine-update allowance is draft, non-binding text (see below and Corrections #6).

Terms: **Indexation** = the FIA's inflation uplift. **Sprint** = a short Saturday race. **Power unit (PU)** = the engine and its hybrid system.

#### What the rules say

**Rule table.** Engineers can load these rows directly. Amounts are whole units of the currency shown.

| rule_id | season(s) | issue | article | value | currency | effective from / to | notes |
|---|---|---|---|---|---|---|---|
| cap.baseline | 2025 | FR Iss 25 | 2.3(a)(i) | 135,000,000 | USD | 2025-01-01 / 2025-12-31 | At 21 Competitions; "adjusted (if applicable) for Indexation". |
| cap.race_adj | 2025 | FR Iss 25 | 2.3(a)(ii)–(iii) | ±1,800,000 per Competition vs 21 | USD | 2025 | A race cancelled less than 3 months out counts as held. |
| cap.ccy | 2025 | FR Iss 25 | 2.4; App.1 "Initial Applicable Rate" | GBP 106,375,000 / EUR 122,928,000 / CHF 134,462,000 | — | 2025 | Rates 1.2691 / 1.0982 / 1.0040 USD per unit. Illustrative, at 21 races and zero indexation. |
| cap.baseline | 2026 | SD Iss 08 | D4.1.2.a | 215,000,000 | USD | 2026-01-01 / 2026-12-31 | Applies at 24 Competitions or fewer. |
| cap.race_adj | 2026 | SD Iss 08 | D4.1.2.b | +1,800,000 per Competition over 24 | USD | 2026 | Dead path: Section A caps the calendar at 24 (SA A2.1.2). |
| cap.ccy | 2026 | SD Iss 08 | D4.1.3; App. D1 | GBP 170,090,000 / EUR 198,663,000 / CHF 189,992,000 | — | 2026 | Rates 1.2640 / 1.0822 / 1.1316. |
| index.method | 2025 | FR Iss 25 | App.1 "Indexation" | G7 average inflation (IMF), compounded | — | 2025 | Rate set by FIA Determination; **value not public, not verified**. |
| index.method | 2026 | SD Iss 08 | App. D1 "Indexation" | **not applicable** | — | 2026 | Defined only for reporting periods ending 31 Dec 2027 onward. |
| index.method | 2027+ | SD Iss 08 | App. D1 | Indexation Rate, or the Adjusted rate if it exceeds the normal rate by 2 points or more | — | 2027-01-01 / — | Compounds from 2027. |
| index.relief | 2022 | FIA statement | [INF] | 3.1% | — | 2022, compounding from 2023 | |
| overspend.minor | 2025 | FR Iss 25 | 8.10 | under 5% | — | 2025 | Penalties discretionary ("may", 8.11). |
| overspend.material | 2025 | FR Iss 25 | 8.12–8.13 | 5% or more | — | 2025 | Points deduction mandatory ("shall"); fine optional ("may"). |
| overspend.minor | 2026 | SD Iss 08 | D10.3.1–2 | under 2% | — | 2026 | Fine mandatory ("shall impose a Financial Penalty"). |
| overspend.material | 2026 | SD Iss 08 | D10.3.3–4 | 2% or more | — | 2026 | Points deduction **and** fine both mandatory. |
| carryforward | 2025, 2026 | — | — | none | — | — | No unused-budget relief before 2027. |
| carryforward | 2027+ | SD Iss 08 | D6.1.1.n; App. D1 "Unused Cost Cap Amount" | at most 2,000,000, indexed | USD | 2027-01-01 / — | Zero if the CCA's review of the prior year isn't finished by 30 Nov. |
| pu.max_price | 2025 | Tech Regs 2025 | App. 4 (per source) | 15,000,000 | EUR | 2025 | **Unverified.** FR25 3.1(n) points to "the Technical Regulations". |
| pu.max_price | 2026–2028 | SA Iss 03 | A7 §1.4 | 22,000,000 | EUR | 2026-01-01 / 2028-12-31 | "adjusted, if applicable, for Indexation" using **Section E** App. 1, not Section D. Applied as the exclusion cap in D5.1.1.n. |
| pu.max_price | 2029–2030 | SA Iss 03 | A9 "Changes for 2029" | 20,750,000 | EUR | 2029-01-01 / 2030-12-31 | Issue 03 struck the earlier 2027 date. |
| sprint.adj | 2025 | FR Iss 25 | 4.1(l) | −300,000 per Competition with a Sprint | USD | 2025 | |
| sprint.adj | 2026 | SD Iss 08 | D6.1.1.p | −300,000 × (Sprints − 6) | USD | 2026 / — | Zero at 6 or fewer Sprints. 2026 Sprint count **not verified**. |
| pu_update.allow_A | 2026–2027 | SD Iss 08 | D6.1.1.q.i–ii | −3,000,000 total across both years | USD | declare by 2026-11-30 | The "50:50, $1.5m each year" fallback is **green, non-binding "content for inclusion in Determination"** text (p.D18–19). |
| pu_update.allow_B | 2027–2028 | SD Iss 08 | D6.1.1.q.iii–iv | −3,000,000 total across both years | USD | declare by 2027-11-30 | Same caveat. |
| excl.hs | 2025 | FR Iss 25 | 3.1(i); App.1 "Human Resources Activities" | excluded only if Directly Attributable to HR Activities, which "include … health and safety matters" | — | 2025 | No separate H&S exclusion. |
| excl.hs | 2026 | SD Iss 08 | D5.1.1.y; App. D1 "Health And Safety Costs" | all Health and Safety Costs | — | 2026 | Protective equipment, physical protection at Competitions, compliance monitoring. The 2026 HR definition drops "health and safety". |
| excl.catering | 2025 | FR Iss 25 | 3.1 (a)–(y) | **no exclusion** | — | 2025 | AMR 2021 item 9: factory catering wrongly excluded as HR. |
| excl.catering | 2026 | SD Iss 08 | D5.1.1.z | catering at a Competition or test site, and at team premises for guests and staff | — | 2026 | |
| deadline.full_year | all | FR25 App.1; SD App. D1 | "Full Year Reporting Deadline" | 31 March, 19:00 CET, of the following year (next business day if 31 March isn't one) | — | — | SA A9.4.5.k: "an expression of time refers to Central European Standard Time". |
| deadline.interim | all | same | "Interim Reporting Deadline" | 30 June, 19:00 CET, covering 1 Jan–30 Apr | — | — | |
| fv.barter | 2025 | FR Iss 25 | 4.1(a)(i) | "not less than Fair Value" | — | 2025 | See the VIK lead. |
| fv.barter | 2026 | SD Iss 08 | D6.1.1.a.i | "higher of the contracted cost and the Fair Value" | — | 2026 | |
| excl.entertainment | 2025 / 2026 | 3.1(t) / D5.1.1.u | — | 1,000,000 / 1,200,000 | USD | — | Indexed. |
| excl.bonus_max | 2025 / 2026 | App.1 / App. D1 | — | 12m or 10m / 14.5m or 12m | USD | — | Higher figure if the team won or improved its constructors' position. |

**Anchors for choosing a rule version.**
- SA A9.8.1: "Any period prior to Year N shall be governed by the substantive rules in effect at the time of that period."
- SA A9.3.3: each year's rules "will be assumed to be identical to those of the previous calendar year" unless amended.
- SD D1.1.1: Section D covers "Financial Regulations Reporting Periods commencing on or after" 1 Jan 2026.
- Both rulebooks count costs "recognised within profit or loss", and add back costs that "should have been recognised … during the … Reporting Period" (FR25 4.1(h); SD D6.1.1.g).

#### What it means for us

- **Goal:** every cost decision records the `rule_id`, the season and issue it came from, and the article. The data comes from rows, not code.
- **Selection logic:**
  1. Find the service or recognition period: the reporting year in which the cost should be recognised under accrual accounting. That means the service date, not the invoice, payment or posting date.
  2. Select rules whose season range contains that season.
  3. Within that season, take the latest issue published on or before the evaluation timestamp. This keeps "what did we believe on date X" replays honest.
  4. Treat green "content for inclusion in Determination" text as a default flagged `binding=false`.
- **Demo beat:** the December 2025 canteen invoice arrives in January 2026. It's judged under 2025 rules, so it counts against the cap. A January 2026 canteen invoice is excluded under D5.1.1.z. One screen shows both lines and the article each used.
- **Edge cases:**
  - **December 2025 canteen, invoiced January 2026.** Service is 2025, so 2025 rules apply: no catering exclusion, counts against the cap. It belongs in the 2025 books as an accrual; if missing, Art 4.1(h) adds it back. **Open question:** if the audited 2026 accounts expense it instead, no Section D article removes a prior-year cost from 2026. Ask the CCA (D8.2.3).
  - **Prepaid in December 2025 for a February 2026 event.** 2026 rules apply.
  - **A spanning subscription, Oct 2025 to Sep 2026.** Split by service days; each slice uses its own year's rules.
  - **A correction posted in a later open period.** Pit Wall's REV-08 and `ledger.posting_date` would move the date. Keep the original service period for rule selection.
  - **Mid-season issue change.** Issue 08 (01/10/2026) governs the whole 2026 reporting period. A replay as of June 2026 should cite Issue 07, which is **not verified or loaded**.
  - **PU price in 2027.** €22m, not €20.75m. Issue 03 struck the 2027 change.
  - **Deadline time zone.** A9.4.5.k pins times to standard time. On 31 March, after daylight saving starts, 19:00 CET is 20:00 local summer time (18:00 UTC). Reviewer's reading, **unverified**.
  - **Deadline on a weekend.** 31 March 2029 is a Saturday, so the deadline moves to the next business day. "Business day" location is undefined, and Easter Monday 2029 may matter (**unverified**).

#### How our code handles it today

- **Pit Wall has no rulebook.** `ledger.rules` is a dictionary of controller rulings keyed by string (`finance/ledger.py:117`), not a versioned regulation table.
- **What helps:** entries are bitemporal (`effective_date` vs `recorded_at`, `finance/ledger.py:25,179`), which is the model a versioned rulebook needs.
- **The risk:** `posting_date()` replaces the effective date with today for closed months (`finance/ledger.py:150-152`). Anything selected by posting date would pick the wrong year.
- **Cost Cap Desk: couldn't tell** (branch not in this clone). From the status doc (pp.4–5): an 85-entry rulebook from the 2025 and 2026 texts and Issue 08; rule version by period incurred not built; carryforward wrongly active in 2026; PU supply limit unset; two H&S lines and one December 2025 canteen invoice marked as misses. Unknown whether the Sprint adjustment, engine-update allowance or €20.75m price are in its rulebook.

#### Gaps and proposed acceptance tests

1. **Given** a catering cost with service date 2025-12-15, invoice date 2026-01-10 and posting date 2026-01-12, **when** classified, **then** the rule is `excl.catering@2025` (no exclusion), it counts against the cap, and the decision cites FR25 Iss 25. **Given** service date 2026-01-15, **then** it is excluded under D5.1.1.z.
2. **Given** a carryforward query, **when** the season is 2026, **then** relief is 0. **When** the season is 2027, the CCA's unused amount is $3m and the review finished on 2027-11-20, **then** relief is $2m. **When** the review finishes on 2027-12-05, **then** relief is 0.
3. **Given** PU supply costs of €25m, **when** the season is 2026 or 2027, **then** €22m is excluded. **When** the season is 2029, **then** €20.75m is excluded. In every case the indexation source is "Section E App 1".
4. **Given** an overspend of 3% (and separately 1.5%), **when** the season is 2025, **then** both are minor. **When** the season is 2026, **then** material and minor.
5. **Given** 7 Sprints in 2026, **then** the adjustment is −$300,000. **Given** 6 Sprint weekends in 2025, **then** −$1,800,000. **Given** no engine-update declaration by 2026-11-30, **then** the allowance is $1.5m in 2026 and $1.5m in 2027, flagged `binding=false`.
6. **Given** a GBP-presenting team, **when** the season is 2026, **then** the cap shown is £170,090,000; **when** 2025, £106,375,000. **When** rules are evaluated as of 2026-10-02 vs 2026-09-30, **then** the source issue is 08 vs 07 respectively, or "07 not loaded" if absent.

#### Sources
- [SD] 2026 Section D Issue 08: D1.1.1, D4.1.2–3, D5.1.1.n/u/y/z/aa, D6.1.1.n/p/q, D10.3; App. D1 "Indexation", "Initial Applicable Rate", "Unused Cost Cap Amount", "Health And Safety Costs", "Full Year Reporting Deadline", "Interim Reporting Deadline".
- [FR25] 2025 Financial Regulations Issue 25: Art. 2.3–2.4, 3.1, 4.1(l), 8.10–8.13; App. 1.
- [SA] 2026 Section A Issue 03: A2.1.2, A7 §1.4, A9 ("Changes for 2027/2029"), A9.3.3, A9.4.5.k, A9.8.1.
- [INF] FIA statement on 2022 inflation relief.
- [AMR21] Aston Martin 2021 settlement, item 9.
- **Couldn't check:** Section D Issue 07; the 2025 Technical Regulations' €15m; the 2026 Sprint count; actual indexation rates (set by FIA Determination, not public).

### 2021 settlement error lists as classifier test cases (Red Bull 13, Aston Martin 12)

> Deep dive by research-reviewer, 2026-10-24. Key correction to the teammate's harness: "related-party underpricing" **does** have a cost cap basis (D6.1.1.a.i; Red Bull items #8 and #11). Only bank-detail changes belong purely to an AP seat. The ABAs name only the article and topic of each error; the "likely error" reasoning below is inferred, and every test amount is invented. The `cost-cap-desk` branch wasn't checked.

**What happened / what the rules say**

In October 2022 the FIA settled the 2021 season with Red Bull and Aston Martin. Each team signed an Accepted Breach Agreement (ABA): it admitted that its 2021 cost report treated costs wrongly, and it accepted a penalty.
- **Red Bull** (ABA dated 26 Oct 2022) had wrongly excluded or adjusted £5,607,000 of costs. It reported £114,293,000 against a cap of £118,036,000. The corrected total was £1,864,000 (1.6%) over the cap. Arithmetic check: £114.293m + £5.607m − £118.036m = £1.864m. ([RBR][RBR], pp. 1–2)
- **Aston Martin** (ABA dated 25 Oct 2022) stayed below the cap. It still paid $450,000 because its report was inaccurate (Art. 8.2(e)). ([AMR21][AMR21], pp. 1–2)

**How the two lists cite the rules.** Each ABA cites the **2021** Financial Regulations, where Art. 3.1(x) is an exclusion and Art. 4.1(x) is an adjustment. The letters are mapped using 2021 Issue 5 ([FR21][FR21], Art. 3.1 pp. 6–8, Art. 4.1 pp. 9–13). Every letter the ABAs cite fits Issue 5's wording. *Unverified:* whether a later 2021 issue changed the letters. Also, the £118,036,000 cap in the Red Bull ABA doesn't match Issue 5's own illustrative £114,254k (Art. 2.4), so the FIA may have used other parameters.

**What the ABAs do not say.** Neither ABA explains why an item was wrong. The "likely error" wording in the tables below is inferred from the article and the topic.

**Red Bull's 13 items** ([RBR][RBR], p. 2)

| # | What it was (plain English) | Error type | 2026 Section D clause today | Good synthetic test? |
|---|---|---|---|---|
| 1 | Catering costs excluded as "marketing", but the excluded amount was too high | Wrong exclusion (overstated) | **Rule changed.** D5.1.1.z now excludes catering at races, at tests, and at the factory for guests and staff. Marketing is D5.1.1.a. | **Yes.** Same invoice, different answer by year. A rule-version test. |
| 2 | Pay for staff on long-term sick leave, excluded | Wrong exclusion (inferred: evidence missing) | D5.1.1.w. Same wording: the employee must be "formally placed" on indefinite leave and "not expected to return". | **Yes.** The exclusion depends on evidence, so the desk should ask instead of guessing. |
| 3 | Non-F1 costs excluded even though they had already been netted out of total costs | **Double exclusion** | D5.1.1.h.b | **Yes.** The best "duplicate" case. |
| 4 | Staff bonuses excluded, but the bonus exclusion has a cap | Wrong exclusion / limit breached (inferred) | D5.1.1.k. The cap is the lower of 20% of fixed pay and $12m ($14.5m for an improving team). **The definition changed:** a 2026 bonus must depend only on the final constructors' standing and be paid after the last race. | **Yes.** A limit calculation. |
| 5 | Profit on selling equipment was netted against costs and not added back | Missed adjustment | D6.1.1.b.i(A)(2) now says explicitly that a gain on disposal must be added back. A gain on land and buildings ("Property") is excluded instead, under D5.1.1.o.i. | **Yes.** Pair it with a Property sale. |
| 6 | Apprenticeship levy excluded as employer "social security" | Wrong exclusion (inferred: a levy is not social security) | **Rule changed.** 2021 excluded only social security above 13.8% of pay (Art. 3.1(q)). D5.1.1.q now excludes *all* mandatory employer social security. *Unverified* whether a levy counts. | **Maybe.** Send it to a human; don't score it automatically. |
| 7 | Pay for staff who also do non-F1 work, partly excluded (the ABA prints "3.1(h)(ii)(i)", probably meaning (h)(ii)(A)) | Wrong exclusion: an apportioned share without proof | **Rule changed, now narrower.** D5.1.1.h.c(A) applies only to four listed activities: engine supply, customer-team support, FIA projects and FIA-appointed sole supply. | **Yes.** Allocation-based exclusions. |
| 8 | Engines from a related company counted below their real value | Missed adjustment (related-party pricing) | D6.1.1.a.i (higher of contract price and fair value) and D6.1.1.f. Engine supply is also excluded up to the maximum price (D5.1.1.n). | **Yes, using a non-engine item.** Engines bring in the D5.1.1.n cap and get complicated. |
| 9 | Staff pay excluded as "directly attributable to non-F1 activities" | Wrong exclusion | D5.1.1.h.a | Yes, but it overlaps with #7. |
| 10 | Spare parts first used on the car in 2021 not expensed in 2021 | Missed adjustment (timing) | D6.1.1.e.i(A) | **Yes.** A timing / backdating case. |
| 11 | Arithmetic mistake on costs recharged by Red Bull Powertrains (the sister engine company) | Clerical / recharge reconciliation | D4.2.2.b and the "Total Costs of the Reporting Group" recharge rule. D6.1.1.a.i applies if it is a related-party transaction. | **No** as a classification test. **Yes** as a reconciliation check. |
| 12 | Travel costs excluded beyond what the travel exclusion allows | Wrong exclusion (inferred) | **Rule changed, now broader.** 2021 covered flights and hotels only (Art. 3.1(r)). D5.1.1.r adds rail, and road transport between airport or station, hotel and track. | **Yes.** For example, rail to a race. |
| 13 | Maintenance costs excluded under Art. 3.1(i) (HR, finance and legal activities) | Wrong exclusion (basis unclear) | Shared-asset maintenance: only a proven portion, under D5.1.1.h.c(C). Property Costs (App. D1) exclude cleaning, security and landscaping, but **not** maintenance. | **No.** The ABA's rationale can't be reconstructed. |

**Also in the Red Bull ABA (not one of the 13):** a "Notional Tax Credit" of £1,431,348 under Art. 4.1(b). With the correct treatment the overspend would have been £432,652 (0.37%) ([RBR][RBR], p. 3). In 2021 this R&D tax credit *lowered* the cap figure (Art. 4.1(b)(ii) required a downward adjustment, [FR21][FR21] p. 10). **Rule changed:** in 2026, R&D incentive income netted against costs must be *added back* (D6.1.1.b.i(A)(1)), so it no longer helps.

**Aston Martin's 12 items** ([AMR21][AMR21], pp. 1–2)

| # | What it was | Error type | 2026 clause | Good synthetic test? |
|---|---|---|---|---|
| 1 | Costs of the new F1 headquarters excluded as non-F1 | Wrong exclusion (wrong route) | D5.1.1.h. Rent and depreciation of buildings are separately excluded (D5.1.1.j and D5.1.1.o.i). | **Maybe.** Some of the cost may be excludable, but under a different article. |
| 2 | R&D tax credit overstated | Tax credit | **Rule changed:** D6.1.1.b.i(A)(1) | **Yes.** Rule-version test. |
| 3 | New F1 simulator excluded as non-F1 | Wrong exclusion | D5.1.1.h. "Testing" includes simulation (App. D1), so it is an F1 activity. | **Yes.** Clear-cut. |
| 4 | Extra wind-tunnel fees excluded as depreciation or revaluation (Art. 3.1(o)) | Wrong exclusion (inferred: fees are not depreciation) | D5.1.1.o, now narrower: Property, plus plant used only for excluded activities | **Yes.** |
| 5 | Signing bonus excluded under HR, finance and legal (Art. 3.1(i)) | Wrong exclusion | D5.1.1.i covers recruitment *activity*, not pay. Pay to staff counts unless the person is a top-3 "Excluded Person" (D5.1.1.d). | **Yes.** |
| 6 | Customer team's use of shared ("transferable") parts undervalued | Missed adjustment | D6.1.1.a.ii, using a method set by an FIA Determination | **No.** Needs the FIA's method. |
| 7 | Spare parts used in-season not expensed | Missed adjustment (timing) | D6.1.1.e.i(A) | **Yes.** Same as Red Bull #10. |
| 8 | IT service desk excluded as non-F1 or HR/finance/legal | Wrong exclusion (miscoded cost centre) | D5.1.1.h / D5.1.1.i | **Yes.** |
| 9 | Factory staff catering excluded | Wrong exclusion in 2021 | **Rule changed:** excluded under D5.1.1.z in 2026 | **Yes.** Rule-version test. |
| 10 | Desks and chairs excluded under HR, finance and legal | Wrong exclusion (inferred: general staff furniture) | D5.1.1.i, only if Directly Attributable to those activities. Depreciation is excluded only if the asset is used exclusively for them (D5.1.1.o.ii). | **Yes.** |
| 11 | Services provided by sponsors never recorded in the books | Unrecorded cost | D6.1.1.g (unrecorded costs) and D6.1.1.a.i (barter at the higher of contract price and fair value) | **Yes.** This is the planned sponsor handoff. |
| 12 | Outsourced personnel excluded as Property Costs | Wrong exclusion | **Partly changed:** 2026 Property Costs now include security and cleaning (App. D1) but still not contractors | **Yes.** Contract engineer vs cleaning contractor. |

**Best 6–8 as synthetic test transactions**

*SYNTHETIC: every amount below is invented. Reporting year FY2026, Section D Issue 08, USD presentation currency.*

| ID | Synthetic transaction | Expected classification | Article to cite | Pattern |
|---|---|---|---|---|
| SYN-01 | $1,840,000 invoice: "Driver-in-loop simulator upgrade", tagged cost centre `NON-F1 / Automotive` | **Relevant** (in the cap). Reject the non-F1 tag. | D5.1.1.h is not met; App. D1 "Testing" includes simulation | AMR #3 |
| SYN-02 | $310,000 "Road-car consultancy staff" already excluded as non-F1 in the GL roll-up, **and** the same $310,000 proposed again as a D5.1.1.h exclusion line | First exclusion stands. The **second is rejected** as a duplicate. | D5.1.1.h.b; "Total Costs of the Reporting Group" (App. D1) | RBR #3 |
| SYN-03 | Bonus pool of $9,500,000 under a Formal Bonus Scheme set before the first race, based only on the final constructors' standing. Fixed pay of $40,000,000. Not the champion, not improving. | **Excluded $8,000,000** (20% of $40m is below $12m). **Relevant $1,500,000.** Employer social security on the excluded $8m is also excluded. | D5.1.1.k; App. D1 "Employee Bonus Costs", "Excluded Bonus Maximum Amount" | RBR #4 |
| SYN-04a / 04b | Factory canteen invoice of $18,400. (a) Incurred Dec 2025, posted Jan 2026. (b) Incurred Jan 2026. | (a) **Relevant** under 2025 rules (per Corrections #7). (b) **Excluded.** | (b) D5.1.1.z. (a) Uses the period the cost was incurred, not the posting date. | RBR #1, AMR #9 |
| SYN-05 | R&D tax incentive income of $1,200,000 netted against R&D costs in the 2026 accounts | **Upward adjustment of +$1,200,000** | D6.1.1.b.i(A)(1) | RBR tax credit, AMR #2 |
| SYN-06a / 06b | (a) Sale of a used test rig (plant): $250,000 gain netted in operating costs. (b) Sale of a car park (Property): $250,000 gain. | (a) **Upward adjustment +$250,000.** (b) **Excluded.** | (a) D6.1.1.b.i(A)(2). (b) D5.1.1.o.i | RBR #5 |
| SYN-07 | Parent group's composites shop charges the team $600,000 for bodywork. An independent quote puts fair value at $900,000. | **Relevant $900,000.** Record that fair value won, plus the evidence. | D6.1.1.a.i; App. D1 "Related Party Transaction", "Fair Value" | RBR #8 / #11 |
| SYN-08 | Sponsor provides cloud compute for CFD (aerodynamic simulation) under the sponsorship deal. No invoice and nothing booked. Fair value $350,000. | **Add +$350,000** as an unrecorded cost, valued at the higher of contract price ($0) and fair value | D6.1.1.g; D6.1.1.a.i ("Exchange Transaction") | AMR #11 |

**Which items make good red-team mutations**

| Teammate's mutation | Basis in cost cap rules? | Seed cases | Notes |
|---|---|---|---|
| Duplicates | **Yes**, as a duplicate *exclusion* or double-netting | RBR #3 | The cap is an annual total, so a duplicated *payment* matters only if it reaches the cost lines. A duplicated *exclusion* understates Relevant Costs. Pit Wall's saboteur already has a `duplicate` attack on the revenue ledger (`finance/saboteur.py:61`). |
| Backdating into closed periods | **Yes**, as moving a cost to a different reporting year | RBR #10, AMR #7, SYN-04 | Costs belong to the period incurred (D6.1.1.c), and parts are expensed when first used (D6.1.1.e.i(A)). Information the team didn't have at the deadline isn't considered (D8.6.4). Pit Wall already has `closed_period` (`saboteur.py:62`). |
| Miscoded cost centres | **Yes**, the core error type | RBR #1, 9, 12; AMR #1, 3, 4, 5, 8, 10, 12 | Also mutate the cost-centre tag *and* the description, so the classifier can't rely on the tag alone. |
| Related-party underpricing | **Yes. Correct the premise.** | RBR #8, #11; SYN-07 | D6.1.1.a.i and D4.2.4. The template must list related-party transactions (App. D1, "Cost Cap Reporting Template" (e)). |
| Split under threshold | **Partly.** | — | Cost cap limits are *annual totals* (bonus D5.1.1.k, entertainment $1.2m D5.1.1.u, disaster-recovery $1.5m D5.1.1.aa, engine price D5.1.1.n), so splitting invoices doesn't get round them. The cost-cap version is splitting *one* shared cost by an allocation percentage to claim a partial exclusion. That fails "Directly Attributable", which requires a cost "separately identifiable without apportionment" (App. D1). The only exceptions are the proven-portion clauses D5.1.1.e.ii and D5.1.1.h.c. Splitting to stay under an *approval* limit is an AP control. |
| Bank-detail changes | **None** | — | A payment-fraud control. It belongs to an AP / vendor-master seat, not the cost cap classifier. |

**What it means for us**

- **Goal:** a regression set built from real, citable error patterns, so we can say "Red Bull paid $7m over 13 items of these kinds; here our desk catches each kind."
- **Constraints:**
  - Every amount is synthetic. Label it so, and never say we "replayed Red Bull's books".
  - Five items behave differently under 2021, 2025 and 2026 rules (catering, travel, R&D credit, social security, non-F1 sharing). The answer must come from the rule version for the period **incurred**. The status doc lists that as not built.
- **Demo beat:** after the January run, inject SYN-01 (simulator tagged non-F1) and SYN-04b. The desk rejects the first, citing D5.1.1.h and the "Testing" definition. It excludes the second under D5.1.1.z, then shows the same invoice dated December 2025 counting toward the cap.

**Gaps and proposed acceptance tests**

Gap: the status doc says the hospitality invoice is "split three ways, exact to the cent", but not how. If that split comes from an allocation key rather than separate invoice lines, it may fail "Directly Attributable". AT-1.4 tests this.

- **AT-1.1 (case set):** *Given* SYN-01…SYN-08 loaded as January 2026 lines, *when* the classifier runs offline, *then* each line gets the expected classification and amount to the cent, plus a citation that names the article in the table, and the score report lists each case by ID.
- **AT-1.2 (rule version):** *Given* SYN-04a (incurred 2025-12-18, posted 2026-01-07) and SYN-04b (incurred 2026-01-12), *when* classified, *then* 04a uses the 2025 rule and is Relevant, 04b uses Issue 08 D5.1.1.z and is Excluded, and each result records `rule_version` and `incurred_date`.
- **AT-1.3 (duplicate exclusion):** *Given* SYN-02, *when* the second exclusion is proposed, *then* it is refused with reason `duplicate_exclusion`, Relevant Costs are unchanged, and the refusal is logged.
- **AT-1.4 (apportionment):** *Given* an invoice with one total line, a proposed split of 60% excluded and 40% Relevant by allocation key, and no proven-portion clause tagged, *when* classified, *then* nothing is auto-excluded and the line goes to the "ask" queue citing "Directly Attributable". *Given* the same invoice with three itemised lines, *then* the split is allowed.
- **AT-1.5 (evidence-gated exclusions):** *Given* an indefinite-sick-leave pay line (D5.1.1.w) with no "formal placement" document attached, *when* classified, *then* the status is `ask`, not `excluded`. The same applies to D5.1.1.k with no pre-first-race scheme evidence.
- **AT-1.6 (fair value):** *Given* SYN-07, *when* the related-party schedule is built, *then* the row shows contract $600,000, fair value $900,000, winner `fair_value`, the evidence reference, and Relevant Costs of $900,000.
- **AT-1.7 (harness scope):** *Given* the red-team harness emits a `bank_detail_change` mutation, *when* it reaches Cost Cap Desk, *then* it is tagged `out_of_scope:AP` and is not counted in the cost cap score. Every other mutation carries a `rule_basis` field (the article).

**Sources**

- Red Bull 2021 ABA: [RBR][RBR], pp. 1–3
- Aston Martin 2021 ABA: [AMR21][AMR21], pp. 1–2
- 2021 Financial Regulations Issue 5: [FR21][FR21], Art. 3.1, 4.1, App. "Directly Attributable", "Employee Bonus Costs", "Human Resources Activities"
- 2026 Section D Issue 08: [SD][SD], D4.2, D5.1.1.a–aa, D6.1.1.a–g, D8.6.4, App. D1 "Testing", "Property Costs", "Fair Value", "Exchange Transaction", "Related Party Transaction", "Excluded Bonus Maximum Amount", "Cost Cap Reporting Template"
- Pit Wall saboteur: `finance/saboteur.py`
- Status doc (Cost Cap Desk facts): `Project status Cal Hacks 13.0, Oct 24.pdf`, pp. 4–5
- **Unverified:** the reason behind each item (the ABAs give only the article and topic); whether a later 2021 issue changed the letters; whether an apprenticeship levy counts as social security under D5.1.1.q; what the `cost-cap-desk` rulebook already covers.

### US GP 2023 summons as an "at risk" state

> Deep dive by research-reviewer, 2026-10-24. All six FIA PDFs opened directly. Both summonses and all listing times confirmed in `ingestion/captures/2023-united-states-grand-prix-*.json` by the main session. Code paths traced, not run.

**What happened**

Sunday 22 October 2023, Austin. Local time was CDT (UTC−5); Europe was still on CEST (UTC+2) until 29 October. **Printed times are Austin local time and listing times are Paris time, seven hours apart.** That's why the listing dates several documents 23.10.23.

| Doc | What it is | Printed (Austin) | Listed ("CET") | UTC (printed / listed) |
|---|---|---|---|---|
| 56 | Provisional Race Classification: VER 1, **HAM 2**, NOR 3, SAI 4, PER 5, **LEC 6**, **RUS 7** | 16:00 | 22.10 23:01 | 21:00Z / 21:01Z |
| 61 | **Summons, Car 44 (Hamilton).** "Alleged non-compliance with Article 3.5.9 e)" (plank/skid wear). Report at 18:00 | 17:48 | 23.10 00:49 | 22:48Z / 22:49Z |
| 62 | **Summons, Car 16 (Leclerc).** Same article. Report at 18:15 | 17:49 | 23.10 00:53 | 22:49Z / 22:53Z |
| 64 | Decision, Car 44: rear skid outside the limits; "Car 44 is disqualified from the Race (Article 12.4.1.m ISC)". Team accepted the measurement | 19:16 | 23.10 02:17 | 00:16Z / 00:17Z |
| 65 | Decision, Car 16: same finding, disqualified | 19:18 | 23.10 02:30 | 00:18Z / 00:30Z |
| 66 | Final Race Classification: VER 1, HAM DQ, NOR 2, SAI 3, PER 4, LEC DQ, **RUS 5** ("Stewards' document nos. 64 & 65") | 19:35 | 23.10 02:37 | 00:35Z / 00:37Z |

Each summons was followed by a hearing and a disqualification about 90 minutes later. The disqualification reached the books only through the Final Classification.

**What it means for us**

- **Rule to test: a summons is not guilt.** REV-02a: "A summons or infringement concerning a Meridian car marks the affected expected bonuses as at risk", and while provisional "no bonus revenue is recognized and no bonus is billed; expected bonuses are recorded as memos only" (`policy/revenue_policy.md:24-25`). A summons must produce an at-risk memo and a controller alert, never a journal entry, reversal or billing rejection on its own.
- **Money for Meridian (Mercedes) in round 18, under Halcyon v2:**
  - At the provisional, car 44 at P2 expects Halcyon 4.2 podium $1,000,000, Arcadia £400,000, Northwind $150,000 and Volta €100,000.
  - Car 63 at P7 expects only Volta €100,000 (6 points).
  - Commercial asks to invoice all four car 44 bonuses at 21:06Z, five minutes after the provisional: BR-2023-086 to 089, "Podium's basically confirmed…" (`world/requests/2023.json:1195-1250`).
- **Demo beat (a cleaner contrast than Spa).** For 105 minutes only an allegation exists: about $1.7m of car 44 bonuses is "at risk", nothing is booked, invoices stay on hold. At the final, those memos are "avoided" and the requests rejected.
  - **Upside the code doesn't flag:** Russell rises from P7 to P5. Hamilton's DQ alone puts him P6; Leclerc's adds one more place and 2 more points. So the **Car 16 summons concerns a rival car but still moves Meridian's numbers** (race points and the REV-03 prize estimate), though no bonus here.
- **Time-zone constraint.** Austin proves `issued_at` can't be parsed in Europe/Paris. Printed "17:48" is CDT; read as Paris time it would land 7 hours early, before the race started.

**How our code handles it today**

- **Classification is correct.** "Summons…" → kind `summons` with car numbers (`classify.py:82-83`; tested `test_classify.py:38-39`). Plank infringements → `infringement`, likely outcome "disqualification", `outcome_confirmed=False` (`classify.py:85-89`). `test_classify.py:58-65` asserts the Austin capture flags cars {44, 16}.
- **Meridian filter.** `on_fia_document` keeps only Meridian cars (`engine.py:66-69`). Car 44's summons marks its memos `at_risk` and raises `at_risk_alert` (`engine.py:74-81`). **Car 16's summons is ignored entirely**: matches the policy wording, misses the upside.
- **No journal entry from a summons.** `on_fia_document` returns only memo ids and an alert; the alert handler writes an `alert` memo (`revenue.py:113-124`); billing stays `hold / provisional` because `review()` checks only whether the round is final (`engine.py:272-273`); K5 refuses bonus/billing entries before the final (`kernel.py:165-172`); K9 allows reversals only of posted bonuses (`kernel.py:210-228`). Today a summons **cannot** create an entry or reversal (traced, not tested end to end).
- **Resolution at the final** (`engine.py:83-102`): at-risk memos whose bonus is earned under the final become `booked` (`:96-97`), the "summons, no action" path, correct but not exercised by Austin data. The rest become `avoided` (`:91-95`): car 44's four memos. Northwind 6.3 for car 63 (top six) is newly proposed and booked, though never "expected". BR-086 to 089 are rejected as `overturned`.
- **Provisional rebuild** from the final via `world/result_changes.json:16-38` (car 44 back at road position 2, car 16 at 6), reinstated in road-position order (`world.py:244-253`, `reinstate` at `:102-115`), gives RUS P7, matching the real Doc 56.
- **Summons after the final** → `decision_after_final`: a controller question, nothing posted (`engine.py:71-72`, `revenue.py:126-134`).
- **Smaller issues:**
  - Infringement after summons sends a second alert for the same memos (same as Spa).
  - The alert's "held" count includes every hold in the round, not just the summonsed car's (`revenue.py:115`).
  - The at-risk memo doesn't record whether the risk is an allegation (summons) or a decision awaiting the final (infringement).
  - `fia_bridge.py:43` decides "sprint" only from the title, so "Infringement - Car 63 - Leaving the track" (listed 22.10 01:25, just after the provisional sprint classification) is tagged race and silently dropped by the race window in `sim.py:64`. Impact on sprint bonuses unverified.

**Gaps and proposed acceptance tests**

1. **A summons is not guilt.** Given 2023 R18 provisional (Hamilton P2) and BR-2023-086–089 on hold, when "Summons - Car 44 - Alleged technical non-compliance" is processed at 22:49Z, then: the four car 44 memos are `at_risk`; `journal_entries` count unchanged, zero `bonus_reversal` rows; all four requests still `hold / provisional`; exactly one `alert` memo containing "nothing has been booked or billed".
2. **Rival summons.** Given the same state, when "Summons - Car 16 …" is processed, then no Meridian memo changes and no alert is raised. (Optional product extension: an info memo "rival car under investigation, upside possible, no action".)
3. **Summons with no further action** (synthetic fixture). Given a Meridian car's bonuses at risk from a summons and a Final Classification that leaves its position unchanged, when the final is processed, then the memos become `booked`, the bonuses post as routine code entries without parking, and held billing requests are approved at the contract amount.
4. **Final after the summons.** Given the final at 00:37Z, then car 44's memos are `avoided`; no reversal exists; BR-2023-086–089 are `rejected / overturned`; `bonus|2023|R18|race|northwind|6.3|car63` posts for 15,000,000 cents with a decision showing final P5 vs provisional P7.
5. **Summons after the final.** Given R18 final and a Meridian bonus posted, when a summons for that car arrives (e.g. a right of review), then a controller question is created, the bonus stays posted, and no reversal is proposed until a `result_changed` event.
6. **Printed time is circuit-local.** Given Doc 61 printed "22 October 2023 17:48" at a circuit in America/Chicago and listed "23.10.23 00:49 CET", when parsed, then `issued_at_utc=2023-10-22T22:48:00Z`, `published_at_utc=2023-10-22T22:49:00Z`, gap 0–30 minutes. Parsing the printed time as Europe/Paris must fail.

**Sources**

- [Summons, Car 44, Doc 61](https://www.fia.com/sites/default/files/decision-document/2023%20United%20States%20Grand%20Prix%20-%20Summons%20-%20Car%2044%20-%20Alleged%20technical%20non-compliance.pdf) (printed 17:48)
- [Summons, Car 16, Doc 62](https://www.fia.com/sites/default/files/decision-document/2023%20United%20States%20Grand%20Prix%20-%20Summons%20-%20Car%2016%20-%20Alleged%20technical%20non-compliance.pdf) (printed 17:49)
- [Decision, Car 44, Doc 64](https://api.fia.com/sites/default/files/decision-document/2023%20United%20States%20Grand%20Prix%20-%20Infringement%20-%20Car%2044%20-%20Technical%20non-compliance%20%28Plank%29.pdf) (printed 19:16; `www` link 404s)
- [Decision, Car 16, Doc 65](https://www.fia.com/sites/default/files/decision-document/2023_united_states_grand_prix_-_infringement_-_car_16_-_technical_non-compliance_plank_0.pdf) (printed 19:18)
- [Provisional Race Classification, Doc 56](https://www.fia.com/sites/default/files/decision-document/2023%20United%20States%20Grand%20Prix%20-%20Provisional%20Race%20Classification.pdf) (printed 16:00)
- [Final Race Classification, Doc 66](https://www.fia.com/sites/default/files/decision-document/2023%20United%20States%20Grand%20Prix%20-%20Final%20Race%20Classification.pdf) (printed 19:35)
- [FIA listing, US GP 2023](https://www.fia.com/documents/championships/fia-formula-one-world-championship-14/season/season-2023-2042/event/United%20States%20Grand%20Prix)
- Repo: `policy/revenue_policy.md`, `world/result_changes.json`, `world/requests/2023.json`, `world/sponsors.json`, `finance/{engine,kernel,ledger,world,fia_bridge,sim}.py`, `finance/agents/revenue.py`, `ingestion/actor/src/classify.py`, `ingestion/tests/test_classify.py`.
- **Couldn't check:** `world/results` for 2023 (marked verified in `result_changes.json`); whether the sprint-session Car 63 infringement changed any sprint bonus.

### Submission and declaration gate (Williams 2021, Aston Martin 2024)

> Deep dive by research-reviewer, 2026-10-24. Time-zone trap: the rules say "19.00 CET on 31 March", but Europe is already on summer time (CEST) by then. The CCA's template, declaration and auditor-report formats are set by Determinations that don't appear to be public.

**What happened / what the rules say**

**Williams, 2021 reporting year** (ABA dated 19 May 2022; [WIL][WIL])
- Williams failed to submit its complete full-year financial documents by the deadline of **31 March 2022**. That breached Art. 5.1(b) and counted as a "procedural breach" under Art. 8.2(e).
- Williams told the FIA about the problem itself, *before* the deadline.
- The FIA's Cost Cap Administration (CCA) formally notified Williams on 12 April 2022, and Williams accepted on 15 April.
- **Outcome:** a $25,000 fine and the CCA's costs. Williams had to fix the gap by **19:00 CET on 31 May 2022**, which it did.

**Aston Martin, 2024 reporting year** (ABA dated 29 Sep 2025; [AMR24][AMR24])
- Its **signed audited annual financial statements** and **auditor's assessment report** were missing at the **31 March 2025** deadline. This was a "late submission" (Art. 8.2(a)).
- Aston Martin had filed **unsigned** versions of everything before the deadline. The auditor's signature was added as soon as possible, and the content was identical apart from the signature.
- The missing documents arrived on **15 April 2025**, inside an extended deadline the CCA granted (Art. 8.6).
- The FIA accepted "exceptional and unpredictable circumstances" beyond the team's control. Its costs were below the cap.
- **Outcome:** no sanction (Art. 6.28 and 8.3(a)), but the team paid the CCA's costs (Art. 6.29(d)).
- **Lesson:** even a document that is identical except for a missing auditor signature counts as a breach.

**What 2026 Section D requires** ([SD][SD])

| Requirement | Article |
|---|---|
| **Deadline:** "19.00 CET on 31 March" (moves to the next business day if 31 March isn't one) for the year ending the previous 31 December, unless the CCA sets a later time by Determination | App. D1 "Full Year Reporting Deadline" |
| The team must submit on time and make sure everything is "accurate, complete, not misleading" | D2.1.1.a–b |
| Keep 5 years of records, including emails | D2.1.1.c |
| **Full-year package:** (a) Reporting Group Documentation, (b) Full Year Financial Reporting Documentation, (c) Declarations, (d) **assessment report from the same Independent Audit Firm that signs the audited accounts**, in a format set by Determination | D7.1.1.a–d |
| (b) means the **audited annual financial statements for each Reporting Group Entity** plus a completed **Cost Cap Reporting Template**, or the optional "Subset Accounts" route | App. D1 "Full Year Financial Reporting Documentation" |
| The template must include total costs, a **reconciliation to the audited statements for each entity**, the Relevant Costs calculation, adequate disclosure, and details of related-party, exchange (barter), inter-team and engine transactions | App. D1 "Cost Cap Reporting Template" (a)–(e) |
| Reporting Group Documentation: details of each entity in the group, plus confirmation that leaving out other group entities follows D4.2 (the 98% rule, D4.2.1.b) | App. D1; D4.2 |
| The audit firm must be approved by the CCA | App. D1 "Independent Audit Firm" |
| **Declarations**, in the CCA's prescribed format, signed by the **Team Principal, CEO, CFO and Technical Director**, plus (full year only) an **authorised signatory** for the team. Each confirms the documents are complete, accurate, not misleading and compliant (D3.1.1.a.i), and that the team complied with Art. A5.7.2 (D3.1.1.a.ii) | D3.1.1.a |
| Plus (full year only) a declaration by or for the **Ultimate Controlling Party** (the team's ultimate owner) covering the Reporting Group Documentation | D3.1.1.b |
| Signatories must not sign a declaration they know, or ought to know, is untrue. The team is strictly liable for declarations made on its behalf. | D3.1.2.a; D2.1.3 |
| Signatory roles are defined by the team's FIA staff registration | App. D1 "CEO", "CFO", "Team Principal", "Technical Director", "Individual F1 Team Member" |
| **Interim report:** 19:00 CET on 30 June for January–April. It contains the Reporting Group Documentation, interim financial documents and Declarations, with **no** auditor report. | D7.2.1; App. D1 "Interim Reporting Deadline" |
| **Late submission and extensions:** missing anything "fully completed" by the deadline is a Late Submission. The CCA sends a notice, and the team has **two business days** to explain (2021 allowed 48 hours, [FR21][FR21] Art. 8.5). The CCA *may* grant an Extended Reporting Deadline. | D10.2.1–D10.2.3 |
| If the team doesn't respond, its explanation is rejected, or it misses the extended deadline, that is a **Non-Submission Breach**. It goes to the Cost Cap Adjudication Panel, which **must** deduct constructors' points. | D10.2.4, D10.2.6 |
| Using the Subset template without meeting the Subset deadlines is also a Non-Submission Breach | D10.2.5 |
| Declaration failures and late submission are procedural breaches. The CCA may apply a materiality threshold, which isn't published. | D10.1.2.a, d, i; D10.1.3 |
| Other 2026 dates to calendar: the engine-update allowance split must be declared by **30 Nov 2026**, otherwise it is split 50:50 | D6.1.1.q.ii |

**Time-zone flag.** The rules literally say "CET", but Europe switches to summer time on the last Sunday of March, so on 31 March it is on CEST.
- 31 March 2027 (the FY2026 deadline) is a Wednesday, after the switch on 28 March 2027.
- 19:00 CET is 18:00 UTC; 19:00 CEST is 17:00 UTC.
- Store the deadline as written, and drive the countdown off the **earlier** reading (17:00 UTC).
- *Unverified* which one the FIA means.

**What it means for us**

- **Goal:** build the "submission gate" that the status doc lists as not built (p. 5). It checks completeness, signatures and timing; it does not check the numbers.
- **Constraints:**
  - **The app does not file with the FIA.** It prepares and checks a package that the team's own officers submit. There must be no FIA connection or upload, and the screen must say so.
  - The app can confirm a document is *present* and *marked* signed. It cannot confirm a real signature or audit opinion.
  - The CCA's template format, declaration format and auditor-report format are set by Determinations we don't have. Treat them as placeholders.
- **Demo beat (Aston Martin 2024):** the gate is red because one item is missing: "Auditor assessment report: unsigned draft." Flip it to signed and the gate turns green. Voice-over: "In 2025 a team with identical, correct numbers still committed a breach because a signature was missing."

**Proposed minimum submission gate**

| # | Item | Owner role | Evidence | Blocking? |
|---|---|---|---|---|
| G0 | Banner: **"This app does not file with the FIA. Output is a package for the team's own submission."** | — | Static text on the gate screen and in the exported package | Always shown |
| G1 | Reporting year and rule version pinned (FY2026, Section D Issue 08) | Cost cap analyst | Rulebook version ID | **Blocking** |
| G2 | Presentation currency set; cap converted at the Initial Applicable Rate | Cost cap analyst | Currency + converted cap (D4.1.1.a, D4.1.3) | **Blocking** |
| G3 | Reporting Group list, with the 98% test and the excluded-entity confirmation | Controller | Entity table (D4.2.1; App. D1) | **Blocking** |
| G4 | Template complete: total costs → exclusions by article → adjustments by article → Relevant Costs | Cost cap analyst | Generated template (App. D1 (a), (c), (d)) | **Blocking** |
| G5 | Reconciliation to audited statements for each entity, difference = 0 | Controller | Reconciliation table (App. D1 template (b)) | **Blocking** |
| G6 | Related-party / exchange / inter-team / engine schedule: contract vs fair value, which won, evidence | Cost cap analyst | Schedule (App. D1 template (e); D6.1.1.a.i) | **Blocking** |
| G7 | Open "asked" lines = 0 | Cost cap analyst | Queue count (D2.1.1.b; D3.1.2.a) | **Blocking** |
| G8 | Audited annual statements, signed, for each entity | CFO (external auditor supplies) | Uploaded file + `signed=true` (D7.1.1.b) | **Blocking.** An unsigned draft shows "Late Submission risk" ([AMR24][AMR24]). |
| G9 | Auditor assessment report from the **same** audit firm, signed | CFO | File + firm name matches G8 (D7.1.1.d) | **Blocking** |
| G10 | Declarations: TP, CEO, CFO, TD, authorised signatory, Ultimate Controlling Party | CFO collects | One record per role: name, date, file (D3.1.1.a–b) | **Blocking** |
| G11 | Signatory names match the staff registration | CFO | Registered-names list | **Warning** (we can't verify against the FIA) |
| G12 | Elections recorded: foreign-exchange adjustment applied to all or none (D6.1.1.h.ii); engine-update split declared by 30 Nov 2026, else 50:50 (D6.1.1.q.ii); unused-cap relief = n/a for 2026 (D6.1.1.n) | Cost cap analyst | Election log | **Blocking** for q after 30 Nov; otherwise warning |
| G13 | Deadline countdown in UTC, with the CET/CEST note; alert at T-14 days if G8 or G9 are unsigned | Controller | Computed | **Warning** |
| G14 | After the deadline: Late Submission state and a "two business days to explain" timer, with a draft explanation | Controller | D10.2.1–D10.2.2 | **Warning**, shown prominently |
| G15 | Overspend band shown (none / minor under 2% / material 2% or more) | Cost cap analyst | D10.3.1, D10.3.3 | Information only |
| G16 | Records-retention flag (5 years) | Controller | D2.1.1.c | **Warning** |

**Gaps and proposed acceptance tests**

- **AT-2.1 (missing auditor report):** *Given* G1–G8 and G10 pass and there is no G9 file, *when* the user clicks "Mark ready", *then* the gate stays `blocked`, lists "D7.1.1.d assessment report missing", and no package is produced.
- **AT-2.2 (unsigned statements):** *Given* a G8 file with `signed=false`, *when* the gate is evaluated, *then* the status is `blocked`, with the reason "Audited statements unsigned: Late Submission risk (D10.2.1)".
- **AT-2.3 (declarations):** *Given* declarations from TP, CEO and CFO only, *when* the gate is evaluated, *then* it is `blocked` and names the missing roles: Technical Director, authorised signatory, Ultimate Controlling Party (D3.1.1).
- **AT-2.4 (reconciliation):** *Given* the template total differs from the audited total by $1, *when* evaluated, *then* G5 fails and shows the difference by entity.
- **AT-2.5 (open questions):** *Given* 3 lines in the "ask" queue, *when* evaluated, *then* G7 blocks and links to them.
- **AT-2.6 (deadline):** *Given* the clock is 2027-03-31 16:59 UTC and the package isn't ready, *then* the countdown shows under 1 minute using the 17:00 UTC (CEST) reading. *Given* 17:01 UTC, *then* the state is `late` and the two-business-day timer starts (D10.2.2).
- **AT-2.7 (no filing):** *Given* the gate is green, *when* "Export package" runs, *then* a local archive is produced with the G0 banner text, and the test asserts no outbound request goes to any `fia.com` host.
- **AT-2.8 (engine-update election):** *Given* the date is after 2026-11-30 and no D6.1.1.q split is recorded, *then* the gate applies $1.5m to FY2026 and $1.5m to FY2027 and shows "default 50:50 applied".

**Sources**

- Williams ABA: [WIL][WIL]
- Aston Martin 2024-reporting ABA: [AMR24][AMR24]
- 2026 Section D Issue 08: [SD][SD], D2.1.1, D2.1.3, D3.1.1–D3.1.2, D4.1, D4.2, D6.1.1.h, n, q, D7.1.1, D7.2.1, D10.1.2–D10.1.3, D10.2.1–D10.2.6, D10.3; App. D1 "Full Year Reporting Deadline", "Interim Reporting Deadline", "Full Year Financial Reporting Documentation", "Cost Cap Reporting Template", "Reporting Group Documentation", "Independent Audit Firm", "Individual F1 Team Member"
- 2021 Issue 5 (48-hour rule, Art. 8.5): [FR21][FR21]
- Status doc ("A submission gate and the FIA reporting template", not built): p. 5
- **Unverified:**
  - Whether the FIA's "CET" means CET or local time on 31 March.
  - The CCA Determinations that set the template, declaration and assessment-report formats (not public as far as found).
  - What the `cost-cap-desk` branch already has.
  - Minor: App. D1 cites "Article D7.1.2" for Interim Reporting Documentation; it should be D7.2.1 (a typo in the rulebook).

## Open questions for the team

1. **Which currency does the merged company present its accounts in?** Pit Wall's Meridian books are in USD; Kestrel is assumed to be GBP. This decides whether the cap shown is $215m or £170.09m.
2. **Which reporting year does the Cost Cap Desk demo show?** It may be 2025 rules, 2026 Issue 08, or both with a "rule change" moment. Thresholds, H&S and catering, and the Sprint adjustment all differ between them.
3. **Spa demo:** show only the printed time, or both times (printed and FIA listing)? Recommended: both fields in the data and the printed time on screen.
4. **Handoff valuation:** who supplies the fair value of a sponsor's service, and is it labelled as an assumption? The cap takes the higher of contract price and fair value.
5. **Does the `cost-cap-desk` rulebook already include** the Sprint adjustment, the $3m engine-update allowance and the 2029 €20.75m engine price?
6. **Is anyone willing to check by hand** the Mercedes 2025 accounts and the Liberty 10-K before any slide quotes them?

[SD]: https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_d_financial_-_f1_teams_-_iss_08_-_2026-10-01.pdf
[SA]: https://api.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_a_general_provisions_-_iss_03_-_2026-06-25.pdf
[FR25]: https://www.fia.com/system/files/documents/2025_fia_formula_1_financial_regulations_-_issue_25_-_2025-07-31.pdf
[FR21]: https://api.fia.com/sites/default/files/2021_formula_1_financial_regulations_-_iss_5_-_2020-04-30.pdf
[RBR]: https://api.fia.com/sites/default/files/rbr_public_summary_aba_-_article_6.32_1.pdf
[AMR21]: https://api.fia.com/sites/default/files/amr_public_summary_aba_-_article_6.32_0.pdf
[WIL]: https://api.fia.com/sites/default/files/williams_public_summary_aba_v1.3.pdf
[ALP]: https://api.fia.com/sites/default/files/summary_aba_for_public_disclosure_-_alpine.pdf
[HRC]: https://api.fia.com/sites/default/files/summary_aba_for_public_disclosure_-_hrc.pdf
[AMR24]: https://api.fia.com/sites/default/files/summary_aba_for_public_disclosure_-_amr.pdf
[D43]: https://www.fia.com/sites/default/files/decision-document/2024%20Belgian%20Grand%20Prix%20-%20Summons%20-%20Car%2063%20-%20Technical%20Regulations.pdf
[LSPA]: https://www.fia.com/documents/championships/fia-formula-one-world-championship-14/season/season-2024-2043/event/Belgian%20Grand%20Prix
[D41]: https://www.fia.com/sites/default/files/decision-document/2024%20Belgian%20Grand%20Prix%20-%20Provisional%20Race%20Classification.pdf
[D44]: https://www.fia.com/sites/default/files/decision-document/2024%20Belgian%20Grand%20Prix%20-%20Infringement%20-%20Car%2063%20-%20Technical%20non-compliance%20%28Weight%29.pdf
[D46]: https://www.fia.com/sites/default/files/decision-document/2024%20Belgian%20Grand%20Prix%20-%20Final%20Race%20Classification.pdf
[SAU]: https://api.fia.com/sites/default/files/decision-document/2023%20Saudi%20Arabian%20Grand%20Prix%20-%20Decision%20-%20Car%2014%20-%20Right%20of%20Review%20.pdf
[USGP]: https://www.formula1.com/en/latest/article/explained-why-hamilton-and-charles-leclerc-were-disqualified-from-the-2023-united-states.35mNgpUwUVjJiePtPjEWWQ
[INF]: https://www.fia.com/news/fia-formula-1-commission-meeting-8-july-2022-statement
[REV23]: https://www.fia.com/news/fia-completes-its-review-compliance-2023-fia-formula-1-financial-regulations
[F1CAP]: https://www.formula1.com/en/latest/article/explained-what-is-the-f1-cost-cap-and-why-has-it-gone-up.2tYtDIe5SbE5utjThctBT3
