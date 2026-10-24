# What changed between the 2025 and 2026 rulebooks

`ISS22` is the FIA Formula 1 Financial Regulations Issue 22, in force 2021-2025. `SECD-ISS07` is the 2026 F1 Regulations Section D Issue 07, in force from 1 January 2026 but published 25 June 2026. Both are in `rulebook.json`, built from the regulation text by `build_rulebook.py`. Every claim below can be checked against the entry text.

These are the changes the Policy Learner must catch when it turns 2025 practice into 2026 policy. Each one makes a 2025 precedent the wrong answer in 2026.

| Change | 2025 (ISS22) | 2026 (SECD-ISS07) | Effect on a 2025 precedent |
|---|---|---|---|
| **Catering** | Not mentioned, so inside the cap | Excluded: catering at Competitions, testing and team premises (D5.1.1.z) | Canteen lines classified RELEVANT in 2025 become CATERING in 2026 |
| **R&D grant income** | Grant income in revenue is offset against R&D costs: a downward adjustment (4.1(b)(ii)) | Grant income offset against costs must be grossed up: an upward adjustment (D6.1.1.b.i.A.1) | The direction flips. In Red Bull's 2021 case, correcting this treatment would have cut the reported overspend from 1.6% to 0.37% of the cap, though a breach remained |
| **Depreciation** | All depreciation and amortisation excluded (3.1(o)); a separate capital expenditure limit applies (4.1(e)) | Only property depreciation and assets used solely for excluded activities are excluded (D5.1.1.o). Plant and equipment depreciation is inside the cap on IAS 16 terms (D6.1.1.k), with clawbacks of 2023-25 accelerated write-downs (D6.1.1.l, m) | Depreciation lines move from Excluded to Relevant |
| **Employer social security** | Only the excess above 13.8% of Total Employee Remuneration is excluded (3.1(q)) | All mandatory employer contributions are excluded (D5.1.1.q) | More payroll on-cost leaves the cap |
| **Competition travel** | Flight, rail and hotel (3.1(r)) | Adds road transport between airport or station, hotel and venue (D5.1.1.r) | Race-weekend taxis and transfers become excluded |
| **Staff entertainment limit** | USD 1,000,000 (3.1(t)) | USD 1,200,000 (D5.1.1.u) | Headroom changes |
| **Sprint adjustment** | USD 300,000 down for every sprint (4.1(l)) | USD 300,000 down only for each sprint beyond six (D6.1.1.p) | The year-end adjustment shrinks |
| **New exclusions** | none | Health and Safety (y), homologated fuel (t), business continuity up to USD 1.5m (aa) | New categories to learn |
| **Removed exclusions** | Sick-leave cover staff (3.1(v)), 2021-22 termination benefits (3.1(x)) | gone | Those 2025 precedents have no 2026 home and must be re-asked |
| **Fines** | Breaches of the Financial Regulations (3.1(m)) | Any FIA fine under Sections A-F (D5.1.1.m) | Sporting fines become excluded |
| **Employee bonuses** | Formal schemes could reward points, podiums and race wins | Only amounts determined solely by the final Constructors' classification and paid after the last Competition (definition of Employee Bonus Costs) | Annual performance, retention, podium and race-win bonuses become fully Relevant |
| **Mixed-staff apportionment** | Any staff working on both F1 and Non-F1 Activities (3.1(h)(ii)(A)) | Only staff on F1 plus PU supply, Customer Team Support, FIA Projects or Standard Supply Components (D5.1.1.h.c.A) | A generic non-F1 client project no longer splits salaries |
| **Property Costs** | Rent, lease, rates and taxes | Adds reinstatement, insurance, external-access security, landscaping, cleaning and waste | Those facilities costs move out of the cap |
| **Race-count adjustment** | USD 1.8m less per race below 21 | No reduction for 24 or fewer Competitions (D4.1.2.a) | The cap no longer falls with a shorter calendar |
| **Indexation** | Applied from 2023 | Defined only from FY2027 | Every 2026 limit is nominal |

Outside the rulebook entries but relevant to the demo: the minor/material overspend threshold tightened from 5% to 2% (Iss 22 Art. 8.3 to D10.3), and the cap rose to USD 215m for 2026 (D4.1.2). See `research/01-f1-team-finance.md`.

**Issue dates.** The 2026 rules took effect on 1 January 2026 and were published in earlier issues before the season. Issue 07, the text in `rulebook.json`, is a later revision dated 25 June 2026. The simulation treats the 2026 rules as known from day one, so onboarding maps 2025 practice to them before the first 2026 line arrives. A mid-season rule event for the self-improving demo should come from a CCA Determination, such as the Transferable Component methodology due by 30 November, not from the 2026 regulations "arriving" in June.
