"""The per-car comparator: stay out, pit now, the other compound, the same stop under green. Priced; none is chosen.

After Varun Sanjeev's decision cockpit (var-updated-live, live_racing/strategy.py `compare`): one column per decision
with the same rows, so the head of strategy reads across. For each option:

- the position after the stop as a range [best, likely, worst]: the cars behind within the stop's time, at the low,
  middle and high ends of the stop's cost, from the timing feed's gaps now (a lapped car's gap is a lower bound, so it
  is "too close to call" rather than counted);
- the time lost and its basis (measured from n stops of this race under the condition, derived, or a stated range);
- the points that position scores, the constructors' place on the running order and its prize change on the 2024
  ladder (race/prize.py, only shown as a change when the place can move), the assumed sponsor clause change ($100k a
  point, $500k a place above 10th; ASSUMPTION, race/season_sim.py), and the cost cap line (Pirelli supplies the
  tyres: $0; parts count only when damage is fitted);
- pace evidence for the compound fitted, and the expected race-end value, which is "unavailable": no calibrated
  finishing model exists, so none is pretended.

Varun's "lowest risk" flag is not carried over: the desk prices options and does not single one out.
"""

from __future__ import annotations

from race import prize as prize_ladder
from race.cockpit.pit_model import LossEstimate, loss_estimate, measured_stops, pace_evidence
from race.cockpit.timing import NAMES, WET, SessionIndex, gap_seconds
from race.points import points_for, position_of, projected_standings
from race.season_sim import SPONSOR_PER_PLACE_CENTS, SPONSOR_PER_POINT_CENTS

SPONSOR_ASSUMPTION = ("ASSUMPTION: $100k per championship point and $500k per constructors' place above 10th, the structure "
                      "(not the amounts) of the only public case (Etihad/Aldar with Force India)")
RACE_END = "unavailable: no calibrated finishing model; every figure assumes the position after the stop holds to the flag"
TYRES_CAP = "Pirelli supplies the tyres: $0 against the cost cap"
COMPOUND_WORD = {"SOFT": "softs", "MEDIUM": "mediums", "HARD": "hards", "INTERMEDIATE": "intermediates", "WET": "wets"}


def word(c: str) -> str:
    return COMPOUND_WORD.get(c, (c or "tyres").lower())


# ---------------------------------------------------------------------- the running order

def running_order(state, idx: SessionIndex, t: float) -> dict[int, int]:
    """Car -> place among the cars still racing now: no DNS, no car out per the replay or per timing. A position row
    alone never proves a car is racing (a DNS car keeps its grid slot in the feed)."""
    from race.season_sim import _out_of_race, _race_key

    ctx = state.replay.ctx
    known_out = _out_of_race(state, _race_key(state))  # our own cars: a DNS in the result, an incident's belief, a withdrawal
    rows = []
    for car in idx.positions:
        p = idx.position(car, t)
        if p is None or car in known_out or ctx.positions.get(car, 0) is None or idx.dns(car, t) or idx.out_per_timing(car, t):
            continue
        rows.append((p, car))
    return {car: i + 1 for i, (_, car) in enumerate(sorted(rows))}


def positions_after_losing(order: dict[int, int], car: int, lost: int) -> dict[int, int]:
    """Move `car` back by `lost` places; the cars it drops behind move up one each."""
    pos = order.get(car)
    if pos is None or lost <= 0:
        return dict(order)
    lost = min(lost, len(order) - pos)
    out = dict(order)
    for n, p in order.items():
        if n != car and pos < p <= pos + lost:
            out[n] = p - 1
    out[car] = pos + lost
    return out


def behind(idx: SessionIndex, order: dict[int, int], car: int, t: float) -> list[tuple[int, float | None, bool]]:
    """Cars behind `car` in the order with their gap to it: (car, seconds, exact?)."""
    typical = idx.typical_lap(t)
    me, me_exact = gap_seconds(idx.gap(car, t), typical)
    if order.get(car) == 1:
        me, me_exact = 0.0, True
    out = []
    for other, p in sorted(order.items(), key=lambda kv: kv[1]):
        if p <= order[car]:
            continue
        g, exact = gap_seconds(idx.gap(other, t), typical)
        if me is None or g is None:
            out.append((other, None, False))
        elif exact and me_exact:
            out.append((other, round(g - me, 3), True))
        else:
            # a lapped car's gap is a lower bound from a typical lap, not the leader's own: widen it by a quarter lap
            out.append((other, round(g - me - 0.25 * (typical or 0.0), 3), False))
    return out


def passed_within(rows: list[tuple[int, float | None, bool]], seconds: float) -> tuple[list[int], list[int]]:
    """(certainly past, too close to call) if the car lost `seconds` now."""
    passed, maybe = [], []
    if seconds <= 0:
        return passed, maybe
    for car, gap, exact in rows:
        if gap is None:
            maybe.append(car)
        elif gap <= seconds:
            (passed if exact else maybe).append(car)
    return passed, maybe


# ---------------------------------------------------------------------- money on an order

def priced(state, order: dict[int, int]) -> dict:
    ctx = state.replay.ctx
    team = state.team
    ours = [c for c, tm in state.replay.team_of.items() if tm == team]
    pts = sum(points_for(order.get(c)) for c in ours)
    standings = projected_standings(ctx.standings_start, order, state.replay.team_of)
    place = position_of(team, standings) or 0
    prize = prize_ladder.prize(state.year, place) if place else 0
    sponsor = SPONSOR_PER_POINT_CENTS * pts + SPONSOR_PER_PLACE_CENTS * max(0, 10 - place) if place else 0
    return {"points": pts, "place": place, "prize": prize, "sponsor": sponsor}


def _clauses(car: int, now: int, after: int) -> list[str]:
    out = []
    a, b = points_for(now), points_for(after)
    if b < a:
        out.append(f"car {car} P{now} -> P{after}: {a - b} point{'s' if a - b != 1 else ''} fewer" + (", out of the points" if b == 0 else ""))
    elif b > a:
        out.append(f"car {car} P{now} -> P{after}: {b - a} more point{'s' if b - a != 1 else ''}")
    return out


# ---------------------------------------------------------------------- one option

def _option(state, idx, car: int, t: float, *, oid: str, label: str, est: LossEstimate, compound: str, base_order: dict, base_money: dict,
            rows_behind, laps_left: int | None, available: bool = True, why_not: str = "", cap_line: str = TYRES_CAP) -> dict:
    pos = base_order.get(car)
    lo, mid, hi = est.low_s, est.mid, est.high_s
    p_lo, _ = passed_within(rows_behind, lo)
    p_mid, m_mid = passed_within(rows_behind, mid)
    p_hi, m_hi = passed_within(rows_behind, hi)
    ks = [len(p_lo), len(p_mid), len(p_hi) + len(set(m_hi) - set(p_hi))]
    orders = [positions_after_losing(base_order, car, k) for k in ks]
    money = [priced(state, o) for o in orders]
    positions = [o.get(car) for o in orders]
    places = [m["place"] for m in money]
    moves = any(p != base_money["place"] for p in places)
    prize_delta = [m["prize"] - base_money["prize"] for m in money] if moves else [0, 0, 0]
    prize_note = (f"constructors' place on the running order: P{base_money['place']} -> " + "/".join(f"P{p}" for p in places)
                  if moves else f"constructors' place on the running order is P{base_money['place']} whichever way: no prize change")
    pace = pace_evidence(idx, car, compound, mid, laps_left, t) if compound and est.method != "suspension" else None
    time_txt = (f"{est.seconds:.1f}s" if est.seconds is not None else f"{lo:.0f}-{hi:.0f}s") + f" ({est.method}"
    time_txt += f", {est.samples} stop{'s' if est.samples != 1 else ''})" if est.method in ("measured", "derived") else ")"
    evidence = [f"stop cost {time_txt}"]
    if p_mid:
        evidence.append("cars within the stop's time behind: " + ", ".join(f"#{c}" for c in p_mid))
    elif est.mid > 0:
        evidence.append("no car within the stop's time behind" if rows_behind else "no car behind")
    if m_mid or m_hi:
        evidence.append("too close to call (lapped, or no gap in the feed): " + ", ".join(f"#{c}" for c in sorted(set(m_mid) | set(m_hi))))
    return {
        "id": oid, "label": label, "available": available, "why_not": why_not, "compound_after": compound,
        "position_now": pos, "positions": positions,
        "time_lost_s": est.wire(),
        "cars_passed": p_mid, "cars_maybe": sorted(set(m_mid) | set(m_hi)),
        "points": [points_for(p) for p in positions], "points_delta": [m["points"] - base_money["points"] for m in money],
        "constructors_place": places, "prize_delta_cents": prize_delta, "prize_note": prize_note,
        "sponsor_delta_cents": [m["sponsor"] - base_money["sponsor"] for m in money], "sponsor_label": "ASSUMPTION",
        "clauses": _clauses(car, pos, positions[1]) if pos and positions[1] else [],
        "cost_cap": {"cents": 0, "line": cap_line},
        "pace": pace.wire() if pace else None,
        "race_end_value": "unavailable",
        "evidence": evidence,
    }


def compound_choices(current: str, field: dict[str, int]) -> tuple[str, str, str]:
    """(the set a stop would fit now, the alternative, why). Wet or dry is read from what the field runs on now: the
    replay has no weather feed, and the field's tyres are the evidence."""
    wet_n = sum(v for k, v in field.items() if k in WET)
    wet = wet_n * 2 > sum(field.values())
    if wet:
        same = current if current in WET else "INTERMEDIATE"
        alt = "WET" if same == "INTERMEDIATE" else "INTERMEDIATE"
        return same, alt, f"{wet_n} of {sum(field.values())} running cars are on wet-weather tyres: the choice is between the two"
    if current in WET:
        return current, "MEDIUM", "the field is on slicks: slicks are the alternative to another wet-weather set"
    alt = {"SOFT": "MEDIUM", "MEDIUM": "HARD", "HARD": "MEDIUM"}.get(current, "MEDIUM")
    return current or "MEDIUM", alt, "dry: the other slick compound"


def compare(state, idx: SessionIndex, car: int, t: float) -> tuple[list[dict], dict]:
    """The options and their shared context for one running car at moment `t`."""
    cond = idx.condition_at(t)
    order = running_order(state, idx, t)
    pos = order.get(car)
    car_lap = idx.car_lap(car, t)
    compound, age = idx.tyre(car, max(car_lap, 1), t)
    field: dict[str, int] = {}
    for c in order:
        comp, _ = idx.tyre(c, max(idx.car_lap(c, t), 1), t)
        if comp:
            field[comp] = field.get(comp, 0) + 1
    total, total_basis = idx.scheduled_laps(t)
    fl = idx.field_lap(t)
    laps_left = max(0, total - fl) if total else None
    stops = measured_stops(idx, t)
    est = loss_estimate(idx, cond, t, stops)
    green = loss_estimate(idx, "green", t, stops) if cond != "green" else est
    rows_behind = behind(idx, order, car, t) if pos else []
    base_money = priced(state, order)
    same, alt, why_alt = compound_choices(compound, field)
    booked = (state.replay.ctx.booked or {}).get(car)
    damage = (f"; car {car} has crash damage booked (${booked['mid'] / 1e8:.2f}m mid): any part fitted at a stop counts against the "
              "cap when first used" if booked else "")
    kw = dict(base_order=order, base_money=base_money, rows_behind=rows_behind, laps_left=laps_left)

    opts: list[dict] = []
    stay = {"id": "stay_out", "label": "Restart on the current set" if cond == "red" else "Stay out", "available": True, "why_not": "",
            "compound_after": compound, "position_now": pos, "positions": [pos, pos, pos],
            "time_lost_s": {"condition": cond, "seconds": 0.0, "low": 0.0, "high": 0.0, "method": "none", "samples": 0, "basis": "no stop"},
            "cars_passed": [], "cars_maybe": [], "points": [points_for(pos)] * 3, "points_delta": [0, 0, 0],
            "constructors_place": [base_money["place"]] * 3, "prize_delta_cents": [0, 0, 0],
            "prize_note": f"constructors' place on the running order: P{base_money['place']}",
            "sponsor_delta_cents": [0, 0, 0], "sponsor_label": "ASSUMPTION", "clauses": [],
            "cost_cap": {"cents": 0, "line": "no spend" + damage}, "pace": None, "race_end_value": "unavailable",
            "evidence": [f"{word(compound)} {age if age is not None else '?'} laps old; no wear model is pretended"]}
    opts.append(stay)
    if cond == "red":
        cap = TYRES_CAP + "; repairs during the suspension are restricted and parts are not free: any part fitted counts when first used"
        opts.append(_option(state, idx, car, t, oid="pit_now", label=f"Fit fresh {word(same)} during the suspension", est=est, compound=same,
                            cap_line=cap, **kw))
        opts.append(_option(state, idx, car, t, oid="other_compound", label=f"Fit {word(alt)} during the suspension", est=est, compound=alt,
                            cap_line=cap, **kw))
    else:
        opts.append(_option(state, idx, car, t, oid="pit_now", label=f"Pit now for fresh {word(same)}", est=est, compound=same,
                            cap_line=TYRES_CAP + damage, **kw))
        o = _option(state, idx, car, t, oid="other_compound", label=f"Pit now for {word(alt)}", est=est, compound=alt, cap_line=TYRES_CAP + damage, **kw)
        o["evidence"].insert(0, f"{why_alt}; the same stop, the compound changes only the pace that follows")
        opts.append(o)
    if cond != "green":
        o = _option(state, idx, car, t, oid="same_stop_green", label=f"The same stop under green (after the {NAMES[cond]})", est=green,
                    compound=same, available=False, why_not="a comparison, not a choice now: what the stop costs once the neutralisation ends",
                    cap_line=TYRES_CAP + damage, **kw)
        opts.append(o)

    ahead = next((c for c, p in order.items() if pos and p == pos - 1), None)
    typical = idx.typical_lap(t)
    g_me, _ = gap_seconds(idx.gap(car, t), typical)
    g_ahead, ex_ahead = gap_seconds(idx.gap(ahead, t), typical) if ahead else (None, False)
    nxt = rows_behind[0] if rows_behind else None
    context = {
        "driver": idx.name(car), "condition": cond, "condition_label": NAMES[cond], "field_lap": fl, "car_lap": car_lap,
        "laps_left": laps_left, "laps_left_basis": total_basis, "position": pos, "running": len(order),
        "car_ahead": ahead, "gap_ahead_s": round(g_me - g_ahead, 3) if (g_me is not None and g_ahead is not None and ex_ahead) else None,
        "car_behind": nxt[0] if nxt else None, "gap_behind_s": nxt[1] if nxt and nxt[2] else None,
        "compound": compound, "tyre_age": age, "field_compounds": dict(sorted(field.items())),
        "constructors_place": base_money["place"], "team_points_now": base_money["points"],
        "stop_cost": {c: {k: v for k, v in loss_estimate(idx, c, t, stops).wire().items() if k != "basis"} for c in ("green", "vsc", "sc")}
        if cond != "red" else {"red": {k: v for k, v in est.wire().items() if k != "basis"}},
        "stops_measured": len(stops),
        "cap_headroom_cents": int(state.replay.ctx.cap_headroom_cents()),
        "prize_basis": f"{state.year} ladder: {prize_ladder.basis(state.year)}",
        "sponsor_basis": SPONSOR_ASSUMPTION, "race_end_value": RACE_END,
        "range": "positions, points and money are [best, likely, worst] at the low, middle and high stop cost",
        "as_of": "every figure from timing rows at or before this moment; nothing later is read",
        "credit": "after Varun Sanjeev's decision cockpit (var-updated-live)",
    }
    return opts, context
