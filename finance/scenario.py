"""Stewards' Decision: a judge changes a result after it was final, and the books follow.

`apply` records the change as an overlay, routes a `result_changed` event,
and returns what moved: every balance that changed, by account and sponsor,
and the entries the change created.
"""

from __future__ import annotations

from .config import ACCOUNTS
from .ledger import new_id
from .money import fmt


def snapshot(ledger) -> dict:
    """Balances by (account, sponsor) including parked entries, so a pending reversal shows as moving."""
    rows = ledger.q(
        "SELECT l.account, COALESCE(l.sponsor_id,'') s, SUM(l.debit_cents - l.credit_cents) n FROM je_lines l "
        "JOIN journal_entries j ON j.je_id=l.je_id WHERE j.status IN ('posted','parked') GROUP BY l.account, s")
    return {(r["account"], r["s"]): r["n"] for r in rows}


def apply(run, *, season: int, rnd: int, car: int, action: str = "dsq", places: int = 0, session: str = "race",
          reason: str = "Stewards' decision (scenario)") -> dict:
    ledger, world = run.ledger, run.world
    if not ledger.is_final(season, rnd, session):
        raise ValueError(f"{season} R{rnd} {session} is not final yet; scenarios change results after the Final Classification")
    team_cars = [r.number for r in world.team_rows(world.classification(season, rnd, session, "final", ledger.overlays()))]
    before = snapshot(ledger)
    standings_before = world.prize_estimate(season, ledger.last_final_round(season), ledger.overlays())
    scenario_id = new_id("scn")
    overlay = {"overlay_id": scenario_id, "season": season, "round": rnd, "session": session, "car": car, "action": action,
               "places": places, "reason": reason, "hypothetical": True}
    ledger.add_overlay(overlay)
    driver = world.car_map(season).get(car, {}).get("driver_id", f"car {car}")
    text = (f"Car {car} ({driver}) disqualified" if action == "dsq" else f"Car {car} ({driver}) dropped {places} places") + \
           f" from the {season} R{rnd} {session} classification. {reason}."
    event = {"id": scenario_id, "type": "result_changed", "at": ledger.clock,
             "payload": {"season": season, "round": rnd, "session": session, "car": car, "action": action,
                         "evidence": [{"type": "stewards_decision", "ref": scenario_id, "text": text, "hypothetical": True}]}}
    results = run.router.dispatch(event, ledger)
    after = snapshot(ledger)
    moved = []
    for k in sorted(set(before) | set(after)):
        b, a = before.get(k, 0), after.get(k, 0)
        if a != b:
            moved.append({"account": k[0], "name": ACCOUNTS.get(k[0], k[0]), "sponsor_id": k[1] or None,
                          "before_cents": b, "after_cents": a, "delta_cents": a - b, "label": f"{ACCOUNTS.get(k[0], k[0])}"
                          + (f" ({k[1]})" if k[1] else "") + f": {fmt(b)} -> {fmt(a)}"})
    entries = [ledger.entry(r["je_id"]) for r in ledger.q("SELECT je_id FROM journal_entries WHERE source_event_id=?", scenario_id)]
    revenue_delta = -sum(m["delta_cents"] for m in moved if m["account"].startswith("4"))
    return {"scenario_id": scenario_id, "text": text, "team_cars_before": team_cars, "moved": moved,
            "revenue_delta_cents": revenue_delta, "entries": [{"je_id": e["je_id"], "kind": e["kind"], "status": e["status"],
                                                             "memo": e["memo"], "total_cents": e["total_cents"], "needs": e["needs"]}
                                                            for e in entries],
            "prize_before": {"position": standings_before[0], "estimate_cents": standings_before[1]},
            "prize_after": dict(zip(("position", "estimate_cents"), world.prize_estimate(season, ledger.last_final_round(season), ledger.overlays())[:2])),
            "results": [r if isinstance(r, dict) else {"status": r.status, "je_id": r.je_id, "reason": r.reason} for r in results]}
