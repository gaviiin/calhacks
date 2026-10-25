import pytest

from live_racing.finance_projections import if_finished_now
from live_racing.normalize import NormalizedEvent
from live_racing.race_state import RaceState, cars_in_message, lap_start_times


def build_to(meta, events, t, team=(63, 44)):
    st = RaceState("2024_sao_paulo_gp", meta["session"]["session_key"], meta["drivers"], list(team))
    for ev in events:
        if ev.event_time_utc > t:
            break
        st.apply(ev)
    return st


def test_slice_has_no_future_fields(slice_events):
    assert all("lap_end" not in e.payload for e in slice_events if e.endpoint == "stint_start")
    assert all("lap_duration" not in e.payload for e in slice_events if e.endpoint == "lap_start")
    assert not any(e.endpoint == "session_result" for e in slice_events)
    assert all(slice_events[i].event_time_utc <= slice_events[i + 1].event_time_utc for i in range(len(slice_events) - 1))


def test_car_43_is_running_before_its_stop_and_a_candidate_after(slice_meta, slice_events):
    before = build_to(slice_meta, slice_events, "2024-11-03T16:36:50.000Z")
    assert before.drivers[43].status != "stopped_candidate"
    assert before.flag_status == "SAFETY_CAR"
    after = build_to(slice_meta, slice_events, "2024-11-03T16:37:15.000Z")
    assert after.drivers[43].status == "stopped_candidate"
    assert after.drivers[43].stopped_at == "2024-11-03T16:37:03.754Z"
    assert after.flag_status == "SAFETY_CAR"  # the red flag (16:37:22) is still in the future
    red = build_to(slice_meta, slice_events, "2024-11-03T16:37:30.000Z")
    assert red.flag_status == "RED_FLAG" and red.lap == 32


def test_positions_and_tyres_as_of_the_moment(slice_meta, slice_events, world, brazil):
    st = build_to(slice_meta, slice_events, "2024-11-03T16:29:00.000Z")
    assert st.drivers[63].position == 1 and st.drivers[63].compound == "INTERMEDIATE" and st.drivers[63].last_pit_lap is None
    fc = if_finished_now(world, brazil, st.positions(), as_of_utc=st.now_utc, drivers_meta=slice_meta["drivers"])
    assert {(l.sponsor_id, l.clause_id, l.car) for l in fc.lines} == {("halcyon", "4.1", 63), ("arcadia", "4.2", 63), ("northwind", "6.3", 63), ("volta", "5.1", 63)}
    assert fc.status == "indicative" and fc.financial_source == "synthetic"
    later = build_to(slice_meta, slice_events, "2024-11-03T16:33:00.000Z")
    assert later.drivers[63].position == 5 and later.drivers[63].last_pit_lap == 28
    fc2 = if_finished_now(world, brazil, later.positions(), as_of_utc=later.now_utc, drivers_meta=slice_meta["drivers"])
    assert not any(l.sponsor_id == "halcyon" for l in fc2.lines)
    # the final classification (Russell P4) is not knowable mid-race: the state says what the feed said
    assert later.drivers[63].position != 4


def test_out_of_order_event_is_refused(slice_meta, slice_events):
    st = build_to(slice_meta, slice_events, "2024-11-03T16:30:00.000Z")
    old = slice_events[0]
    with pytest.raises(ValueError):
        st.apply(old)


def test_lap_start_times_and_message_parsing(slice_events):
    starts = lap_start_times(slice_events)
    assert starts[28] == "2024-11-03T16:28:09.077Z" and starts[1] < starts[2] < starts[69]
    assert cars_in_message("TURN 1 INCIDENT INVOLVING CARS 81 (PIA) AND 30 (LAW) UNDER INVESTIGATION") == [81, 30]
    assert cars_in_message("CAR 43 (COL) TIME 1:27.143 DELETED") == [43]
    assert cars_in_message("RED FLAG") == []
