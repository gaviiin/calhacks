"""Stage 3, respond: what the playbook sets off for an incident, priced so the person who decides sees the trade.

    manifest = load_manifest(state)       # part -> {"at_track": n, "factory": n}
    actions = plan(incident, state)       # idempotent: the same incident version gives the same actions

Reversible, internal actions are `auto`; outward-facing or irreversible ones (withdraw a car, book freight or a
hand carry, an FIA notice) are `awaiting_approval` with the owner_role who decides. Keys are
`{incident_key}:{kind}[:{part}]`, so a later version of the same incident rewrites its rows instead of adding to
them; reservations are recomputed from every incident's latest belief in the order the crashes happened, so a
part is never counted twice. An action that a newer belief no longer needs comes back `cancelled`, and a
person's approval or rejection is never overwritten.

The withdraw decision follows Varun Sanjeev's incident planner (var930, live_racing/incident_planner.py): every
outcome is priced the same way and gated on feasibility before anyone decides. Here the outcomes are the garage's
(repair and start from the grid, build up the spare tub and start from the pit lane, withdraw), the gate is hours
needed against hours until the race start, and the price is the cost band, the expected points and the risk.

The assumptions (spares, hours, freight cut-offs, allocations) live in race/data/williams_2024.json, each with
its basis and source; other weekends fall back to race/data/williams_spares.json and stated defaults.
"""

from __future__ import annotations

import json
from datetime import timedelta
from functools import lru_cache
from pathlib import Path

from race import prices as P
from race.events import Action, Incident, iso, parse_iso
from race.points import points_for

DATA = Path(__file__).resolve().parent / "data"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
LIKELY = 0.5  # a part is reserved, rebuilt and shipped when P(damaged) >= LIKELY (the effects' low band)
POSSIBLE = 0.2  # a power unit or gearbox check runs when P(damaged) >= POSSIBLE
TUB = ("chassis", "chassis_repair")
DECIDED = ("approved", "rejected", "done")

# Defaults when a weekend has no williams_<year>.json (assumptions, as in that file).
DEFAULTS = {
    "chassis": {"spare_tub_build_hours": {"low": 10, "mid": 12, "high": 14}},
    "repair": {"crews": 2, "checks_hours": 1.0, "hours": {"front_wing": 0.5, "rear_wing": 1.0, "floor": 3.0, "front_suspension": 2.5,
                                                         "rear_suspension": 2.5, "gearbox": 4.0, "bodywork": 1.0, "brakes": 1.0,
                                                         "rear_brakes": 1.5, "electronics": 2.0, "steering_rack": 2.0,
                                                         "wheel_speed_sensor": 0.3, "power_unit": 5.0}},
    "decision": {"lead_minutes": 60, "finish_rate": 0.75, "pit_lane_expected_points": 0.3},
    "freight": {"hand_carry_parts": ["front_wing", "rear_wing", "front_suspension", "rear_suspension", "bodywork", "brakes", "rear_brakes",
                                     "electronics", "steering_rack", "wheel_speed_sensor"]},
    "allocation": {"limits": {"ICE": 4, "TC": 4, "MGU-H": 4, "MGU-K": 4, "ES": 2, "CE": 2, "gearbox": 4}, "used": {},
                   "pu_elements": ["ICE", "TC", "MGU-H", "MGU-K", "ES", "CE"]},
}


@lru_cache(maxsize=None)
def _json(path: str) -> dict:
    p = Path(path)
    return json.loads(p.read_text()) if p.exists() else {}


def assumptions(state) -> dict:
    """The weekend's assumptions file when it is for this meeting, else {} (the DEFAULTS apply)."""
    d = _json(str(DATA / f"williams_{state.year}.json"))
    return d if d and int(d.get("meeting_key") or 0) == int(state.meeting_key) else {}


def _a(state, section: str) -> dict:
    return {**DEFAULTS.get(section, {}), **assumptions(state).get(section, {})}


def load_manifest(state) -> dict:
    """part -> {"at_track": n, "factory": n} before the weekend's first crash."""
    spares = assumptions(state).get("spares")
    if spares:
        return {k: {"at_track": int(v.get("at_track", 0)), "factory": int(v.get("factory", 0))}
                for k, v in spares.items() if not k.startswith("_")}
    generic = _json(str(DATA / "williams_spares.json")).get("spares", {})
    return {k: {"at_track": int(n), "factory": 0} for k, n in generic.items()}


# ---------------------------------------------------------------------- what we believe the car needs

def belief_of(inc: Incident, state) -> dict:
    """Severity and part probabilities as priced: the incident's belief pooled with the telemetry impact, the same
    pool race/effects.py applies (race/prices.py impact_parts). A person's own severity answer is kept as given."""
    b = inc.belief or {}
    parts, sev, kph = dict(b.get("parts") or {}), dict(b.get("severity") or {}), b.get("impact_kph")
    source = "belief"
    if not parts:
        booked = _booked(inc, state)
        if booked:
            return {"parts": dict(booked.get("parts") or {}), "severity": dict(booked.get("severity") or sev), "kph": booked.get("kph") or kph,
                    "source": "the booked crash line"}
        if sev:
            parts = dict(P.SEVERITY_TEMPLATES.get(max(sev, key=sev.get), []))
            source = "the severity template"
    person = b.get("assessed_by") not in (None, "", "deadline")
    out_parts = P.impact_parts(parts, kph)
    out_sev = sev if person and sev else P.impact_severity_p(sev, kph)
    if kph:
        source += f" pooled with the {int(kph)} km/h impact"
    return {"parts": out_parts, "severity": out_sev, "kph": kph, "source": source}


def _booked(inc: Incident, state) -> dict | None:
    replay = getattr(state, "replay", None)
    ctx = getattr(replay, "ctx", None)
    if ctx is None or int((getattr(replay, "session", {}) or {}).get("session_key") or 0) != inc.session_key:
        return None
    booked = ctx.booked.get(inc.driver_number)
    if booked and abs(int(booked.get("lap") or 0) - int(inc.belief.get("lap") or 0)) <= 10:
        return booked
    return None


def _label(part: str, default: str | None = None) -> str:
    return "monocoque" if part == "chassis" else P.PART_LABELS.get(part, default or part)


def tub_p(parts: dict) -> float:
    """P(the monocoque is damaged): replaced and repaired are alternatives, both mean the tub is out."""
    return min(1.0, sum(float(parts.get(k, 0.0)) for k in TUB))


def likely_parts(b: dict) -> list[str]:
    """Parts to reserve, rebuild and ship: P >= LIKELY and priced; the tub as `chassis` when it is likely damaged."""
    parts = b["parts"]
    out = sorted((k for k, p in parts.items() if p >= LIKELY and k not in TUB and k in P.PARTS and P.PARTS[k].mid > 0),
                 key=lambda k: (-parts[k], k))
    if tub_p(parts) >= LIKELY:
        out.insert(0, "chassis")
    return out


def _tub_job(parts: dict) -> str:
    """Which factory job the tub needs: a new monocoque or a repair at Grove, whichever is likelier."""
    return "chassis" if parts.get("chassis", 0.0) >= parts.get("chassis_repair", 0.0) else "chassis_repair"


# ---------------------------------------------------------------------- the weekend's clock

@lru_cache(maxsize=None)
def _session_start(key: int) -> str:
    s = _json(str(FIXTURES / str(key) / "session.json"))
    if isinstance(s, list):
        s = s[0] if s else {}
    return s.get("date_start") or ""


def session_type(inc: Incident, state) -> str:
    return inc.belief.get("session_type") or (state.info.get("session_names") or {}).get(str(inc.session_key)) or state.session_type


def race_start(state, after: str) -> str:
    """The start of the next Race session after `after` (ISO), from the session fixtures; '' when none is known."""
    names = state.info.get("session_names") or {}
    for key in state.info.get("sessions", []):
        if names.get(str(key)) != "Race":
            continue
        start = _session_start(int(key))
        if not start and int((state.session or {}).get("session_key") or 0) == int(key):
            start = state.session.get("date_start") or ""
        if start and parse_iso(start) > parse_iso(after):
            return iso(parse_iso(start))
    return ""


def _hours(a: str, b: str) -> float:
    return (parse_iso(b) - parse_iso(a)).total_seconds() / 3600


def next_events(state) -> list[dict]:
    """The next events with their freight cut-offs: the assumptions file's, else the weekend's next race with a
    factory cut-off seven days before it and a hand carry three days before (assumption)."""
    ev = assumptions(state).get("freight", {}).get("events")
    if ev:
        return ev
    out = []
    for e in [state.info.get("next") or {}, *(state.info.get("after_next") or [])]:
        if not e.get("date"):
            continue
        d = parse_iso(e["date"] + "T18:00:00Z")
        out.append({"name": e.get("name", "next event"), "race": e["date"], "factory_air_cutoff": iso(d - timedelta(days=7)),
                    "hand_carry_cutoff": iso(d - timedelta(days=3, hours=10))})
    return out


def _flyaway(state) -> bool:
    return bool((state.info.get("next") or {}).get("flyaway"))


# ---------------------------------------------------------------------- stock, in the order the crashes happened

def _ordered(inc: Incident, state) -> list[Incident]:
    incs = dict(state.incidents)
    incs[inc.incident_key] = inc
    return sorted(incs.values(), key=lambda i: (i.first_seen_at, i.incident_key))


def allocate(inc: Incident, state) -> dict[str, dict]:
    """part -> where this incident's part comes from and the stock before and after it, after every earlier
    incident took its own parts (each from its latest belief). At track first, then Grove's stock, else made."""
    stock = {k: dict(v) for k, v in (state.spares or load_manifest(state)).items()}
    for cur in _ordered(inc, state):
        b = belief_of(cur, state)
        mine = {}
        for part in likely_parts(b):
            s = stock.setdefault(part, {"at_track": 0, "factory": 0})
            before = dict(s)
            if s["at_track"] > 0:
                s["at_track"] -= 1
                src = "at_track"
            elif s["factory"] > 0:
                s["factory"] -= 1
                src = "factory"
            else:
                src = "make"
            mine[part] = {"source": src, "before": before, "after": dict(s), "p": round(tub_p(b["parts"]) if part == "chassis" else b["parts"].get(part, 0.0), 3)}
        if cur.incident_key == inc.incident_key:
            return mine
    return {}


# ---------------------------------------------------------------------- money and points for the decision

def _usd_cents(state, gbp: float) -> int:
    ctx = getattr(getattr(state, "replay", None), "ctx", None)
    return ctx.gbp_cents(gbp) if ctx is not None else int(round(gbp * P.USD_PER_GBP * 100))


def _band(state, price: P.Price) -> list[int]:
    return [_usd_cents(state, price.low), _usd_cents(state, price.mid), _usd_cents(state, price.high)]


def _grid(inc: Incident, state) -> tuple[int | None, str]:
    for row in (state.results or {}).get(inc.session_key, []) or []:
        if int(row.get("driver_number") or 0) == inc.driver_number and row.get("position"):
            return int(row["position"]), "qualifying result"
    ctx = getattr(getattr(state, "replay", None), "ctx", None)
    pos = (ctx.positions.get(inc.driver_number) if ctx is not None else None)
    if pos:
        return int(pos), "running order when the car stopped"
    return None, "grid not known yet (P10 assumed)"


def _standings_note(state) -> str:
    ctx = getattr(getattr(state, "replay", None), "ctx", None)
    start = dict(getattr(ctx, "standings_start", {}) or {})
    if state.team not in start:
        return ""
    order = sorted(start.items(), key=lambda kv: (-kv[1], kv[0]))
    i = [t for t, _ in order].index(state.team)
    bits = [f"{state.team} P{i + 1} on {start[state.team]:g} pts"]
    if i + 1 < len(order):
        bits.append(f"{order[i + 1][0]} P{i + 2} on {order[i + 1][1]:g}")
    if i > 0:
        bits.insert(0, f"{order[i - 1][0]} P{i} on {order[i - 1][1]:g}")
    try:
        from race import prize as ladder

        step = ladder.prize(state.year, i + 1) - ladder.prize(state.year, i + 2)
        bits.append(f"one place is ${step / 1e8:,.1f}m on the {state.year} ladder")
    except (KeyError, ValueError, FileNotFoundError):
        pass
    return "; ".join(bits)


def repair_hours(parts: list[str], state) -> list[float]:
    """[low, mid, high] garage hours to change `parts` like for like: the crews work in parallel, so the job is the
    longer of the longest single change and the total split across the crews, plus the checks."""
    r = _a(state, "repair")
    hours = [float(r["hours"].get(p, 1.5)) for p in parts if p not in TUB]
    if not hours:
        mid = float(r["checks_hours"])
    else:
        mid = max(max(hours), sum(hours) / max(int(r["crews"]), 1)) + float(r["checks_hours"])
    return [round(mid * 0.8, 1), round(mid, 1), round(mid * 1.3, 1)]


def expected_points(grid: int, state) -> float:
    """Expected points from a grid slot: the mean points of finishing within SPREAD places of it, times the chance of
    finishing, and never less than a pit-lane start is worth (a grid slot is at least as good). Assumptions."""
    d = _a(state, "decision")
    spread = int(d.get("spread", 5))
    slots = range(max(1, grid - spread), min(20, grid + spread) + 1)
    e = float(d["finish_rate"]) * sum(points_for(p) for p in slots) / len(slots)
    return round(max(e, float(d["pit_lane_expected_points"])), 1)


def withdraw_options(inc: Incident, state, b: dict, start: str) -> dict:
    """The three priced outcomes for a car damaged in qualifying, side by side. The desk prices them and states what
    fits the time; it does not pick one. Whether the car starts is the Team Principal's call."""
    d = _a(state, "decision")
    parts = likely_parts(b)
    available = round(max(_hours(inc.first_seen_at, start), 0.0), 2)
    grid, grid_basis = _grid(inc, state)
    g = grid or 10
    sev = max(b["severity"], key=b["severity"].get) if b["severity"] else "moderate"
    tp = tub_p(b["parts"])
    tub_h = _a(state, "chassis")["spare_tub_build_hours"]
    checks = float(_a(state, "repair")["checks_hours"])

    rep_h = repair_hours(parts, state)
    rep_ok = tp < LIKELY and rep_h[1] <= available
    rep_risk = (f"the tub is likely damaged (P={tp:.2f}) and a monocoque is not repaired at the track" if tp >= LIKELY else
                f"{rep_h[1]:.1f} h needed against {available:.1f} h" + ("; tight: an overrun means a pit-lane start or no start"
                                                                        if rep_h[2] > available else ""))
    tub = [round(float(tub_h["low"]) + checks, 1), round(float(tub_h["mid"]) + checks, 1), round(float(tub_h["high"]) + checks, 1)]
    tub_ok = tub[1] <= available
    labour = _band(state, P.REPAIR_LABOUR.get(sev, P.REPAIR_LABOUR["moderate"]))
    heavy = _band(state, P.REPAIR_LABOUR["heavy"])
    chassis = _band(state, P.PARTS["chassis"])
    options = [
        {"id": "repair", "label": "Repair and start from the grid", "hours_needed": rep_h, "feasible": rep_ok, "cost_cents": labour,
         "expected_points": expected_points(g, state) if rep_ok else 0.0,
         "risk": rep_risk + f"; the {len(parts)} parts fitted now count against the cap now"},
        {"id": "spare_tub", "label": "Build up the spare tub, start from the pit lane", "hours_needed": tub, "feasible": tub_ok,
         "cost_cents": [heavy[0] + chassis[0], heavy[1] + chassis[1], heavy[2] + chassis[2]],
         "expected_points": float(d["pit_lane_expected_points"]) if tub_ok else 0.0,
         "risk": f"{tub[1]:.0f} h to build up a bare tub against {available:.1f} h" + ("" if tub_ok else ": cannot be ready for the start")
                 + "; the spare tub's first use counts against the cap and leaves none for the next event"},
        {"id": "withdraw", "label": "Withdraw the car", "hours_needed": [0, 0, 0], "feasible": True, "cost_cents": [0, 0, 0],
         "expected_points": 0.0, "risk": "certain zero points; the rebuild moves to Grove and the spares at track stay for the next event"},
    ]
    fits = ", ".join(f"{o['label'].lower()} {o['hours_needed'][1]:.1f} h" for o in options if o["id"] != "withdraw")
    summary = (f"The race starts {available:.1f} h after the crash. Hours needed: {fits}"
               + (f"; the tub is likely damaged (P={tp:.2f})" if tp >= LIKELY else "") + ".")
    return {"car": inc.driver_number, "grid": grid, "grid_basis": grid_basis, "race_start": start, "hours_available": available,
            "p_heavy": round(b["severity"].get("heavy", 0.0), 2), "p_tub": round(tp, 2), "options": options,
            "summary": summary, "standings": _standings_note(state)}


# ---------------------------------------------------------------------- the plan

def plan(inc: Incident, state) -> list[Action]:
    car, ik = inc.driver_number, inc.incident_key
    b = belief_of(inc, state)
    parts = likely_parts(b)
    alloc = allocate(inc, state)
    kph = f"{int(b['kph'])} km/h" if b.get("kph") else "no telemetry impact"
    p_heavy = b["severity"].get("heavy", 0.0)
    labels = ", ".join(_label(p, p) for p in parts) or "nothing likely"
    stype = session_type(inc, state)
    start = race_start(state, inc.first_seen_at) if stype != "Race" else ""
    events = next_events(state)
    nxt = events[0] if events else {}
    out: list[Action] = []

    def add(kind: str, title: str, detail: dict, *, part: str = "", owner: str, status: str = "auto", due: str = "",
            outward: bool = False, reversible: bool = True) -> None:
        key = f"{ik}:{kind}" + (f":{part}" if part else "")
        out.append(Action(action_key=key, incident_key=ik, kind=kind, title=title, detail=detail, due_at=due, status=status,
                          owner_role=owner, outward=outward, reversible=reversible, updated_at=inc.updated_at))

    add("garage_check", f"Garage: confirm the damage on car {car}",
        {"why": f"Telemetry says {kph}; the desk believes {labels} (P(heavy)={p_heavy:.2f}, from {b['source']}). The chief mechanic's "
                "look decides which parts change; every reservation and entry below is provisional until then.",
         "likely": {p: alloc.get(p, {}).get("p") for p in parts}}, owner="chief_mechanic")

    for part in parts:
        a = alloc[part]
        label = _label(part, part)
        src = {"at_track": "from the spares at track", "factory": "from Grove's stock, none left at track", "make": "none at track or at Grove: one must be made"}[a["source"]]
        add("spares_reserve", f"Reserve {label} for car {car}" + ("" if a["source"] == "at_track" else f" ({src})"),
            {"why": f"P(damaged)={a['p']:.2f} >= {LIKELY}: reserved {src}; earlier crashes this weekend already took theirs.",
             "part": part, "label": label, "p": a["p"], "qty": 1, "source": a["source"],
             "manifest_at_track": (state.spares or {}).get(part, {}).get("at_track", 0),
             "at_track_before": a["before"]["at_track"], "at_track_after": a["after"]["at_track"],
             "factory_before": a["before"]["factory"], "factory_after": a["after"]["factory"]}, part=part, owner="chief_mechanic")

    carry, ship = [], []
    if parts and nxt:
        hand_ok = set(_a(state, "freight")["hand_carry_parts"])
        for part in parts:
            job = _tub_job(b["parts"]) if part == "chassis" else part
            lead = P.LEAD_DAYS.get(job, (3, 5, 8))
            ready = iso(parse_iso(inc.first_seen_at) + timedelta(days=lead[1]))
            cutoff, hand = nxt["factory_air_cutoff"], nxt["hand_carry_cutoff"]
            covered = alloc[part]["after"]["at_track"] > 0 or alloc[part]["after"]["factory"] > 0
            if parse_iso(ready) <= parse_iso(cutoff):
                route = "makes the factory air freight"
                ship.append(part)
            elif part in hand_ok and parse_iso(ready) <= parse_iso(hand):
                route = "misses the air freight: hand carry"
                carry.append(part)
            else:
                route = f"misses {nxt['name']}" + ("; the spares at track cover it" if covered else f"; the team races {nxt['name']} without a spare")
            what = "repair the damaged tub" if job == "chassis_repair" else ("build a new monocoque" if job == "chassis" else f"rebuild the {_label(job, job)}")
            add("work_order", f"Grove: {what} for {nxt['name']}",
                {"why": f"Replaces the {_label(part, part)} car {car} used; {lead[1]} working days (assumption) puts it ready "
                        f"{ready[:10]}, against the {nxt['name']} factory cut-off {cutoff[:10]}: {route}.",
                 "part": job, "qty": 1, "lead_days": list(lead), "ready_at": ready, "cutoff": cutoff, "route": route},
                part=part, owner="technical_director", due=cutoff)
        f_band = _band(state, P.EXPEDITED_FREIGHT)
        if carry:
            add("hand_carry", f"Hand carry to {nxt['name']}: {', '.join(_label(p, p) for p in carry)}",
                {"why": f"Grove finishes these after the air freight closes ({nxt['factory_air_cutoff'][:10]}); a person flies with them by "
                        f"{nxt['hand_carry_cutoff'][:10]}. Outward and paid: the Head of Logistics books it.",
                 "parts": carry, "cost_cents": f_band, "cutoff": nxt["hand_carry_cutoff"]},
                owner="logistics", status="awaiting_approval", due=nxt["hand_carry_cutoff"], outward=True)
        if _flyaway(state) and ship:
            add("freight", f"Book air freight to {nxt['name']}: {len(ship)} part{'s' if len(ship) != 1 else ''} for car {car}",
                {"why": f"{nxt['name']} is a flyaway; the rebuilt parts join the factory's air consolidation before {nxt['factory_air_cutoff'][:10]}. "
                        "A booking with a carrier is outward: the Head of Logistics confirms it.",
                 "parts": ship, "cost_cents": f_band, "cutoff": nxt["factory_air_cutoff"]},
                owner="logistics", status="awaiting_approval", due=nxt["factory_air_cutoff"], outward=True)

    decision = None
    said_heavy = max(p_heavy, float((inc.belief.get("severity") or {}).get("heavy", 0.0)))  # the incident's own belief, or the priced one
    if stype != "Race" and start and (said_heavy >= LIKELY or tub_p(b["parts"]) >= LIKELY):
        decision = withdraw_options(inc, state, b, start)
        if inc.belief.get("dns"):
            decision["outcome"] = f"car {car} did not take the start (DNS in the race result)"
        decide_by = iso(parse_iso(start) - timedelta(minutes=int(_a(state, "decision")["lead_minutes"])))
        add("withdraw_car", f"Car {car}: repair, spare tub or withdraw? {decision['hours_available']:.1f} h from the crash to the start",
            {"why": decision["summary"] + " Three options priced; the desk does not choose. Whether the car starts is irreversible and outward: "
                    "the Team Principal decides.", **decision},
            owner="team_principal", status="awaiting_approval", due=decide_by, outward=True, reversible=False)

    # Execution follows the person's choice: once the Team Principal has chosen, the paperwork that goes with it is
    # the only paperwork left (the decision itself is kept by _settle).
    prior_w = (state.actions or {}).get(f"{ik}:withdraw_car")
    chosen = (prior_w.detail or {}).get("chosen") if prior_w is not None and prior_w.status in ("approved", "done") else None
    chosen_by = (prior_w.detail or {}).get("chosen_by", "the Team Principal") if chosen else ""

    if stype != "Race" and start:
        pf_detail = {"why": "Between qualifying and the race the car is in parc fermé: like-for-like replacements need the Technical Delegate's "
                            "approval, so the list is drafted now from the likely parts and confirmed by the garage.",
                     "parts": [{"part": p, "label": _label(p, p), "spec": "identical specification"} for p in parts if p != "chassis"],
                     "used_only_if": "the car is repaired to start"}
        if chosen == "withdraw":
            add("parc_ferme_list", f"Parc fermé list for car {car}: not needed, the car is withdrawn",
                {**pf_detail, "why": f"{chosen_by} chose to withdraw car {car}: no parts change under parc fermé."}, owner="chief_mechanic", status="cancelled")
        else:
            add("parc_ferme_list", f"Parc fermé: replaced parts on car {car} for the Technical Delegate", pf_detail, owner="chief_mechanic")
        drafts = [
            {"option": "repair", "to": "Technical Delegate",
             "draft": f"Williams requests approval to replace damaged parts on car {car} under parc fermé with parts of identical specification (list attached)."},
            {"option": "spare_tub", "to": "Technical Delegate and the Stewards",
             "draft": f"Williams will change the survival cell of car {car} under parc fermé; the car will start from the pit lane."},
            {"option": "withdraw", "to": "the Stewards", "draft": f"Williams notifies that car {car} will not take the start of the race."},
        ]
        pick = next((d for d in drafts if d["option"] == chosen), None)
        if pick is not None:
            add("fia_notice", f"FIA notice to {pick['to']}: car {car}, {chosen.replace('_', ' ')}",
                {"why": f"{chosen_by} chose {chosen.replace('_', ' ')}; this is the notice that goes with it. Outward: the Sporting Director sends it.",
                 "drafts": drafts, "chosen": chosen, "to": pick["to"], "draft": pick["draft"], "follows": chosen_by},
                owner="sporting_director", status="awaiting_approval", due=start, outward=True)
        else:
            add("fia_notice", f"FIA notice for car {car}: one draft per option",
                {"why": "One draft for each option the Team Principal may choose; the Sporting Director sends the one that matches the choice "
                        "(a notice to the FIA is outward).", "drafts": drafts, "follows": "the Team Principal's choice"},
                owner="sporting_director", status="awaiting_approval", due=start, outward=True)

    p_pu, p_gb = b["parts"].get("power_unit", 0.0), b["parts"].get("gearbox", 0.0)
    if max(p_pu, p_gb) >= POSSIBLE:
        al = _a(state, "allocation")
        used = (al.get("used") or {}).get(str(car), {})
        elements = []
        for el in [*al["pu_elements"], "gearbox"]:
            limit, n = int(al["limits"].get(el, 0)), int(used.get(el, 0))
            elements.append({"element": el, "used": n, "limit": limit, "left": max(limit - n, 0), "p_damaged": round(p_gb if el == "gearbox" else p_pu, 2)})
        at_limit = [e for e in elements if e["left"] == 0 and e["p_damaged"] >= POSSIBLE]
        risk = max((e["p_damaged"] for e in at_limit), default=0.0)
        add("pu_check", f"Power unit and gearbox check on car {car}" + (f": grid penalty risk {risk:.0%} at {nxt.get('name', 'the next event')}" if at_limit else ""),
            {"why": f"P(power unit damaged)={p_pu:.2f}, P(gearbox)={p_gb:.2f}. "
                    + (f"{', '.join(e['element'] for e in at_limit)} already at the limit: a new one means a grid penalty "
                       f"(10 places for the first element over) at {nxt.get('name', 'the next event')}." if at_limit else "Allocation left covers a replacement."),
             "elements": elements, "penalty_risk": round(risk, 2), "basis": "allocation used is an assumption (race/data/williams_2024.json)"},
            owner="technical_director")

    if parts:
        moves = []
        for p in parts:
            label = _label(p, p)
            moves.append({"part": p, "label": label, "from": f"car {car}", "to": "redundant (destroyed)", "recognition": "already_expensed"})
            moves.append({"part": p, "label": label, "from": {"at_track": "spares at track", "factory": "Grove stock", "make": "new manufacture"}[alloc[p]["source"]],
                          "to": f"car {car}", "recognition": "first_use" if alloc[p]["source"] != "make" else "incurred"})
        add("td017_move", f"Inventory: {len(parts)} part{'s' if len(parts) != 1 else ''} off car {car}, spares on",
            {"why": "Used inventory moves as it happens: the destroyed part was counted when first used and goes redundant; the spare fitted "
                    "in its place counts against the cap on first use; a part made new counts as it is incurred.",
             "moves": moves}, owner="head_of_cost_cap")

    add("evidence_pack", f"Evidence pack for car {car}'s incident",
        {"why": "What the desk saw, in order, so the Head of Cost Cap can show the FIA why each line was booked when it was.",
         "evidence": [{k: e.get(k) for k in ("kind", "at", "source", "note")} for e in inc.evidence[-10:]], "belief_source": b["source"],
         "sources": [v.get("url") for v in (assumptions(state).get("sources") or {}).values() if v.get("url")]},
        owner="head_of_cost_cap")

    return _settle(inc, out, state)


def _settle(inc: Incident, acts: list[Action], state) -> list[Action]:
    """Keep a person's decision, keep the timestamp of an action that did not change, cancel what the belief no longer needs."""
    prior = {k: a for k, a in (state.actions or {}).items() if a.incident_key == inc.incident_key}
    out = []
    for a in acts:
        old = prior.get(a.action_key)
        if old is not None and old.status in DECIDED:
            out.append(old)
            continue
        if old is not None and (old.title, old.detail, old.status, old.due_at) == (a.title, a.detail, a.status, a.due_at):
            a.updated_at = old.updated_at
        out.append(a)
    keys = {a.action_key for a in acts}
    for k, old in sorted(prior.items()):
        if k in keys or old.status == "cancelled":
            continue
        if old.status in DECIDED:
            out.append(old)
            continue
        out.append(Action(action_key=k, incident_key=old.incident_key, kind=old.kind, title=old.title,
                          detail={**old.detail, "why": f"No longer needed after v{inc.version}: {inc.cause}"[:400]}, due_at=old.due_at,
                          status="cancelled", owner_role=old.owner_role, reversible=old.reversible, outward=old.outward,
                          decided_by="code", updated_at=inc.updated_at))
    return out
