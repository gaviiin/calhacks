"""Strategic finance as of now: what a place, a pit stop and the tyres are worth (plan section 5).

Everything is arithmetic on the timing feed and the synthetic contracts. Gaps come from when each
car started its current lap; what a stop costs is measured from this race's own stops under each
racing condition (pit_model.py); tyre pace is recent lap evidence, not a degradation model. Nothing
here predicts a finishing position; it prices the decisions the pit wall actually has, and says
"forecast unavailable" where a calibrated model would be needed.
"""

from __future__ import annotations

from statistics import median

from finance.world import World

from .finance_projections import championship_context, diff, if_finished_now, usd
from .pit_model import LossEstimate, all_estimates, loss_estimate, measured_stops, pace_evidence
from .race_state import OUT, RaceState, _seconds_between, condition_of
from .races import Race
from .schemas import CarComparison, PaceNote, PitLoss, PitScenario, PlaceValue, StrategyAdvice, StrategyOption, Timestamps, TyreContext


def _point(e: LossEstimate) -> float:
    """The single figure a position count needs: the estimate, or the middle of its range when only a range is honest."""
    if e.seconds is not None:
        return e.seconds
    return ((e.low_s or 0.0) + (e.high_s or 0.0)) / 2


def pit_loss(state: RaceState) -> tuple[float, str]:
    """What a green-flag stop costs in race time in this race so far."""
    e = loss_estimate(state, "green")
    return _point(e), e.basis


def effective_pit_loss(state: RaceState) -> tuple[float, str, str | None]:
    """What a stop costs under the condition the race is in now, measured or derived (never a fixed factor)."""
    cond = condition_of(state.flag_status)
    e = loss_estimate(state, cond)
    return _point(e), e.basis, (None if cond == "green" else state.flag_status)


def _pit_loss_model(e: LossEstimate) -> PitLoss:
    return PitLoss(condition=e.condition, seconds=e.seconds, low_s=e.low_s, high_s=e.high_s, method=e.method, samples=e.samples, basis=e.basis)


def cars_behind_within(state: RaceState, car: int, seconds: float) -> tuple[list[int], list[int]]:
    """Cars that would get past if this car lost `seconds`: (certainly, possibly). A following car on
    the same lap is placed by when it started the lap; one still on the previous lap is at least
    the time since this car's lap start behind, so it is 'possibly' when that lower bound is short."""
    me = state.drivers.get(car)
    if me is None or me.position is None or me.lap is None or not me.lap_started_at or not state.now_utc:
        return [], []
    passed: list[int] = []
    maybe: list[int] = []
    behind = sorted((d for d in state.drivers.values() if d.position is not None and d.position > me.position), key=lambda d: d.position)
    for other in behind:
        if other.status == "stopped_candidate" or other.status in OUT:
            continue
        gap: float | None
        if other.lap == me.lap and other.lap_started_at:
            gap = _seconds_between(me.lap_started_at, other.lap_started_at)
        elif other.lap is not None and other.lap < me.lap:
            lower = _seconds_between(me.lap_started_at, state.now_utc)
            gap = lower if lower > seconds else None
        else:
            gap = None
        if gap is None:
            maybe.append(other.number)
            continue
        if gap <= seconds:
            passed.append(other.number)
        else:
            break
    return passed, maybe


def positions_after_losing(positions: dict[int, int | None], car: int, lost: int) -> dict[int, int | None]:
    """Move `car` back by `lost` places; the cars it drops behind move up one each."""
    pos = positions.get(car)
    if pos is None or lost <= 0:
        return dict(positions)
    out = dict(positions)
    for n, p in positions.items():
        if n != car and p is not None and pos < p <= pos + lost:
            out[n] = p - 1
    out[car] = pos + lost
    return out


def positions_without(positions: dict[int, int | None], car: int) -> dict[int, int | None]:
    pos = positions.get(car)
    out = {n: p for n, p in positions.items() if n != car}
    if pos is not None:
        for n, p in list(out.items()):
            if p is not None and p > pos:
                out[n] = p - 1
    return out


def swap(positions: dict[int, int | None], car: int, target: int) -> dict[int, int | None]:
    out = dict(positions)
    other = next((n for n, p in positions.items() if p == target and n != car), None)
    if other is not None:
        out[other] = positions[car]
    out[car] = target
    return out


def place_values(world: World, race: Race, state: RaceState, team_cars: list[int], as_of: str | None, drivers_meta) -> list[PlaceValue]:
    positions = state.classified_positions()
    base = if_finished_now(world, race, positions, as_of_utc=as_of, drivers_meta=drivers_meta)
    car_map = world.car_map(race.season)
    out = []
    for car in team_cars:
        pos = positions.get(car)
        mine = sum(l.amount_usd_cents for l in base.lines if l.car == car)
        pv = PlaceValue(car=car, driver_id=car_map.get(car, {}).get("driver_id", f"car{car}"), position=pos, value_now_cents=mine)
        if pos is not None:
            if pos > 1:
                up = if_finished_now(world, race, swap(positions, car, pos - 1), as_of_utc=as_of, drivers_meta=drivers_meta)
                pv.up_one_cents = (up.amount_cents or 0) - (base.amount_cents or 0)
                pv.up_one_text = f"P{pos} -> P{pos - 1}: {'+' if pv.up_one_cents >= 0 else ''}{usd(pv.up_one_cents)}"
            else:
                pv.up_one_text = "already leading"
            if any(p == pos + 1 for p in positions.values()):
                down = if_finished_now(world, race, swap(positions, car, pos + 1), as_of_utc=as_of, drivers_meta=drivers_meta)
                pv.down_one_cents = (down.amount_cents or 0) - (base.amount_cents or 0)
                pv.down_one_text = f"P{pos} -> P{pos + 1}: {usd(pv.down_one_cents) if pv.down_one_cents < 0 else '+' + usd(pv.down_one_cents)}"
            else:
                pv.down_one_text = "last of the classified runners"
        out.append(pv)
    return out


def pit_scenarios(world: World, race: Race, state: RaceState, team_cars: list[int], as_of: str | None, drivers_meta) -> list[PitScenario]:
    positions = state.classified_positions()
    base = if_finished_now(world, race, positions, as_of_utc=as_of, drivers_meta=drivers_meta)
    loss, basis, under = effective_pit_loss(state)
    green_loss, _ = pit_loss(state)
    out = []
    for car in team_cars:
        pos = positions.get(car)
        if state.drivers.get(car) is not None and state.drivers[car].status in OUT:
            continue
        passed, maybe = cars_behind_within(state, car, loss) if loss > 0 else ([], [])
        after = positions_after_losing(positions, car, len(passed))
        fc = if_finished_now(world, race, after, as_of_utc=as_of, drivers_meta=drivers_meta)
        delta = (fc.amount_cents or 0) - (base.amount_cents or 0)
        rejoin = (pos + len(passed)) if pos is not None else None
        green_passed, _ = cars_behind_within(state, car, green_loss)
        green_fc = if_finished_now(world, race, positions_after_losing(positions, car, len(green_passed)), as_of_utc=as_of, drivers_meta=drivers_meta)
        green_delta = (green_fc.amount_cents or 0) - (base.amount_cents or 0)
        text = (f"Pit now from P{pos}: about {loss:.0f}s in the lane, " + (f"rejoin P{rejoin} behind {', '.join(f'car {c}' for c in passed)}" if passed else f"rejoin P{rejoin}, nobody close enough to get past")
                + (f" (cars {', '.join(map(str, maybe))} too close to call)" if maybe else "") + f": {usd(delta) if delta < 0 else '+' + usd(delta)} on the sponsor exposure"
                + (f" under the {under.replace('_', ' ').lower()}" if under else "") + ". Indicative; no tyre or pace model.")
        out.append(PitScenario(car=car, position=pos, pit_loss_s=round(loss, 1), pit_loss_basis=basis, under=under, cars_passed=passed, cars_maybe=maybe,
                               positions_lost=len(passed), rejoin_position=rejoin, delta_cents=delta, green_pit_loss_s=round(green_loss, 1),
                               green_positions_lost=len(green_passed), green_delta_cents=green_delta, text=text))
    return out


def _signed(cents: int) -> str:
    return ("+" if cents > 0 else "") + usd(cents) if cents else "$0"


def lever_lines(world: World, places: list[PlaceValue], pits: list[PitScenario], tyres: list[TyreContext], state: RaceState) -> list[str]:
    """What the numbers mean, in the words a pit wall would use. Every figure comes from the objects above."""
    name = lambda car: driver_name(world, state, car)  # noqa: E731
    lines: list[str] = []
    for p in places:
        d = state.drivers.get(p.car)
        if d is not None and d.status in OUT:
            lines.append(f"{name(p.car)}: {'did not start' if d.status == 'dns' else 'out of the race'}; nothing to price.")
            continue
        if p.position is None:
            continue
        if p.up_one_cents == 0 and p.down_one_cents == 0:
            lines.append(f"{name(p.car)} at P{p.position}: no sponsor clause turns on one place either way.")
        else:
            lines.append(f"{name(p.car)} at P{p.position}: one place up {_signed(p.up_one_cents)}, one place down {_signed(p.down_one_cents)}.")
    for s in pits:
        if s.position is None:
            continue
        if s.under == "RED_FLAG":
            lines.append(f"Red flag: {name(s.car)} can change tyres in the pit lane while the race is suspended without losing track position; "
                         "other work is restricted and a car stopped on track cannot reach the lane.")
        elif s.under in ("SAFETY_CAR", "SAFETY_CAR_ENDING", "VSC", "VSC_ENDING"):
            lines.append(f"Under the {'Safety Car' if s.under.startswith('SAFETY') else 'Virtual Safety Car'} a stop costs {name(s.car)} {s.positions_lost} place(s) and "
                         f"{_signed(s.delta_cents)}; the same stop under green would cost {s.green_positions_lost} place(s) and {_signed(s.green_delta_cents or 0)}.")
        else:
            lines.append(f"A stop now costs {name(s.car)} {s.positions_lost} place(s) and {_signed(s.delta_cents)} ({s.pit_loss_s:.0f}s in the lane).")
    w = state.weather
    if w.rainfall:
        comp = {t.compound for t in tyres if t.compound}
        lines.append(f"Rain is falling and the team is on {', '.join(sorted(c.lower() + 's' for c in comp)) or 'unknown tyres'}: the next tyre call is a weather call, "
                     "and its price is the pit-stop line above.")
    else:
        lines.append("Dry at the sensor; a tyre change is a wear call, and its price is the pit-stop line above (no wear model is pretended).")
    for t in tyres:
        if t.age_laps is not None and t.field_median_age_laps is not None and t.age_laps >= t.field_median_age_laps + 5:
            lines.append(f"{name(t.car)} has {t.age_laps} laps on this set, {t.age_laps - t.field_median_age_laps:.0f} more than the field median.")
    return lines


def driver_name(world: World, state: RaceState, car: int) -> str:
    d = state.drivers.get(car)
    if d is not None and d.full_name:
        return d.full_name.split(" ")[-1].title()
    return world.car_map(2024).get(car, {}).get("driver_id", f"car {car}").replace("_", " ").title()


def tyre_context(state: RaceState, team_cars: list[int]) -> list[TyreContext]:
    ages = [d.tyre_age_laps for d in state.drivers.values() if d.tyre_age_laps is not None and d.status in ("running", "in_pit")]
    med = float(median(ages)) if ages else None
    out = []
    for car in team_cars:
        d = state.drivers.get(car)
        if d is None:
            continue
        age = d.tyre_age_laps
        if age is None or med is None:
            note = "tyre age unknown from the feed"
        elif age >= med + 5:
            note = f"{age} laps on this set, {age - med:.0f} more than the field median; the pit-stop figure above is what a stop costs today"
        elif age <= 2:
            note = f"fresh set ({age} laps); a stop now would be for weather, not wear"
        else:
            note = f"{age} laps on this set against a field median of {med:.0f}; no degradation model is pretended here"
        out.append(TyreContext(car=car, compound=d.compound, age_laps=age, stint_lap_start=d.stint_lap_start, field_median_age_laps=med, note=note))
    return out


def strategy_advice(world: World, race: Race, state: RaceState, team_cars: list[int], *, version: int, observed_at: str, drivers_meta,
                    exposure_at_join: int | None, exposure_peak: int | None, finance_recomputed: str | None = None,
                    cap_headroom: tuple[int | None, str | None] = (None, None)) -> StrategyAdvice:
    as_of = state.now_utc
    positions = state.classified_positions()
    base = if_finished_now(world, race, positions, as_of_utc=as_of, drivers_meta=drivers_meta)
    now = base.amount_cents or 0
    w = state.weather
    weather_note = ("rain falling" if w.rainfall else "dry at the sensor") + (f", track {w.track_temperature_c}C" if w.track_temperature_c is not None else "") + \
        " (measurement, not a forecast)"
    places = place_values(world, race, state, team_cars, as_of, drivers_meta)
    pits = pit_scenarios(world, race, state, team_cars, as_of, drivers_meta)
    tyres = tyre_context(state, team_cars)
    stops = measured_stops(state)
    comparisons = compare(world, race, state, team_cars, as_of, drivers_meta, base=base, stops=stops)
    return StrategyAdvice(
        race_id=race.race_id, version=version, as_of_utc=as_of or "", observed_at_utc=observed_at, lap=state.lap, flag_status=state.flag_status,
        exposure_now_cents=now, exposure_at_join_cents=exposure_at_join, exposure_peak_cents=exposure_peak,
        lost_from_peak_cents=(exposure_peak - now) if exposure_peak is not None else None,
        places=places, pit=pits, tyres=tyres, weather_note=weather_note, levers=lever_lines(world, places, pits, tyres, state),
        comparisons=comparisons, pit_losses=[_pit_loss_model(e) for e in all_estimates(state)],
        championship=championship_context(world, race, positions, drivers_meta), cap_headroom_cents=cap_headroom[0], cap_headroom_source=cap_headroom[1],
        basis=f"positions and lap-start gaps from the timing feed as of {as_of}; contracts: Meridian's synthetic sponsors; stop cost measured from this race's stops",
        timestamps=Timestamps(source_event=as_of, adapter_received=observed_at, finance_recomputed=finance_recomputed))


# ---------------------------------------------------------------- the decision comparator

STOP_COST_CAP = ("a routine tyre stop: no incremental Relevant Cost is evidenced for it here (no invoice, no parts); "
                 "nothing is counted against the cap")


def compound_choices(current: str | None, raining: bool) -> tuple[str, str | None, str]:
    """(the set a stop would fit now, the alternative worth showing, why)."""
    if raining:
        same = current if current in ("INTERMEDIATE", "WET") else "INTERMEDIATE"
        alt = "WET" if same == "INTERMEDIATE" else "INTERMEDIATE"
        return same, alt, "rain at the sensor: the choice is between the two wet-weather tyres"
    if current in ("INTERMEDIATE", "WET"):
        return current, "MEDIUM", "dry at the sensor: slicks are the alternative to another wet-weather set"
    alt = {"SOFT": "MEDIUM", "MEDIUM": "HARD", "HARD": "MEDIUM"}.get(current or "", "MEDIUM")
    return current or "MEDIUM", alt, "dry: the alternative slick compound"


def _priced(world: World, race: Race, base, positions: dict, car: int, lost: int, as_of, drivers_meta) -> tuple[int, int, list[str], list[str]]:
    after = positions_after_losing(positions, car, lost)
    fc = if_finished_now(world, race, after, as_of_utc=as_of, drivers_meta=drivers_meta)
    d = diff(base, fc)
    return after.get(car), fc.amount_cents or 0, d.lost, d.gained


def _stop_option(world: World, race: Race, state: RaceState, base, positions: dict, car: int, key: str, label: str, est: LossEstimate,
                 compound: str | None, as_of, drivers_meta, scheduled_laps: int | None) -> StrategyOption:
    now = base.amount_cents or 0
    pos = positions.get(car)
    mid = _point(est)
    lo = est.low_s if est.low_s is not None else mid
    hi = est.high_s if est.high_s is not None else mid
    passed, maybe = cars_behind_within(state, car, mid) if mid > 0 else ([], [])
    best_passed, _ = cars_behind_within(state, car, lo) if lo > 0 else ([], [])
    worst_passed, worst_maybe = cars_behind_within(state, car, hi) if hi > 0 else ([], [])
    after_pos, after_cents, lost, gained = _priced(world, race, base, positions, car, len(passed), as_of, drivers_meta)
    best_pos, best_cents, _, _ = _priced(world, race, base, positions, car, len(best_passed), as_of, drivers_meta)
    worst_pos, worst_cents, _, _ = _priced(world, race, base, positions, car, len(worst_passed) + len(worst_maybe), as_of, drivers_meta)
    pace = pace_evidence(state, car, compound, mid, scheduled_laps)
    assumptions = [f"the stop costs {mid:.0f}s ({est.method}: {est.basis})" if est.seconds is not None
                   else f"the stop costs {lo:.0f}-{hi:.0f}s ({est.basis}); the middle of that range is used for the central position",
                   "gaps behind are the lap-start gaps from the timing feed now",
                   "the position after the stop holds to the flag (that is what 'immediate' means)"]
    unknowns = ["how the rest of the race plays out: tyre wear, weather, overtakes, further flags"]
    if maybe or worst_maybe:
        unknowns.append(f"cars {', '.join(map(str, sorted(set(maybe) | set(worst_maybe))))} are too close to call from lap-start times")
    return StrategyOption(key=key, label=label, condition=est.condition, compound_after=compound, position_now=pos, position_after=after_pos,
                          position_best=best_pos, position_worst=worst_pos, cars_passed=passed, cars_maybe=maybe, payout_now_cents=now,
                          payout_after_cents=after_cents, delta_cents=after_cents - now, delta_best_cents=best_cents - now, delta_worst_cents=worst_cents - now,
                          lines_lost=lost, lines_gained=gained, cost_cap_status=STOP_COST_CAP, pit_loss=_pit_loss_model(est),
                          pace=PaceNote(compound=compound, own_recent_s=pace.own_recent_s, field_fresh_s=pace.field_fresh_s, gain_per_lap_s=pace.gain_per_lap_s,
                                        laps_to_recover=pace.laps_to_recover, laps_remaining=pace.laps_remaining, samples=pace.own_samples, note=pace.note),
                          assumptions=assumptions, unknowns=unknowns)


def _summary(name: str, opts: list[StrategyOption], lowest: StrategyOption | None) -> str:
    choices = [o for o in opts if o.feasible and o.key != "pit_if_green"]
    stay = next((o for o in opts if o.key == "stay_out"), None)
    stop = next((o for o in opts if o.key == "pit_now"), None)
    if stay is None:
        return ""
    if all(o.delta_cents == 0 and o.delta_worst_cents == 0 for o in choices):
        tail = f"; a stop now rejoins about P{stop.position_after}" if stop and stop.position_after else ""
        return (f"No decision moves the current-position payout for {name}: P{stay.position_now} pays the same either way{tail}. "
                "The call is about pace and the finish, which is not priced here.")
    if stop is not None and lowest is not None and lowest.key == "stay_out":
        return (f"Staying out holds P{stay.position_now}; a stop now ({stop.condition.replace('_', ' ')}) rejoins about P{stop.position_after} "
                f"(P{stop.position_best}-P{stop.position_worst}) and moves {usd(stop.delta_cents)} of the provisional payout. "
                "Expected race-end value: forecast unavailable.")
    if lowest is not None:
        return f"{lowest.label}: {usd(lowest.delta_cents)} against staying out on the current-position payout. Expected race-end value: forecast unavailable."
    return ""


def compare(world: World, race: Race, state: RaceState, team_cars: list[int], as_of: str | None, drivers_meta, *, base=None, stops=None) -> list[CarComparison]:
    positions = state.classified_positions()
    base = base or if_finished_now(world, race, positions, as_of_utc=as_of, drivers_meta=drivers_meta)
    stops = measured_stops(state) if stops is None else stops
    cond = condition_of(state.flag_status)
    raining = bool(state.weather.rainfall)
    scheduled = getattr(race, "scheduled_laps", None)
    out: list[CarComparison] = []
    for car in team_cars:
        d = state.drivers.get(car)
        name = driver_name(world, state, car)
        mine = sum(l.amount_usd_cents for l in base.lines if l.car == car)
        cc = CarComparison(car=car, driver_name=name, status=d.status if d else "unknown", out_reason=d.out_reason if d else None,
                           position=positions.get(car), compound=d.compound if d else None, tyre_age_laps=d.tyre_age_laps if d else None, payout_now_cents=mine)
        if d is None or d.status in OUT:
            cc.summary = (f"{name} did not start; there is no decision to price." if d is not None and d.status == "dns"
                          else f"{name} is out of the race; there is no decision to price.")
            out.append(cc)
            continue
        if d.status == "stopped_candidate":
            cc.summary = (f"{name} has been stationary on track since {d.stopped_at[11:19] if d.stopped_at else '?'}Z: no strategy decision applies; "
                          "the incident case prices continue, repair and retire.")
            out.append(cc)
            continue
        now = base.amount_cents or 0
        stay = StrategyOption(key="stay_out", label="Stay out" if cond != "red_flag" else "Restart on the current set", condition=cond, compound_after=d.compound,
                              position_now=positions.get(car), position_after=positions.get(car), position_best=positions.get(car), position_worst=positions.get(car),
                              payout_now_cents=now, payout_after_cents=now, cost_cap_status="no spend",
                              assumptions=["the current position holds to the flag"],
                              unknowns=[f"tyre age grows from {d.tyre_age_laps if d.tyre_age_laps is not None else '?'} laps; no wear model is pretended"])
        opts = [stay]
        same, alt, why_alt = compound_choices(d.compound, raining)
        if cond == "red_flag":
            est = loss_estimate(state, "red_flag", stops)
            opts.append(StrategyOption(key="tyres_in_suspension", label=f"Fit fresh {same.lower()}s during the suspension", condition=cond, compound_after=same,
                                       position_now=positions.get(car), position_after=positions.get(car), position_best=positions.get(car),
                                       position_worst=positions.get(car), payout_now_cents=now, payout_after_cents=now, pit_loss=_pit_loss_model(est),
                                       cost_cap_status=STOP_COST_CAP, assumptions=[est.basis],
                                       unknowns=["how the race restarts (behind the Safety Car or a standing start)", "whether further repairs are permitted"]))
        else:
            est = loss_estimate(state, cond, stops)
            opts.append(_stop_option(world, race, state, base, positions, car, "pit_now", f"Pit now for fresh {same.lower()}s", est, same, as_of, drivers_meta, scheduled))
            if alt:
                o = _stop_option(world, race, state, base, positions, car, "pit_alt_compound", f"Pit now for {alt.lower()}s", est, alt, as_of, drivers_meta, scheduled)
                o.assumptions.append(f"{why_alt}; the position effect is the same stop, the compound changes only the pace that follows")
                if alt in ("SOFT", "MEDIUM", "HARD") and raining:
                    o.feasible, o.why_not = False, "rain is falling at the sensor: slicks are not a credible call"
                opts.append(o)
            if cond != "green":
                g = loss_estimate(state, "green", stops)
                o = _stop_option(world, race, state, base, positions, car, "pit_if_green", f"The same stop under green (after the {cond.replace('_', ' ')})", g, same,
                                 as_of, drivers_meta, scheduled)
                o.assumptions.insert(0, "a comparison, not a choice available now: what the stop costs once the neutralisation ends")
                opts.append(o)
        choices = [o for o in opts if o.feasible and o.key != "pit_if_green"]
        lowest = max(choices, key=lambda o: (o.delta_worst_cents, o.delta_cents, o.key == "stay_out")) if choices else None
        cc.options, cc.lowest_risk = opts, lowest.key if lowest else None
        cc.summary = _summary(name, opts, lowest)
        out.append(cc)
    return out
