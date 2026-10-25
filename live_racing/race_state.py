"""Rolling race state, built strictly as-of the events it has been given (no lookahead).

The reducer only ever sees events whose `event_time_utc` is at or before the replay clock. It
knows a tyre's compound and starting age but never its end lap, a lap once it has started and
its time once it has ended, a car's position when the timing feed changed it, and a car's speed
only in the window car_data was downloaded for. Everything else is None.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import timedelta

from .normalize import NormalizedEvent
from .openf1_client import parse_openf1_time
from .schemas import DriverState, Weather

# Global flag status from race control. Sector-scoped flags never change the track status.
_FLAGS = {
    "RED": "RED_FLAG",
    "CHEQUERED": "FINISHED",
    "GREEN": "GREEN",
    "CLEAR": "GREEN",
}


# A car that cannot score: it never started, or the timing feed shows it out. Neither is a
# finishing position, so neither enters the if-finished-now arithmetic.
OUT = ("dns", "retired")


def condition_of(flag: str | None) -> str:
    """The racing condition a flag status puts the field under, for measuring stops by condition."""
    if flag in ("VSC", "VSC_ENDING"):
        return "vsc"
    if flag in ("SAFETY_CAR", "SAFETY_CAR_ENDING"):
        return "safety_car"
    if flag == "RED_FLAG":
        return "red_flag"
    return "green"


@dataclass
class CompletedLap:
    car: int
    lap: int
    duration: float | None
    completed_at: str
    flag: str | None
    compound: str | None
    tyre_age: int | None
    pit_out: bool


@dataclass
class PitRecord:
    car: int
    lap: int  # the in-lap: OpenF1 numbers the stop by the lap the car came in on; lap + 1 is the out-lap
    at: str
    flag: str | None
    lane_duration: float | None


@dataclass
class DriverTrack:
    number: int
    acronym: str | None = None
    team: str | None = None
    full_name: str | None = None
    position: int | None = None
    lap: int | None = None
    lap_started_at: str | None = None
    compound: str | None = None
    tyre_age_at_start: int | None = None
    stint_lap_start: int | None = None
    last_pit_lap: int | None = None
    last_pit_at: str | None = None
    last_lap_duration: float | None = None
    status: str = "unknown"
    speed: int | None = None
    speed_at: str | None = None
    zero_since: str | None = None
    stopped_at: str | None = None
    flag_at_stop: str | None = None
    xyz: tuple | None = None
    out_reason: str | None = None
    out_at: str | None = None

    @property
    def tyre_age_laps(self) -> int | None:
        if self.lap is None or self.stint_lap_start is None or self.tyre_age_at_start is None:
            return None
        return max(0, self.lap - self.stint_lap_start) + self.tyre_age_at_start

    def to_state(self) -> DriverState:
        return DriverState(driver_number=self.number, name_acronym=self.acronym, full_name=self.full_name, team=self.team,
                           position=None if self.status == "dns" else self.position, lap=self.lap,
                           compound=self.compound, tyre_age_laps=self.tyre_age_laps, last_pit_lap=self.last_pit_lap,
                           status=self.status if self.status in ("running", "in_pit", "stopped_candidate", "dns", "retired") else "unknown",
                           out_reason=self.out_reason)


def _seconds_between(a: str, b: str) -> float:
    return (parse_openf1_time(b) - parse_openf1_time(a)).total_seconds()


class RaceState:
    def __init__(self, race_id: str, session_key: int, drivers_meta: list[dict], team_cars: list[int], *,
                 stop_threshold_s: float = 8.0, pit_grace_s: float = 45.0, withdrawals: tuple | list = ()):
        self.race_id = race_id
        self.session_key = session_key
        self.team_cars = list(team_cars)
        self.stop_threshold_s = stop_threshold_s
        self.pit_grace_s = pit_grace_s
        self.drivers: dict[int, DriverTrack] = {}
        for d in drivers_meta:
            n = int(d["driver_number"])
            self.drivers[n] = DriverTrack(n, d.get("name_acronym"), d.get("team_name"), d.get("full_name"))
        for w in withdrawals:  # known before the start (races.Withdrawal), so usable from the first record
            d = self.driver(int(w.driver_number))
            d.status, d.out_reason = "dns", f"did not start: {w.note} (known from {w.known_from})"
        self.now_utc: str | None = None
        self.lap: int | None = None
        self.flag_status: str | None = None
        self.weather = Weather()
        self.recent_race_control: list[dict] = []
        self.pit_lane_durations: list[float] = []
        self.resumed_at: str | None = None  # when the last red-flag suspension ended
        self.completed_laps: dict[tuple[int, int], CompletedLap] = {}
        self.pit_records: list[PitRecord] = []
        self.events_applied = 0
        self.last_event: NormalizedEvent | None = None

    # ------------------------------------------------------------------ reducer

    def driver(self, n: int) -> DriverTrack:
        if n not in self.drivers:
            self.drivers[n] = DriverTrack(n)
        return self.drivers[n]

    def apply(self, ev: NormalizedEvent) -> list[str]:
        """Apply one event; return the aspects that changed (for the trigger engine and the publisher)."""
        if self.now_utc and ev.event_time_utc < self.now_utc:
            raise ValueError(f"event {ev.event_id} at {ev.event_time_utc} is earlier than the state clock {self.now_utc}; "
                             "the replay must feed events in order")
        self.now_utc = ev.event_time_utc
        self.events_applied += 1
        self.last_event = ev
        p = ev.payload
        changes: list[str] = []
        ep = ev.endpoint
        if ep == "weather":
            self.weather = Weather(observed_at_utc=ev.event_time_utc, rainfall=p.get("rainfall"), track_temperature_c=p.get("track_temperature"),
                                   air_temperature_c=p.get("air_temperature"), humidity=p.get("humidity"), wind_speed=p.get("wind_speed"),
                                   wind_direction=p.get("wind_direction"))
            changes.append("weather")
        elif ep == "race_control":
            self.recent_race_control.append({**p, "event_time_utc": ev.event_time_utc})
            del self.recent_race_control[:-30]
            changes.append("race_control")
            new_flag = self._flag_from(p)
            if new_flag and new_flag != self.flag_status:
                if self.flag_status == "RED_FLAG":
                    self.resumed_at = ev.event_time_utc
                self.flag_status = new_flag
                changes.append(f"flag:{new_flag}")
        elif ep == "pit":
            d = self.driver(int(p["driver_number"]))
            d.last_pit_lap = p.get("lap_number")
            d.last_pit_at = ev.event_time_utc
            d.status = "in_pit"
            if p.get("lane_duration"):
                self.pit_lane_durations.append(float(p["lane_duration"]))
            if p.get("lap_number") is not None:
                self.pit_records.append(PitRecord(d.number, int(p["lap_number"]), ev.event_time_utc, self.flag_status,
                                                  float(p["lane_duration"]) if p.get("lane_duration") else None))
            changes.append(f"pit:{d.number}")
        elif ep == "stint_start":
            d = self.driver(int(p["driver_number"]))
            d.compound = p.get("compound")
            d.tyre_age_at_start = p.get("tyre_age_at_start")
            d.stint_lap_start = p.get("lap_start")
            changes.append(f"stint:{d.number}")
        elif ep == "lap_start":
            d = self.driver(int(p["driver_number"]))
            d.lap = p.get("lap_number")
            d.lap_started_at = ev.event_time_utc
            if d.status in ("in_pit", "unknown"):
                d.status = "running"
            elif d.status == "dns" and (d.lap or 0) >= (self.lap or 0) - 2:
                # the timing feed outranks an inference: a car that starts a lap with the field is racing (a pit-lane starter's
                # late lap 2). A lone lap-1 record while the leader is on lap 32 is a feed artefact, not a start.
                d.status, d.out_reason, d.out_at = "running", None, None
                changes.append(f"started:{d.number}")
            leader_lap = max((t.lap for t in self.drivers.values() if t.lap is not None), default=None)
            if leader_lap != self.lap:
                self.lap = leader_lap
                changes.append("lap")
                changes += self._out_per_timing(ev.event_time_utc)
        elif ep == "lap_complete":
            d = self.driver(int(p["driver_number"]))
            d.last_lap_duration = p.get("lap_duration")
            if p.get("lap_number") is not None:
                lap_no = int(p["lap_number"])
                self.completed_laps[(d.number, lap_no)] = CompletedLap(
                    d.number, lap_no, float(p["lap_duration"]) if p.get("lap_duration") else None, ev.event_time_utc, self.flag_status,
                    d.compound, d.tyre_age_laps, bool(p.get("is_pit_out_lap")))
        elif ep == "position":
            d = self.driver(int(p["driver_number"]))
            pos = p.get("position")
            if pos != d.position:
                d.position = pos
                changes.append(f"position:{d.number}")
        elif ep == "car_data":
            changes += self._car_data(ev)
        elif ep == "location":
            d = self.driver(int(p["driver_number"]))
            d.xyz = (p.get("x"), p.get("y"), p.get("z"))
        return changes

    def _out_per_timing(self, t: str) -> list[str]:
        """The leader started a new lap. From lap 3, a car that has started no lap did not start (lap 3, not 2:
        a pit-lane starter has no lap-1 record and its lap 2 arrives after the leader's); a car
        the leader has put two laps on and that has not crossed the line for three typical laps is out.
        Both are read from the timing feed as it stood, never from the classification."""
        changes: list[str] = []
        if self.lap is None or self.flag_status == "RED_FLAG":
            return changes
        if self.lap >= 3:
            for d in self.drivers.values():
                if d.lap is None and d.status not in OUT:
                    d.status, d.out_at = "dns", t
                    d.out_reason = f"did not start: no lap started by the time the leader began lap {self.lap} (timing feed)"
                    changes.append(f"dns:{d.number}")
        recent = [x.duration for x in self.completed_laps.values() if x.duration and x.lap >= self.lap - 3]
        typical = sorted(recent)[len(recent) // 2] if recent else None
        for d in self.drivers.values():
            if d.status in OUT or d.lap is None or not d.lap_started_at or typical is None:
                continue
            since = max(d.lap_started_at, self.resumed_at) if self.resumed_at else d.lap_started_at  # a suspension is not lap time
            if self.lap - d.lap >= 2 and _seconds_between(since, t) > 3 * typical:
                d.status, d.out_at = "retired", t
                d.out_reason = (f"out per timing: last started lap {d.lap} at {d.lap_started_at[11:19]}Z; the leader is on lap {self.lap}"
                                + (f"; stationary since {d.stopped_at[11:19]}Z" if d.stopped_at else ""))
                changes.append(f"retired:{d.number}")
        return changes

    def mark_retired(self, n: int, t: str | None, reason: str) -> None:
        d = self.driver(n)
        if d.status != "retired":
            d.status, d.out_at, d.out_reason = "retired", t, reason

    def _flag_from(self, p: dict) -> str | None:
        cat, msg, flag, scope = p.get("category"), (p.get("message") or "").upper(), p.get("flag"), p.get("scope")
        if cat == "SafetyCar":
            if "VIRTUAL SAFETY CAR DEPLOYED" in msg:
                return "VSC"
            if "VIRTUAL SAFETY CAR ENDING" in msg:
                return "VSC_ENDING"
            if "SAFETY CAR DEPLOYED" in msg:
                return "SAFETY_CAR"
            if "SAFETY CAR IN THIS LAP" in msg:
                return "SAFETY_CAR_ENDING"
            return None
        if cat == "Flag" and scope in (None, "Track") and flag in _FLAGS:
            return _FLAGS[flag]
        return None

    def _car_data(self, ev: NormalizedEvent) -> list[str]:
        p = ev.payload
        d = self.driver(int(p["driver_number"]))
        speed = p.get("speed")
        d.speed, d.speed_at = speed, ev.event_time_utc
        if speed is None:
            return []
        changes: list[str] = []
        if speed == 0:
            if d.zero_since is None:
                d.zero_since = ev.event_time_utc
            still = _seconds_between(d.zero_since, ev.event_time_utc)
            in_pit_grace = d.last_pit_at is not None and 0 <= _seconds_between(d.last_pit_at, ev.event_time_utc) <= self.pit_grace_s
            if still >= self.stop_threshold_s and d.status != "stopped_candidate" and not in_pit_grace and self.flag_status != "RED_FLAG":
                d.status = "stopped_candidate"
                d.stopped_at = d.zero_since
                d.flag_at_stop = self.flag_status
                changes.append(f"stopped:{d.number}")
        else:
            d.zero_since = None
            if d.status == "stopped_candidate" and speed > 30:
                d.status = "running"
                changes.append(f"resumed:{d.number}")
        return changes

    # ------------------------------------------------------------------ views

    def positions(self) -> dict[int, int | None]:
        return {n: t.position for n, t in self.drivers.items()}

    def classified_positions(self) -> dict[int, int | None]:
        """The running order the money is computed on: cars that did not start or are out are left
        out (they cannot score), and the cars behind a gap they left move up. Position records alone
        are never taken as proof a car is racing."""
        running = sorted((t for t in self.drivers.values() if t.position is not None and t.status not in OUT), key=lambda t: (t.position, t.number))
        out = {t.number: i + 1 for i, t in enumerate(running)}
        for n, t in self.drivers.items():
            out.setdefault(n, None)
        return out

    def driver_states(self) -> list[DriverState]:
        return [t.to_state() for t in sorted(self.drivers.values(), key=lambda t: (t.position is None, t.position or 0, t.number))]

    def team_positions(self) -> dict[int, int | None]:
        cp = self.classified_positions()
        return {n: cp.get(n) for n in self.team_cars}

    def leader_lap_start(self, lap: int) -> str | None:
        """Earliest known start of `lap` among drivers (the leader starts a lap first)."""
        starts = [t.lap_started_at for t in self.drivers.values() if t.lap == lap and t.lap_started_at]
        return min(starts) if starts else None


CAR_RE = re.compile(r"CARS?\s+(\d{1,2})(?:\s*\([A-Z]{3}\))?(?:\s+AND\s+(\d{1,2}))?")


def cars_in_message(message: str) -> list[int]:
    """Car numbers a race-control message names ("CARS 81 (PIA) AND 30 (LAW)", "CAR 43 (COL)")."""
    out: list[int] = []
    for m in CAR_RE.finditer(message or ""):
        for g in m.groups():
            if g and int(g) not in out:
                out.append(int(g))
    return out


def lap_start_times(events: list[NormalizedEvent]) -> dict[int, str]:
    """Lap number -> earliest lap_start time in the slice (the leader's)."""
    out: dict[int, str] = {}
    for e in events:
        if e.endpoint == "lap_start" and e.lap_number is not None:
            if e.lap_number not in out or e.event_time_utc < out[e.lap_number]:
                out[e.lap_number] = e.event_time_utc
    return out


def plus_seconds(ts: str, s: float) -> str:
    from .openf1_client import iso_utc

    return iso_utc(parse_openf1_time(ts) + timedelta(seconds=s))
