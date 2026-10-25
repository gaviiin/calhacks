# Runs

Every end-to-end run of the cost cap desk, newest first, and the revenue desk's season scores. The cost side's company was renamed from Kestrel Grand Prix to Meridian Racing on Oct 24 (names only: the truth file and every amount are unchanged), so runs before that name Kestrel.

## Cost cap desk, January 2026, people decide only what no rule covers, Oct 24 (run 3)

Same pipeline and model, after the flow change: an approved policy carries standing approval, the standing-approval job (`make standing`) approves what policies decided at any amount, and a person sees only the lines no rule covered.

| Measure | Result |
|---|---|
| Policies drafted from 2025 history, approved by the Head of Cost Cap | 96 (Claude vetoed 3 of 85 parent drafts) |
| January lines approved without a person, under an approved policy | 260 of 285, material lines included; 0 refused by the module |
| Lines brought to a person | 25: 22 new scenarios Claude drafted, 3 questions (run 2: 43 waited, and the Controller approved 240 routine lines by hand) |
| Proposals matching the truth file | 275 of 282 (97.5%); code 257/260, Claude 18/22 |
| Dollars on the wrong side of the cap | $108k of $30.6m (run 2: $713k; Claude asked about the $636k Applied Technologies payroll this time) |
| One correction, taught in the dashboard | the Head of Cost Cap rejected Claude's Property call on Cherwell Building Maintenance (account 6730) as Relevant and ticked Remember: rule `taught:6730\|ven-025` was born approved, the second Cherwell line went back to the analyst, both were re-proposed under the rule, approved without a person and posted |
| After that one correction | 277 of 282 (98.2%); $55.5k on the wrong side of the cap |
| Red-team probes denied and logged | 15 of 15 (three new: the standing-approval job approving a Claude proposal, a controller teaching beyond materiality, the analyst teaching itself a rule) |

## Cost cap desk, January 2026, online with Claude (claude-opus-5-5), Oct 24

Two full runs from a fresh module, `make cost-cap-run` with `ANTHROPIC_API_KEY` set. The Policy Learner's reviews run eight at a time (60 s instead of about 35 min sequentially); the Cap Analyst calls Claude only for lines no approved policy covers.

| Measure | Run 1 | Run 2 (merged branch) |
|---|---|---|
| Policies drafted from 2025 history, approved by the Head of Cost Cap | 97 | 92 |
| Parent drafts Claude vetoed as too broad | 2 of 85 | 4 of 85 |
| January lines covered by an approved policy | 260 of 285 (91.2%) | 258 of 285 (90.5%) |
| Proposals, and asks instead of guesses | 282 and 3 | 280 and 5 |
| Proposals matching the truth file | 275 (97.5%) | 274 (97.9%) |
| Decided by code under a policy, right | 257 of 260 | 255 of 258 |
| Decided by Claude, right | 18 of 22 | 19 of 22 |
| Dollars on the wrong side of the cap | $717k of $31.3m | $713k of $31.2m |
| Routine proposals approved by the Controller and posted, all balanced | 242 | 240 |
| Red-team probes denied and logged | 12 of 12 | 12 of 12 |

What Claude got wrong, both runs: the Applied Technologies payroll (P45, $636k and $51k). 2025 practice split it 60/40 Relevant/Non-F1, and the 2026 rule allows a salary share only for power unit supply, customer team support, FIA projects or standard supply components, so the whole line is Relevant; Claude excluded it as Non-F1 work, said the Controller should confirm no F1 staff were on the payroll, and the module routed it to the Head of Cost Cap on materiality. The deterministic misses are the three known ones (two Health and Safety lines, one 2025 canteen invoice).

Before the reviewer was shown the invoice a bill line sits on and the exception rules under a policy, Claude vetoed 34 of 85 drafts: a "Carriage, packaging & handling" line billed with the goods looked like a different activity, and the 73-77% consistency of the catering and hospitality accounts looked mixed without their exceptions in view. With that context it vetoes 2 to 4, and the remaining vetoes are real judgment calls (equipment maintenance on the building maintenance account, partner hospitality flights on the competition travel account).

## Revenue desk, 2024 season, online (PITWALL_AGENT=claude), Oct 24

| Measure | Result |
|---|---|
| Sponsor bonuses due, booked correctly | 90 of 90 (full season); 52 of 52 through the Belgian Grand Prix |
| Trial balance | ties |
| Kept off invoices because the result was later overturned | $3.74m |
| Decisions routed to code, to Claude | 473, 2 |
| Model cost for the season | 0.35 cents |
| Independent auditor (finance/audit), run to round 14 | unmodified opinion, 0 findings over 199 entries |

## Third end-to-end run, January 2026, offline, after Tier 1 (Oct 24)

Tier 1 added allocations, category limits and policies as Ripple-Down Rules. The simulated company also gained 2025 bill-line history and had four misreadings of the regulations corrected in its truth file (bonuses, mixed staff, building maintenance, Health and Safety under Issue 22). Those corrections alone move about $16m into the cap: Meridian's January-November Relevant Costs are now $209.5m against a $215m cap, so the full year is on track to breach.

| Measure | Result |
|---|---|
| Policies drafted from 2025 history | 101, of which 16 are learned exceptions (100 approved, 1 rejected) |
| January lines covered | 262 of 285 (91.9%) |
| Proposals matching the truth file, allocations included | 261, 98.9% |
| Dollars put on the wrong side of the cap | $22,757 of $26.5m proposed |
| Demo hospitality invoice (P01) | Split three ways, exact to the cent: canteen excluded as catering, sponsor dinner as marketing, offsite engineering lunch inside the cap |
| Lines asked about instead of guessed | 24 |
| Lines posted, all balanced | 261 |
| Red-team probes denied and logged | 10 of 10 |
| Tests passing: Python, module | 328, 135 |

The three misses: two Health and Safety compliance lines mapped to HR_FINANCE_LEGAL (both excluded, so no cap effect; 2026 gives Health and Safety its own exclusion and the rule-version map doesn't yet carry that over), and one 2025 canteen invoice arriving in January, which belongs to 2025's rules.

## Second end-to-end run, January 2026, offline, after the Tier 0 fixes (Oct 24)

| Measure | Result |
|---|---|
| Policies drafted from 2025 history | 100 (99 approved, 1 rejected: "Fuel & lubricants" over-reached) |
| January lines covered by a drafted policy | 257 of 285 (90.2%) |
| Analyst proposals, and share matching the truth file | 248, 96.0% |
| Lines the analyst asked about instead of guessing | 37, of which 8 came from the new duplicate, bank-detail, lookalike and split pre-checks |
| Proposals denied to the controller on materiality, then approved by the Head of Cost Cap | 16 |
| Lines posted to the ERP mock, all balanced, cap effects booked | 248 |
| Red-team probes denied and logged | 10 of 10 |
| Agent steps recorded | 3,077 |
| Tests passing: Python, module | 268, 100 |

The ten defects from `research/review/00-review.md` Tier 0 are fixed, each with the red team's reproduction inverted into a regression test. The ten remaining misses are the same as before and are Tier 1 work: split invoices (the demo hospitality invoice among them), policies that still cover their own learned exceptions, and payroll on-costs absorbed by department policies.

The misses are listed in `SCHEMA.md` section 9. The demo hospitality invoice is one of them: split invoices aren't supported yet.

