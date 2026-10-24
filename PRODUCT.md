# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Head of Cost Cap** at a Formula 1 constructor: approves every house policy and every material cost cap adjustment, owns the FIA cost cap submission.
- **Financial Controller** (Dana Okafor in the demo): approves proposals below materiality, answers the agents' questions, approves parked revenue entries under $1M.
- **CFO** (Priya Raman): second approver for revenue entries at or above $1M.
- **Hackathon judges** (Cal Hacks 13.0, Hyphenate track) watching a three-minute demo: the overview must open the story.

## Product Purpose

Pit Wall is the finance desk of Meridian Racing, a fictional F1 constructor. Two AI seats do the work and humans approve what matters:

- the **revenue accountant** books sponsor fees, performance bonuses and prize money from real F1 results and real FIA documents, through one write path that a deterministic kernel (K1 to K12) re-checks;
- the **cost cap analyst** classifies every cost line under the FIA Financial Regulations against the $215m cap, under house policies a Policy Learner drafted from last year's books and a human approved.

Success: a reviewer can see, for any number, who decided it, under which rule, on what evidence, and who approved it, and the humans spend their time only on what the agents could not settle.

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

- Name: **Pit Wall**. Company: **Meridian Racing** (synthetic). Sponsors: Halcyon Energy (title), Volta Telecom, Arcadia Watches, Northwind Cloud, Ridgeline Logistics.
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
