"""The session's timing feed, indexed once and read strictly as of a moment: no row timed after `t` is ever used.

After Varun Sanjeev's decision cockpit (var-updated-live, live_racing/race_state.py): the reducer there only sees
events at or before the replay clock. Here the raw OpenF1 rows of the replay (state.replay.rows) are indexed once
per session and every query takes the moment `t` (epoch seconds) it is asked as of:

- a lap is known once it has started and its time once it has ended (date_start + lap_duration <= t);
- a stint's compound and starting age are known from the start of its first lap, never its end lap;
- a car did not start when no lap of its own started with the field by the time the leader began lap 3 (a pit-lane
  starter's lap 2 arrives after the leader's; a lone lap-1 record while the leader is on lap 32 is a feed artefact);
- a car is out per timing when the leader has put two laps on it and it has not crossed the line for three typical
  laps (a red-flag suspension is not lap time);
- the racing condition (green, vsc, sc, red) follows race control: a "VSC ENDING" or "SAFETY CAR IN THIS LAP" keeps
  the neutralisation until the track-wide CLEAR or GREEN.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass
from datetime import datetime, timezone
from statistics import median

# Race distance by circuit (laps scheduled). Each extra formation lap announced by race control takes one lap off it.
SCHEDULED_LAPS = {"Interlagos": 71, "Montreal": 70, "Melbourne": 58, "Las Vegas": 50, "Lusail": 57, "Yas Marina": 58}
WET = ("INTERMEDIATE", "WET")
NAMES = {"green": "green flag", "vsc": "Virtual Safety Car", "sc": "Safety Car", "red": "red flag"}


def ts(s: str | None) -> float | None:
    if not s:
        return None
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


@dataclass
class Lap:
    car: int
    n: int
    start: float | None
    dur: float | None
    pit_out: bool

    @property
    def end(self) -> float | None:
        return self.start + self.dur if self.start is not None and self.dur else None


@dataclass
class Pit:
    t: float
    car: int
    lap: int  # the in-lap: OpenF1 numbers a stop by the lap the car came in on; lap + 1 is the out-lap
    lane: float | None


@dataclass
class Stint:
    car: int
    lap_start: int
    compound: str
    age0: int
    known_at: float  # when the feed could know it: the start of its first lap (the grid set before the start)


class SessionIndex:
    """Every raw row of one session, indexed by car and time."""

    def __init__(self, rows: dict, session: dict):
        self.session = session
        self.circuit = session.get("circuit_short_name") or ""
        self.laps: dict[int, list[Lap]] = {}
        self.lap_at: dict[tuple[int, int], Lap] = {}
        self.by_lap: dict[int, list[Lap]] = {}
        for r in rows.get("laps", []):
            lap = Lap(int(r["driver_number"]), int(r["lap_number"]), ts(r.get("date_start")),
                      float(r["lap_duration"]) if r.get("lap_duration") else None, bool(r.get("is_pit_out_lap")))
            self.laps.setdefault(lap.car, []).append(lap)
            self.lap_at[(lap.car, lap.n)] = lap
            if lap.end is not None:
                self.by_lap.setdefault(lap.n, []).append(lap)
        for v in self.laps.values():
            v.sort(key=lambda x: x.n)
        # the leader starts each lap first: field lap at t = the highest lap whose first start is at or before t
        first: dict[int, float] = {}
        for lap in self.lap_at.values():
            if lap.start is not None and (lap.n not in first or lap.start < first[lap.n]):
                first[lap.n] = lap.start
        self.leader = sorted((t, n) for n, t in first.items())
        self._leader_t = [t for t, _ in self.leader]
        self._leader_max = []
        m = 0
        for _, n in self.leader:
            m = max(m, n)
            self._leader_max.append(m)

        self.pits = sorted((Pit(ts(r["date"]), int(r["driver_number"]), int(r.get("lap_number") or 0),
                                float(r["lane_duration"]) if r.get("lane_duration") else None)
                            for r in rows.get("pit", []) if r.get("date")), key=lambda p: (p.t, p.car))
        self._pit_t = [p.t for p in self.pits]

        self.stints: dict[int, list[Stint]] = {}
        start0 = ts(session.get("date_start")) or 0.0
        for r in rows.get("stints", []):
            car, ls = int(r["driver_number"]), int(r.get("lap_start") or 1)
            lap = self.lap_at.get((car, ls))
            known = start0 if ls <= 1 else (lap.start if lap and lap.start is not None else float("inf"))
            self.stints.setdefault(car, []).append(Stint(car, ls, (r.get("compound") or "").upper(), int(r.get("tyre_age_at_start") or 0), known))
        for v in self.stints.values():
            v.sort(key=lambda s: s.lap_start)

        self.positions: dict[int, tuple[list[float], list[int]]] = {}
        for r in sorted(rows.get("position", []), key=lambda r: r["date"]):
            t, p = self.positions.setdefault(int(r["driver_number"]), ([], []))
            t.append(ts(r["date"]))
            p.append(int(r["position"]))

        self.gaps: dict[int, tuple[list[float], list]] = {}
        for r in sorted(rows.get("intervals", []), key=lambda r: r["date"]):
            t, g = self.gaps.setdefault(int(r["driver_number"]), ([], []))
            t.append(ts(r["date"]))
            g.append(r.get("gap_to_leader"))

        self.drivers = {int(d["driver_number"]): d for d in rows.get("drivers", [])}
        self._conditions(rows.get("race_control", []))

    # ------------------------------------------------------------------ race control
    def _conditions(self, rc: list[dict]) -> None:
        cond = "green"
        self.cond_t: list[float] = []
        self.cond_v: list[str] = []
        self.red_end: list[float] = []  # when each suspension ended
        self.laps_lost: list[float] = []  # when race control announced a lap off the distance
        for r in sorted(rc, key=lambda r: r["date"]):
            t = ts(r["date"])
            msg = (r.get("message") or "").upper()
            cat, flag, scope = r.get("category"), r.get("flag"), r.get("scope")
            new = cond
            if cat == "SafetyCar":
                if "VIRTUAL" in msg and "DEPLOYED" in msg:
                    new = "vsc"
                elif "DEPLOYED" in msg:
                    new = "sc"
            elif cat == "Flag" and scope in (None, "Track"):
                if flag == "RED":
                    new = "red"
                elif flag in ("GREEN", "CLEAR"):
                    new = "green"
            if "FORMATION LAP WILL START" in msg or "EXTRA FORMATION LAP" in msg or msg == "ABORTED START":
                self.laps_lost.append(t)
            if new != cond:
                if cond == "red":
                    self.red_end.append(t)
                cond = new
                self.cond_t.append(t)
                self.cond_v.append(cond)

    def condition_at(self, t: float) -> str:
        i = bisect.bisect_right(self.cond_t, t)
        return self.cond_v[i - 1] if i else "green"

    def lap_condition(self, lap: Lap) -> str | None:
        """The condition a whole lap ran under, or None when it changed during the lap."""
        if lap.start is None or lap.end is None:
            return None
        a, b = self.condition_at(lap.start), self.condition_at(lap.end)
        if a != b:
            return None
        i, j = bisect.bisect_right(self.cond_t, lap.start), bisect.bisect_right(self.cond_t, lap.end)
        return a if i == j else None

    def scheduled_laps(self, t: float) -> tuple[int | None, str]:
        base = SCHEDULED_LAPS.get(self.circuit)
        if base is None:
            return None, f"race distance for {self.circuit or 'this circuit'} not in the desk's table"
        lost = sum(1 for x in self.laps_lost if x <= t)
        return base - lost, (f"{base} laps scheduled" + (f", less {lost} announced at the start procedure" if lost else ""))

    # ------------------------------------------------------------------ laps
    def field_lap(self, t: float) -> int:
        i = bisect.bisect_right(self._leader_t, t)
        return self._leader_max[i - 1] if i else 0

    def car_lap(self, car: int, t: float) -> int:
        """The car's lap now: the highest of its laps that has started (lap 1 has no start time in the feed)."""
        n = 0
        for lap in self.laps.get(car, []):
            if lap.start is not None and lap.start <= t:
                n = lap.n
        return n

    def completed(self, car: int, t: float) -> list[Lap]:
        return [x for x in self.laps.get(car, []) if x.end is not None and x.end <= t]

    def started(self, car: int, t: float) -> bool:
        """It started a lap with the field (within two laps of the leader at that moment)."""
        for lap in self.laps.get(car, []):
            if lap.start is not None and lap.start <= t and lap.n >= self.field_lap(lap.start) - 2:
                return True
        return False

    def dns(self, car: int, t: float) -> bool:
        return self.field_lap(t) >= 3 and not self.started(car, t)

    def typical_lap(self, t: float) -> float | None:
        fl = self.field_lap(t)
        vals = [x.dur for n in range(max(1, fl - 3), fl + 1) for x in self.by_lap.get(n, []) if x.end <= t and x.dur < 600]
        return float(median(vals)) if vals else None

    def out_per_timing(self, car: int, t: float) -> bool:
        if self.condition_at(t) == "red":
            return False
        mine = [x for x in self.laps.get(car, []) if x.start is not None and x.start <= t]
        if not mine:
            return False
        last = mine[-1]
        typical = self.typical_lap(t)
        if typical is None or self.field_lap(t) - last.n < 2:
            return False
        since = max([last.start] + [x for x in self.red_end if x <= t])
        return t - since > 3 * typical

    # ------------------------------------------------------------------ tyres
    def stint_at(self, car: int, lap_no: int, t: float) -> Stint | None:
        best = None
        for s in self.stints.get(car, []):
            if s.lap_start <= max(lap_no, 1) and s.known_at <= t:
                best = s
        return best

    def tyre(self, car: int, lap_no: int, t: float) -> tuple[str, int | None]:
        s = self.stint_at(car, lap_no, t)
        if s is None:
            return "", None
        return s.compound, s.age0 + max(0, lap_no - s.lap_start)

    # ------------------------------------------------------------------ order and gaps
    def position(self, car: int, t: float) -> int | None:
        rows = self.positions.get(car)
        if not rows:
            return None
        i = bisect.bisect_right(rows[0], t)
        return rows[1][i - 1] if i else None

    def gap(self, car: int, t: float):
        rows = self.gaps.get(car)
        if not rows:
            return None
        i = bisect.bisect_right(rows[0], t)
        return rows[1][i - 1] if i else None

    def pits_by(self, t: float) -> list[Pit]:
        return self.pits[: bisect.bisect_right(self._pit_t, t)]

    def name(self, car: int) -> str:
        d = self.drivers.get(car) or {}
        last = d.get("last_name") or (d.get("full_name") or "").split(" ")[-1]
        return last.title() if last else f"car {car}"


def gap_seconds(g, typical: float | None) -> tuple[float | None, bool]:
    """(seconds behind the leader, exact?). '+1 LAP' is at least a typical lap behind: a lower bound, not exact."""
    if isinstance(g, (int, float)):
        return float(g), True
    if isinstance(g, str) and "LAP" in g.upper():
        try:
            k = int(g.strip().lstrip("+").split()[0])
        except ValueError:
            k = 1
        return (k * typical if typical else None), False
    return None, False
