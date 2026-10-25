"""Strategic finance as of now: what a place, a pit stop and the tyres are worth (plan section 5).

Everything is arithmetic on the timing feed and the synthetic contracts. Gaps come from when each
car started its current lap; pit loss from this race's own pit-lane times; tyre context is age,
not a degradation model. Nothing here predicts; it prices the levers the pit wall actually has.
"""

from __future__ import annotations

from statistics import median

from finance.world import World

from .finance_projections import if_finished_now, usd
from .race_state import RaceState, _seconds_between
from .races import Race
from .schemas import PitScenario, PlaceValue, StrategyAdvice, Timestamps, TyreContext

DEFAULT_PIT_LOSS_S = 23.0  # a normal stop at Interlagos; replaced by this race's own median once stops are seen
NORMAL_STOP_MAX_S = 45.0  # lane times above this were red-flag standstills, not stops
SC_PIT_FACTOR = 0.5  # under a Safety Car the field is bunched and slow: a stop costs about half the track position
VSC_PIT_FACTOR = 0.6


def pit_loss(state: RaceState) -> tuple[float, str]:
    normal = [d for d in state.pit_lane_durations if d <= NORMAL_STOP_MAX_S]
    if normal:
        return float(median(normal)), f"median pit-lane time of the {len(normal)} normal stops seen so far in this race"
    return DEFAULT_PIT_LOSS_S, "default (no normal stop seen yet in this race)"


def effective_pit_loss(state: RaceState) -> tuple[float, str, str | None]:
    base, basis = pit_loss(state)
    flag = state.flag_status
    if flag == "RED_FLAG":
        return 0.0, basis + "; under a red flag tyres and repairs are free of track position", flag
    if flag in ("SAFETY_CAR", "SAFETY_CAR_ENDING"):
        return base * SC_PIT_FACTOR, basis + f"; x{SC_PIT_FACTOR} under the Safety Car (assumption: the field is bunched and slow)", flag
    if flag in ("VSC", "VSC_ENDING"):
        return base * VSC_PIT_FACTOR, basis + f"; x{VSC_PIT_FACTOR} under the Virtual Safety Car (assumption)", flag
    return base, basis, flag


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
        if other.status == "stopped_candidate":
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
    positions = state.positions()
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
    positions = state.positions()
    base = if_finished_now(world, race, positions, as_of_utc=as_of, drivers_meta=drivers_meta)
    loss, basis, under = effective_pit_loss(state)
    out = []
    for car in team_cars:
        pos = positions.get(car)
        passed, maybe = cars_behind_within(state, car, loss) if loss > 0 else ([], [])
        after = positions_after_losing(positions, car, len(passed))
        fc = if_finished_now(world, race, after, as_of_utc=as_of, drivers_meta=drivers_meta)
        delta = (fc.amount_cents or 0) - (base.amount_cents or 0)
        rejoin = (pos + len(passed)) if pos is not None else None
        text = (f"Pit now from P{pos}: about {loss:.0f}s in the lane, " + (f"rejoin P{rejoin} behind {', '.join(f'car {c}' for c in passed)}" if passed else f"rejoin P{rejoin}, nobody close enough to get past")
                + (f" (cars {', '.join(map(str, maybe))} too close to call)" if maybe else "") + f": {usd(delta) if delta < 0 else '+' + usd(delta)} on the sponsor exposure"
                + (f" under the {under.replace('_', ' ').lower()}" if under else "") + ". Indicative; no tyre or pace model.")
        out.append(PitScenario(car=car, position=pos, pit_loss_s=round(loss, 1), pit_loss_basis=basis, under=under, cars_passed=passed, cars_maybe=maybe,
                               positions_lost=len(passed), rejoin_position=rejoin, delta_cents=delta, text=text))
    return out


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
                    exposure_at_join: int | None, exposure_peak: int | None, finance_recomputed: str | None = None) -> StrategyAdvice:
    as_of = state.now_utc
    positions = state.positions()
    base = if_finished_now(world, race, positions, as_of_utc=as_of, drivers_meta=drivers_meta)
    now = base.amount_cents or 0
    w = state.weather
    weather_note = ("rain falling" if w.rainfall else "dry at the sensor") + (f", track {w.track_temperature_c}C" if w.track_temperature_c is not None else "") + \
        " (measurement, not a forecast)"
    return StrategyAdvice(
        race_id=race.race_id, version=version, as_of_utc=as_of or "", observed_at_utc=observed_at, lap=state.lap, flag_status=state.flag_status,
        exposure_now_cents=now, exposure_at_join_cents=exposure_at_join, exposure_peak_cents=exposure_peak,
        lost_from_peak_cents=(exposure_peak - now) if exposure_peak is not None else None,
        places=place_values(world, race, state, team_cars, as_of, drivers_meta), pit=pit_scenarios(world, race, state, team_cars, as_of, drivers_meta),
        tyres=tyre_context(state, team_cars), weather_note=weather_note,
        basis=f"positions and lap-start gaps from the timing feed as of {as_of}; contracts: Meridian's synthetic sponsors; pit loss from this race's stops",
        timestamps=Timestamps(source_event=as_of, adapter_received=observed_at, finance_recomputed=finance_recomputed))
