"""Race Desk: replay a real Grand Prix lap by lap and price every moment for the team.

For each lap (end-of-lap running order from the real lap chart):
- money telemetry: sponsor bonuses earned if the flag fell now + expected championship prize money;
- the value of a place: what one position up or down is worth right now, per car;
- the pit call: where each car would rejoin if it pitted this lap and nobody else did (real gaps from
  cumulative lap times; pit loss measured from this race's own green-flag stops), and what that costs;
- events and radio calls: our cars gaining or losing money, safety cars, retirements, the flag, and the
  final classification (which can differ: disqualifications are applied after the race).
"""

from __future__ import annotations

import json
import re
import statistics
from datetime import date, datetime, timedelta
from functools import lru_cache
from pathlib import Path

from finance.world import World

from .crash import cap_note
from .money import Valuer
from finance.money import to_usd

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "world" / "race_data"
CRASH_STATUSES = {"Accident", "Collision", "Collision damage", "Spun off", "Damage", "Puncture"}
CALL_THRESHOLD = 10_000_000  # cents: radio a money change of USD 100k or more


@lru_cache(maxsize=8)
def season(year: int) -> dict:
    path = DATA / f"{year}.json"
    if not path.exists():
        raise FileNotFoundError(f"no race data for {year}: run python scripts/fetch_race_data.py {year}")
    return json.loads(path.read_text())


def races(year: int) -> list[dict]:
    return [{"round": r["round"], "name": r["name"], "date": r["date"], "laps": r["laps"]} for r in season(year)["rounds"]]


def usd(cents: int) -> str:
    sign = "-" if cents < 0 else "+"
    v = abs(cents) / 100
    return f"{sign}${v / 1e6:.2f}m" if v >= 1e6 else f"{sign}${v / 1e3:.0f}k"


def money(cents: int) -> str:
    v = cents / 100
    return f"${v / 1e6:.2f}m" if abs(v) >= 1e6 else f"${v / 1e3:.0f}k"


def pit_loss_ms(race: dict) -> tuple[int | None, int]:
    """Median time lost to a green-flag stop in this race.

    For each stop: (in-lap + out-lap) of the stopping car minus the median in-lap and out-lap of the cars that did
    not stop on those laps, corrected for the car's usual pace against that median. Comparing with the field on
    the same laps cancels out track conditions (rain, a drying line, traffic), which a car's own average does not."""
    laps = race["lap_positions"]
    sc_laps = {lap for w in race["safety_cars"] for lap in range((w["from_lap"] or 0), (w["to_lap"] or w["from_lap"] or 0) + 2)}
    stop_laps: dict[str, set[int]] = {}
    for p in race["pit_stops"]:
        stop_laps.setdefault(str(p["car"]), set()).update({p["lap"], p["lap"] + 1})

    def field_median(lap: int) -> float | None:
        v = laps.get(str(lap), {})
        xs = [ms for car, (_, ms) in v.items() if lap not in stop_laps.get(car, set())]
        return statistics.median(xs) if len(xs) >= 5 else None

    medians = {int(L): field_median(int(L)) for L in laps}
    typical = statistics.median(m for m in medians.values() if m)
    # Laps run behind a safety car, VSC or red flag that the data does not mark: the field is far slower than usual.
    sc_laps |= {L for L, m in medians.items() if m and m > 1.07 * typical}
    pace: dict[str, float] = {}
    for car in {c for v in laps.values() for c in v}:
        d = [laps[str(L)][car][1] - m for L, m in medians.items() if m and L > 1 and L not in sc_laps
             and car in laps[str(L)] and L not in stop_laps.get(car, set())]
        if len(d) >= 5:
            pace[car] = statistics.median(d)
    losses = []
    for p in race["pit_stops"]:
        car, lap = str(p["car"]), p["lap"]
        if lap < 2 or lap in sc_laps or lap + 1 in sc_laps or car not in pace:
            continue
        a, b = laps.get(str(lap), {}).get(car), laps.get(str(lap + 1), {}).get(car)
        ma, mb = medians.get(lap), medians.get(lap + 1)
        if not (a and b and ma and mb):
            continue
        losses.append(a[1] - ma + b[1] - mb - 2 * pace[car])
    losses = [x for x in losses if 5_000 < x < 60_000]
    return (round(statistics.median(losses)) if losses else None), len(losses)


def _contracts(v: Valuer) -> list[dict]:
    """Meridian's sponsors and the bonus clauses in force at this round, amounts in contract currency and in USD cents."""
    out = []
    for sp in v.world.sponsors:
        clauses = v.world.contract_for(sp["id"], v.rnd)["clauses"]
        rate = v.fx(sp["currency"])
        out.append({"id": sp["id"], "name": sp["name"], "currency": sp["currency"], "base_fee": sp["base_fee"],
                    "base_fee_usd": to_usd(sp["base_fee"], rate),
                    "clauses": [{"id": c["id"], "type": c["type"], "amount": c["amount"], "usd": to_usd(c["amount"], rate),
                                 "quote": c.get("quote", ""), "excludes_win": bool(c.get("excludes_win"))} for c in clauses]})
    return out


def replay(year: int, rnd: int, team: str = "mercedes", world: World | None = None, crash_hook="default") -> dict:
    if crash_hook == "default":
        from .crash import cost_cap_hook as crash_hook
    s = season(year)
    race = next((r for r in s["rounds"] if r["round"] == rnd), None)
    if race is None:
        raise ValueError(f"no lap data for {year} round {rnd}")
    v = Valuer(world or World(), s, rnd, team)
    names = {c["car"]: c["code"] for c in race["classification"]}
    first = {c["car"]: c["driver"].split()[0] for c in race["classification"]}
    pitted: dict[int, set[int]] = {}
    for p in race["pit_stops"]:
        pitted.setdefault(p["lap"], set()).add(p["car"])
        pitted.setdefault(p["lap"] + 1, set()).add(p["car"])  # the out-lap shows the places lost
    loss, n_stops = pit_loss_ms(race)
    sc_windows = race["safety_cars"]
    cum: dict[str, int] = {}
    prev_total, prev_order, laps_out, calls, crashes = None, None, [], [], []
    t0 = datetime.fromisoformat(race["start_utc"].replace("Z", "+00:00")) if race.get("start_utc") else None
    clock: dict[int, str | None] = {0: _iso(t0)}
    leader_lap_ms: dict[int, int] = {}
    stopped: set[int] = set()

    grid = {c["car"]: c["grid"] for c in race["classification"] if c["grid"] > 0}
    grid_order = {car: i + 1 for i, car in enumerate(sorted(grid, key=grid.get))}
    start = v.value(grid_order)
    calls.append({"lap": 0, "clock": clock[0], "kind": "lights_out", "text": f"Lights out. Grid order is worth {money(start.total)} to us "
                  f"({money(start.bonus_usd)} in sponsor bonuses, {money(start.prize_ev)} expected prize money)."})
    prev_total = start.total
    prev_lines = {(b.sponsor_id, b.clause_id, b.car): b for b in start.bonuses}
    prev_prize = start.prize_ev
    for L in range(1, race["laps"] + 1):
        lap = race["lap_positions"].get(str(L), {})
        for car, (_, ms) in lap.items():
            cum[car] = cum.get(car, 0) + ms
        lead = next((car for car, (pos, _) in lap.items() if pos == 1), None)
        if lead:
            leader_lap_ms[L] = lap[lead][1]
            clock[L] = _iso(t0 + timedelta(milliseconds=cum[lead])) if t0 else None
        else:
            clock[L] = clock.get(L - 1)
        order = {int(car): pos for car, (pos, _) in lap.items()}
        val = v.value(order)
        cars = {}
        for car in v.team_cars:
            pos = order.get(car)
            if pos is None:
                cars[car] = {"code": names[car], "position": None}
                if car not in stopped:
                    stopped.add(car)
                    st = next(c for c in race["classification"] if c["car"] == car)["status"]
                    text = f"{first[car]} is out on lap {L} ({st.lower()})."
                    if st in CRASH_STATUSES:
                        hook = crash_hook(year, race, car, st) if crash_hook else None
                        if hook:
                            text += " " + hook["text"]
                            cars[car]["cost_cap"] = hook
                        crashes.append({"lap": L, "clock": clock[L], "car": car, "driver": first[car] + " " + names[car], "status": st,
                                        "lap_ms": leader_lap_ms.get(L),
                                        "damage_estimate": (hook or {}).get("damage_estimate", 0) * 100 or None,  # cents, like every amount here
                                        **{k: (hook or {}).get(k) for k in ("p_breach_before", "p_breach_after", "p_breach_after_with_final_package")}})
                    note = cap_note(st)
                    if note:
                        text += " " + note
                    calls.append({"lap": L, "clock": clock[L], "kind": "retirement", "car": car, "status": st, "text": text})
                continue
            up, down = v.swapped(order, car, -1), v.swapped(order, car, +1)
            up_val = v.value(up).total - val.total if up else None
            down_val = v.value(down).total - val.total if down else None
            pit = None
            if loss and str(car) in cum:
                rejoin_t = cum[str(car)] + loss
                rejoin = 1 + sum(1 for c, t in cum.items() if c != str(car) and int(c) in order and t < rejoin_t)
                pit_order = {c: p for c, p in order.items() if c != car}
                shifted = {c: (p + 1 if rejoin <= p < pos else p) for c, p in pit_order.items()} if rejoin < pos else dict(pit_order)
                if rejoin > pos:
                    shifted = {c: (p - 1 if pos < p <= rejoin else p) for c, p in pit_order.items()}
                shifted[car] = rejoin
                pit = {"rejoin": rejoin, "places_lost": rejoin - pos, "cost": v.value(shifted).total - val.total}
            cars[car] = {"code": names[car], "position": pos, "up_one": up_val, "down_one": down_val, "pit_now": pit}
        in_sc = next((w for w in sc_windows if w["from_lap"] == L), None)
        if in_sc:
            calls.append({"lap": L, "clock": clock[L], "kind": "safety_car", "text": f"Safety car, lap {L} ({in_sc['cause']}). A cheap stop: a pit stop costs about half "
                          f"its usual time behind the safety car. Order is worth {money(val.total)} right now."})
        delta = val.total - prev_total
        now_lines = {(b.sponsor_id, b.clause_id, b.car): b for b in val.bonuses}
        if prev_order is not None and abs(delta) >= CALL_THRESHOLD:
            movers = [c for c in v.team_cars if order.get(c) != prev_order.get(c) and order.get(c)]
            who = ", ".join(f"{first[c]} P{order[c]}" + (" (pitted)" if c in pitted.get(L, set()) else "") for c in movers) or "Order change"
            def tally(lines):
                out = {}
                for b in lines.values():
                    k = f"{b.sponsor.split()[0]} {b.clause_type.replace('_', ' ')}"
                    out[k] = out.get(k, 0) + 1
                return out
            now_t, prev_t = tally(now_lines), tally(prev_lines)
            gained = [f"+{k}" + (f" x{now_t[k] - prev_t.get(k, 0)}" if now_t[k] - prev_t.get(k, 0) > 1 else "")
                      for k in now_t if now_t[k] > prev_t.get(k, 0)]
            lost = [f"-{k}" + (f" x{prev_t[k] - now_t.get(k, 0)}" if prev_t[k] - now_t.get(k, 0) > 1 else "")
                    for k in prev_t if prev_t[k] > now_t.get(k, 0)]
            champ = val.prize_ev - prev_prize
            parts = gained + lost + ([f"championship {usd(champ)}"] if abs(champ) >= 1_000_000 else [])
            calls.append({"lap": L, "clock": clock[L], "kind": "money", "delta": delta,
                          "text": f"{who}. {usd(delta)} on the board ({', '.join(parts) or 'points'}). Now {money(val.total)}."})
        prev_lines, prev_prize = now_lines, val.prize_ev
        laps_out.append({"lap": L, "clock": clock[L], "order": order, "bonus_usd": val.bonus_usd, "prize_ev": val.prize_ev, "total": val.total, "delta": delta,
                         "constructors_position": val.positions, "cars": cars,
                         "bonuses": [{"sponsor": b.sponsor_id, "clause": b.clause_id, "type": b.clause_type, "car": b.car, "usd": b.usd} for b in val.bonuses]})
        prev_total, prev_order = val.total, order
    last = laps_out[-1]
    calls.append({"lap": race["laps"], "clock": clock[race["laps"]], "kind": "flag", "text": f"Chequered flag. On the road that is {money(last['total'])}. Nothing is booked or "
                  "invoiced until the FIA Final Classification (REV-02a)."})

    final_order = {c["car"]: c["position_order"] for c in race["classification"] if c["position_text"].isdigit()}
    final = v.value(final_order)
    changed = [c for c in race["classification"] if c["constructor"] == team and (not c["position_text"].isdigit())
               and c["car"] in last["order"]]
    if final.total != last["total"]:
        why = "; ".join(f"{c['code']} {c['status'].lower()}" for c in changed) or "classification adjusted after the race"
        calls.append({"lap": race["laps"], "clock": None, "kind": "final_classification", "delta": final.total - last["total"],
                      "text": f"Final classification: {why}. {usd(final.total - last['total'])} against the road result: Pit Wall books {money(final.bonus_usd)} "
                              f"of bonuses, not {money(last['bonus_usd'])}."})
    speed = speed_board(year, race, team, v.team_cars, first, names, crashes, last, final, clock)
    biggest = sorted((x for x in laps_out if x["delta"]), key=lambda x: x["delta"])
    protected = sum(x["usd_protected"] or 0 for x in speed)
    reactions = [x["seconds_to_act"] for x in speed if x["seconds_to_act"] is not None]
    return {
        "season": year, "round": rnd, "race": race["name"], "date": race["date"], "start_utc": race.get("start_utc"),
        "race_laps": race["laps"], "team": team, "team_cars": {c: names[c] for c in v.team_cars}, "classification": {c["car"]: {"position_text": c["position_text"], "status": c["status"], "grid": c["grid"]} for c in race["classification"] if c["car"] in v.team_cars}, "remaining_rounds": v.remaining,
        "field": {c["car"]: {"code": c["code"], "driver": c["driver"], "constructor": c["constructor"], "constructor_name": c["constructor_name"]}
                  for c in race["classification"]},
        "sponsors": _contracts(v),
        "pit_loss_seconds": round(loss / 1000, 1) if loss else None, "pit_loss_from_stops": n_stops,
        "totals": {"start": start.total, "road": last["total"], "final": final.total, "money_protected": protected,
                   "fastest_reaction_seconds": min(reactions) if reactions else None},
        "start": {"total": start.total, "bonus_usd": start.bonus_usd, "prize_ev": start.prize_ev},
        "road": {"total": last["total"], "bonus_usd": last["bonus_usd"], "prize_ev": last["prize_ev"]},
        "final": {"total": final.total, "bonus_usd": final.bonus_usd, "prize_ev": final.prize_ev,
                  "bonuses": [{"sponsor": b.sponsor_id, "clause": b.clause_id, "car": b.car, "position": b.position, "amount_orig": b.amount_orig,
                               "currency": b.currency, "usd": b.usd} for b in final.bonuses]},
        "most_expensive_lap": {"lap": biggest[0]["lap"], "delta": biggest[0]["delta"]} if biggest and biggest[0]["delta"] < 0 else None,
        "best_lap": {"lap": biggest[-1]["lap"], "delta": biggest[-1]["delta"]} if biggest and biggest[-1]["delta"] > 0 else None,
        "radio": calls, "crashes": crashes, "speed": speed, "laps": laps_out,
        "method": {"bonuses": "Meridian's contracts (world/sponsors.json), per car, race-day FX",
                   "prize_money": f"expected over {v.remaining} remaining rounds from each team's real points rate and spread; synthetic prize table",
                   "clock": "race start (UTC) plus the leader's cumulative lap times",
                   "speed": f"Pit Wall acts when a lap closes or an FIA document is published (+{POLL_SECONDS}s polling); "
                            f"manual baseline: booked at month-end close, {CLOSE_BUSINESS_DAYS} business days after month end",
                   "data": "TracingInsights RaceData (CC0) lap chart and classification; FIA documents from Apify captures"},
    }


POLL_SECONDS = 15  # how often the FIA document monitor checks for new documents (assumption)
CLOSE_BUSINESS_DAYS = 5


def _iso(t: datetime | None) -> str | None:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _close_days(race_date: str) -> int:
    from finance.impact import _close_day

    d = date.fromisoformat(race_date)
    return (_close_day(d, CLOSE_BUSINESS_DAYS) - d).days


def _lap_start(c: dict) -> str:
    """The crash happened during its lap; the lap chart shows it when that lap closes (c["clock"])."""
    if not c.get("lap_ms"):
        return c["clock"]
    return _iso(datetime.fromisoformat(c["clock"].replace("Z", "+00:00")) - timedelta(milliseconds=c["lap_ms"]))


def speed_board(year, race, team, team_cars, first, names, crashes, last, final, clock) -> list[dict]:
    """Every money event: when it happened, when Pit Wall acted, and what a month-end close would have done."""
    out = []
    close = _close_days(race["date"])
    for c in crashes:
        out.append({"event": f"Crash: {c['driver']} ({c['status'].lower()}), lap {c['lap']}", "happened_at": max(_lap_start(c), race.get("start_utc") or ""), "acted_at": c["clock"],
                    "seconds_to_act": round(c["lap_ms"] / 1000) if c.get("lap_ms") else None,
                    "action": ("damage booked to the cost cap forecast; breach risk "
                               f"{c['p_breach_before']:.0%} -> {c['p_breach_after']:.0%}"
                               + (f", {c['p_breach_after_with_final_package']:.0%} with the final package" if c.get("p_breach_after_with_final_package") is not None else ""))
                              if c.get("p_breach_after") is not None else "damage estimate booked against the cost cap",
                    "manual_baseline": f"repair invoices reach the books at month-end close, about {close} days later",
                    "usd_at_stake": c.get("damage_estimate"), "usd_protected": None})
    docs = []
    try:
        from finance import fia_bridge

        docs = fia_bridge.weekend(year, _slug(race["name"]))
    except Exception:
        docs = []
    ours = set(team_cars)
    road_by_car: dict[int, int] = {}
    for b in last["bonuses"]:
        road_by_car[b["car"]] = road_by_car.get(b["car"], 0) + b["usd"]
    lost = last["bonus_usd"] - final.bonus_usd
    for d in docs:
        if d["kind"] in ("summons", "infringement", "decision") and set(d["cars"]) & ours and d["published_at_utc"] >= (race.get("start_utc") or ""):
            car = sorted(set(d["cars"]) & ours)[0]
            first_doc = not any(x["event"].startswith("FIA ") and str(car) in x["event"] for x in out)
            out.append({"event": f"FIA {d['kind']}: car {car} ({first[car]})", "happened_at": d["published_at_utc"],
                        "acted_at": _iso(datetime.fromisoformat(d["published_at_utc"].replace("Z", "+00:00")) + timedelta(seconds=POLL_SECONDS)),
                        "seconds_to_act": POLL_SECONDS,
                        "action": "bonuses for this car put at risk; billing held until the Final Classification" if first_doc else "risk confirmed",
                        "manual_baseline": "invoices already sent on the road result; credit notes days later",
                        "usd_at_stake": road_by_car.get(car, 0), "usd_protected": max(0, lost) if first_doc and lost > 0 else None})
    fin = next((d for d in docs if d["kind"] == "final_race_classification"), None)
    out.append({"event": "FIA Final Classification", "happened_at": fin["published_at_utc"] if fin else None,
                "acted_at": _iso(datetime.fromisoformat(fin["published_at_utc"].replace("Z", "+00:00")) + timedelta(seconds=POLL_SECONDS)) if fin else None,
                "seconds_to_act": POLL_SECONDS if fin else None, "action": f"{money(final.bonus_usd)} of bonuses booked and invoiced",
                "manual_baseline": f"booked at month-end close, about {close} days later",
                "usd_at_stake": final.bonus_usd, "usd_protected": None})
    return sorted(out, key=lambda x: x["happened_at"] or "9999")
