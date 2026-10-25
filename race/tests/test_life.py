"""Each part's life from the way the car is raced (race/life.py)."""

from __future__ import annotations

from race import life
from race.events import Incident, RaceEvent
from race.jev import JevAnswers
from race.weekend import WeekendState, weekend_info


def state() -> WeekendState:
    return WeekendState(meeting_key=1249, info=weekend_info(1249), team="Williams")


def ev(kind="lap", car=43, at="2024-11-03T16:00:00Z", lap=10, **payload) -> RaceEvent:
    return RaceEvent(kind=kind, at=at, session_key=9636, meeting_key=1249, lap=lap, driver_number=car, team_name="Williams", payload=payload)


def jev(sev: str, p: float, parts: dict) -> JevAnswers:
    return JevAnswers(severity=sev, parts=parts, probabilities={"severity": {sev: p}}, offline=False, model="jev")


def test_every_lap_uses_life_and_the_forecast_says_when_it_runs_out():
    st = state()
    before = life._car(st, 43)["gearbox"].used
    rows = life.update(st, ev(complete=True))
    gb = {r.part: r for r in rows}["gearbox"]
    assert gb.used > before and gb.updated_at.startswith("2024-11-03T16:00:00")
    assert gb.due_event and gb.cost_cents > 0
    w = gb.wire()
    assert w["part_key"] == "1249-43-gearbox" and 0 < w["used_pct"] < 100 and w["remaining_km"] > 0


def test_jev_classifies_a_contact_and_the_parts_it_hit_lose_life():
    st = state()
    fw0 = life._car(st, 43)["front_wing"].used
    rows = life.update(st, ev("incident", team_involved=True, reason="CAUSING A COLLISION"), jev("light", 0.59, {"front_wing": 0.8}))
    fw = {r.part: r for r in rows}["front_wing"]
    assert round(fw.used - fw0, 3) == round(0.8 * life.SEVERITY_TAKES["light"], 3)
    assert fw.stress[-1]["kind"] == "contact" and fw.stress[-1]["severity"] == "light" and fw.stress[-1]["by"] == "Jev"


def test_a_heavy_crash_damages_the_likely_parts_and_the_garage_replaces_them():
    st = state()
    life.update(st, ev("car_stopped", at="2024-11-03T16:36:55Z"), jev("heavy", 0.9, {"floor": 0.9, "gearbox": 0.3}))
    parts = life._car(st, 43)
    assert parts["floor"].status == "damaged" and parts["gearbox"].status != "damaged"
    st.incidents["1249-9636-43-2"] = Incident(incident_key="1249-9636-43-2", meeting_key=1249, session_key=9636, driver_number=43,
                                              team_name="Williams", first_seen_at="2024-11-03T16:36:55Z", status="assessed", version=3,
                                              updated_at="2024-11-03T16:42:00Z", cause="garage", belief={"parts": {"floor": 0.9}}, evidence=[])
    rows = life.update(st, ev("notice", car=0, at="2024-11-03T16:43:00Z"))
    floor = {r.part: r for r in rows}["floor"]
    assert floor.status == "replaced" and floor.used == 0.0 and "2024 cap" in floor.cap_note


def test_a_power_unit_past_its_allocation_is_a_grid_penalty():
    st = state()
    pu = life._car(st, 23)["power_unit"]
    pu.used = 0.95  # car 23 is at its ICE allocation in the weekend file
    rows = life.update(st, ev(car=23, complete=True))
    r = {x.part: x for x in rows}["power_unit"]
    assert r.status == "due" and "grid penalty" in r.cap_note
    assert life.summary(st)["penalties"]
