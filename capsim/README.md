# capsim: the cost cap strategy simulator

It's late October. Meridian Racing has closed its books through September and has eight races to go. The Team Principal wants one more upgrade. The CFO asks the question every team asks at this point in the season:

> Where will we land on 31 December? How likely is a breach? And is it worth going over?

`capsim` answers it. It runs thousands of simulated ends of season, each with its own crashes, upgrade overruns and freight bills, and classifies every outcome with the FIA's own rules. It then weighs a decision: the prize money the upgrade could win against what a breach would cost.

It sits beside the Cost Cap Desk seat. Cost Cap Desk decides whether each invoice line is inside the cap. `capsim` takes its ledger as actuals to date (`--source cost_cap_desk`) and looks forward.

## Run it

```bash
python -m capsim rules                          # the 2026 rules used, with article numbers
python -m capsim forecast                       # Meridian, books closed through September
python -m capsim decide --option U5             # bring the final upgrade?
python -m capsim decide --option U5 --pu 3000000   # with all of the PU adjustment in 2026 (default 1.5m)
python -m capsim pu --include U5                # split the USD 3m PU-integration adjustment
python -m capsim headroom --target 0.10         # most extra spend at <= 10% breach risk
python -m capsim forecast --source cost_cap_desk --as-of 11   # the Cost Cap Desk seat's ledger
```

HTTP (mounted in `finance.api`): `GET /api/capsim/rules | plan | sources`, `POST /api/capsim/forecast | decide | headroom | pu-allocation`.

## What it shows (default illustrative scenario, 4,000 seasons)

Meridian's question: bring the USD 2.4m final package to Mexico City or not? The answer depends on a declaration due in five weeks.

D6.1.1.q.i gives every team a **mandatory** USD 3m downward adjustment, split between 2026 and 2027 as the team chooses. The split must be declared by **30 November 2026**. If nothing is declared, it is 1.5m/1.5m and can't be changed.

| PU split declared (2026 / 2027) | P(breach) without the package | With it | P(material) with it | Expected net of bringing it | Verdict |
| --- | --- | --- | --- | --- | --- |
| 0 / 3m | about 8% | about 46% | about 2.5% | about -$1.0m | **don't**: material risk above the 1% limit |
| 1.5m / 1.5m (undeclared default) | about 3% | about 17% | about 0.8% | about +$0.9m | do it, but marginal |
| 3m / 0 | about 1% | about 6% | about 0.3% | about +$1.6m | **do it**, and 2027 gets 1.5m less adjustment |

"Expected net" is prize money gained, minus expected fines, minus the next-year cost of a testing restriction. The fine and testing-restriction parts are assumptions (see below). The 1% limit on material risk is a policy setting (`max_material_risk`), not a rule.

## Regulation vs assumption

**Rules (`regulations.py`): exact, cited, tested word for word against the FIA text.** Source: 2026 F1 Regulations Section D Issue 08 (1 Oct 2026), with Issue 22 (2021-25) for comparison.

- Cap: USD 215m when there are 24 Competitions or fewer (D4.1.2.a). 2026 has 23 rounds (Saudi Arabia cancelled; the Bahrain GP was held at Sepang), so the cap doesn't move. Under the 2021-25 rules it would have dropped by USD 1.8m for each race below 21.
- Sprints: USD 300k downward adjustment only for each sprint beyond six (D6.1.1.p). 2026 has six, so there is no adjustment. In 2021-25 every sprint earned the USD 300k.
- Overspend under 2% is minor (D10.3.1). 2% or more, i.e. from USD 219.3m, is material (D10.3.3). The 2021-25 threshold was 5%.
- Minor overspend: a fine **shall** be imposed (D10.3.2). Under ISS22 8.11 it **may** be.
- Material overspend: a Constructors' points deduction **shall** be imposed, plus a fine (D10.3.4). The points come off the championship of the year of the breach (D12.1.1.c.i).
- Fines are set case by case (D12.1.1.a). Fines are Excluded Costs (D5.1.1.m), so paying one doesn't use cap. A cap reduction applies to the full year after the sanction is imposed (D12.1.1.b.vi, c.vii).
- From FY2027 a team may carry unused cap forward, up to USD 2m adjusted for Indexation (D6.1.1.n). The amount is zero if the CCA's review of the prior year, or an investigation into it, isn't finished by 30 November.
- PU integration: a mandatory USD 3m across 2026 and 2027, declared by 30 Nov 2026, defaulting to 50:50 (D6.1.1.q.i-ii). A second USD 3m covers 2027 and 2028, declared by 30 Nov 2027 (q.iii-iv).
- Under Issue 22, a race cancelled less than three months before its date counted as having taken place (2.3). Section D has no such rule, and with 24 races or fewer it wouldn't matter anyway.

**Assumptions (`assumptions.py`): labelled, editable, echoed in every result.**

- **Fine size.** Only one overspend has ever been sanctioned: Red Bull FY2021, a £1.864m overspend fined USD 7m (about 2.7-3.3x the overspend, depending on the exchange rate) plus a 10% cut in aero testing for 12 months. That is the default calibration. No material overspend has ever been sanctioned, so the points deduction size (default 40) is a pure scenario input.
- **Crash damage.** About USD 4.5m a season for a typical team, calibrated on F1Maximaal's 2024 estimates (€2.3m to €13.8m per team) and Vowles's "a million" per wall hit.
- **Meridian's budget, spend so far, upgrades, the constructors' fight around it, and the prize table** are illustrative.

`GET /api/capsim/sources` lists every source.

## How the simulation works

1. Closed months are fact: Meridian's actuals, or Cost Cap Desk's `truth_2026.csv`.
2. For each remaining month and race it simulates:
   - payroll and overheads, with small noise;
   - manufacturing and aero, per plan;
   - race operations and freight;
   - crash damage, as a Poisson count of incidents times a severity mix;
   - every upgrade still to land, with a lognormal overrun.
3. It subtracts the adjustments (sprints, tyre tests, PU integration) and classifies the result with `regulations.classify`.
4. For a decision, both arms see **the same simulated seasons**: same crashes, same overruns. The only difference between them is the decision itself.

## Tests

`python -m pytest capsim/tests` runs 21 tests. They cover:
- every boundary: exactly the cap, one dollar over, the 2% line (compared exactly, never after rounding);
- calendar and plan arithmetic;
- determinism, run-by-run pairing, and the PU adjustment moving every run by exactly USD 3m;
- decision logic, the Cost Cap Desk adapter and the API;
- every regulation quote found verbatim in the FIA text. This one runs when `research/fia/` is present (it's on the cost-cap-desk branch) or `CAPSIM_REG_TEXT` points at it.
