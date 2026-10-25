from live_racing.event_triggers import TriggerEngine
from live_racing.jev_router import deterministic_route
from live_racing.normalize import NormalizedEvent
from live_racing.race_state import RaceState
from live_racing.races import race as get_race

URL = "https://api.openf1.org/v1/race_control?session_key=9636"
DRIVERS = [{"driver_number": 43, "name_acronym": "COL", "team_name": "Williams"}, {"driver_number": 63, "name_acronym": "RUS", "team_name": "Mercedes"}]


def t(sec: float) -> str:
    base = 16 * 3600 + 36 * 60  # 16:36:00
    s = base + sec
    return f"2024-11-03T{int(s // 3600):02d}:{int(s % 3600 // 60):02d}:{s % 60:06.3f}Z"


_seq = [0]


def ev(endpoint, when, payload, driver=None, lap=None):
    _seq[0] += 1
    return NormalizedEvent(f"t:{_seq[0]}", "openf1", endpoint, URL, when, _seq[0], driver, lap, payload)


def car_speed(n, when, speed):
    return ev("car_data", when, {"driver_number": n, "speed": speed}, n)


def red_flag(when, lap=32):
    return ev("race_control", when, {"category": "Flag", "flag": "RED", "scope": "Track", "message": "RED FLAG", "lap_number": lap, "driver_number": None}, None, lap)


def make():
    st = RaceState("2024_sao_paulo_gp", 9636, DRIVERS, [63])
    st.lap = 32
    for n in st.drivers.values():
        n.lap = 32
    return st, TriggerEngine(st, get_race("2024_sao_paulo_gp"))


def feed(st, tr, events):
    out = []
    for e in events:
        out += tr.on_event(e, st.apply(e))
    return out


def test_stop_then_red_flag_is_one_attributed_incident():
    st, tr = make()
    events = [car_speed(43, t(0), 120)] + [car_speed(43, t(1 + i), 0) for i in range(12)] + [red_flag(t(20))]
    cands = feed(st, tr, events)
    kinds = [c.kind for c in cands]
    assert kinds == ["driver_stopped", "race_control_red_flag"]
    stop, red = cands
    assert stop.drivers == [43] and stop.material and stop.incident_id == "2024_sao_paulo_gp:race:lap32:car43:crash_candidate"
    assert red.drivers == [43] and red.incident_id == stop.incident_id and red.version == 2
    assert red.context["attribution"] == "provisionally_correlated"
    assert any(e.endpoint == "car_data" for e in red.evidence)
    assert deterministic_route(red.kind, red.context) == "crash_finance"
    assert deterministic_route(stop.kind, stop.context) == "human_review"


def test_red_flag_without_driver_evidence_needs_confirmation():
    st, tr = make()
    [red] = feed(st, tr, [red_flag(t(0))])
    assert red.drivers == [] and red.incident_id.endswith("red_flag:needs_confirmation")
    assert red.material and deterministic_route(red.kind, red.context) == "human_review"


def test_duplicate_red_flag_is_suppressed_but_a_new_incident_is_not():
    st, tr = make()
    cands = feed(st, tr, [red_flag(t(0)), red_flag(t(30))])
    assert len(cands) == 1 and tr.suppressed == 1
    # lap 40, a different car stops and the flag comes again: a new incident
    st.flag_status = "GREEN"
    st.lap = 40
    later = [car_speed(63, t(600 + i), 0) for i in range(10)] + [red_flag(t(615), lap=40)]
    new = feed(st, tr, later)
    assert [c.kind for c in new] == ["driver_stopped", "race_control_red_flag"]
    assert new[1].incident_id == "2024_sao_paulo_gp:race:lap40:car63:crash_candidate"


def test_pit_stop_and_red_flag_standstills_are_not_crashes():
    st, tr = make()
    pit = ev("pit", t(0), {"driver_number": 43, "lap_number": 32, "lane_duration": 24.0}, 43, 32)
    cands = feed(st, tr, [pit] + [car_speed(43, t(1 + i), 0) for i in range(12)])
    assert cands == []
    st2, tr2 = make()
    cands2 = feed(st2, tr2, [red_flag(t(0))] + [car_speed(43, t(1 + i), 0) for i in range(30)])
    assert [c.kind for c in cands2] == ["race_control_red_flag"]


def test_stewards_follow_up_updates_the_same_incident():
    st, tr = make()
    noted = ev("race_control", t(0), {"category": "Other", "message": "TURN 1 INCIDENT INVOLVING CARS 44 (HAM) AND 30 (LAW) NOTED - CAUSING A COLLISION", "lap_number": 33}, None, 33)
    review = ev("race_control", t(400), {"category": "Other", "message": "FIA STEWARDS: TURN 1 INCIDENT INVOLVING CARS 44 (HAM) AND 30 (LAW) REVIEWED NO FURTHER INVESTIGATION - CAUSING A COLLISION",
                                        "lap_number": 33}, None, 33)
    st.team_cars = [63, 44]
    tr.watched_cars |= {44}
    a, b = feed(st, tr, [noted, review])
    assert a.material and a.incident_id == "2024_sao_paulo_gp:race:lap33:car44:crash_candidate" and a.version == 1
    assert not b.material and b.incident_id == a.incident_id and b.version == 2 and b.context["follow_up"]


def test_unwatched_collision_is_a_state_update_only():
    st, tr = make()
    noted = ev("race_control", t(0), {"category": "Other", "message": "TURN 1 INCIDENT INVOLVING CARS 81 (PIA) AND 30 (LAW) NOTED - CAUSING A COLLISION", "lap_number": 27}, None, 27)
    [c] = feed(st, tr, [noted])
    assert not c.material and c.incident_id is None and deterministic_route(c.kind, c.context) == "no_action"
