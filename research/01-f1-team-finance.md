# How an F1 team's finance function actually works

Research memo, 2026-10-23. Primary sources: FIA 2026 F1 Regulations Section D (Financial, F1 Teams) Issue 07; Section E (PU Manufacturers) Issue 04; Section A (General Provisions) Issue 02; 2021-25 Financial Regulations Issue 22. Extracted text of all four is in `research/fia/` so you can grep article numbers directly.

- Section D: https://api.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_d_financial_-_f1_teams_-_iss_07_-_2026-06-25.pdf
- Section E: https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_e_financial_-_pu_manufacturers_-_iss_04_-_2026-04-28.pdf
- Section A: https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_a_general_provisions_-_iss_02_-_2026-02-27.pdf
- Issue 22 (2021-25 era): https://api.fia.com/sites/default/files/fia_formula_1_financial_regulations_-_issue_22_-_2024-12-11.pdf

## 1. The cost cap

**Cap level history.** $145m (2021), $140m (2022), $135m (2023-2025, indexed for inflation and adjusted for calendar length; The Race put the effective 2024 figure at roughly $165m after indexation). 2026: **$215,000,000** (Art. D4.1.2). Illustrative FY2026 conversions printed in the regs: £170.090m / €198.663m / CHF 189.992m (D4.1.3).

**Race-count / sprint / indexation mechanics.** 2026 base assumes 24 Competitions; +$1.8m per Competition above 24 (D4.1.2.b). Sprints: $300k downward adjustment per sprint beyond 6 (D6.1.1.p). Indexation Rate = weighted average country-specific inflation to 31 Dec of the preceding period, set by Cost Cap Administration (CCA) Determination; an Adjusted Indexation Rate (to 30 June) applies if it exceeds the base by 2%+. Tyre-test days earn a downward adjustment by Determination (D6.1.1.i; ~$200k/day reported in 2021). New for 2026-27: $3m aggregate downward adjustment for 2027/28 PU integration work, allocation declared by 30 Nov 2026 (D6.1.1.q). Consideration Factor (OECD average-wage ratio) lets high-wage jurisdictions discount employee costs up to $250k per Relevant Employee (D6.1.1.o). From FY2027 teams may carry forward an Unused Cost Cap Amount up to $2m (D6.1.1.n).

**What changed in 2026 (verified).** The separate Capital Expenditure Limit ($36m rolling four-year window under Iss 22) is gone; depreciation and amortisation now sit inside Relevant Costs, measured on IAS 16 cost model, zero residual, straight line (D6.1.1.k), with clawback of accelerated depreciation/impairments booked in 2023-25 on assets later used for F1 (D6.1.1.l-m). Catering (track and factory) and Health & Safety became Excluded Costs (D5.1.1.y, z). The minor/material overspend threshold tightened from **5% (Iss 22 Art. 8.3) to 2% (D10.3.1/D10.3.3)**. The press claim that the staff-time split loophole was closed could not be matched to Sec D wording.

**Relevant vs Excluded Costs.** Relevant Costs = Total Costs of the Reporting Group − Excluded Costs ± Adjustments. Excluded (D5.1.1):
(a) Marketing Activities; (b) F1 driver consideration + driver travel; (c) other racing drivers and Academy programme; (d) three highest-paid individuals ("Excluded Persons") incl. employer NI and travel; (e) Heritage Asset Activities; (f) Finance Costs; (g) Corporate Income Tax; (h) Non-F1 Activities (with cost-allocation provisions); (i) HR, Finance and Legal activities; (j) Property Costs; (k) Employee Bonus Costs up to the lower of 20% of Total Fixed Employee Remuneration or the Excluded Bonus Maximum ($14.5m if champion or improved on best of prior 3 years; otherwise $12m); (l) FIA entry fees, super licence fees, Concorde payments to the Commercial Rights Holder; (m) FIA fines; (n) Power Unit Supply Perimeter purchases up to the Section A maximum price; (o) property depreciation and depreciation of assets used exclusively for excluded activities; (p) FX gains/losses; (q) mandatory employer social security; (r) hotel/flight/rail/ground transport for Competitions and testing; (s) alternative fuel/oil development with the PU supplier; (t) FIA-homologated fuel; (u) all-staff entertainment up to $1.2m; (v) parental leave; (w) indefinite sick/disability leave; (x) Sustainability Initiative Costs; (y) Health & Safety; (z) catering at track and factory; (aa) business continuity/disaster recovery up to $1.5m.

**Air/sea freight is inside the cap** (only personnel travel is excluded). Crash damage is inside the cap.

**Reporting Group / periods / deadlines.** Reporting Group = the F1 Team entity plus whichever Legal Group entities are needed to capture ≥98% of F1 Activity costs (D4.2.1). Costs incurred outside the group must be recharged or adjusted in as Related Party Transactions (D4.2.4). Full Year Reporting Period = calendar year. **Full Year Reporting Deadline = 19:00 CET on 31 March** following. **Interim period = 1 Jan-30 Apr; Interim Reporting Deadline = 19:00 CET 30 June.** Full Year Reporting Documentation (D7.1.1) = Reporting Group Documentation + Cost Cap Reporting Template (Total Costs, reconciliation to each entity's Audited Annual Financial Statements, Relevant Costs calculation, disclosure of related-party/exchange/inter-team/PU transactions) + Declarations signed by Team Principal/CEO/CFO/Technical Director (personally sanctionable, D8.11) + an assessment report from the **same Independent Audit Firm that audits the statutory accounts** (D7.1.1.d), known in job ads as the "Cost Cap Agreed Upon Procedures". Teams also file a Used Inventory Incremental List per TD017 (D10.1.2.k). Records kept five periods.

**Review and enforcement.** CCA (Federico Lodi, FIA Single-Seater Financial Regulations Director; grew 4 → 10 FTE by 2023) may engage audit firms, do comparative analysis across teams, site visits, interviews, and Demands for electronic devices (D8.1.3). Submissions run 150-200 pages; review involves about a month of reading, follow-up questions, on-site audits. Outcomes (D8.6.5): Certificate of Compliance; Procedural Breach and/or Minor Overspend (<2%) → Accepted Breach Agreement (ABA) (D8.10) or referral to the Cost Cap Adjudication Panel; Material Overspend (≥2%) or Non-Submission → mandatory referral, mandatory Constructors' points deduction plus fine (D10.3.4, D12.1.1). Late submission → Late Submission Notice, 2 business days to explain (D10.2). Certificate dates: 10 Oct 2022 (FY21), 5 Sep 2023 (FY22), 11 Sep 2024 (FY23), **28 Oct 2025 (FY24, seven-month review)**. FY2025 results not yet announced as of today.

**Red Bull 2021 breach (ABA 26 Oct 2022).** Reported overspend £1,864,000 (1.6%); with correct treatment of a notional tax credit (£1,431,348) the overspend would have been £432,652 (0.37%). Thirteen misstatements:
1. Catering treated as marketing
2. Sick-leave pay for an employee not on indefinite leave
3. Double-offset of Non-F1 costs
4. Bonuses above the exclusion limit
5. Gain on disposal of fixed assets not grossed up
6. Apprenticeship levy / social security
7. Unproven Non-F1 share of social security for mixed staff (item A)
8. Same, item B
9. PU transactions with Honda / Red Bull Powertrains understated at below fair value
10. Used-inventory valuation (parts moved to heritage)
11. Clerical error on RBPT recharges
12. Travel not related to competitions
13. Maintenance costs misallocated to HR/finance/legal
Penalty: $7m fine + 10% cut in wind tunnel and CFD allowances for 12 months.
Sources: https://www.the-race.com/formula-1/the-13-ways-red-bull-got-its-cost-cap-calculation-wrong.md ; https://the-race.com/formula-1/food-parts-and-sick-pay-key-areas-of-fia-red-bull-dispute/

Aston Martin FY21: procedural breach (12 inaccurately accounted costs), $450,000 fine. Williams FY21: late submission, $25,000. Aston Martin FY24: unsigned reporting documents filed by 31 Mar 2025; auditor signature only on 15 Apr; ABA 29 Sep 2025. https://www.autosport.com/f1/news/fia-confirms-all-f1-teams-obliged-with-2024-cost-cap-aston-martin-in-procedural-breach/10772182/

**Related parties / Fair Value.** Any Related Party, Exchange, Inter-Team or Power Unit Transaction is included at the **higher of contracted cost and Fair Value** (IFRS 13) (D6.1.1.a.i); Transferable Components used by a Customer Team are valued per a CCA methodology Determination issued by 30 Nov of the preceding year (D6.1.1.a.ii). Where the group itself makes PUs or Standard Supply Components, Fair Value of what the team consumes must be added (D6.1.1.f). R&D grant/tax-credit income offset against costs must be grossed up (D6.1.1.b), which is the UK R&D tax credit treatment that tripped Red Bull.

**PU cost cap (Section E).** $95m/yr for 2022-25; 2026 onward **$190m** adjusted for Indexation, $148.5m for pre-entry years of a new manufacturer. FY2024: all 5 PU manufacturers compliant.

## 2. Revenue

**FOM prize money (Concorde).** Confidential, reconstructed by The Race: 2024 team payments **$1.266bn** (paid during 2025). Structure: ~5% Ferrari Longstanding Team Payment (~$63.3m), ~20% "previous success" bonus based on top-3 finishes over prior 10 years (~$4.22m/point), ~75% by Constructors' position (1st ~$132.9m to 10th ~$57.9m). Estimated 2025 receipts: Ferrari ~$251m, Mercedes ~$209m, Red Bull ~$183m, McLaren ~$150m, Aston ~$99m, Alpine ~$90m, Haas ~$83m, Racing Bulls ~$74m, Williams ~$70m, Sauber ~$58m. https://www.the-race.com/formula-1/f1-2025-prize-money-split-revealed-mclaren-only-fourth/

Cadence: historically USD on the last business day of each month of the season (nine or ten instalments) with a final true-up (~10%) the following Feb/March once Liberty's audited revenue is known. Whether the 2026 agreement kept this is unverified. 2026 Concorde runs 2026-2030; teams take roughly half of F1 revenue. Cadillac anti-dilution fee **$450m** (some say $500m), split equally among 10 incumbents; payment timing not public.

**Sponsorship.** Team sponsorship market ~$2.0-2.6bn. Title deal estimates: Oracle/Red Bull ~$110m/yr, Aramco/Aston ~$75m, Petronas/Mercedes ~$75-80m. Mercedes 2025: >£415m of £633m turnover from sponsorship/licensing; 24 partners. Invoicing cadence and VIK/barter terms: **not public**, model as contractual assumption. In-kind technical supply is covered by the regs as "Exchange Transactions" valued at Fair Value.

**Technical supply / customer teams.** PU Supply Perimeter must be supplied at a maximum of roughly €20-22m adjusted for Indexation (tracked change in the Sec A text; exact figure uncertain). Press figure for a 2026 Mercedes customer deal: €17m/yr. Customer teams (Haas-Ferrari gearbox/suspension; Williams/McLaren/Alpine-Mercedes PU+gearbox) buy Transferable Components valued via CCA notional values. FIA entry fee (excluded): ~$703k base + ~$7,030/point → McLaren ~$7.7m for 2026.

## 3. Expenditure

Headcount: top teams 1,000-1,500 incl. non-F1 units; Haas ~330; Williams averaged 1,151 in 2025 (949 in 2024), R&D headcount 765, payroll £107.5m, capex £37.4m. ATR sliding scale: baseline 320 wind-tunnel runs and 2,000 CFD items per ~8-week period; 7th place = 100%, champion 70%, last 115%, reset 1 Jan and 1 July. Freight: DHL; teams run 3-4 rotating sets of sea containers; flyaway air freight ~$8-20m/season per team, inside the cap. Crash damage: Williams >$5m at Interlagos 2024 alone (~$7m incl. Las Vegas); a front wing ~$125k, gearbox ~$500k (press). Pirelli: teams historically pay a supply fee (~€2m/yr per 2015 report); current terms not public. Fuel excluded. Part tracking: FIA TD017 Used Inventory lists; Mercedes' SAP system tracks and values >14,500 components per car for FIA reporting. Fixed assets: statutory depreciation now flows into Relevant Costs; wind tunnels/simulators/buildings = Property (excluded) vs plant & equipment (included).

## 4. Corporate structure and public filings

UK, 31 Dec year-ends, Companies House accounts due 9 months later (30 Sept):
- Mercedes-Benz Grand Prix Ltd: thirds Mercedes-Benz / INEOS / Wolff; FY2025 turnover £633.4m, PAT ~£126-133m, dividends £125m.
- McLaren Racing Ltd: FY2024 £530.3m turnover, £54.2m PAT; FY2025 £588.5m, loss £17.4m after loan-note repayment.
- Red Bull Racing Ltd: FY2024 £314.4m, £1.7m; FY2025 £379.6m, £9.4m. Red Bull Technology Ltd is the parent that holds staff and recharges (~50 direct RBR employees). Red Bull Powertrains Ltd under Red Bull GmbH. This is the related-party web.
- Williams Grand Prix Engineering Ltd: FY2024 £179.8m, loss £49.8m; FY2025 £244.0m, loss £25.1m; Dorilton-funded share issues.
- AMR GP Ltd: FY2024 £280.7m, loss £45.8m; FY2025 £344.2m, loss £28.5m; £336.6m loans.
- Alpine Racing Ltd (co. 01806337): FY2025 £287.6m, PAT £8.0m.
- TWG Cadillac Formula 1 Team Ltd: FY2025 loss £121.9m.
Non-UK: Haas Formula LLC (US), Racing Bulls (Italy), Sauber Motorsport AG (Switzerland, Audi), Scuderia Ferrari inside Ferrari N.V.
Companies House Document API serves iXBRL accounts free (API key needed); bulk Free Accounts Data Product: https://download.companieshouse.gov.uk/en_accountsdata.html

## 5. The finance team

Mercedes: CFO Russell Braithwaite reports to Wolff; deputy finance director owns business partnering, budgeting/forecasting and "cost-cap optimisation"; finance now co-decides asset purchases with engineers because of depreciation; income largely USD → FX risk; AI used to interpret regs. https://abmagazine.accaglobal.com/global/articles/2026/may/interview/driving-force.html

Job ads describe the workflow:
- Williams "Senior Financial Regulations Reporting Analyst": monthly cost-cap actuals that need no later amendment, Cost Cap AUP audits, FIA clarification requests, Financial Advisory Committee papers, technical interpretation papers, **fair value assessment schedule**, FRS 102; ERP D365/SAP/Workday. https://careers.williamsf1.com/job/senior-financial-regulations-reporting-analyst-in-grove-wantage-jid-589
- Cadillac "Financial Regulations Analyst": Interim and Full-Year submissions, monthly FIA Financial Report, ERP cost-classification coding.
- Audi/Sauber "Cost Cap Analyst": strategic spend simulations.
- "Assistant Financial Controller – Chassis Cost Cap": evidence packs, transaction compliance testing.
Marko: Red Bull's finance department "expanded significantly" and accountants now gate update scope. Systems: McLaren uses Workday Adaptive Planning; Mercedes moving to SAP Cloud ERP Private.

## 6. Finance-year pressure points

- Jan-Feb: new-car build, heaviest manufacturing spend; 1 Jan ATR reset.
- 31 Mar: Full Year Reporting Documentation (prior year) due 19:00 CET, with auditor AUP sign-off attached.
- Mar-Dec: 24 races; monthly FOM instalments; sponsorship invoicing per contract.
- 30 Apr / 30 Jun: interim period end / Interim Reporting Deadline. 30 Jun: standings fix H2 ATR.
- Jul/Aug: 14-day mandatory shutdown (2026: ~3-17 Aug; finance/marketing/legal may continue); CCA review runs through summer.
- Sep-Oct: Certificates/ABAs; 30 Sep Companies House deadline; FOM true-up for prior year lands Feb/Mar.
- 31 Oct: CCA publishes Consideration Factor; 30 Nov: Transferable Component methodology and PU-integration declarations.
- Nov-Dec: crash-damage squeeze on remaining cap; press-reported option to borrow from next year's cap at a 2x penalty (regulatory basis not located).

**Unverified:** exact 2026 PU max supply price; sponsorship payment cadence and VIK terms; current FOM instalment schedule; Pirelli terms; Cadillac fee timing; the "2x borrowing" mechanism; FY2025 compliance results.
