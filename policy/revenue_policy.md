# Meridian Racing: Revenue Recognition Policy Book

> SYNTHETIC. Simplified policies written for the Pit Wall hackathon project. Not audited, not real ASC 606 guidance.
> Every decision cites the policy IDs below. The kernel enforces them in code (`finance/kernel.py`).

Functional currency: **USD**. All ledger amounts are integer cents.

## Materiality
A journal entry or estimate change of **$250,000** or more parks for the controller when it is:
(a) a reversal, (b) a change in an estimate, (c) prepared by an agent rather than by code, or (d) a billing approval at an amount that differs from what was requested.
Above **$1,000,000** it also needs the CFO.
Routine entries that the kernel re-performs exactly from the cited contract, result and rate (base fee shares, bonuses from final results under unambiguous clauses, pro-rata prize accrual at an unchanged estimate, cash receipts) post without approval.

## REV-01: Sponsor base fee
The annual base fee is recognized evenly across the season's Grand Prix rounds: one equal share on each race date, with any rounding remainder in the final round. Sponsors are invoiced quarterly for the shares earned that quarter.

Entry per round: Dr 1200 Accounts receivable / Cr 4000 Sponsorship revenue: base

## REV-02: Sponsor performance bonus
A bonus is earned only when the triggering result is **final**. It is recognized when the FIA publishes the Final Race (or Sprint) Classification.

Entry: Dr 1300 Accrued bonus revenue / Cr 4010 Sponsorship revenue: performance bonuses

### REV-02a: Provisional results and later decisions
A result is provisional from the race until the FIA publishes the Final Classification. While a result is provisional, no bonus revenue is recognized and no bonus is billed; expected bonuses are recorded as memos only. A summons or infringement concerning a Meridian car marks the affected expected bonuses as at risk. A decision that changes a result after the Final Classification (for example, after a right of review) is reversed in the current open period, with a reference to the original entry.

Reversal: Dr 4010 / Cr 1300 if not yet billed, or Cr 1200 (credit note) if billed.

## REV-03: Championship prize money
Prize money depends on the final constructors' championship position and is variable consideration. After each Grand Prix becomes final:
1. Estimated position = current constructors' championship position.
2. Constraint: if the points gap to the team directly behind is under 10, use one position worse. Once every round is final, the actual position is used.
3. Estimated total = prize table amount for that position.
4. Cumulative revenue = estimated total x (Grand Prix rounds final / Grand Prix rounds in season), to the cent.
5. Book the difference from the cumulative amount booked so far, split into the routine accrual at the previous estimate and the estimate change.

Entry (increase): Dr 1250 Prize money receivable / Cr 4100 Championship prize money revenue. Decrease: the reverse.

## REV-04: Contract amendments
Amendments apply from their effective round. Revenue already recognized is not restated unless the amendment says so.

## REV-05: Foreign currency
EUR and GBP amounts are translated to USD at the rate for the recognition date (`world/fx_rates.csv`). Receivables keep that carrying amount. The difference between the carrying amount and the USD actually received is realized FX (7100).

## REV-06: Sprint races
A sprint result counts toward a bonus clause **only** if the clause explicitly says sprint races are included. If a clause is silent, the first case is escalated to the controller, and the controller's ruling may become a standing rule.

## REV-07: Billing review
Every bonus billing request from the commercial team is checked before an invoice is issued:
- the result is final (otherwise **hold**);
- the bonus was earned under the final result and the contract version in effect (otherwise **reject**);
- it has not already been billed (otherwise **reject** as a duplicate);
- the amount matches the contract (otherwise **approve at the contract amount** and tell the requester).
An approved request moves the bonus from accrued revenue to receivables at its carrying amount: Dr 1200 / Cr 1300.

## REV-08: Period close
Each month is closed after its last day. Closed periods accept no entries; corrections post in the current open period.

## Chart of accounts

| Account | Name |
| --- | --- |
| 1000 | Cash (USD) |
| 1200 | Accounts receivable: sponsors |
| 1250 | Prize money receivable (contract asset) |
| 1300 | Accrued bonus revenue (contract asset) |
| 4000 | Sponsorship revenue: base |
| 4010 | Sponsorship revenue: performance bonuses |
| 4100 | Championship prize money revenue |
| 7100 | Realized FX gain/loss |
