"""Deterministic material-event candidates (plan 3D). These always fire for authoritative
events, with or without Jev; Jev only chooses the specialist and the urgency.

A candidate is not a conclusion: a red flag is a red flag, and only a correlated stopped car
(car_data) plus later corroboration turns it into an attributed incident. Duplicates are
suppressed by stable incident ids and cooldowns, but a genuinely new incident (another lap,
another car) is never suppressed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .normalize import NormalizedEvent
from .race_state import RaceState, cars_in_message
from .races import Race
from .schemas import ForecastChange, SourceRef

MATERIAL_FORECAST_DELTA_CENTS = 5_000_000  # $50k: below this a position shuffle is a state update, not a candidate
TRACK_TEMP_STEP_C = 3.0


@dataclass
class Candidate:
    kind: str
    event_time_utc: str
    lap: int | None
    drivers: list[int]
    message: str
    evidence: list[SourceRef]
    material: bool
    dedupe_key: str
    context: dict = field(default_factory=dict)
    incident_id: str | None = None
    version: int = 1


class TriggerEngine:
    def __init__(self, state: RaceState, race: Race, *, cooldown_s: float = 300.0, correlate_window_s: float = 120.0):
        self.state = state
        self.race = race
        self.cooldown_s = cooldown_s
        self.correlate_window_s = correlate_window_s
        # Cars whose incidents matter to the finance desk: the team's, plus the demo's focus car.
        self.watched_cars = set(state.team_cars) | {f.driver_number for f in race.incident_focus}
        self.recent_stops: list[tuple[str, int]] = []
        self.incidents: dict[str, dict] = {}
        self.last_fired: dict[str, str] = {}
        self.suppressed = 0
        self.last_weather_candidate: dict | None = None

    # ------------------------------------------------------------------ helpers

    def _ref(self, ev: NormalizedEvent, note: str | None = None) -> SourceRef:
        return SourceRef(system=ev.source_system, endpoint=ev.endpoint, url=ev.source_url, event_time_utc=ev.event_time_utc,
                         record_id=ev.event_id, note=note)

    def _seconds(self, a: str, b: str) -> float:
        from .race_state import _seconds_between

        return _seconds_between(a, b)

    def _cooled(self, key: str, t: str) -> bool:
        last = self.last_fired.get(key)
        if last is not None and self._seconds(last, t) < self.cooldown_s:
            self.suppressed += 1
            return False
        self.last_fired[key] = t
        return True

    def _incident_id(self, lap: int | None, driver: int | None) -> str:
        lap_s = f"lap{lap}" if lap is not None else "lap_unknown"
        return (f"{self.race.race_id}:race:{lap_s}:car{driver}:crash_candidate" if driver is not None
                else f"{self.race.race_id}:race:{lap_s}:red_flag:needs_confirmation")

    def _correlated_stop(self, t: str) -> int | None:
        """A watched car that stopped within the correlation window before `t` (most recent first)."""
        for stop_t, n in reversed(self.recent_stops):
            if 0 <= self._seconds(stop_t, t) <= self.correlate_window_s:
                return n
        return None

    # ------------------------------------------------------------------ events

    def on_event(self, ev: NormalizedEvent, changes: list[str]) -> list[Candidate]:
        out: list[Candidate] = []
        lap = self.state.lap
        for c in changes:
            if c.startswith("stopped:"):
                n = int(c.split(":")[1])
                self.recent_stops.append((ev.event_time_utc, n))
                del self.recent_stops[:-20]
                material = n in self.watched_cars
                key = f"stopped:{n}:{lap}"
                if self._cooled(key, ev.event_time_utc):
                    d = self.state.drivers[n]
                    incident_id = self._incident_id(lap, n)
                    self.incidents[incident_id] = {"version": 1, "driver": n, "lap": lap, "cars": [n], "at": ev.event_time_utc}
                    out.append(Candidate("driver_stopped", ev.event_time_utc, lap, [n],
                                         f"Car {n} ({d.acronym or '?'}) has shown zero speed since {d.stopped_at} outside a pit stop; "
                                         f"track status {d.flag_at_stop or self.state.flag_status}", [self._ref(ev, "car_data speed 0 for the stop threshold")],
                                         material, key, {"attribution": "provisionally_correlated", "stopped_at": d.stopped_at},
                                         incident_id=incident_id))
        if ev.endpoint == "race_control":
            out += self._race_control(ev, lap)
        if ev.endpoint == "weather" and "weather" in changes:
            out += self._weather(ev, lap)
        return out

    def _race_control(self, ev: NormalizedEvent, lap: int | None) -> list[Candidate]:
        p = ev.payload
        msg = p.get("message") or ""
        cat, flag = p.get("category"), p.get("flag")
        t = ev.event_time_utc
        if cat == "Flag" and flag == "RED":
            driver = p.get("driver_number") or self._correlated_stop(t)
            attribution = "named_by_race_control" if p.get("driver_number") else ("provisionally_correlated" if driver else "none")
            incident_id = self._incident_id(p.get("lap_number") or lap, driver)
            existing = self.incidents.get(incident_id)
            if not self._cooled(f"red_flag:{incident_id}", t):
                return []
            version = (existing["version"] + 1) if existing else 1
            self.incidents[incident_id] = {"version": version, "driver": driver, "lap": lap, "cars": [driver] if driver else [], "at": t}
            evidence = [self._ref(ev, "RED FLAG; the message names no driver" if not p.get("driver_number") else None)]
            stopped_at = self.state.drivers[driver].stopped_at if driver in self.state.drivers else None
            if driver and attribution == "provisionally_correlated" and stopped_at:
                evidence.append(SourceRef(endpoint="car_data", url=ev.source_url.replace("/race_control", "/car_data"), event_time_utc=stopped_at,
                                          note=f"car {driver} speed 0 from {stopped_at}, {self._seconds(stopped_at, t):.0f}s before the flag"))
            flag_then = self.state.drivers[driver].flag_at_stop if driver in self.state.drivers else None
            text = (f"RED FLAG on lap {p.get('lap_number') or lap}. " + (f"Car {driver} stopped {self._seconds(stopped_at, t):.0f}s earlier under "
                    f"{flag_then or 'unknown status'}; attribution is provisional until corroborated." if driver and attribution == "provisionally_correlated" and stopped_at
                    else "Race control names no driver; the cause is not established."))
            return [Candidate("race_control_red_flag", t, p.get("lap_number") or lap, [driver] if driver else [], text, evidence, True,
                              f"red_flag:{incident_id}", {"attribution": attribution, "race_control_message": msg}, incident_id=incident_id, version=version)]
        if cat == "SafetyCar":
            key = f"sc:{msg}:{p.get('lap_number')}"
            if "DEPLOYED" in msg.upper() and self._cooled(key, t):
                return [Candidate("race_control_safety_car", t, p.get("lap_number") or lap, [], msg, [self._ref(ev)], False, key,
                                  {"race_control_message": msg})]
            return []
        if "INCIDENT INVOLVING" in msg.upper():
            cars = cars_in_message(msg)
            watched = [c for c in cars if c in self.watched_cars]
            collision = "COLLISION" in msg.upper()
            follow_up = msg.upper().startswith("FIA STEWARDS")
            # The same cars within the correlation window are the same incident: stewards' follow-ups
            # ("UNDER INVESTIGATION", "REVIEWED NO FURTHER INVESTIGATION") update it, they do not open a new one.
            same = next((iid for iid, inc in self.incidents.items() if inc.get("cars") == cars and inc.get("at")
                         and 0 <= self._seconds(inc["at"], t) <= 15 * 60), None)
            key = f"incident:{','.join(map(str, cars))}"
            if same is None and not self._cooled(key, t):
                return []
            incident_id = None
            version = 1
            if watched and collision:
                incident_id = same or self._incident_id(p.get("lap_number") or lap, watched[0])
                prev = self.incidents.get(incident_id)
                version = (prev["version"] + 1) if prev else 1
                self.incidents[incident_id] = {"version": version, "driver": watched[0], "lap": lap, "cars": cars, "at": prev["at"] if prev else t}
            material = bool(watched) and collision and not follow_up
            return [Candidate("race_control_incident_noted", t, p.get("lap_number") or lap, cars, msg, [self._ref(ev)], material, key,
                              {"attribution": "named_by_race_control", "race_control_message": msg, "watched_cars": watched, "collision": collision,
                               "follow_up": follow_up}, incident_id=incident_id, version=version)]
        return []

    def _weather(self, ev: NormalizedEvent, lap: int | None) -> list[Candidate]:
        w = self.state.weather
        prev = self.last_weather_candidate
        if prev is None:
            self.last_weather_candidate = {"rainfall": w.rainfall, "track": w.track_temperature_c}
            return []
        rain_flip = w.rainfall is not None and prev["rainfall"] is not None and w.rainfall != prev["rainfall"]
        temp_step = (w.track_temperature_c is not None and prev["track"] is not None and abs(w.track_temperature_c - prev["track"]) >= TRACK_TEMP_STEP_C)
        if not (rain_flip or temp_step):
            return []
        last = self.last_fired.get("weather")
        if last is not None and self._seconds(last, ev.event_time_utc) < 2 * self.cooldown_s:
            self.suppressed += 1
            return []
        self.last_fired["weather"] = ev.event_time_utc
        self.last_weather_candidate = {"rainfall": w.rainfall, "track": w.track_temperature_c}
        what = ("rain started" if rain_flip and w.rainfall else "rain stopped" if rain_flip else f"track temperature moved to {w.track_temperature_c}C")
        return [Candidate("weather_change", ev.event_time_utc, lap, [], f"Weather: {what} (measurement, not a forecast)", [self._ref(ev)], True, "weather",
                          {"rainfall": w.rainfall, "track_temperature_c": w.track_temperature_c})]

    def financial_threshold(self, change: ForecastChange, t: str, lap: int | None, ev: NormalizedEvent, cooldown_s: float = 60.0) -> Candidate | None:
        """A forecast swing of $50k or more. Within `cooldown_s` of the last one it is still published
        with the state (the number moved) but is not material (no second Jev call for the same shuffle)."""
        if change.delta_cents is None or abs(change.delta_cents) < MATERIAL_FORECAST_DELTA_CENTS:
            return None
        last = self.last_fired.get("forecast")
        material = last is None or self._seconds(last, t) >= cooldown_s
        if material:
            self.last_fired["forecast"] = t
        else:
            self.suppressed += 1
        return Candidate("financial_threshold_crossed", t, lap, [int(c) for c in self.state.team_cars], change.text, [self._ref(ev)], material, f"forecast:{t}",
                         {"delta_cents": change.delta_cents, "gained": change.gained, "lost": change.lost, "team_positions": self.state.team_positions()})

    def document(self, doc: dict, t: str, team_cars: list[int], lap: int | None = None) -> Candidate | None:
        """An official FIA document (from the existing Apify captures) as a candidate."""
        cars = [c for c in doc.get("cars", []) if c in team_cars]
        kind = doc.get("kind")
        if kind in ("provisional_race_classification", "final_race_classification"):
            return Candidate("result_document", t, lap, [], doc.get("title", ""), [SourceRef(system="fia", endpoint="document", url=doc.get("url") or "", event_time_utc=t)],
                             False, f"doc:{doc.get('url')}", {"kind": kind, "cars": doc.get("cars", [])})
        if kind in ("summons", "infringement", "decision") and cars:
            return Candidate("result_document", t, lap, cars, doc.get("title", ""), [SourceRef(system="fia", endpoint="document", url=doc.get("url") or "", event_time_utc=t)],
                             True, f"doc:{doc.get('url')}", {"kind": kind, "cars": cars, "likely_outcome": doc.get("likely_outcome")})
        return None
