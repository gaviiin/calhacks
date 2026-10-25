"""Cost cap strategy simulator, from the terminal.

    python -m capsim rules
    python -m capsim forecast                      # Meridian, books closed through September
    python -m capsim forecast --include U5          # with the proposed final upgrade
    python -m capsim decide --option U5             # should we bring it?
    python -m capsim decide --option U5 --pu 3000000
    python -m capsim headroom --target 0.10
    python -m capsim pu --include U5                # split of the D6.1.1.q USD 3m between 2026 and 2027
    python -m capsim forecast --source cost_cap_desk --as-of 11   # the Cost Cap Desk seat's ledger
"""

from __future__ import annotations

import argparse

from . import regulations as R
from .assumptions import Assumptions
from .decide import Option, evaluate, headroom, pu_allocation
from .sim import Scenario, forecast
from .sources import load


def usd(x: float) -> str:
    return f"{'-' if x < 0 else ''}${abs(x) / 1e6:,.2f}m"


def main() -> None:
    ap = argparse.ArgumentParser(prog="capsim")
    ap.add_argument("cmd", choices=["rules", "forecast", "decide", "headroom", "pu"])
    ap.add_argument("--as-of", type=int, default=9, help="last closed month (default 9 = September)")
    ap.add_argument("--source", default="meridian", choices=["meridian", "cost_cap_desk"])
    ap.add_argument("--include", nargs="*", default=[])
    ap.add_argument("--pu", type=int, default=R.PU_INTEGRATION_DEFAULT_2026,
                    help="USD of the mandatory D6.1.1.q.i USD 3m put in 2026 (default 1.5m, the split if nothing is declared)")
    ap.add_argument("--option", default="U5")
    ap.add_argument("--points-per-race", type=float, default=2.0)
    ap.add_argument("--target", type=float, default=0.10)
    ap.add_argument("--runs", type=int, default=4000)
    args = ap.parse_args()
    a = Assumptions(runs=args.runs)

    if args.cmd == "rules":
        cap = R.cost_cap(2026, 23)
        print(f"2026 Cost Cap: {usd(cap)} (D4.1.2.a; 23 rounds, 6 sprints: no adjustment)")
        print(f"Material overspend from {usd(R.classify(2026, cap, cap).material_line)} (2% over, D10.3.3)")
        for k, p in R.SECD_ISS08.provisions.items():
            print(f"  {p.article:<36} {p.says}")
        return

    plan, act, meta = load(args.source, args.as_of)
    sc = Scenario(args.as_of, act, set(args.include), args.pu, label="cli")
    if args.cmd == "forecast":
        f = forecast(plan, sc, a)
        rc, pr = f["relevant_costs"], f["probability"]
        print(f"{meta['note']}; actuals through month {args.as_of}: {usd(f['actuals_to_date'])}")
        print(f"Cap {usd(f['cap'])}  material line {usd(f['material_line'])}  adjustments {usd(f['adjustments']['total'])}")
        print(f"Year-end Relevant Costs: p5 {usd(rc['p5'])}  median {usd(rc['p50'])}  p95 {usd(rc['p95'])}")
        print(f"P(compliant) {pr['compliant']:.1%}  P(minor overspend) {pr['minor_overspend']:.1%}  P(material) {pr['material_overspend']:.1%}")
        print(f"Headroom at p95: {usd(f['headroom_at_p95'])}; crash damage still to come: mean {usd(f['crash_damage_remaining']['mean'])}, "
              f"p95 {usd(f['crash_damage_remaining']['p95'])}")
    elif args.cmd == "decide":
        r = evaluate(plan, sc, Option(args.option, args.points_per_race), a=a)
        d = r["delta"]
        print(f"{r['decision']['name']}: {usd(r['decision']['planned_cost'])}, runs {r['decision']['races_it_runs']} races, "
              f"~{r['decision']['expected_points_gain']} points expected")
        print(f"P(breach) {r['without']['forecast']['probability']['breach']:.1%} -> {r['with']['forecast']['probability']['breach']:.1%}; "
              f"P(material) {r['without']['forecast']['probability']['material_overspend']:.1%} -> "
              f"{r['with']['forecast']['probability']['material_overspend']:.1%}")
        print(f"Prize money {usd(d['expected_prize_money'])}  fines {usd(-d['expected_fine'])}  next-year testing cut "
              f"{usd(-d['next_year_points_valued_at'])}  =>  net {usd(d['net_including_next_year'])}")
        print(f"2027 carry-forward room {usd(d['carry_forward_room_2027'])} (D6.1.1.n)")
        print(f"VERDICT: {r['verdict'].replace('_', ' ').upper()}. " + "; ".join(r["reasons"]))
    elif args.cmd == "headroom":
        h = headroom(plan, sc, a, args.target)
        print(f"Extra spend allowed at P(breach) <= {args.target:.0%}: {usd(h['extra_spend_allowed'])}" + (f" ({h['note']})" if "note" in h else ""))
    elif args.cmd == "pu":
        for o in pu_allocation(plan, sc, a):
            print(f"  2026 {usd(o['to_2026'])} / 2027 {usd(o['to_2027'])}: P(breach 2026) {o['p_breach_2026']:.1%}, "
                  f"P(material) {o['p_material_2026']:.1%}")
        print("Mandatory adjustment: declare the split by 30 November 2026, or it is 1.5m/1.5m and cannot be changed (D6.1.1.q.ii).")


if __name__ == "__main__":
    main()
