"""OpenF1 rows -> RaceEvents, incrementally, so replay and live share one code path.

    n = Normalizer(team="Williams", session=session_row)
    for t, endpoint, row in stamped_rows(rows):   # replay: every raw row, sorted by its timestamp
        for ev in n.feed(endpoint, row):          # live: the MQTT topic's endpoint and message
            ...
        for ev in n.tick(t):                      # retirement detection runs on the clock, not on rows
            ...

What OpenF1 does and does not say (verified on 2025-26 sessions):
- race_control never announces a retirement. We infer one when a car's laps stop (`retirement_suspected`)
  and confirm from session_result.dnf at the end (`retirement_confirmed`).
- Incidents are category "Other" free text that lags the incident by minutes; the clock in brackets at the
  end of the message is the real time. Penalties are free text too.
- Stints carry no timestamp; we stamp them with the start of their first lap.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field
from datetime import timedelta

from race.events import CarState, RaceEvent, iso, parse_iso

INCIDENT_RE = re.compile(
    r"^(?:FIA STEWARDS: )?(?:UPDATE: )?(?:(?P<turn>TURN \d+|LAP \d+ TURN \d+|PIT (?:LANE|EXIT|ENTRY)) )?"
    r"INCIDENT INVOLVING CARS? (?P<cars>.+?) "
    r"(?P<stage>NOTED|UNDER INVESTIGATION|REVIEWED NO FURTHER INVESTIGATION|REVIEWED NO FURTHER ACTION|NO FURTHER ACTION|"
    r"WILL BE INVESTIGATED AFTER THE RACE)"
    r"(?: - (?P<reason>.+?))?(?: \((?P<clock>\d\d:\d\d:\d\d)\))?$"
)
PENALTY_RE = re.compile(
    r"^FIA STEWARDS: (?P<served>PENALTY SERVED - )?(?P<what>\d+ SECOND TIME PENALTY|DRIVE THROUGH PENALTY|"
    r"\d+ SECOND STOP ?(?:AND|/) ?GO PENALTY|\d+ GRID (?:PLACE|POSITION) PENALTY|REPRIMAND|FINE) FOR CAR (?P<car>\d+)"
    r"(?: \((?P<acr>[A-Z]{3})\))?(?: - (?P<reason>.+?))?(?: \((?P<clock>\d\d:\d\d:\d\d)\))?$"
)
CAR_RE = re.compile(r"(\d+) \(([A-Z]{3})\)")
DAMAGE_REASONS = ("CAUSING A COLLISION", "COLLISION", "FORCING ANOTHER DRIVER OFF", "UNSAFE RELEASE")

# A car with no new lap for this many median laps is treated as stopped. SC laps run about 1.4x, so 2.5 is
# a safe margin; red flags pause the clock entirely.
SUSPECT_AFTER_MEDIAN_LAPS = 2.5
DEFAULT_LAP_SECONDS = 95.0


def _cars(text: str) -> list[dict]:
    return [{"number": int(n), "acronym": a} for n, a in CAR_RE.findall(text)]


def parse_race_control(message: str) -> dict | None:
    """Classify one race-control message: incident / penalty / None (plain notice)."""
    m = INCIDENT_RE.match(message)
    if m:
        cars = _cars(m.group("cars"))
        reason = (m.group("reason") or "").strip()
        return {
            "type": "incident", "cars": cars, "turn": m.group("turn") or "", "stage": m.group("stage"), "reason": reason,
            "clock": m.group("clock") or "", "damage_likely": any(k in reason for k in DAMAGE_REASONS) or reason == "",
        }
    m = PENALTY_RE.match(message)
    if m:
        return {
            "type": "penalty", "car": int(m.group("car")), "what": m.group("what"), "served": bool(m.group("served")),
            "reason": (m.group("reason") or "").strip(), "clock": m.group("clock") or "",
        }
    return None


@dataclass
class _Driver:
    number: int
    team: str
    acronym: str
    position: int | None = None
    lap: int = 0
    last_lap_start: str = ""
    last_lap_complete: bool = True
    laps_seen: set = field(default_factory=set)
    compound: str = ""
    tyre_age: int = 0
    gap: str = ""
    last_pit_lap: int = 0
    status: str = "running"
    recent_laps: list = field(default_factory=list)  # lap_duration of completed laps


class Normalizer:
    def __init__(self, team: str, session: dict, source: str = "openf1_replay"):
        self.team = team
        self.source = source
        self.session_key = int(session["session_key"])
        self.meeting_key = int(session.get("meeting_key") or 0)
        self.session_start = session.get("date_start", "")
        self.session_end = session.get("date_end", "")
        self.drivers: dict[int, _Driver] = {}
        self.track_status = "green"  # green | sc | vsc | red | finished
        self.field_lap = 0
        self.finished = False
        self._last_tick = ""

    # ------------------------------------------------------------------ helpers
    def _team(self, n: int) -> str:
        d = self.drivers.get(n)
        return d.team if d else ""

    def _driver(self, n: int) -> _Driver:
        if n not in self.drivers:
            self.drivers[n] = _Driver(n, "", str(n))
        return self.drivers[n]

    def is_team_car(self, n: int) -> bool:
        return self._team(n) == self.team

    def team_cars(self) -> list[int]:
        return sorted(n for n, d in self.drivers.items() if d.team == self.team)

    def median_lap(self) -> float:
        laps = [x for d in self.drivers.values() for x in d.recent_laps[-5:] if x]
        return statistics.median(laps) if len(laps) >= 3 else DEFAULT_LAP_SECONDS

    def _state(self, d: _Driver, at: str) -> CarState:
        return CarState(
            driver_number=d.number, team_name=d.team, position=d.position or 0, lap=d.lap, compound=d.compound,
            tyre_age=d.tyre_age, gap_to_leader=d.gap, last_pit_lap=d.last_pit_lap, status=d.status, updated_at=at,
        )

    def _ev(self, kind: str, at: str, driver: int, lap: int, payload: dict, extra_key: str = "", with_state: bool = True) -> RaceEvent:
        d = self.drivers.get(driver) if driver else None
        return RaceEvent(
            kind=kind, at=at, session_key=self.session_key, meeting_key=self.meeting_key, lap=lap, driver_number=driver,
            team_name=d.team if d else "", payload=payload, source=self.source, extra_key=extra_key,
            state=self._state(d, at) if (d and with_state) else None,
        )

    # ------------------------------------------------------------------ feed
    def feed(self, endpoint: str, row: dict) -> list[RaceEvent]:
        fn = getattr(self, f"_on_{endpoint}", None)
        return fn(row) if fn else []

    def _on_drivers(self, row: dict) -> list[RaceEvent]:
        n = int(row["driver_number"])
        d = self._driver(n)
        d.team = row.get("team_name") or d.team
        d.acronym = row.get("name_acronym") or d.acronym
        return []

    def _on_laps(self, row: dict) -> list[RaceEvent]:
        n = int(row["driver_number"])
        d = self._driver(n)
        lap = int(row["lap_number"])
        start = row.get("date_start")
        dur = row.get("lap_duration")
        if start and (lap > d.lap or lap not in d.laps_seen):
            d.lap = max(d.lap, lap)
            d.laps_seen.add(lap)
            d.last_lap_start = start
            d.last_lap_complete = dur is not None
            if d.status == "retired_suspected":
                d.status = "running"  # it was a long pit stop or a red flag, not a retirement
        if dur:
            d.recent_laps.append(float(dur))
        self.field_lap = max(self.field_lap, lap)
        if d.team != self.team or not start:
            return []
        at = iso(parse_iso(start) + timedelta(seconds=float(dur))) if dur else start
        payload = {
            "lap_number": lap, "lap_duration": dur, "sector_1": row.get("duration_sector_1"), "sector_2": row.get("duration_sector_2"),
            "sector_3": row.get("duration_sector_3"), "is_pit_out_lap": row.get("is_pit_out_lap"), "complete": dur is not None,
            "i1_speed": row.get("i1_speed"), "st_speed": row.get("st_speed"),
        }
        return [self._ev("lap", at, n, lap, payload)]

    def _on_position(self, row: dict) -> list[RaceEvent]:
        n = int(row["driver_number"])
        d = self._driver(n)
        pos = int(row["position"])
        prev = d.position
        d.position = pos
        if prev == pos:
            return []
        payload = {"from": prev, "to": pos, "gained": (prev - pos) if prev else 0}
        return [self._ev("position", row["date"], n, d.lap, payload)]

    def _on_intervals(self, row: dict) -> list[RaceEvent]:
        d = self._driver(int(row["driver_number"]))
        gap = row.get("gap_to_leader")
        if gap is None:
            d.gap = "LEADER" if d.position == 1 else d.gap
        elif isinstance(gap, (int, float)):
            d.gap = f"+{gap:.3f}"
        else:
            d.gap = str(gap)  # "+1 LAP"
        return []

    def _on_stints(self, row: dict) -> list[RaceEvent]:
        n = int(row["driver_number"])
        d = self._driver(n)
        d.compound = row.get("compound") or d.compound
        d.tyre_age = int(row.get("tyre_age_at_start") or 0)
        at = row.get("_t") or d.last_lap_start or self.session_start
        payload = {
            "stint_number": row.get("stint_number"), "compound": row.get("compound"), "lap_start": row.get("lap_start"),
            "lap_end": row.get("lap_end"), "tyre_age_at_start": row.get("tyre_age_at_start"),
        }
        return [self._ev("stint", at, n, int(row.get("lap_start") or d.lap), payload, extra_key=str(row.get("stint_number")))]

    def _on_pit(self, row: dict) -> list[RaceEvent]:
        n = int(row["driver_number"])
        d = self._driver(n)
        d.last_pit_lap = int(row.get("lap_number") or d.lap)
        payload = {
            "lap_number": row.get("lap_number"), "lane_duration": row.get("lane_duration"), "stop_duration": row.get("stop_duration"),
            "under": self.track_status,
        }
        return [self._ev("pit_stop", row["date"], n, d.last_pit_lap, payload)]

    def _on_overtakes(self, row: dict) -> list[RaceEvent]:
        n = int(row["overtaking_driver_number"])
        d = self._driver(n)
        payload = {"overtaken": row.get("overtaken_driver_number"), "position": row.get("position")}
        return [self._ev("overtake", row["date"], n, d.lap, payload, extra_key=str(row.get("overtaken_driver_number")))]

    def _on_race_control(self, row: dict) -> list[RaceEvent]:
        msg = (row.get("message") or "").strip()
        cat = row.get("category") or "Other"
        flag = row.get("flag")
        lap = int(row.get("lap_number") or self.field_lap)
        at = row["date"]
        base = {"message": msg, "category": cat, "flag": flag, "scope": row.get("scope"), "sector": row.get("sector")}
        driver = int(row.get("driver_number") or 0)

        if cat == "SafetyCar":
            if "VIRTUAL" in msg:
                self.track_status = "vsc" if "DEPLOYED" in msg else "green"
                return [self._ev("vsc", at, 0, lap, {**base, "deployed": "DEPLOYED" in msg})]
            if "DEPLOYED" in msg:
                self.track_status = "sc"
            elif "IN THIS LAP" in msg or "ENDING" in msg:
                self.track_status = "green"
            return [self._ev("safety_car", at, 0, lap, {**base, "deployed": "DEPLOYED" in msg})]
        if cat == "SessionStatus":
            if "FINISH" in msg or "ENDS" in msg:
                self.finished = True
            return [self._ev("session_status", at, 0, lap, base)]
        if cat == "Flag":
            if flag == "RED":
                self.track_status = "red"
                return [self._ev("red_flag", at, 0, lap, base)]
            if flag == "CHEQUERED":
                self.finished = True
                self.track_status = "finished"
            elif flag in ("GREEN", "CLEAR") and self.track_status == "red":
                self.track_status = "green"
            return [self._ev("flag", at, driver, lap, base)]

        parsed = parse_race_control(msg)
        if parsed and parsed["type"] == "incident":
            cars = [c["number"] for c in parsed["cars"]]
            ours = [c for c in cars if self.is_team_car(c)]
            who = ours[0] if ours else (cars[0] if cars else 0)
            payload = {**base, **parsed, "car_numbers": cars, "team_involved": bool(ours)}
            return [self._ev("incident", at, who, lap, payload, extra_key="|".join(map(str, cars)) + parsed["stage"])]
        if parsed and parsed["type"] == "penalty":
            payload = {**base, **parsed, "team_involved": self.is_team_car(parsed["car"])}
            return [self._ev("penalty", at, parsed["car"], lap, payload, extra_key=parsed["what"] + str(parsed["served"]))]
        return [self._ev("flag", at, driver, lap, base)] if flag else [self._ev("notice", at, driver, lap, base)]

    def _on_championship_teams(self, row: dict) -> list[RaceEvent]:
        at = row.get("_t") or self.session_end or self.session_start
        payload = {k: row.get(k) for k in ("team_name", "points_start", "points_current", "position_start", "position_current")}
        payload["team"] = row.get("team_name")
        return [self._ev("standings", at, 0, self.field_lap, payload, extra_key=str(row.get("team_name")))]

    def _on_session_result(self, row: dict) -> list[RaceEvent]:
        if not row.get("dnf"):
            return []
        n = int(row["driver_number"])
        d = self._driver(n)
        d.status = "retired"
        at = row.get("_t") or self.session_end or self.session_start
        payload = {"number_of_laps": row.get("number_of_laps"), "dnf": True, "dns": row.get("dns"), "dsq": row.get("dsq")}
        return [self._ev("retirement_confirmed", at, n, int(row.get("number_of_laps") or d.lap), payload)]

    # ------------------------------------------------------------------ clock
    def tick(self, now: str) -> list[RaceEvent]:
        """Retirement detection: a running car with no new lap for 2.5 median laps while the track is not red."""
        if self.finished or self.track_status == "red" or now <= self._last_tick:
            return []
        self._last_tick = now
        out: list[RaceEvent] = []
        t_now = parse_iso(now)
        limit = self.median_lap() * SUSPECT_AFTER_MEDIAN_LAPS
        for d in self.drivers.values():
            if d.status != "running" or not d.last_lap_start or d.lap == 0:
                continue
            silent = (t_now - parse_iso(d.last_lap_start)).total_seconds()
            if silent > limit and self.field_lap >= d.lap + 2:
                d.status = "retired_suspected"
                payload = {
                    "last_lap": d.lap, "last_lap_complete": d.last_lap_complete, "silent_seconds": round(silent),
                    "field_lap": self.field_lap, "track_status": self.track_status,
                    "summary": f"no lap since L{d.lap} ({round(silent)}s, field on L{self.field_lap})",
                }
                out.append(self._ev("retirement_suspected", now, d.number, d.lap, payload))
        return out


# ---------------------------------------------------------------------- replay helpers

def stamped_rows(rows: dict[str, list[dict]]) -> list[tuple[str, str, dict]]:
    """(timestamp, endpoint, row) for every raw row, sorted, with synthetic stamps where OpenF1 has none."""
    out: list[tuple[str, str, dict]] = []
    laps_by_driver: dict[tuple[int, int], str] = {}
    for r in rows.get("laps", []):
        if r.get("date_start"):
            laps_by_driver[(int(r["driver_number"]), int(r["lap_number"]))] = r["date_start"]
    session = (rows.get("session") or [{}])[0]
    start = session.get("date_start") or min((r["date_start"] for r in rows.get("laps", []) if r.get("date_start")), default="")
    chequered = next((r["date"] for r in rows.get("race_control", []) if r.get("flag") == "CHEQUERED"), None)
    end = chequered or session.get("date_end") or start
    for r in rows.get("drivers", []):
        out.append(("0000", "drivers", r))  # first, whatever the clock says
    for ep in ("laps", "position", "intervals", "pit", "overtakes", "race_control"):
        for r in rows.get(ep, []):
            t = r.get("date_start") if ep == "laps" else r.get("date")
            if t:
                out.append((t, ep, r))
    for r in rows.get("stints", []):
        t = laps_by_driver.get((int(r["driver_number"]), int(r.get("lap_start") or 1))) or start
        out.append((t, "stints", {**r, "_t": t}))
    for r in rows.get("championship_teams", []):
        out.append((end, "championship_teams", {**r, "_t": end}))
    for r in rows.get("session_result", []):
        t = iso(parse_iso(end) + timedelta(minutes=2)) if end else end
        out.append((t, "session_result", {**r, "_t": t}))
    out.sort(key=lambda x: (x[0], 0 if x[1] == "drivers" else 1))
    return out


def normalize(rows: dict[str, list[dict]], team: str, source: str = "openf1_replay") -> list[RaceEvent]:
    """Whole-session normalisation: every event in time order, including inferred retirements."""
    session = (rows.get("session") or [{}])[0]
    if not session:
        any_row = next((r for ep in ("laps", "position") for r in rows.get(ep, [])), {})
        session = {"session_key": any_row.get("session_key", 0), "meeting_key": any_row.get("meeting_key", 0)}
    n = Normalizer(team, session, source)
    events: list[RaceEvent] = []
    for t, ep, row in stamped_rows(rows):
        events.extend(n.feed(ep, row))
        if t != "0000":
            events.extend(n.tick(t))
    events.sort(key=lambda e: (e.at, e.kind != "retirement_confirmed"))
    return events
