"""What a pit stop costs in race time, measured from this race's own stops, by racing condition; and tyre pace evidence.

After Varun Sanjeev's decision cockpit (var-updated-live, live_racing/pit_model.py). A stop's cost is not the
pit-lane time: it is how much longer the car spends on its in-lap and out-lap than the cars that stayed out took
over the same two laps. Measured here for every stop whose out-lap has finished by now, grouped by the condition the
stop was made under. When a condition has no measured stop yet, the figure is derived from the green measurement and
how much slower the field is lapping under the condition, and says so; with no lap at that pace yet it is a range,
never a point. There is no fixed "a stop under the Safety Car costs half" factor anywhere. A red flag is a
suspension: a tyre change in the pit lane costs no track position, but repairs are restricted and parts are not free.

Tyre pace is evidence, not a forecast: this car's recent green laps against the field on a young set of a compound
on the same laps, so the weather and the track are the same on both sides.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median

from race.cockpit.timing import NAMES, Lap, SessionIndex

NORMAL_STOP_MAX_S = 45.0  # pit-lane times above this were red-flag standstills in the lane, not stops
PRIOR_GREEN_LOSS_S = 23.0  # a typical Interlagos stop, used only until this race has measured one; labelled a prior
MAX_PLAUSIBLE_LOSS_S = 60.0
PACE_WINDOW = 8
FRESH_AGE = 5


@dataclass
class MeasuredStop:
    car: int
    lap: int
    condition: str
    loss_s: float
    lane_s: float | None


@dataclass
class LossEstimate:
    condition: str
    seconds: float | None  # None when only a range is honest
    low_s: float
    high_s: float
    method: str  # measured | derived | prior | unmeasured | suspension
    samples: int
    basis: str
    stops: list[MeasuredStop] = field(default_factory=list)

    @property
    def mid(self) -> float:
        return self.seconds if self.seconds is not None else (self.low_s + self.high_s) / 2

    def wire(self) -> dict:
        return {"condition": self.condition, "seconds": self.seconds, "low": self.low_s, "high": self.high_s, "method": self.method,
                "samples": self.samples, "basis": self.basis}


def _clean(lap: Lap | None, t: float) -> float | None:
    if lap is None or lap.end is None or lap.end > t or not lap.dur or lap.dur >= 600:
        return None
    return lap.dur


def _field_median(idx: SessionIndex, n: int, exclude: set[int], t: float) -> float | None:
    vals = [x.dur for x in idx.by_lap.get(n, []) if x.car not in exclude and x.end <= t and not x.pit_out and x.dur < 600]
    return float(median(vals)) if len(vals) >= 3 else None


def measured_stops(idx: SessionIndex, t: float) -> list[MeasuredStop]:
    """Every stop whose out-lap has finished by `t`, priced against the cars that stayed out on the same two laps."""
    pits = idx.pits_by(t)
    pitted_on: dict[int, set[int]] = {}
    for p in pits:
        pitted_on.setdefault(p.lap, set()).add(p.car)
        pitted_on.setdefault(p.lap + 1, set()).add(p.car)
    out: list[MeasuredStop] = []
    for p in pits:
        if p.lane is not None and p.lane > NORMAL_STOP_MAX_S:
            continue
        a, b = _clean(idx.lap_at.get((p.car, p.lap)), t), _clean(idx.lap_at.get((p.car, p.lap + 1)), t)
        if a is None or b is None:
            continue
        ex = pitted_on.get(p.lap, set()) | pitted_on.get(p.lap + 1, set())
        ra, rb = _field_median(idx, p.lap, ex, t), _field_median(idx, p.lap + 1, ex, t)
        if ra is None or rb is None:
            continue
        loss = (a + b) - (ra + rb)
        if not 0 < loss < MAX_PLAUSIBLE_LOSS_S:
            continue  # a spin or an incident on the in- or out-lap, not the stop
        out.append(MeasuredStop(p.car, p.lap, idx.condition_at(p.t), round(loss, 1), p.lane))
    return out


def _recent_field_lap(idx: SessionIndex, cond: str, t: float) -> float | None:
    """The field's median on the most recent lap completed wholly under `cond` by at least five cars."""
    for n in range(idx.field_lap(t), 0, -1):
        vals = [x.dur for x in idx.by_lap.get(n, []) if x.end <= t and not x.pit_out and x.dur < 600 and idx.lap_condition(x) == cond]
        if len(vals) >= 5:
            return float(median(vals))
    return None


def loss_estimate(idx: SessionIndex, cond: str, t: float, stops: list[MeasuredStop]) -> LossEstimate:
    if cond == "red":
        return LossEstimate("red", 0.0, 0.0, 0.0, "suspension", 0,
                            "the race is suspended: tyres may be changed in the pit lane, so a tyre change costs no track position; "
                            "other work is restricted, a repair is not free, and a car stopped on track cannot reach the lane")
    mine = [s for s in stops if s.condition == cond]
    if mine:
        v = [s.loss_s for s in mine]
        return LossEstimate(cond, round(float(median(v)), 1), min(v), max(v), "measured", len(v),
                            f"median of {len(v)} stop{'s' if len(v) != 1 else ''} measured under the {NAMES[cond]} in this race: in-lap + "
                            "out-lap against the cars that stayed out on the same laps", mine)
    green = [s.loss_s for s in stops if s.condition == "green"]
    if cond == "green":
        return LossEstimate("green", None, PRIOR_GREEN_LOSS_S - 3, PRIOR_GREEN_LOSS_S + 3, "prior", 0,
                            f"no green-flag stop measured yet in this race: a typical stop here is about {PRIOR_GREEN_LOSS_S:.0f}s "
                            "(a prior, not a measurement), shown as a range")
    lanes = [p.lane for p in idx.pits_by(t) if p.lane is not None and p.lane <= NORMAL_STOP_MAX_S]
    g_lap, c_lap = _recent_field_lap(idx, "green", t), _recent_field_lap(idx, cond, t)
    g = green or [PRIOR_GREEN_LOSS_S]
    if lanes and g_lap and c_lap and c_lap > g_lap:
        lane = float(median(lanes))
        slow = c_lap / g_lap
        # The cars that stay out cover the pit-lane bypass in (lane - green loss) s at green pace; at the field's pace now
        # that stretch takes longer, so the stop costs less. Same geometry, measured lap times.
        est = [max(0.0, lane - (lane - x) * slow) for x in g]
        return LossEstimate(cond, round(float(median(est)), 1), round(min(est), 1), round(max(est), 1), "derived", len(green),
                            f"no stop measured under the {NAMES[cond]} yet: derived from "
                            + (f"{len(green)} green stop{'s' if len(green) != 1 else ''}" if green else "the green prior")
                            + f" and the field lapping {slow:.2f}x slower ({c_lap:.0f}s against {g_lap:.0f}s); pit lane {lane:.1f}s")
    hi = float(median(g))
    return LossEstimate(cond, None, round(hi * 0.3, 1), round(hi, 1), "unmeasured", 0,
                        f"no stop measured under the {NAMES[cond]} and no full lap at its pace yet: from about a third of a green "
                        f"stop to a full one ({hi:.0f}s), a range, not a point")


# ---------------------------------------------------------------------- tyre pace evidence

@dataclass
class Pace:
    compound: str
    own_s: float | None
    field_s: float | None
    gain_s: float | None  # positive: the field on a young set of `compound` was quicker than this car
    pairs: int
    laps_to_recover: float | None
    note: str

    def wire(self) -> dict:
        return {"compound": self.compound, "own_s": self.own_s, "field_fresh_s": self.field_s, "gain_per_lap_s": self.gain_s,
                "laps_compared": self.pairs, "laps_to_recover": self.laps_to_recover, "note": self.note}


def pace_evidence(idx: SessionIndex, car: int, compound: str, loss_s: float, laps_left: int | None, t: float) -> Pace:
    fl = idx.field_lap(t)
    in_laps = {(p.car, p.lap) for p in idx.pits_by(t)}
    mine: dict[int, float] = {}
    fresh: dict[int, list[float]] = {}
    for n in range(max(1, fl - PACE_WINDOW), fl + 1):
        for x in idx.by_lap.get(n, []):
            if x.end > t or x.pit_out or x.dur >= 600 or (x.car, x.n) in in_laps or idx.lap_condition(x) != "green":
                continue
            if x.car == car:
                mine[n] = x.dur
                continue
            comp, age = idx.tyre(x.car, n, t)
            if comp == compound and age is not None and age <= FRESH_AGE:
                fresh.setdefault(n, []).append(x.dur)
    pairs = [(mine[n], float(median(v))) for n, v in fresh.items() if n in mine and len(v) >= 2]
    word = f"fresh {compound.lower()}s" if compound else "a fresh set"
    if len(pairs) < 2:
        return Pace(compound, None, None, None, len(pairs), None,
                    f"not enough shared green laps in the last {PACE_WINDOW} to compare with the field on {word} ({len(pairs)}): no pace figure")
    own = float(median(a for a, _ in pairs))
    fs = float(median(b for _, b in pairs))
    gain = round(float(median(a - b for a, b in pairs)), 2)
    rec = round(loss_s / gain, 1) if gain > 0.05 and loss_s > 0 else None
    if gain > 0.05:
        note = (f"on {len(pairs)} shared green laps the field on {word} was {gain:.1f}s a lap quicker"
                + (f": the stop's time back in about {rec:.0f} laps" + (f" of {laps_left} left" if laps_left is not None else "") if rec else "")
                + "; evidence, not a forecast")
    else:
        note = (f"on {len(pairs)} shared green laps the field on {word} was "
                + (f"{-gain:.1f}s a lap slower" if gain < -0.05 else "level") + ": no pace case from the laps")
    return Pace(compound, round(own, 2), round(fs, 2), gain, len(pairs), rec, note)
