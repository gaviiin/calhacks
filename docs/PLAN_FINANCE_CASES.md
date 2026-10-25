# Pit Wall Live: from race analytics to an accountable finance employee

Plan written 2026-10-25 from the Hyphenate product review. Everything that already works stays:
the OpenF1 replay, Jev routing, the contract calculator, the SpacetimeDB publisher, the SSE API,
the dashboard data layer. What changes is what the system *does* with an event, and what the page
leads with.

## Principles the review set, now rules of the code

1. **Four kinds of money, never mixed:** provisional sponsor payout (current-position scenario),
   potential incident exposure (unknown until evidence), forecast relevant costs (cost cap), and
   recognized entries (the revenue desk's books). Labels say which; nothing hypothetical reads as
   booked or lost.
2. **No look-ahead.** Post-race sources are not live evidence. A crash is corroborated live from the
   timing feed (the car does not take the restart); the race report is attached as a post-race
   reference only.
3. **Feasibility before recommendation.** A stopped car cannot "continue"; repair needs engineering
   clearance; a red-flag stop saves track position, not money, and proves nothing about repairability.
   Infeasible outcomes are removed from the advisor's table, not offered.
4. **Team scope is a permission.** Our car damaged: a crash-finance case with garage and cost-cap
   access. A competitor damaged: our projections move; no access to their books, no cost-cap request.
5. **Jev routes; it never spends.** Route confidence is not permission. Agents complete what evidence
   and authority allow; everything else is an explicit escalation with the work so far attached.
6. **Separation of duties.** An agent never approves a restricted action; engineering clears
   feasibility, the controller authorizes spend, and the same person cannot do both.
7. **Measured proof only.** The scorecard is generated from test runs; no number on it is typed in.

## The customer for the crash demo

Meridian Racing keeps mirroring Mercedes for the championship-money story. For the crash case the
replay can run as **"Meridian as a Williams-mirror"** (`team=williams`): the same synthetic
contracts and people, applied to cars 43 and 23. Car 43's lap-32 crash is then an own-team incident
with the full workflow; Mercedes' cars become competitors whose results only move our projections.
Run as Mercedes, the same crash is a competitor event and the only own-team incident is Hamilton's
lap-33 contact, the adversarial case that must close without a repair bill.

## Milestones

### M1 Financial correctness (P0)
- Pit-stop scenario text names the clause changes (including the other team car moving up), so
  "P5 to P12 costs $150k" is explained: top-six lost, points lost, the sister car's point gained.
- Relabel: current-position bonus scenario; change from the highest provisional scenario;
  provisional sponsor payout; estimated immediate position-related bonus change; unconfirmed
  incident exposure.
- Corroboration from the feed: a car that does not take the restart within a grace period is
  `retired_from_timing`; the race report becomes a post-race reference with its real availability.
- Feasibility gate on scenarios: `feasible`, `requires` (engineering_clearance, stewards), `why`;
  the advisor sees only feasible rows; a stopped car's table is retire / repair-if-cleared / DSQ.

### M2 Team scope (P0)
- `team` parameter on the replay (`mercedes` default, `williams` for the crash case); the world's
  team cars follow it; contracts are the same synthetic set.
- Incident scope: `own_team` or `competitor`; competitor incidents never create a cost-cap hand-off
  or a garage request; their plan shows only our projection change.

### M3 Financial cases (P0)
- `live_racing/cases.py`: a persistent case per material incident with states
  `detected → investigating → awaiting_evidence → evaluated → awaiting_approval → authorized →
  reconciling → closed | rejected`, stable ids, provenance, timestamps, owner, decision log,
  next action, missing evidence, permissions, every transition appended to JSONL and published.
- Agents act automatically where allowed: create the case, gather sporting evidence, request the
  garage report (own team only), price supported scenarios, evaluate the garage options under the
  cost cap (parts are Relevant Costs; headroom read from the cost-cap desk when reachable),
  recommend, prepare a mock procurement order once authorized, reconcile the invoice, close.
- Escalations with reasons: missing or contradictory evidence, feasibility unconfirmed, ambiguous
  FIA treatment, authority exceeded, invoice outside tolerance.
- API: `GET /live/cases`, `POST /live/cases/{id}/garage-report` (synthetic, labelled),
  `POST /live/cases/{id}/approve` (role engineering | controller; agent and self-approval refused),
  `POST /live/cases/{id}/invoice` (synthetic; matched within tolerance or escalated).

### M4 One complete demo (P0)
- Williams-mirror replay of laps 28–34: crash → case → garage report (synthetic: replace $400k or
  repair $130k) → cost-cap evaluation → recommendation (repair, if engineering clears it) →
  engineering clearance and controller authorization from the page → procurement order →
  synthetic invoice → reconciled → closed with the audit trail.
- Adversarial case: Hamilton's lap-33 contact (as Mercedes): investigated, car running, stewards
  no further action, no damage reported → closed, no expense invented.
- A demo scheduler (`demo_mode=true` on the replay) that delivers the synthetic garage report and
  invoice at replay offsets, each labelled synthetic.

### M5 Dashboard redesign (P0)
- Above the fold: the active financial case (what happened, how much might be affected, what the
  agents are doing, what needs approval), case progress stages, next autonomous action, approval
  buttons for the seat, the agent operations timeline.
- Compact Jev reflex monitor with an expandable inspector (probabilities, input hash, latency).
- Money card relabelled; race intelligence (clock, cars, conditions, story) as supporting views.
- Scorecard panel from the generated file.

### M6 Measured proof (P1)
- `scripts/live_scorecard.py`: Jev routing on the labeled cases (offline mock and, with a key,
  live), the contract calculator against the hidden expectations in the tests, escalation
  correctness on the two demo cases, unauthorized-action count from the approval guards, event to
  decision latency, cases completed, reconciliation accuracy; written to
  `live_racing/out/scorecard.json` and shown on the page.

### Not now (P2)
- A calibrated race-strategy or finish-probability model. Until one exists and is validated, the
  page shows only the current-position scenario and recognized outcomes.
