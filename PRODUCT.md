# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Race day is the product; the desks behind it are where its entries land.

- **CFO**: reads the Sunday-night brief, approves the sealed weekend before any brief goes out, second approver for revenue entries at or above $1M.
- **Head of Cost Cap**: owns the cap position and the FIA submission; sees every race-day entry with when the cap counts it; approves house policies and material adjustments.
- **Team Principal**: decides what is outward-facing or irreversible on race day (withdrawing a car, FIA notices).
- **Chief Mechanic**: answers the damage question in one click (two cases the team has lived through), which settles the crash lines and teaches the desk.
- **Technical Director / Head of Logistics**: work orders, spares and freight against the next event.
- **Financial Controller**: approves proposals below materiality on the desks behind Books.
- **Hackathon judges** (Cal Hacks 13.0, Hyphenate track) watching a three-minute demo: Race day must open the story.

## Product Purpose

Pit Wall is race-day finance for a Formula 1 team. The demo is Williams at the 2024 São Paulo Grand Prix: three crashes in one Sunday, a car that did not start, no points, and a fall from P8 to P9 in the constructors' championship. From the moment a car stops to the CFO's brief, in seven stages:

1. **Detect**: a telemetry tripwire sees our car stop seconds before the red flag, and minutes before race control (which sometimes never names the car).
2. **Log**: one incident per crash whose belief evolves as evidence arrives, versioned as what we believed when.
3. **Respond**: the playbook learned from the team's own history reserves spares, raises work orders against the next event, drafts the FIA paperwork, and prices the decision to withdraw a car; anything outward-facing waits for the person who owns it.
4. **Account**: balanced provisional entries, each saying when the cost cap counts it (a spare when fitted, a destroyed part already counted when first used, a fine never).
5. **Ask**: a person is asked only when a wrong call would cost more than the question, and the answer is a choice between two cases the team has lived through.
6. **Re-plan**: the rest of the season and the cap re-run after every change: the chance of holding P8, the prize money at stake and how much of it our crashes cost versus rivals' results, next year's aero-testing allowance, and how much development must move into next year to stay under the cap.
7. **Close**: the weekend is sealed under one hash and briefed to each role; actuals true it up later and recalibrate the price book.

Success: on race day a reviewer can see, for any number, which stage produced it, from what evidence, under which learned rule or which person's answer; people spend their time only on what the desk could not settle.

The two desks behind Books keep their own story: the **revenue accountant** books sponsor fees, bonuses and prize money through one write path a deterministic kernel re-checks (K1 to K12), and the **cost cap analyst** classifies every cost line under the FIA Financial Regulations, under house policies a Policy Learner drafted from last year's books.

## Positioning

The agents never post on their own authority. Every proposal carries its regulation text, policy and version, precedents and evidence; separation of duties and materiality are enforced in the database (SpacetimeDB reducers and the revenue kernel), and denied attempts are logged next to allowed ones. The rulebook is shared by every team; the company-specific part is learned from history, not configured.

## Operating Context

- Month-end close and race weekends. FIA documents (stewards' decisions, classifications) arrive during a weekend and can reverse a booked bonus.
- The cost side works the 2026 cap year (2025 history learned at onboarding); the revenue side replays the real 2023 (training) and 2024 (test) seasons.
- Approvals also arrive by Slack, email, Teams and SMS on the revenue side.

## Capabilities and Constraints

- Live data: SpacetimeDB 2.13 on :3000 with two databases, `cost-cap-desk` (work items, policies, allocations, audit log, agent steps, cap position, roles) and `pit-wall` (FIA documents, decision extracts, the revenue ledger mirror). Revenue desk REST API on :8000 (runs, queue, approve, timeline, scorecard, auditor, impact).
- People take a seat (Head of Cost Cap, Controller) by claiming a one-time invite code with the browser's own identity; the module enforces what that seat may do.
- Money in USD minor units on the cost side, cents on the revenue side.

## Brand Commitments

- Name: **Pit Wall**. Race day: **Williams Racing**, from public data only (OpenF1 timing and telemetry, Jolpica results, press figures with sources); not affiliated. People appear by role. The desks behind Books: **Meridian Racing** (synthetic), sponsors Halcyon Energy (title), Volta Telecom, Arcadia Watches, Northwind Cloud, Ridgeline Logistics.
- Visual identity: the landing page's (`landing/`), confirmed by the user on Oct 24: near-black ground, lime accent, Barlow Condensed, DM Sans, IBM Plex Mono.

## Evidence on Hand

- Real: 200 FIA documents captured by Apify (`ingestion/captures/`), Jolpica-F1 results for 2023 and 2024, the FIA Financial Regulations text (`research/fia/`), the 2024 Spa disqualification decision (Doc 44).
- Synthetic: the company, its ledgers, vendors, contracts, sponsors and people. Live run of Oct 24: 97 policies approved, 282 of 285 January lines proposed, 275 matching the truth file, 242 posted, 12 of 12 red-team probes denied; revenue 2024 season 90 of 90 bonuses correct.
- Absent: real customer quotes, real team data, production deployment. Do not invent them.

## Product Principles

1. Code and agents do the accounting; a person sees a line only when no approved rule covers it, and one decision teaches the rule.
2. Show the why next to the number, without a click when possible.
3. A denied attempt is shown, not hidden.
4. Materiality picks which person decides, never whether one is needed; every decision is logged for review after the fact.

## Accessibility & Inclusion

Status is never color alone (icon and label); numbers keep tabular figures; the dashboard works at phone width for an approver away from the desk.
