from pathlib import Path
from types import SimpleNamespace

import pytest

from race.events import Effect, parse_iso
from race.incidents import IncidentBook
from race.jev import offline_decide
from race.normalize import normalize
from race.openf1 import load_fixture
from race.weekend import WeekendState, weekend_info

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
SAO_PAULO = (9627, 9636)  # qualifying (Sunday morning), then the race


def _crash_effects(ev):
    """The 6050 line the replay would book for a telemetry stop, carrying Jev's log like the real one."""
    if ev.kind != "car_stopped":
        return [], None
    jev = offline_decide(ev, {"team_cars": [23, 43]})
    return [Effect("cost", "6050", 1, 2, 3, "Crash damage", "assumption", "jev", "test", jev.log())], jev


def run_weekend():
    state = WeekendState(meeting_key=1249, info=weekend_info(1249), team="Williams")
    book = IncidentBook(state)
    history: list[tuple[str, int, str, str, str]] = []  # (key, version, status, at, cause) as returned
    events = {}

    def take(inc):
        if inc is not None:
            history.append((inc.incident_key, inc.version, inc.status, inc.updated_at, inc.cause))

    for key in SAO_PAULO:
        rows = load_fixture(key, FIXTURES)
        state.session = rows["session"][0]
        state.session_type = state.session["session_type"]
        events[key] = normalize(rows, "Williams")
        for ev in events[key]:
            state.now = ev.at
            effects, jev = _crash_effects(ev)
            take(book.observe(ev, effects, jev))
        for inc in book.end_of_session(SimpleNamespace(session=state.session, session_type=state.session_type)):
            take(inc)
    return state, book, history, events


@pytest.fixture(scope="module")
def weekend():
    return run_weekend()


def _secs(a, b):
    return (parse_iso(b) - parse_iso(a)).total_seconds()


def test_one_incident_per_crash_with_deterministic_keys(weekend):
    _, book, _, _ = weekend
    assert list(book.incidents) == ["1249-9627-43-1", "1249-9627-23-1", "1249-9636-43-1", "1249-9636-43-2"]
    again = run_weekend()[1]
    assert [(i.incident_key, i.version, i.status, i.cause) for i in again.incidents.values()] == \
           [(i.incident_key, i.version, i.status, i.cause) for i in book.incidents.values()]


@pytest.mark.parametrize("key,stop_at", [("1249-9627-43-1", "2024-11-03T10:39:00"), ("1249-9627-23-1", "2024-11-03T11:57:19"),
                                         ("1249-9636-43-2", "2024-11-03T16:36:55")])
def test_each_crash_is_corroborated_within_30_s_of_the_stop(weekend, key, stop_at):
    _, book, history, _ = weekend
    inc = book.incidents[key]
    assert inc.first_seen_at.startswith(stop_at)
    first = next(h for h in history if h[0] == key)
    assert first[1] == 1 and first[2] == "suspected" and "telemetry" in first[4]
    corr = next(h for h in history if h[0] == key and h[2] == "corroborated")
    assert _secs(inc.first_seen_at, corr[3]) <= 30
    assert corr[4].startswith("red flag ") and corr[4].endswith("after the stop: corroborated")
    assert inc.belief["impact_kph"] in (166, 315, 188) and inc.belief["signature"] == "stop"
    assert abs(sum(inc.belief["severity"].values()) - 1) < 0.01 and inc.belief["parts"]


def test_qualifying_crashes_are_out_of_the_session(weekend):
    _, book, _, _ = weekend
    col = book.incidents["1249-9627-43-1"]
    assert col.status == "confirmed" and col.belief["out_of_session"] and col.belief["session_type"] == "Qualifying"
    assert any("never ran again before qualifying ended" in h[4] for h in weekend[2] if h[0] == col.incident_key)


def test_albon_carries_over_and_ends_confirmed_did_not_start(weekend):
    _, book, history, _ = weekend
    alb = book.incidents["1249-9627-23-1"]
    assert alb.status == "confirmed" and "did not start" in alb.cause
    assert alb.belief["dns"] is True and alb.belief["missed_session"] == 9636
    assert any(e["session_key"] == 9636 for e in alb.evidence), "the race's evidence lands on the qualifying incident"
    assert not [k for k in book.incidents if k.startswith("1249-9636-23-")], "no second incident for the same crash"
    grid = next(h for h in history if h[0] == alb.incident_key and "not on the grid" in h[4])
    assert grid[3] < "2024-11-03T16:00", "known from the laps minutes after the start, not from the result at 17:58"


def test_colapinto_race_crash_confirmed_by_the_result(weekend):
    _, book, _, _ = weekend
    crash = book.incidents["1249-9636-43-2"]
    assert crash.status == "confirmed" and "classified DNF after 30 laps" in crash.cause
    kinds = [e["kind"] for e in crash.evidence]
    assert kinds[:2] == ["car_stopped", "red_flag"] and "incident" not in kinds, "race control never names him"
    early = book.incidents["1249-9636-43-1"]  # the lap-5 contact with Bearman: named by the stewards, car ran on
    assert early.status == "corroborated" and early.belief["turn"] == "Turn 10" and early.belief["laps_after"] >= 20


def test_versions_only_increase(weekend):
    _, _, history, _ = weekend
    by_key: dict[str, list[int]] = {}
    for key, v, *_ in history:
        by_key.setdefault(key, []).append(v)
    for key, vs in by_key.items():
        assert vs == sorted(set(vs)) and vs[0] == 1, key


def test_observing_the_same_event_twice_changes_nothing():
    state = WeekendState(meeting_key=1249, info=weekend_info(1249), team="Williams", session_type="Qualifying")
    book = IncidentBook(state)
    evs = normalize(load_fixture(9627, FIXTURES), "Williams")
    stop = next(e for e in evs if e.kind == "car_stopped")
    red = next(e for e in evs if e.kind == "red_flag")
    inc = book.observe(stop, [], None)
    assert inc.version == 1 and book.observe(stop, [], None) is None and inc.version == 1
    assert book.observe(red, [], None) is inc and inc.version == 2
    assert book.observe(red, [], None) is None and inc.version == 2


def test_assess_moves_forward_and_a_later_signal_does_not_undo_it():
    state = WeekendState(meeting_key=1249, info=weekend_info(1249), team="Williams", session_type="Qualifying")
    book = IncidentBook(state)
    evs = normalize(load_fixture(9627, FIXTURES), "Williams")
    stop = next(e for e in evs if e.kind == "car_stopped")
    inc = book.observe(stop, [], None)
    book.assess(inc, {"severity": {"heavy": 1.0}}, "Chief Mechanic: chassis cracked", stop.at)
    assert inc.status == "assessed" and inc.version == 2
    later = next(e for e in evs if e.kind == "retirement_suspected" and e.driver_number == 43)
    assert book.observe(later, [], None) is inc and inc.status == "assessed" and inc.version == 3


def test_qualifying_laps_heuristic_only_flags_cars_that_stopped(weekend):
    _, _, _, events = weekend
    quali = [(e.driver_number, e.kind) for e in events[9627] if e.kind == "retirement_suspected"]
    assert quali and all(car in (23, 43) for car, _ in quali)
    dns = [e for e in events[9636] if e.kind == "retirement_confirmed" and e.payload.get("dns")]
    assert [e.driver_number for e in dns] == [23] and dns[0].payload["dnf"] is False
