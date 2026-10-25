"""Each part's life, from the way the car is actually raced.

    rows = life.update(state, ev, jev, replay)      # PartLife rows that changed on this event

Three things use a part up:

    laps          every completed lap of ours adds its kilometres (a qualifying lap counts 1.15x: the car is pushed)
    stress        a race-control incident, a lap deleted for leaving the track, a contact: Jev classifies how hard it
                  was (none / light / moderate / heavy) and which parts it hit, and the part loses that share of life
    crashes       the telemetry tripwire's stop marks the likely parts damaged at once; when the garage assesses the
                  incident, the damaged parts are replaced with spares and start again at zero

Wear is never booked: the 2024 Financial Regulations exclude depreciation and amortisation (Art. 3.1(o)). What life
moves is the forecast: the race at which each part runs out, which is when its replacement is fitted and its cost
counts against the cap (first use). When this weekend's running moves a replacement from next year into this one,
that cost is `brought_forward_cents`. A gearbox or power unit due before the season ends on a car already at its
allocation is a grid penalty.

Every life figure here is an assumption (stated below); the lap counts, race-control messages and crashes are real.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from race import prices as P

# Kilometres a part lasts in normal running (assumption: a gearbox or power unit element over four to six weekends,
# the season's allocation of four spread over 24 rounds; a floor's plank and a front wing over a few weekends;
# brake discs about two weekends).
LIFE_KM = {
    "front_wing": 2500, "floor": 2000, "rear_wing": 3000, "front_suspension": 5000, "rear_suspension": 5000,
    "gearbox": 5000, "power_unit": 4800, "brakes": 1600, "bodywork": 4000, "electronics": 10000, "chassis": 15000,
}
PARTS = tuple(LIFE_KM)
# Life already used when the weekend starts (assumption: late in the season, both cars near the end of their
# gearbox and power unit elements; Colapinto's car inherited Sargeant's).
START_USED = {
    23: {"front_wing": 0.35, "floor": 0.48, "rear_wing": 0.40, "front_suspension": 0.52, "rear_suspension": 0.50, "gearbox": 0.70,
         "power_unit": 0.78, "brakes": 0.0, "bodywork": 0.30, "electronics": 0.55, "chassis": 0.62},
    43: {"front_wing": 0.30, "floor": 0.60, "rear_wing": 0.45, "front_suspension": 0.40, "rear_suspension": 0.45, "gearbox": 0.55,
         "power_unit": 0.72, "brakes": 0.0, "bodywork": 0.35, "electronics": 0.50, "chassis": 0.58},
}
LAP_KM = 4.309          # Interlagos (Autódromo José Carlos Pace)
QUALI_FACTOR = 1.15     # assumption: a qualifying lap wears the car harder than a race lap
WEEKEND_KM = 750        # assumption: practice, qualifying and race distance at a future round
# Share of a part's life one stress event takes, by Jev's severity, scaled by Jev's probability that the part was hit.
SEVERITY_TAKES = {"none": 0.01, "light": 0.05, "moderate": 0.15, "heavy": 0.25}  # heavy: on the parts it did not destroy
OFF_TRACK_PARTS = {"floor": 0.8, "front_wing": 0.4, "bodywork": 0.3, "front_suspension": 0.2}  # a run over kerbs or run-off
LIKELY = 0.5
WATCH = 0.75
# The rest of the 2024 season after São Paulo (assumption when the weekend file has no calendar).
REST_OF_SEASON = [
    {"name": "Las Vegas Grand Prix", "race": "2024-11-23"},
    {"name": "Qatar Grand Prix", "race": "2024-12-01"},
    {"name": "Abu Dhabi Grand Prix", "race": "2024-12-08"},
]
PENALTY_PARTS = {"gearbox": "gearbox", "power_unit": "ICE"}


@dataclass
class PartLife:
    meeting_key: int
    driver_number: int
    part: str
    used: float                     # share of life used
    status: str = "ok"              # ok | watch | due | damaged | replaced
    due_event: str = ""
    due_at: str = ""
    cost_cents: int = 0
    cap_note: str = ""
    brought_forward_cents: int = 0
    stress: list[dict] = field(default_factory=list)
    updated_at: str = ""

    @property
    def key(self) -> str:
        return f"{self.meeting_key}-{self.driver_number}-{self.part}"

    def wire(self) -> dict:
        life = LIFE_KM[self.part]
        return {"part_key": self.key, "meeting_key": self.meeting_key, "driver_number": self.driver_number, "part": self.part,
                "used_pct": round(self.used * 100, 2), "life_km": life, "remaining_km": int(round(life * (1 - self.used))),
                "status": self.status, "due_event": self.due_event, "due_at": self.due_at, "cost_cents": int(self.cost_cents),
                "cap_note": self.cap_note[:512], "brought_forward_cents": int(self.brought_forward_cents),
                "stress_json": json.dumps(self.stress[-12:], separators=(",", ":"))[:4096], "updated_at": self.updated_at}


def _calendar(state) -> list[dict]:
    from race.logistics import next_events

    try:
        ev = next_events(state)
    except Exception:
        ev = []
    return [{"name": e["name"], "race": e.get("race", "")} for e in ev if e.get("race")] or REST_OF_SEASON


def _forecast(p: PartLife, state, baseline_used: float) -> None:
    """When the part runs out, what its replacement costs, and whether this weekend moved it into this year's cap."""
    cal = _calendar(state)
    life = LIFE_KM[p.part]
    price = P.PARTS.get(p.part)
    p.cost_cents = price.usd_cents()[1] if price else 0

    def due_index(used: float) -> int:  # 0-based round of the rest of the season, len(cal) = next year
        left = life * max(0.0, 1 - used)
        return min(int(left // WEEKEND_KM), len(cal))

    i = due_index(p.used)
    if p.status in ("damaged", "replaced"):
        pass
    elif i < len(cal):
        p.status = "due" if i == 0 else "watch" if p.used >= WATCH else "ok"
    else:
        p.status = "watch" if p.used >= WATCH else "ok"
    if p.status == "damaged":
        p.due_event, p.due_at = cal[0]["name"], cal[0]["race"]
        p.cap_note = "damaged: the spare fitted counts against the 2024 cap at first use"
    elif p.status == "replaced":
        p.due_event, p.due_at = "", ""
        p.cap_note = "new: the spare fitted after the crash counts against the 2024 cap at first use"
    elif i < len(cal):
        p.due_event, p.due_at = cal[i]["name"], cal[i]["race"]
        p.cap_note = f"runs out by the {cal[i]['name']}: the replacement counts against the 2024 cap when fitted"
        pen = PENALTY_PARTS.get(p.part)
        alloc = (_assumptions(state).get("allocation") or {})
        used_n = ((alloc.get("used") or {}).get(str(p.driver_number)) or {}).get(pen or "", 0)
        limit = (alloc.get("limits") or {}).get(pen or "", 99)
        if pen and used_n >= limit:
            p.cap_note += f"; car {p.driver_number} is at its {pen} allocation ({used_n} of {limit}): a new one is a grid penalty"
    else:
        p.due_event, p.due_at = "2025", ""
        p.cap_note = "lasts the season: its replacement falls in the 2025 cap"
    # moved into this year by this weekend's running and stress, against the life it had at the start
    p.brought_forward_cents = p.cost_cents if (p.status not in ("damaged", "replaced") and i < len(cal) and due_index(baseline_used) >= len(cal)) else 0


def _assumptions(state) -> dict:
    from race.logistics import assumptions

    try:
        return assumptions(state) or {}
    except Exception:
        return {}


def _book(state) -> dict:
    book = getattr(state, "life", None)
    if book is None:
        book = state.life = {"cars": {}, "start": {}, "assessed": set()}
    return book


def _car(state, car: int) -> dict[str, PartLife]:
    book = _book(state)
    if car not in book["cars"]:
        start = START_USED.get(car) or START_USED[23]
        book["cars"][car] = {p: PartLife(state.meeting_key, car, p, start.get(p, 0.3)) for p in PARTS}
        book["start"][car] = dict(start)
    return book["cars"][car]


def _stress_kind(ev) -> str | None:
    msg = str((ev.payload or {}).get("message", "")).upper()
    if ev.kind == "notice" and "TRACK LIMITS" in msg:
        return "off_track"
    if ev.kind == "incident" and (ev.payload or {}).get("team_involved"):
        reason = str((ev.payload or {}).get("reason", "")).upper()
        return "off_track" if "LEAVING THE TRACK" in reason else "contact"
    if ev.kind == "car_stopped":
        return "crash"
    return None


def _jev_read(ev, jev, replay) -> tuple[str, float, dict, str]:
    """(severity, its probability, part probabilities, who decided). Uses the answers the replay already has for the
    event; asks Jev itself (System One, a few hundred ms) when nothing decided it yet."""
    if jev is None or not (jev.probabilities or {}).get("severity"):
        from race import jev as J

        ctx = replay.context_for(ev) if replay is not None and hasattr(replay, "context_for") else {"team": "Williams"}
        offline = getattr(replay, "offline", False)
        jev = J.offline_decide(ev, ctx) if offline else J.decide(ev, ctx)
    sev = jev.severity or "none"
    p = float((jev.p("severity") or {}).get(sev, 0.0))
    who = "offline rules" if getattr(jev, "offline", True) else "Jev"
    return sev, p, dict(jev.parts or {}), who


def update(state, ev, jev=None, replay=None) -> list[PartLife]:
    """Life for our cars after one event; returns the rows that changed."""
    car = int(ev.driver_number or 0)
    team = getattr(state, "team", "Williams")
    changed: dict[str, PartLife] = {}
    book = _book(state)

    # the garage assessed an incident of ours: its damaged parts are replaced with spares and start again
    for inc in (getattr(state, "incidents", {}) or {}).values():
        if inc.team_name != team or inc.status not in ("assessed", "closed") or inc.incident_key in book["assessed"]:
            continue
        book["assessed"].add(inc.incident_key)
        parts = _car(state, inc.driver_number)
        hit = {("chassis" if n == "chassis_repair" else n) for n, pr in ((inc.belief or {}).get("parts") or {}).items() if float(pr) >= LIKELY}
        for name, pl in parts.items():
            if pl.status == "damaged" and name not in hit:  # the garage found it fine: it keeps the life it has left
                pl.status = "ok"
                changed[pl.key] = pl
        for name, pr in ((inc.belief or {}).get("parts") or {}).items():
            name = "chassis" if name == "chassis_repair" else name
            if name in parts and float(pr) >= LIKELY:
                pl = parts[name]
                pl.used, pl.status = 0.0, "replaced"
                pl.stress.append({"at": inc.updated_at, "kind": "replaced", "note": f"replaced after {inc.incident_key}", "taken": 0})
                book["start"][inc.driver_number][name] = 0.0
                changed[pl.key] = pl

    if not car or getattr(ev, "team_name", "") != team:
        return _finish(state, changed, ev)
    parts = _car(state, car)
    kind = _stress_kind(ev)
    if ev.kind == "lap" and (ev.payload or {}).get("complete"):
        factor = QUALI_FACTOR if getattr(replay, "session_type", "Race") != "Race" else 1.0
        for pl in parts.values():
            if pl.status == "damaged":
                continue
            pl.used += LAP_KM * factor / LIFE_KM[pl.part]
            if pl.status == "replaced":
                pl.status = "ok"
            changed[pl.key] = pl
    elif kind:
        sev, p, hit, who = _jev_read(ev, jev, replay)
        note = str((ev.payload or {}).get("summary") or (ev.payload or {}).get("message") or ev.kind)[:120]
        for name, pl in parts.items():
            if kind == "off_track":
                share = OFF_TRACK_PARTS.get(name, 0.0) * max(SEVERITY_TAKES.get(sev, 0.01), 0.02)
            else:
                share = float(hit.get(name, 0.0)) * SEVERITY_TAKES.get(sev, 0.0)
            if share <= 0.002:
                continue
            if kind == "crash" and sev == "heavy" and float(hit.get(name, 0.0)) >= LIKELY:
                pl.status = "damaged"
                share = max(share, 1 - pl.used)
            pl.used = min(pl.used + share, 1.2)
            pl.stress.append({"at": ev.at, "lap": ev.lap, "kind": kind, "note": note, "severity": sev, "p": round(p, 2),
                              "taken": round(share * 100, 1), "by": who})
            changed[pl.key] = pl
    return _finish(state, changed, ev)


def _finish(state, changed: dict[str, PartLife], ev) -> list[PartLife]:
    book = _book(state)
    out = []
    for pl in changed.values():
        base = book["start"].get(pl.driver_number, {}).get(pl.part, pl.used)
        _forecast(pl, state, base)
        pl.updated_at = ev.at
        out.append(pl)
    return out


def summary(state) -> dict:
    """The hardware picture for the season run and the CFO: replacements due this year and what they bring into the cap."""
    rows = [pl for parts in (_book(state)["cars"] or {}).values() for pl in parts.values()]
    due = [pl for pl in rows if pl.due_event and pl.due_event != "2025"]
    return {"due_this_year": len(due), "due_cents": sum(pl.cost_cents for pl in due),
            "brought_forward_cents": sum(pl.brought_forward_cents for pl in rows),
            "penalties": [f"car {pl.driver_number} {pl.part} at the {pl.due_event}" for pl in due if "grid penalty" in pl.cap_note]}
