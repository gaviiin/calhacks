from live_racing.normalize import NEVER_REPLAYED, attach_stint_times, normalize_rows, order_events

URL = "https://api.openf1.org/v1/x?session_key=1"


def test_ids_are_stable_and_session_scoped():
    row = {"date": "2024-11-03T16:37:22+00:00", "category": "Flag", "flag": "RED", "message": "RED FLAG", "lap_number": 32, "driver_number": None, "session_key": 9636}
    a = normalize_rows("race_control", [row], 9636, URL)[0]
    b = normalize_rows("race_control", [dict(row)], 9636, URL)[0]
    c = normalize_rows("race_control", [row], 9999, URL)[0]
    assert a.event_id == b.event_id and a.event_id != c.event_id
    assert a.event_time_utc == "2024-11-03T16:37:22.000Z"
    assert "session_key" not in a.payload


def test_stint_end_lap_is_masked_and_timed_by_lap_start():
    stint = {"driver_number": 63, "stint_number": 2, "lap_start": 29, "lap_end": 32, "compound": "INTERMEDIATE", "tyre_age_at_start": 0}
    lap = {"driver_number": 63, "lap_number": 29, "date_start": "2024-11-03T16:30:30+00:00", "lap_duration": 100.0, "duration_sector_1": 30.0}
    events = normalize_rows("stints", [stint], 9636, URL) + normalize_rows("laps", [lap], 9636, URL)
    events = order_events(attach_stint_times(events, "2024-11-03T15:30:00.000Z"))
    st = next(e for e in events if e.endpoint == "stint_start")
    assert "lap_end" not in st.payload and "lap_end" in st.masked_fields
    assert st.event_time_utc == "2024-11-03T16:30:30.000Z"


def test_lap_record_becomes_start_then_completion():
    lap = {"driver_number": 43, "lap_number": 31, "date_start": "2024-11-03T16:35:06.189+00:00", "lap_duration": None, "is_pit_out_lap": True}
    done = {"driver_number": 43, "lap_number": 30, "date_start": "2024-11-03T16:32:55.376+00:00", "lap_duration": 130.874, "duration_sector_1": 40.37,
            "segments_sector_1": [2049, 2049]}
    events = order_events(normalize_rows("laps", [lap, done], 9636, URL))
    kinds = [(e.endpoint, e.lap_number) for e in events]
    # lap 31 starts (16:35:06.189) a few ms before the timing feed closes lap 30 (16:35:06.250): time order wins
    assert kinds == [("lap_start", 30), ("lap_start", 31), ("lap_complete", 30)]
    start = events[0]
    assert "lap_duration" in start.masked_fields and "lap_duration" not in start.payload
    complete = events[2]
    assert complete.event_time_utc == "2024-11-03T16:35:06.250Z" and complete.payload["lap_duration"] == 130.874
    assert "segments_sector_1" not in complete.payload


def test_session_result_is_never_replayed():
    assert "session_result" in NEVER_REPLAYED
    assert normalize_rows("session_result", [{"driver_number": 43, "position": None, "dnf": True}], 9636, URL) == []


def test_order_is_deterministic_and_deduplicated():
    w = {"date": "2024-11-03T16:37:22+00:00", "rainfall": 1}
    rc = {"date": "2024-11-03T16:37:22+00:00", "category": "Flag", "flag": "RED", "message": "RED FLAG", "lap_number": 32}
    pos = {"date": "2024-11-03T16:37:22+00:00", "driver_number": 43, "position": 16}
    events = normalize_rows("position", [pos, pos], 9636, URL) + normalize_rows("race_control", [rc], 9636, URL) + normalize_rows("weather", [w], 9636, URL)
    ordered = order_events(events)
    assert [e.endpoint for e in ordered] == ["weather", "race_control", "position"]
    assert [e.seq for e in ordered] == [0, 1, 2]
    assert order_events(reversed(events)) == ordered
