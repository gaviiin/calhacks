"""What a pit stop costs in race time, measured from this race's own stops, by racing condition.

A stop's cost is not the pit-lane time: it is how much more time the car spends on its in-lap and
out-lap than the cars that stayed out spent on the same two laps. That is measured here for every
stop whose out-lap has finished, grouped by the condition the stop was made under (green, VSC,
Safety Car). When a condition has no measured stop yet, the estimate is derived from the green
measurement and how much slower the field is lapping now, and says so. Nothing in this file uses a
fixed "half the loss under a Safety Car"; a red flag is a suspension, priced separately.

Tyre pace is evidence, not a forecast: recent green-flag laps on each compound in the field, and the
car's own recent laps. It answers "is a fresh set faster, by about how much, on what sample", never
"where will the car finish".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median

from .race_state import CompletedLap, RaceState, condition_of

NORMAL_STOP_MAX_S = 45.0  # pit-lane times above this were red-flag standstills, not stops
PRIOR_GREEN_LOSS_S = 23.0  # a normal stop at Interlagos, used only until this race has measured one; labelled a prior
MAX_PLAUSIBLE_LOSS_S = 60.0
CONDITION_WORDS = {"green": "green flag", "vsc": "Virtual Safety Car", "safety_car": "Safety Car", "red_flag": "red flag"}


@dataclass
class MeasuredStop:
    car: int
    lap: int
    condition: str
    loss_s: float
    lane_s: float | None
    reference_s: float  # the field's in-lap + out-lap on the same two laps
    at: str


@dataclass
class LossEstimate:
    condition: str
    seconds: float | None
    low_s: float | None
    high_s: float | None
    method: str  # measured | derived | prior | unmeasured | suspension
    samples: int
    basis: str
    measured: list[MeasuredStop] = field(default_factory=list)


def _clean(lap: CompletedLap | None) -> float | None:
    return lap.duration if lap is not None and lap.duration and lap.duration < 600 else None


def _field_median(state: RaceState, lap_no: int, exclude: set[int]) -> float | None:
    vals = [x.duration for (car, n), x in state.completed_laps.items() if n == lap_no and car not in exclude and x.duration and not x.pit_out and x.duration < 600]
    return float(median(vals)) if len(vals) >= 3 else None


def measured_stops(state: RaceState) -> list[MeasuredStop]:
    """Every stop whose out-lap has finished, priced against the cars that stayed out on the same laps."""
    pitted_on: dict[int, set[int]] = {}
    for p in state.pit_records:
        pitted_on.setdefault(p.lap, set()).add(p.car)
        pitted_on.setdefault(p.lap + 1, set()).add(p.car)
    out: list[MeasuredStop] = []
    for p in state.pit_records:
        if p.lane_duration is not None and p.lane_duration > NORMAL_STOP_MAX_S:
            continue  # a red-flag standstill in the lane, not a stop
        car_in, car_out = _clean(state.completed_laps.get((p.car, p.lap))), _clean(state.completed_laps.get((p.car, p.lap + 1)))
        if car_in is None or car_out is None:
            continue
        exclude = pitted_on.get(p.lap, set()) | pitted_on.get(p.lap + 1, set())
        ref_in, ref_out = _field_median(state, p.lap, exclude), _field_median(state, p.lap + 1, exclude)
        if ref_in is None or ref_out is None:
            continue
        loss = (car_in + car_out) - (ref_in + ref_out)
        if not 0 < loss < MAX_PLAUSIBLE_LOSS_S:
            continue  # a spin or an incident on the in- or out-lap, not the stop
        out.append(MeasuredStop(p.car, p.lap, condition_of(p.flag), round(loss, 1), p.lane_duration, round(ref_in + ref_out, 1), p.at))
    return out


def _recent_field_lap(state: RaceState, condition: str) -> float | None:
    """The field's median lap on the most recent lap completed wholly under this condition."""
    laps = sorted({x.lap for x in state.completed_laps.values() if condition_of(x.flag) == condition and x.duration}, reverse=True)
    for n in laps[:3]:
        vals = [x.duration for x in state.completed_laps.values() if x.lap == n and condition_of(x.flag) == condition and x.duration and not x.pit_out and x.duration < 600]
        if len(vals) >= 5:
            return float(median(vals))
    return None


def loss_estimate(state: RaceState, condition: str | None = None, stops: list[MeasuredStop] | None = None) -> LossEstimate:
    cond = condition or condition_of(state.flag_status)
    stops = measured_stops(state) if stops is None else stops
    if cond == "red_flag":
        return LossEstimate(cond, 0.0, 0.0, 0.0, "suspension", 0,
                            "the race is suspended: the Sporting Regulations allow tyre changes in the pit lane while it is, so a tyre change "
                            "costs no track position; work beyond that is restricted, and a car that stopped on track cannot reach the lane")
    mine = [s for s in stops if s.condition == cond]
    if mine:
        vals = [s.loss_s for s in mine]
        return LossEstimate(cond, round(float(median(vals)), 1), min(vals), max(vals), "measured", len(vals),
                            f"median of {len(vals)} stop(s) measured under the {CONDITION_WORDS[cond]} in this race: in-lap + out-lap against the cars "
                            "that stayed out on the same laps", mine)
    green = [s for s in stops if s.condition == "green"]
    if cond == "green":
        return LossEstimate(cond, PRIOR_GREEN_LOSS_S, PRIOR_GREEN_LOSS_S - 3, PRIOR_GREEN_LOSS_S + 3, "prior", 0,
                            "no green-flag stop measured yet in this race; a typical Interlagos stop (a prior, not a measurement)")
    lanes = [d for d in state.pit_lane_durations if d <= NORMAL_STOP_MAX_S]
    green_lap, cond_lap = _recent_field_lap(state, "green"), _recent_field_lap(state, cond)
    g = [s.loss_s for s in green] or [PRIOR_GREEN_LOSS_S]
    if lanes and green_lap and cond_lap and cond_lap > green_lap:
        lane = float(median(lanes))
        # The cars that stay out cover the pit-lane bypass in (lane - green loss) seconds at green pace; at the
        # field's current pace that stretch takes longer, so the stop costs less. Same geometry, measured lap times.
        slow = cond_lap / green_lap
        est = [max(0.0, lane - (lane - x) * slow) for x in g]
        mid = float(median(est))
        return LossEstimate(cond, round(mid, 1), round(min(est), 1), round(max(est), 1), "derived", len(green),
                            f"no stop measured under the {CONDITION_WORDS[cond]} yet: derived from {'the ' + str(len(green)) + ' green stop(s)' if green else 'the green prior'} "
                            f"and the field lapping {slow:.2f}x slower now ({cond_lap:.0f}s against {green_lap:.0f}s); pit lane {lane:.1f}s")
    hi = float(median(g))
    return LossEstimate(cond, None, round(hi * 0.3, 1), round(hi, 1), "unmeasured", 0,
                        f"no stop measured under the {CONDITION_WORDS[cond]} and no full lap at its pace yet: anywhere from about a third of a green "
                        f"stop to a full one ({hi:.0f}s); shown as a range, not a point")


def all_estimates(state: RaceState) -> list[LossEstimate]:
    stops = measured_stops(state)
    return [loss_estimate(state, c, stops) for c in ("green", "vsc", "safety_car")] + ([loss_estimate(state, "red_flag", stops)] if state.flag_status == "RED_FLAG" else [])


# ---------------------------------------------------------------- tyre pace evidence


@dataclass
class PaceEvidence:
    compound: str | None
    own_recent_s: float | None
    own_samples: int
    field_fresh_s: float | None  # the field on this compound with a young set (age <= 5), recent green laps
    field_fresh_samples: int
    gain_per_lap_s: float | None  # own recent minus field fresh: positive = a fresh set is faster
    laps_to_recover: float | None
    laps_remaining: int | None
    note: str


def _green_laps(state: RaceState, window: int) -> list[CompletedLap]:
    if state.lap is None:
        return []
    in_laps = {(p.car, p.lap) for p in state.pit_records}
    return [x for x in state.completed_laps.values() if x.lap >= state.lap - window and condition_of(x.flag) == "green" and x.duration and not x.pit_out
            and x.duration < 600 and (x.car, x.lap) not in in_laps]


def pace_evidence(state: RaceState, car: int, compound: str | None, loss_s: float | None, scheduled_laps: int | None) -> PaceEvidence:
    """Lap by lap over the recent green laps: this car's time against the field on a young set of
    `compound` on the same lap, so the weather and the track evolution are the same on both sides."""
    window = 8
    laps = _green_laps(state, window)
    mine = {x.lap: x.duration for x in laps if x.car == car}
    fresh_by_lap: dict[int, list[float]] = {}
    for x in laps:
        if x.car != car and x.compound == compound and x.tyre_age is not None and x.tyre_age <= 5:
            fresh_by_lap.setdefault(x.lap, []).append(x.duration)
    pairs = [(mine[n], float(median(v))) for n, v in fresh_by_lap.items() if n in mine and len(v) >= 2]
    n_fresh = sum(len(v) for n, v in fresh_by_lap.items() if n in mine)
    remaining = (scheduled_laps - state.lap) if scheduled_laps and state.lap else None
    word = f"fresh {compound.lower()}s" if compound else "a fresh set"
    if len(pairs) < 2:
        return PaceEvidence(compound, None, len(mine), None, n_fresh, None, None, remaining,
                            f"not enough shared green-flag laps in the last {window} to compare this car with the field on {word} "
                            f"({len(pairs)} lap(s) with both); no pace figure is given")
    own_s = float(median([a for a, _ in pairs]))
    fresh_s = float(median([b for _, b in pairs]))
    gain = round(float(median([a - b for a, b in pairs])), 2)
    recover = round(loss_s / gain, 1) if gain > 0.05 and loss_s else None
    if gain > 0.05:
        note = (f"on the same {len(pairs)} green laps the field on {word} was about {gain:.1f}s a lap quicker than this car "
                + (f"(the stop pays back its time in about {recover:.0f} laps" + (f" of the {remaining} left)" if remaining is not None else ")") if recover else "")
                + "; evidence, not a forecast")
    else:
        note = (f"on the same {len(pairs)} green laps the field on {word} was " + (f"{-gain:.1f}s a lap slower than this car" if gain < -0.05 else "level with this car")
                + "; no pace case for a stop")
    return PaceEvidence(compound, round(own_s, 2), len(pairs), round(fresh_s, 2), n_fresh, gain, recover, remaining, note)
