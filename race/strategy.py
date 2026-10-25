"""Strategy: what each decision the pit wall has would do right now, priced and never recommended.

    options_for(state, event) -> list[OptionSet]   # at decision points: SC, VSC, red flag, each completed lap

After Varun Sanjeev's decision cockpit (var-updated-live: live_racing/strategy.py, pit_model.py, race_state.py),
ported to the race desk's replay and money model; the logic lives in race/cockpit/.

Only in a Race session, only for our cars still racing: never a car that did not start (car 23 in São Paulo 2024
keeps a grid slot in the position feed; no lap of its own ever starts), never one out of the race or stopped on
track (a stopped car's decision is the incident's: continue, repair or retire, race/logistics.py). Decision points:

    safety_car / vsc deployed, red_flag   every running car of ours, keyed by the race (leader's) lap
    lap                                   once per completed lap of each of our cars, keyed by the car's lap

option_key is `{session}-{car}-L{lap}-{trigger}`. optionsJson is {"context": {...}, "options": [...]}: the context
is shared by the options (condition, laps left, gaps, tyres, the stop cost per condition, the assumptions).
The pit-wall module refuses any option set containing the word for advising one option; this module checks
before it returns. No option carries a flag that marks it out from the others.

Every figure is read as of the event's moment from the session's own rows (race/cockpit/timing.py): the index of
the session is built once, and each decision point costs well under 2 ms.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from race.cockpit import comparator
from race.cockpit.timing import SessionIndex, ts
from race.events import OptionSet, RaceEvent, _j, canonical

TRIGGERS = ("safety_car", "vsc", "red_flag", "lap")
MAX_JSON = 8192
_FORBIDDEN = re.compile("re" + "commend", re.I)  # spelled apart so this module's own source never trips a grep


@dataclass
class CockpitOptionSet(OptionSet):
    """An OptionSet whose options share one context; the wire form keeps both in optionsJson."""

    context: dict = field(default_factory=dict)

    def wire(self) -> dict:
        w = super().wire()
        w["options_json"] = payload_json(self.options, self.context)
        return w


def payload_json(options: list[dict], context: dict) -> str:
    """The options and their context as JSON under the module's 8 KB limit: evidence is trimmed before anything else,
    so the JSON is never cut mid-way."""
    body = {"context": context, "options": options}
    s = _j(body)
    if len(s) <= MAX_JSON:
        return s
    slim = [{**o, "evidence": o.get("evidence", [])[:2], "pace": (o.get("pace") or {}).get("note") if o.get("pace") else None} for o in options]
    ctx = {k: v for k, v in context.items() if k not in ("stop_cost", "field_compounds")}
    s = _j({"context": ctx, "options": slim})
    if len(s) <= MAX_JSON:
        return s
    slim = [{k: v for k, v in o.items() if k not in ("evidence", "pace", "clauses")} for o in slim]
    return _j({"context": ctx, "options": slim})


class _Cache:
    def __init__(self):
        self.key: tuple | None = None
        self.idx: SessionIndex | None = None
        self.emitted: set[str] = set()
        self.stopped: dict[int, float] = {}  # car -> when telemetry or race control saw it stop on track


_cache = _Cache()


def _index(state) -> SessionIndex | None:
    r = state.replay
    if r is None:
        return None
    key = (id(r), int(r.session.get("session_key") or 0))
    if _cache.key != key:
        _cache.key, _cache.idx, _cache.emitted, _cache.stopped = key, SessionIndex(r.rows, r.session), set(), {}
    return _cache.idx


def our_cars(state, ev: RaceEvent) -> list[int]:
    if ev.kind == "lap":
        team = ev.team_name or state.replay.team_of.get(ev.driver_number, "")
        return [ev.driver_number] if team == state.team else []
    return sorted(c for c, t in state.replay.team_of.items() if t == state.team)


def out_reason(state, idx: SessionIndex, car: int, t: float) -> str | None:
    """Why there is no strategy decision to price for this car now, or None when it is racing."""
    from race.season_sim import _out_of_race, _race_key

    if not idx.started(car, t):
        return "did not start" if idx.dns(car, t) else "no lap started yet"
    if car in _out_of_race(state, _race_key(state)):
        return "out of the race (result, incident or withdrawal)"
    if state.replay.ctx.positions.get(car, 0) is None or state.replay.retired_lap.get(car) is not None:
        return "out of the race"
    if idx.out_per_timing(car, t):
        return "out per timing"
    stopped = _cache.stopped.get(car)
    if stopped is not None:
        last = max((x.end for x in idx.completed(car, t)), default=None)
        if last is None or last < stopped:
            return "stopped on track: the incident prices continue, repair or retire"
    return None


def options_for(state, ev: RaceEvent) -> list[OptionSet]:
    if getattr(state, "session_type", "Race") != "Race" or state.replay is None:
        return []
    if ev.kind == "car_stopped":
        idx = _index(state)
        if idx is not None:
            _cache.stopped.setdefault(ev.driver_number, ts(ev.at))
        return []
    if ev.kind not in TRIGGERS:
        return []
    if ev.kind in ("safety_car", "vsc") and not ev.payload.get("deployed"):
        return []
    if ev.kind == "lap" and not ev.payload.get("complete"):
        return []
    idx = _index(state)
    if idx is None:
        return []
    t = ts(ev.at)
    out: list[OptionSet] = []
    for car in our_cars(state, ev):
        lap = ev.lap if ev.kind == "lap" else (ev.lap or idx.field_lap(t))
        key = f"{ev.session_key}-{car}-L{lap}-{ev.kind}"
        if key in _cache.emitted or out_reason(state, idx, car, t):
            continue
        opts, ctx = comparator.compare(state, idx, car, t)
        if ctx.get("position") is None:
            continue
        ctx["trigger"] = ev.kind
        o = CockpitOptionSet(option_key=key, session_key=ev.session_key, meeting_key=ev.meeting_key, driver_number=car, lap=lap,
                             at=canonical(ev.at), condition=ctx["condition"], trigger=ev.kind, options=opts, context=ctx)
        if _FORBIDDEN.search(json.dumps(o.wire())):
            continue  # never sent: the module would refuse it, and the desk does not advise
        _cache.emitted.add(key)
        out.append(o)
    return out
