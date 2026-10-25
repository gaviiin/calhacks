# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Race day is the product; the desks behind it are where its entries land.

- **CFO**: reads the Sunday-night brief, approves the sealed weekend before any brief goes out, second approver for revenue entries at or above $1M.
- **Head of Cost Cap**: owns the cap position and the FIA submission; sees every race-day entry with when the cap counts it; approves house policies and material adjustments.
- **Team Principal**: decides what is outward-facing or irreversible on race day (withdrawing a car, FIA notices).
- **Chief of Staff**: approves the team's reaction to an incident as a whole (the response plan: spares, work orders, freight, the entries) in one click; after that the agent executes every line the team has a precedent for and brings only novel lines to a person.
- **Chief Mechanic**: answers the damage question in one click (two cases the team has lived through), which settles the crash lines and teaches the desk.
- **Technical Director / Head of Logistics**: work orders, spares and freight against the next event.
- **Financial Controller**: approves proposals below materiality on the desks behind Books.
- **Hackathon judges** (Cal Hacks 13.0, Hyphenate track) watching a three-minute demo: Race day must open the story.

## Product Purpose

Pit Wall is an autonomous race accountant for a Formula 1 team: **it keeps the books in step with the car.** Every lap, every trip off the track and every crash changes what each part has left; the agent turns that into entries, cost cap timing, spares and a cap forecast within milliseconds of the data, and people approve only what is material.

The job exists at every team, and crashes are its biggest swing in the season (Williams 2024: crash damage squeezed the cap, the FIA refused relief, development moved into the next year). The demo is Williams at the 2024 São Paulo Grand Prix, led by Albon's 315 km/h qualifying crash.

Three twists, in this order:

1. **The car is the ledger.** Each part on each car has a life: laps use it, stress events use it (Jev classifies how hard a contact or a trip off the track hit and which parts), crashes destroy it. Wear is never booked (the cap excludes depreciation); it sets when each replacement is fitted, which is when its cost counts, and flags a power unit or gearbox past its allocation as a grid penalty.
2. **The books keep themselves.** Balanced entries with when the cap counts each line, inventory moves, accruals, adjustments once the garage confirms, ERP postings, the evidence pack, the seal and the true-up. People answer a damage question when Jev is unsure, make the racing calls (priced, never recommended) and approve each crash's response plan in one click; the books then post on precedent, not on amount: a line like one the team has booked before posts on its own, a line with no precedent waits for the Head of Cost Cap.
3. **Milliseconds.** Every event is costed in about a millisecond, so the numbers are never stale when someone decides; telemetry sees a crash seconds before race control.

After an incident the dashboard follows it in seven steps: seen, hardware, engineering call, race call, next steps, books, season. Race-day numbers are provisional: the weekend is sealed on Sunday night and briefed once the CFO approves, and the true-up against actuals weeks later recalibrates the price book.

Success: a judge sees the car change, the books follow without a person, and one click where a person is needed; any number traces to the event, the part and the rule or person behind it.

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
- Visual identity: race day uses the Williams garage palette (white and grays, Williams blue for a person or the primary action, navy ink), asked for by the user on Oct 25; the landing page (`landing/`) keeps its near-black ground. Type: Barlow Condensed, DM Sans, IBM Plex Mono.

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
