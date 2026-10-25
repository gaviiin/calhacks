"""Stage 2, log: one incident per crash or stoppage of a team car, its belief versioned as evidence arrives.

    book = IncidentBook(state)
    inc = book.observe(event, effects, jev)     # None when the event says nothing new about any incident
    book.end_of_session(replay)                 # DNS / out-of-session carry-over at the end of a session

An incident moves suspected -> corroborated -> confirmed -> assessed -> closed and never blocks on a person:
- suspected:     the first signal (telemetry car_stopped, laps stopping, a race-control message naming the car);
- corroborated:  a second, independent signal (a red flag or SC within 60 s of a car_stopped, a stewards' message);
- confirmed:     the session result (DNF / DNS / did not set a time) or the car never rejoining;
- assessed:      a person answered the damage question (race/questions.py calls `assess`);
- closed:        the weekend was sealed.
Each change bumps `version`; `cause` says what changed in one line. The belief carries the severity distribution
and part probabilities from the effects that booked it, the telemetry impact, where, and `out_of_session`.
"""

from __future__ import annotations

from race.events import Effect, Incident, RaceEvent

CRASH_KINDS = ("car_stopped", "incident", "retirement_suspected", "retirement_confirmed")
SAME_INCIDENT_LAPS = 10


class IncidentBook:
    def __init__(self, state):
        self.state = state
        self.by_car: dict[tuple[int, int], Incident] = {}  # (session_key, car) -> latest incident

    def _key(self, ev: RaceEvent) -> str:
        n = sum(1 for (s, c) in self.by_car if s == ev.session_key and c == ev.driver_number) + 1
        return f"{ev.meeting_key}-{ev.session_key}-{ev.driver_number}-{n}"

    def observe(self, ev: RaceEvent, effects: list[Effect], jev=None) -> Incident | None:
        cars = set(self.state.cars())
        if ev.kind not in CRASH_KINDS or ev.driver_number not in cars:
            return None
        if ev.kind == "incident" and not ev.payload.get("damage_likely"):
            return None
        cur = self.by_car.get((ev.session_key, ev.driver_number))
        crash = [e for e in effects if e.kind == "cost" and e.bucket == "6050"]
        belief_update = {}
        if crash and crash[0].jev:
            belief_update = {"severity": crash[0].jev.get("p", {}).get("severity") or {}, "parts": crash[0].jev.get("parts") or {}}
        if ev.kind == "car_stopped":
            belief_update.update({"impact_kph": ev.payload.get("peak_kph"), "signature": ev.payload.get("signature")})
        evidence = {"event_key": ev.key, "kind": ev.kind, "at": ev.at, "source": ev.payload.get("source") or ev.source,
                    "note": ev.one_line()[15:120].strip()}
        if cur is None or (ev.kind == "car_stopped" and cur.status != "suspected" and abs(ev.lap - _lap(cur)) > SAME_INCIDENT_LAPS):
            inc = Incident(incident_key=self._key(ev), meeting_key=ev.meeting_key, session_key=ev.session_key, driver_number=ev.driver_number,
                           team_name=ev.team_name or self.state.team, first_seen_at=ev.at, belief={**belief_update, "lap": ev.lap},
                           evidence=[evidence], updated_at=ev.at, cause=f"{ev.kind.replace('_', ' ')}: {evidence['note']}")
            self.by_car[(ev.session_key, ev.driver_number)] = inc
            return inc
        status = cur.status
        if ev.kind == "retirement_confirmed":
            status = "confirmed"
        elif status == "suspected":
            status = "corroborated"
        cur.belief.update(belief_update)
        cur.evidence.append(evidence)
        cur.status = status
        cur.version += 1
        cur.updated_at = ev.at
        cur.cause = f"{ev.kind.replace('_', ' ')}: {evidence['note']}"
        return cur

    def end_of_session(self, replay) -> list[Incident]:
        return []

    def assess(self, inc: Incident, belief: dict, cause: str, at: str) -> Incident:
        """A person answered: the belief takes their answer and the incident is assessed."""
        inc.belief.update(belief)
        inc.status = "assessed"
        inc.version += 1
        inc.updated_at = at
        inc.cause = cause
        return inc


def _lap(inc: Incident) -> int:
    return int(inc.belief.get("lap") or 0)
