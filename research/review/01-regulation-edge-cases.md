# Cost cap edge cases: regulation review

Independent review, Oct 24, 2026. Sources: `research/fia/secD_iss07.txt` (SECD), `finreg_iss22_2024.txt` (ISS22), `secA_iss02.txt`, and the implementation. Seed-7 dollar figures come from `world/out/truth_2026.csv`. Verified by the integrator against the regulation text: the 2026 bonus definition, Relevant Costs measured in Presentation Currency (D4.1.1.a), Indexation defined only from FY2027, the cap staying USD 215m for 24 or fewer Competitions (D4.1.2.a), and mixed-staff apportionment narrowed to four activities (D5.1.1.h.c.A).

Hard-because tags: **CUM** cumulative limit across the year, **YE** facts known only at year end, **VAL** valuation, **ALLOC** allocation or split, **VER** rule-version boundary, **TIME** timing or period, **DEF** definitional ambiguity.

## Cross-cutting implementation facts

- **I1. Cap arithmetic.** `index.ts:633-643` puts EXCLUDED lines in the excluded bucket and everything else, RELEVANT and ADJUSTMENT, into relevant at the signed line amount. Nothing reads `cap_limit_usd_minor`. The fair-value uplift reaches the ERP (`gateway.py:94-102`) but never `cap_position`.
- **I2. One category per line, no year state.** Patterns match only the line's own fields; nothing accumulates year-to-date, person, asset or part facts.
- **I3. Rulebook has articles but no definitions.** Most traps below live in the definitions (Appendix D1), which the model never sees.
- **I4. Everything is in USD at the monthly spot rate**, but the regulation measures in Presentation Currency.
- **I5. Rule version follows the posting month**, not the period the cost was incurred in.

## Catalogue

| # | Edge case | Rule and trap | Tags | Today |
|---|---|---|---|---|
| E1 | Capped exclusions flip back to Relevant | Staff entertainment up to USD 1.2m (u); business continuity up to 1.5m, solely and exclusively, infrastructure unusable for production (aa). For a GBP team the limit converts at the Initial Applicable Rate: £949,367. A £310k Christmas party arriving with £800k already excluded: £149,367 excluded, £160,633 Relevant | CUM, VAL | Not handled |
| E2 | Employee bonuses | Only amounts under a Formal Bonus Scheme determined solely by the final Constructors' classification and paid after the last Competition. ISS22 allowed points, podiums and wins. Then capped at the lower of 20% of TFER and USD 12m (14.5m on a title or improvement). Retention and annual performance bonuses are 100% Relevant | DEF, YE, CUM | Not handled; the world truth is wrong too (about $11.6m of $12.0m BONUS should be Relevant) |
| E3 | Excluded Persons | Top three by aggregate Consideration, skipping anyone wholly excluded elsewhere; carries their social security, travel and Connected-Party payments. A July severance can push someone into the top three and flip another person's whole year | YE, CUM | Partly: a static policy with no ranking |
| E4 | Non-F1 and mixed staff | 2026 allows salary apportionment only for staff on F1 plus PU supply, Customer Team Support, FIA Projects or Standard Supply Components. ISS22 allowed any Non-F1 activity. "Directly Attributable" forbids apportionment otherwise. From 2027, site and IT segregation with 3x or 6x penalties; D6.1.1.j claws back two years | DEF, ALLOC, VER | Not handled; the world still splits Applied Technologies 60/40 (about $3.7m) |
| E5 | Inventories and TD017 | Used inventory expensed in full in the year of first use; unused not recognised; redundant expensed now and added back if later used. SECD dropped freight-in from cost. Next-year spares bought in December are a downward adjustment. Missing the Used Inventory Incremental List is a Procedural Breach | TIME, YE, VAL | Partly |
| E6 | Transferable Components | Customer use valued by the CCA methodology Determination due by 30 November of the prior year, not invoice price and not Fair Value | VAL, DEF | Not handled; the related-party path would wrongly apply max(contract, FV) |
| E7 | PU Supply Perimeter | Excluded up to the Section A maximum price, whose extracted text reads "22 20 million euros" (a tracked change). Fair Value first, then the cap. Trackside and dyno services outside the perimeter are Relevant | CUM, VAL, DEF, TIME | Partly |
| E8 | Depreciation | P&E depreciation Relevant with no grandfathering; IAS 16 measurement; 2023-25 accelerated write-downs clawed back in the first year of F1 use. Don't depreciate in costs already expensed via D6.1.1.c/d. The regex token "ppe" means personal protective equipment in 2026, a Health and Safety exclusion | VAL, VER, YE | Partly: classification only |
| E9 | Presentation currency and FX election | Measured in Presentation Currency (GBP cap £170.09m); USD limits convert at the IAR; the retranslation election is all-or-nothing at the Applicable Rate. The seed shows $193.3m against $215m in USD but about £143.7m against £170.09m in GBP: headroom understated by about £10m | VAL, YE | Not handled |
| E10 | R&D grants and tax credits | Grant income offset against costs must be grossed up; ISS22's downward adjustment for grant income in revenue is gone. A −£1.38m credit's cap effect is zero | VER, VAL | Classification asks correctly; **cap position wrong**: I1 adds −£1.38m to Relevant (seed −$5.5m) |
| E11 | Disposals | Gains grossed up (no benefit); losses on F1 P&E Relevant; property disposals excluded | DEF, VAL | Partly; same sign bug |
| E12 | Travel boundaries | Only hotel, flight, rail and road transport between airport or station, hotel and the site of a Competition or Testing of Current Cars. Per diems, meals, week-long car hire, supplier and tunnel trips stay Relevant. Previous-car testing is arguably Heritage | DEF, ALLOC | Partly: memo regex |
| E13 | Catering versus entertainment | Catering at team premises for guests and personnel is uncapped and excluded; the band and marquee at a staff party are capped entertainment; offsite food is capped | ALLOC, CUM | Not handled: no splits |
| E14 | Marketing versus hospitality | Hospitality to guests is Marketing; the motorhome and engineering trailer are Marketing Outputs; inventory is never Marketing. Sponsor value-in-kind is an Exchange Transaction at Fair Value, often with no ledger line | DEF, VAL | Partly |
| E15 | Heritage | Directly Attributable costs excluded; staff pay only for Heritage Asset Personnel (90% or more of hours) and only if proven | YE, DEF | Partly: asks |
| E16 | Sick pay | Only staff formally placed on indefinite leave and not expected to return, from that date. ISS22's sick-cover exclusion is gone | DEF | Partly |
| E17 | Parental leave | Only under a written policy applying substantially equally to all employees of all group entities; an enhanced scheme for senior engineers is Relevant | DEF | Partly |
| E18 | Employer social security | 2026: all mandatory contributions. 2025: only the excess over 13.8% of Total Employee Remuneration, which for UK NIC is tiny. Apprenticeship levy and pension auto-enrolment are not social security | VER, DEF, YE | Partly |
| E19 | FIA fines | 2026 excludes any FIA fine under Sections A-F; police, customs and supplier penalties stay Relevant | VER | Handled |
| E20 | Interim and full year | Interim 1 Jan-30 Apr due 30 June; full year due 31 March. D8.6.4: after an Initial Notice, any recalculation involving judgement is disregarded, so every open question must close before 31 March | TIME | Partly: monthly locks only |
| E21 | Reporting Group 98% | Costs outside the group must be recharged or adjusted in "regardless of whether a price has been charged": the parent's free IT needs a Fair Value line that doesn't exist | YE, VAL | Not handled |
| E22 | Overspend thresholds | Minor under 2% ($4.3m, about £3.40m); material 2% or more brings a mandatory points deduction | | Not handled: `cap_usd_minor` never used |
| E23 | Year-level adjustments | Sprints only beyond six (2026 has six: $0, versus $1.8m under ISS22); tyre test days by Determination; the $3m PU integration split must be declared by 30 Nov 2026, default 50:50, unamendable; carryforward only from 2027 (`rulebook.json` wrongly makes it effective 2026) | | Not handled |
| E24 | Consideration Factor | Optional; REC capped at $250k per Relevant Employee; small for a UK team, large for a Swiss one | VAL, CUM | Not handled |

## Definitions that drive classification

- **Directly Attributable:** would have been avoided, and separately identifiable without apportionment. Any split fails unless an article allows apportionment.
- **Marketing:** includes hospitality to guests, livery, the engineering trailer and the motorhome. Inventory is never Marketing.
- **Heritage Asset Activities:** preservation, operation, testing and maintenance of Previous and Historic Cars. Last year's car is not a Previous Car under ISS22's N-4 to N-2 definition.
- **Health and Safety Costs:** PPE, including race suits, physical protection at Competitions, compliance monitoring. ISS22's HR Activities already covered health and safety matters, so the world's "no H&S exclusion under ISS22" is wrong for compliance services.
- **Sustainability Initiative Costs:** up to 50 low-emission vehicles at any one time (a count limit), electric buses, SAF certificates, FOM logistics surcharges.
- **Property Costs:** ISS22 is rent, lease, rates and taxes. SECD adds reinstatement, insurance, external-access security, landscaping, cleaning and waste. Building maintenance and utilities are never Property Costs, yet the world marks building maintenance PROPERTY.
- **HR Activities:** private medical insurance is Relevant. **Finance Activities** include the cost cap team itself.
- **Related Party Transaction:** applies regardless of whether a price was charged, and covers third parties trading on altered terms because of a related party.

## Ranked top 10

1. **E9 Presentation currency:** about £10m headroom error; every line affected.
2. **E2 Bonus definition:** about $11.6m wrongly excluded.
3. **E10/E11 Adjustment sign bug:** −$5.65m of Relevant; a live bug at `index.ts:633-643`.
4. **E8 Depreciation and clawbacks:** about $21m moves into the cap.
5. **E4 Mixed-staff narrowing:** about $3.7m; contradicts the world truth.
6. **E3 Excluded Persons ranking:** about $7.6m provisional until year end.
7. **E7 PU maximum price:** €0-1.8m depending on the redline figure.
8. **E5 Inventory timing:** multi-million at year end.
9. **E21/E14 Uncharged related-party services and sponsor value-in-kind:** invisible to a line classifier.
10. **E23 PU integration declaration by 30 Nov 2026:** a timely, decision-shaped demo.

## Findings that would surprise an expert

- The 2026 bonus definition makes annual performance, retention, race-win and podium bonuses fully Relevant.
- Mixed-staff splits are already narrowed in the 2026 text, with segregation penalties from 2027.
- No cap reduction for fewer races in 2026; ISS22 cut $1.8m per race below 21.
- No Indexation in 2026 in Section D or E; every 2026 limit is nominal.
- The IAR changed between issues: GBP 1.2691 to 1.2640, CHF 1.0040 to 1.1316.
- Disposal gains and losses are asymmetric: losses count, gains give no credit.
- Shipping homologated fuel to the factory is excluded; shipping it to the circuit is not.
- After an Initial Notice, judgement-based recalculations are ignored.
- Unused-cap carryforward is zero if the FIA review runs past 30 November.
- Two corrections for the pitch: the tax-credit treatment did not cause Red Bull's breach (correcting it would have cut the overspend from 1.6% to 0.37%), and Section A's PU maximum price redline must be resolved before quoting a figure.
