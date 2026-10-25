"""The strategy desk's priced options on São Paulo 2024 (race 9636). After the intent of Varun Sanjeev's
live_racing/tests/test_decision_cockpit.py and test_strategy_and_plans.py (var-updated-live): who is actually
racing, stop cost measured per condition with no fixed factor, the comparator's columns, and no look-ahead."""

import json
import re

import pytest

from race.cockpit import comparator
from race.cockpit.pit_model import loss_estimate, measured_stops
from race.cockpit.timing import SessionIndex, ts
from race.replay import load_rows
from race.weekend import Weekend

RACE = 9636
WORD = re.compile("re" + "commend", re.I)


def run():
    w = Weekend(1249, pace=0, sink=None, offline=True, forecast=False, quiet=True)
    w.run()
    return w


@pytest.fixture(scope="module")
def weekend():
    return run()


@pytest.fixture(scope="module")
def idx():
    rows = load_rows(RACE, True)
    return SessionIndex(rows, rows["session"][0])


def payload(o) -> dict:
    return json.loads(o.wire()["options_json"])


def test_options_on_colapinto_race_laps_only(weekend):
    sets = list(weekend.state.options.values())
    assert sets and all(o.session_key == RACE for o in sets)  # nothing in qualifying
    laps = sorted(o.lap for o in sets if o.driver_number == 43 and o.trigger == "lap")
    assert len(laps) >= 25 and laps == sorted(set(laps))  # once per completed lap, never twice
    assert max(laps) <= 30  # Colapinto stopped on lap 31: no options after his last completed lap


def test_safety_car_on_lap_30_prices_four_columns_for_car_43(weekend):
    o = weekend.state.options["9636-43-L30-safety_car"]
    p = payload(o)
    assert o.condition == "sc" and o.trigger == "safety_car" and p["context"]["condition"] == "sc"
    ids = [x["id"] for x in p["options"]]
    assert ids == ["stay_out", "pit_now", "other_compound", "same_stop_green"]
    by = {x["id"]: x for x in p["options"]}
    stop, green = by["pit_now"]["time_lost_s"], by["same_stop_green"]["time_lost_s"]
    assert stop["condition"] == "sc" and stop["method"] in ("measured", "derived", "unmeasured")  # never a fixed factor
    if stop["method"] == "unmeasured":
        assert stop["seconds"] is None and stop["low"] < stop["high"]  # a range, not a point
    assert green["condition"] == "green" and green["method"] == "measured" and green["samples"] >= 1
    assert by["same_stop_green"]["available"] is False  # a comparison, not a choice now
    for x in p["options"]:
        b, likely, worst = x["positions"]
        assert b <= likely <= worst and len(x["points"]) == 3 and len(x["prize_delta_cents"]) == 3
        assert x["cost_cap"]["cents"] == 0 and x["sponsor_label"] == "ASSUMPTION" and x["race_end_value"] == "unavailable"
    ctx = p["context"]
    assert ctx["compound"] == "INTERMEDIATE" and ctx["laps_left"] == 69 - 30 and ctx["position"] == 16
    assert "ASSUMPTION" in ctx["sponsor_basis"] and "unavailable" in ctx["race_end_value"]


def test_vsc_options_and_no_options_for_a_car_stopped_at_the_red_flag(weekend):
    assert "9636-43-L28-vsc" in weekend.state.options
    assert not any(o.trigger == "red_flag" and o.driver_number == 43 for o in weekend.state.options.values())


def test_never_car_23_which_did_not_start_the_race(weekend):
    assert not any(o.driver_number == 23 for o in weekend.state.options.values())
    for o in weekend.state.options.values():  # and never counted in anyone's running order
        for x in payload(o)["options"]:
            assert 23 not in x["cars_passed"]


def test_no_option_set_advises_or_flags_one_option(weekend):
    for o in weekend.state.options.values():
        s = o.wire()["options_json"]
        assert not WORD.search(s) and len(s) <= 8192
        json.loads(s)  # never cut mid-way
        for x in payload(o)["options"]:
            assert not {"best", "lowest_risk", "chosen", "preferred"} & set(x)


def test_pit_loss_is_measured_from_this_races_stops_per_condition(idx):
    t = ts("2024-11-03T16:29:00Z")  # the VSC is out (16:28:21); no stop under it has finished its out-lap yet
    stops = measured_stops(idx, t)
    assert stops and all(s.condition == "green" for s in stops)
    vsc = loss_estimate(idx, "vsc", t, stops)
    assert vsc.method in ("derived", "unmeasured") and "no stop measured under the Virtual Safety Car" in vsc.basis
    later = ts("2024-11-03T16:33:00Z")  # seven stops were made under the VSC on lap 27
    stops = measured_stops(idx, later)
    v, g = loss_estimate(idx, "vsc", later, stops), loss_estimate(idx, "green", later, stops)
    assert v.method == "measured" and v.samples == 7 and v.low_s <= v.seconds <= v.high_s < 40
    assert g.method == "measured" and v.seconds < g.seconds and v.seconds > 0.6 * g.seconds  # a few seconds saved, nowhere near half
    assert all(s.lane_s is None or s.lane_s <= 45 for s in stops)  # red-flag standstills in the lane are never stops
    red = loss_estimate(idx, "red", later, stops)
    assert red.seconds == 0.0 and red.method == "suspension" and "restricted" in red.basis and "not free" in red.basis
    first = loss_estimate(idx, "green", ts("2024-11-03T16:00:00Z"), [])
    assert first.seconds is None and first.method == "prior" and "not a measurement" in first.basis


def test_no_look_ahead_in_stops_or_laps(idx):
    t = ts("2024-11-03T16:33:00Z")
    for s in measured_stops(idx, t):
        out_lap = idx.lap_at[(s.car, s.lap + 1)]
        assert out_lap.end <= t
    assert idx.field_lap(t) == 30 and idx.condition_at(t) == "sc"
    assert idx.condition_at(ts("2024-11-03T16:29:58Z")) == "vsc"  # "VSC ENDING" keeps the neutralisation until the track is clear
    assert idx.condition_at(ts("2024-11-03T16:30:26Z")) == "green"  # Russell's stop on lap 28 was a green stop


def test_who_is_racing_is_read_from_timing(idx):
    t5 = ts("2024-11-03T15:56:00Z")  # leader on lap 5
    assert idx.dns(23, t5) and idx.dns(18, t5)  # Albon (withdrawn) and Stroll (off on the formation lap): no lap started
    assert not idx.dns(55, t5)  # Sainz started from the pit lane: no lap-1 record, his lap 2 after the leader's
    assert idx.dns(18, ts("2024-11-03T17:10:00Z"))  # a lone lap-1 record at the restart is a feed artefact, not a start
    assert idx.started(43, t5)


def test_red_flag_prices_a_tyre_change_not_a_free_repair(weekend):
    st = weekend.state
    rows = st.replay.rows
    i = SessionIndex(rows, rows["session"][0])
    opts, ctx = comparator.compare(st, i, 31, ts("2024-11-03T16:45:00Z"))  # Ocon during the suspension
    assert ctx["condition"] == "red" and [o["id"] for o in opts] == ["stay_out", "pit_now", "other_compound", "same_stop_green"]
    stop = next(o for o in opts if o["id"] == "pit_now")
    assert stop["time_lost_s"]["seconds"] == 0.0 and stop["positions"] == [ctx["position"]] * 3
    assert "not free" in stop["cost_cap"]["line"] and stop["cost_cap"]["cents"] == 0


def test_order_arithmetic():
    pos = {1: 1, 2: 2, 3: 3, 4: 4}
    assert comparator.positions_after_losing(pos, 1, 2) == {1: 3, 2: 1, 3: 2, 4: 4}
    assert comparator.positions_after_losing(pos, 3, 5) == {1: 1, 2: 2, 3: 4, 4: 3}  # never past the last running car
    assert comparator.positions_after_losing(pos, 9, 2) == pos


def test_deterministic_and_cheap(weekend):
    again = run()
    assert sorted(again.state.options) == sorted(weekend.state.options)
    for k, o in weekend.state.options.items():
        assert again.state.options[k].wire()["options_json"] == o.wire()["options_json"]
    ms = again.timings["strategy"]
    assert sum(ms) / len(ms) < 2.0
