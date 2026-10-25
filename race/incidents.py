"""Stage 2, log: one incident per crash or stoppage of a team car, its belief versioned as evidence arrives.

    book = IncidentBook(state)
    inc = book.observe(event, effects, jev)     # None when the event says nothing new about any incident
    book.end_of_session(replay)                 # out-of-session and car-continued calls at the end of a session
    book.assess(inc, belief, cause, at)         # a person answered the damage question (race/questions.py)

An incident moves suspected -> corroborated -> confirmed -> assessed -> closed, never backwards, and never blocks
on a person:
- suspected:     the first signal: telemetry car_stopped, laps stopping (retirement_suspected), or a race-control
                 incident naming the car with damage likely;
- corroborated:  a second, independent signal: a red flag, safety car or VSC within 60 s after our car_stopped
                 (field events, driver 0), a stewards' message naming the car, or the car's laps stopping;
- confirmed:     the session result (DNF or DNS), the car missing from the race grid, or in qualifying the car never
                 setting another lap before the session ended (end_of_session: out_of_session = true);
- assessed:      a person answered the damage question;
- closed:        the weekend was sealed.
One IncidentBook spans the weekend, so a qualifying crash carries over: when the race shows the car did not start,
the qualifying incident is the one that is confirmed.

Each change bumps `version` (the module appends every version to race_beliefs, so the history lives there) and sets
`cause` to one line saying what changed. The belief:
    {"severity": {heavy, moderate, light, none -> P}, "parts": {part -> P(damaged)}, "severity_by": str,
     "impact_kph": int, "signature": "stop" | "freeze", "decel_g": float, "lap": int, "where": str, "turn": str,
     "session_type": str, "out_of_session": bool, "dns": bool, "laps_after": int, "corroborated_after_s": int}
Keys are `{meeting}-{session}-{car}-{n}`: deterministic for the same replay.
"""

from __future__ import annotations

from datetime import timedelta

from race.events import INCIDENT_STATUSES, Effect, Incident, RaceEvent, iso, parse_iso

RANK = {s: i for i, s in enumerate(INCIDENT_STATUSES)}
FIELD_SIGNALS = {"red_flag": "red flag", "safety_car": "safety car", "vsc": "virtual safety car"}
CORROBORATE_WITHIN_S = 60.0
SAME_INCIDENT_LAPS = 10
GRID_CHECK_LAP = 3  # a teammate completing lap 3 while our other car has no lap: it is not in the race
CONTINUED_LAPS = 3  # laps after an incident that show the car carried on


def _secs(a: str, b: str) -> float:
    return (parse_iso(b) - parse_iso(a)).total_seconds()


def _crash_belief(effects: list[Effect], jev) -> dict:
    """Severity and part probabilities from the crash-damage line (6050) that booked this event, else from Jev."""
    crash = next((e for e in effects if e.kind == "cost" and e.bucket == "6050" and e.jev), None)
    log = crash.jev if crash else (jev.log() if jev is not None and getattr(jev, "probabilities", None) else {})
    sev = (log.get("p") or {}).get("severity") or {}
    if not sev:
        return {}
    out = {"severity": sev, "parts": {k: v for k, v in (log.get("parts") or {}).items() if v}}
    out["severity_by"] = crash.decided_by if crash else "jev"
    return out


class IncidentBook:
    def __init__(self, state):
        self.state = state
        self.incidents: dict[str, Incident] = {}  # creation order
        self.seen: set[str] = set()  # event keys already observed: the same event twice changes nothing
        self.pending: list[Incident] = []  # changed on an earlier event but not yet returned (one return per event)
        self.laps: dict[tuple[int, int], list[str]] = {}  # (session, car) -> when each lap started
        self.grid_checked: set[tuple[int, int]] = set()

    # ------------------------------------------------------------------ lookups
    def _cars(self) -> set[int]:
        return set(self.state.cars())

    def _in_session(self, session_key: int, car: int) -> list[Incident]:
        return [i for i in self.incidents.values() if i.session_key == session_key and i.driver_number == car]

    def _latest(self, session_key: int, car: int, lap: int | None = None) -> Incident | None:
        """The newest incident for this car in this session, optionally only one close enough in laps to be the same."""
        for inc in reversed(self._in_session(session_key, car)):
            if inc.status == "closed":
                continue
            if lap is None or abs(lap - int(inc.belief.get("lap") or 0)) <= SAME_INCIDENT_LAPS:
                return inc
            return None
        return None

    def _carried(self, ev: RaceEvent) -> Incident | None:
        """The newest incident for this car in an earlier session of the same weekend."""
        prior = [i for i in self.incidents.values() if i.meeting_key == ev.meeting_key and i.driver_number == ev.driver_number
                 and i.session_key != ev.session_key and i.status != "closed"]
        return prior[-1] if prior else None

    # ------------------------------------------------------------------ writes
    def _evidence(self, ev: RaceEvent, note: str = "") -> dict:
        p = ev.payload
        note = note or p.get("summary") or p.get("message") or ev.kind.replace("_", " ")
        return {"event_key": ev.key, "kind": ev.kind, "at": ev.at, "source": p.get("source") or ev.source,
                "session_key": ev.session_key, "note": str(note)[:160]}

    def _open(self, ev: RaceEvent, status: str, cause: str, belief: dict) -> Incident:
        n = len(self._in_session(ev.session_key, ev.driver_number)) + 1
        inc = Incident(incident_key=f"{ev.meeting_key}-{ev.session_key}-{ev.driver_number}-{n}", meeting_key=ev.meeting_key,
                       session_key=ev.session_key, driver_number=ev.driver_number, team_name=ev.team_name or self.state.team,
                       first_seen_at=ev.at, status=status, updated_at=ev.at, cause=cause, evidence=[self._evidence(ev)],
                       belief={"lap": ev.lap, "where": f"L{ev.lap}", "session_type": self.state.session_type,
                               "out_of_session": False, **belief})
        self.incidents[inc.incident_key] = inc
        return inc

    def _change(self, inc: Incident, at: str, cause: str, status: str | None = None, belief: dict | None = None,
                ev: RaceEvent | None = None) -> Incident:
        if status and RANK[status] > RANK[inc.status]:
            inc.status = status
        if belief:
            if inc.status in ("assessed", "closed") and status != "assessed":
                # A person's assessment outranks later machine reads: keep their severity and parts.
                belief = {k: v for k, v in belief.items() if k not in ("severity", "parts", "severity_by")}
            inc.belief.update(belief)
        if ev is not None:
            inc.evidence.append(self._evidence(ev))
        inc.version += 1
        inc.updated_at = max(inc.updated_at, at)
        inc.cause = cause
        return inc

    def _promote_cause(self, inc: Incident, status: str, what: str) -> str:
        """'red flag 9 s after the stop: corroborated', or 'still confirmed' when the status does not move."""
        return f"{what}: {status}" if RANK[status] > RANK[inc.status] else f"{what}: still {inc.status}"

    # ------------------------------------------------------------------ observe
    def observe(self, ev: RaceEvent, effects: list[Effect], jev=None) -> Incident | None:
        if ev.key in self.seen:
            return self.pending.pop(0) if self.pending else None
        self.seen.add(ev.key)
        changed = self._observe(ev, effects or [], jev)
        self.pending = changed + [p for p in self.pending if all(p is not c for c in changed)]
        return self.pending.pop(0) if self.pending else None

    def _observe(self, ev: RaceEvent, effects: list[Effect], jev) -> list[Incident]:
        if ev.kind in FIELD_SIGNALS:
            return self._field_signal(ev)
        if ev.driver_number not in self._cars():
            return []
        if ev.kind == "lap":
            return self._lap(ev)
        fn = getattr(self, f"_on_{ev.kind}", None)
        return fn(ev, _crash_belief(effects, jev)) if fn else []

    def _field_signal(self, ev: RaceEvent) -> list[Incident]:
        """A red flag, SC or VSC right after one of our cars stopped is the field confirming what telemetry saw."""
        if ev.kind != "red_flag" and not ev.payload.get("deployed"):
            return []
        out = []
        for inc in self.incidents.values():
            if inc.session_key != ev.session_key or inc.status != "suspected":
                continue
            stop = next((e for e in inc.evidence if e["kind"] == "car_stopped"), None)
            if stop is None:
                continue
            lag = _secs(stop["at"], ev.at)
            if 0 <= lag <= CORROBORATE_WITHIN_S:
                what = f"{FIELD_SIGNALS[ev.kind]} {round(lag)} s after the stop"
                out.append(self._change(inc, ev.at, f"{what}: corroborated", "corroborated",
                                        {"corroborated_after_s": round(lag)}, ev=ev))
        return out

    def _lap(self, ev: RaceEvent) -> list[Incident]:
        """Laps feed two calls: which cars ran after an incident (end_of_session), and a car missing from the race."""
        # a lap event is stamped at its end; a lap that spans a red flag ends long after a crash it did not survive
        dur = ev.payload.get("lap_duration") if ev.payload.get("complete") else None
        start = iso(parse_iso(ev.at) - timedelta(seconds=float(dur))) if dur else ev.at
        self.laps.setdefault((ev.session_key, ev.driver_number), []).append(start)
        if self.state.session_type != "Race" or ev.lap < GRID_CHECK_LAP or not ev.payload.get("complete"):
            return []
        out = []
        for car in sorted(self._cars() - {ev.driver_number}):
            if (ev.session_key, car) in self.grid_checked or self.laps.get((ev.session_key, car)):
                continue
            self.grid_checked.add((ev.session_key, car))
            missing = RaceEvent(kind="retirement_suspected", at=ev.at, session_key=ev.session_key, meeting_key=ev.meeting_key,
                                lap=0, driver_number=car, team_name=ev.team_name, source="laps",
                                payload={"summary": f"no lap while #{ev.driver_number} completed lap {ev.lap}", "dns": True})
            note = f"not on the grid, no lap while #{ev.driver_number} completed lap {ev.lap}"
            prior = self._carried(missing)
            if prior is not None:
                out.append(self._change(prior, ev.at, self._promote_cause(prior, "confirmed", f"did not start the race, {note}"),
                                        "confirmed", {"dns": True, "out_of_session": True, "missed_session": ev.session_key}, ev=missing))
            else:
                out.append(self._open(missing, "suspected", f"{note}: suspected", {"dns": True}))
        return out

    def _on_car_stopped(self, ev: RaceEvent, crash: dict) -> list[Incident]:
        p = ev.payload
        tele = {"impact_kph": p.get("peak_kph"), "signature": p.get("signature"), "decel_g": p.get("decel_g"), **crash}
        cur = self._latest(ev.session_key, ev.driver_number, ev.lap)
        if cur is not None and not any(e["kind"] == "car_stopped" for e in cur.evidence):
            # race control or the laps got there first; telemetry is a second, independent source
            return [self._change(cur, ev.at, self._promote_cause(cur, "corroborated", f"telemetry agrees ({p.get('summary')})"),
                                 "corroborated", tele, ev=ev)]
        return [self._open(ev, "suspected", f"{p.get('summary') or 'car stopped'}: suspected", tele)]

    def _on_incident(self, ev: RaceEvent, crash: dict) -> list[Incident]:
        p = ev.payload
        if not p.get("damage_likely"):
            return []
        others = [c for c in p.get("car_numbers") or [] if c != ev.driver_number]
        turn = (p.get("turn") or "").title()
        where = {"turn": turn, "where": f"{turn}, L{ev.lap}"} if turn else {}
        stewards = str(p.get("message") or "").startswith("FIA STEWARDS")
        what = (f"{'stewards name' if stewards else 'race control names'} the car"
                f"{' with #' + ', #'.join(map(str, others)) if others else ''}{' at ' + turn if turn else ''}"
                f" ({str(p.get('stage') or '').lower()}{', ' + p['reason'].lower() if p.get('reason') else ''})")
        cur = self._latest(ev.session_key, ev.driver_number, ev.lap)
        if cur is None:
            return [self._open(ev, "suspected", f"{what}: suspected", {**where, **crash})]
        independent = stewards or not any(e["kind"] == "incident" for e in cur.evidence)
        status = "corroborated" if independent else cur.status
        return [self._change(cur, ev.at, self._promote_cause(cur, status, what), status, {**where, **crash}, ev=ev)]

    def _on_retirement_suspected(self, ev: RaceEvent, crash: dict) -> list[Incident]:
        p = ev.payload
        what = f"laps stopped, {p.get('summary') or 'no new lap'}"
        cur = self._latest(ev.session_key, ev.driver_number, ev.lap)
        if cur is None:
            return [self._open(ev, "suspected", f"{what}: suspected", crash)]
        if any(e["kind"] == "retirement_suspected" for e in cur.evidence):
            return []
        return [self._change(cur, ev.at, self._promote_cause(cur, "corroborated", what), "corroborated", crash, ev=ev)]

    def _on_retirement_confirmed(self, ev: RaceEvent, crash: dict) -> list[Incident]:
        p = ev.payload
        if p.get("dns"):
            cur = self._latest(ev.session_key, ev.driver_number) or self._carried(ev)
            what = "did not start the race (classified DNS in the result)"
            belief = {"dns": True, "out_of_session": True, "missed_session": ev.session_key}
        else:
            cur = self._latest(ev.session_key, ev.driver_number, ev.lap)
            what = f"classified DNF after {p.get('number_of_laps')} laps"
            belief = {"out_of_session": True}
        if cur is None:
            return [self._open(ev, "confirmed", f"{what}: confirmed", {**belief, **crash})]
        return [self._change(cur, ev.at, self._promote_cause(cur, "confirmed", what), "confirmed", {**belief, **crash}, ev=ev)]

    # ------------------------------------------------------------------ end of session
    def end_of_session(self, replay) -> list[Incident]:
        """What the end of a session settles: in qualifying a car that never ran again is out of the session
        (confirmed); in a race a car that kept lapping carried on. Also flushes changes not yet returned."""
        session = getattr(replay, "session", None) or self.state.session or {}
        key = int(session.get("session_key") or 0)
        stype = getattr(replay, "session_type", None) or session.get("session_type") or self.state.session_type
        end = self.state.now or session.get("date_end") or ""
        out = list(self.pending)
        self.pending = []
        for inc in list(self.incidents.values()):
            if inc.session_key != key or inc.belief.get("out_of_session") or inc.status == "closed":
                continue
            after = [t for t in self.laps.get((key, inc.driver_number), []) if t > inc.first_seen_at]
            at = max(inc.updated_at, end) if end else inc.updated_at
            if stype != "Race" and not after:
                what = f"never ran again before {stype.lower()} ended (out of the session)"
                ch = self._change(inc, at, self._promote_cause(inc, "confirmed", what), "confirmed", {"out_of_session": True, "laps_after": 0})
            elif len(after) >= CONTINUED_LAPS and RANK[inc.status] < RANK["confirmed"]:
                ch = self._change(inc, at, f"car ran {len(after)} more laps after it: carried on, still {inc.status}",
                                  belief={"laps_after": len(after)})
            else:
                continue
            if all(ch is not o for o in out):
                out.append(ch)
        return out

    # ------------------------------------------------------------------ a person answered
    def assess(self, inc: Incident, belief: dict, cause: str, at: str) -> Incident:
        """A person answered: the belief takes their answer and the incident is assessed. Works on the book's own copy
        so a later signal never writes an older version over the person's answer."""
        own = self.incidents.get(inc.incident_key, inc)
        own.version = max(own.version, inc.version)
        self._change(own, at, cause, "assessed", belief)
        if own is not inc:
            inc.__dict__.update(own.__dict__)
        return own

    def close(self, at: str) -> list[Incident]:
        """The weekend was sealed: every incident is closed."""
        return [self._change(i, at, f"weekend sealed: closed (was {i.status})", "closed") for i in self.incidents.values()
                if i.status != "closed"]
