from collections import Counter

from race.normalize import normalize, parse_race_control


def test_incident_regex_on_real_canada_messages():
    p = parse_race_control("TURN 10 INCIDENT INVOLVING CARS 81 (PIA) AND 23 (ALB) NOTED - CAUSING A COLLISION (16:25:37)")
    assert p["type"] == "incident" and [c["number"] for c in p["cars"]] == [81, 23]
    assert p["turn"] == "TURN 10" and p["stage"] == "NOTED" and p["reason"] == "CAUSING A COLLISION" and p["clock"] == "16:25:37"
    assert p["damage_likely"]
    p = parse_race_control("FIA STEWARDS: TURN 10 INCIDENT INVOLVING CARS 81 (PIA) AND 23 (ALB) UNDER INVESTIGATION - CAUSING A COLLISION (16:25:37)")
    assert p["stage"] == "UNDER INVESTIGATION"
    p = parse_race_control("INCIDENT INVOLVING CAR 14 (ALO) NOTED - SAFETY CAR INFRINGEMENT")
    assert p["type"] == "incident" and not p["damage_likely"] and p["cars"][0]["acronym"] == "ALO"
    assert parse_race_control("RECOVERY VEHICLE ON TRACK AT TURN 14") is None


def test_penalty_regex():
    p = parse_race_control("FIA STEWARDS: 10 SECOND TIME PENALTY FOR CAR 81 (PIA) - CAUSING A COLLISION (16:25:37)")
    assert p == {"type": "penalty", "car": 81, "what": "10 SECOND TIME PENALTY", "served": False, "reason": "CAUSING A COLLISION", "clock": "16:25:37"}
    p = parse_race_control("FIA STEWARDS: PENALTY SERVED - 10 SECOND TIME PENALTY FOR CAR 81 (PIA) - CAUSING A COLLISION (16:25:37)")
    assert p["served"] is True
    p = parse_race_control("FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 55 (SAI) (15:23:42)")
    assert p["car"] == 55 and p["reason"] == ""


def test_canada_albon_retirement_is_suspected_before_race_control_speaks(canada):
    evs = normalize(canada, "Williams")
    assert all(e.at.endswith("Z") for e in evs)
    kinds = Counter(e.kind for e in evs)
    assert kinds["retirement_confirmed"] == 5
    suspected = [e for e in evs if e.kind == "retirement_suspected" and e.driver_number == 23]
    assert len(suspected) == 1 and suspected[0].lap == 12 and suspected[0].state.status == "retired_suspected"
    first_mention = next(e for e in evs if e.kind == "incident" and 23 in e.payload["car_numbers"])
    assert suspected[0].at < first_mention.at, "the laps feed must beat the stewards' message"
    assert first_mention.payload["team_involved"] and first_mention.driver_number == 23 and first_mention.lap == 16
    confirmed = next(e for e in evs if e.kind == "retirement_confirmed" and e.driver_number == 23)
    assert confirmed.state.status == "retired"
    # penalty for the other car is attributed to that car, flagged as not ours
    pen = next(e for e in evs if e.kind == "penalty" and e.driver_number == 81)
    assert pen.payload["what"] == "10 SECOND TIME PENALTY" and pen.payload["team_involved"] is False


def test_australia_sainz_lap_one_crash_without_any_race_control_mention(australia):
    evs = normalize(australia, "Williams")
    rc_mentions = [e for e in evs if e.kind in ("incident", "penalty") and 55 in (e.payload.get("car_numbers") or [e.payload.get("car")])]
    assert rc_mentions == [], "race control never names Sainz in Melbourne 2025"
    suspected = [e for e in evs if e.kind == "retirement_suspected" and e.driver_number == 55]
    assert len(suspected) == 1 and suspected[0].lap == 1 and suspected[0].payload["last_lap_complete"] is False
    assert any(e.kind == "retirement_confirmed" and e.driver_number == 55 for e in evs)
    sc = [e for e in evs if e.kind == "safety_car"]
    assert sc and sc[0].payload["deployed"] and sc[0].lap == 1


def test_events_are_ordered_and_keys_unique(canada):
    evs = normalize(canada, "Williams")
    assert [e.at for e in evs] == sorted(e.at for e in evs)
    keys = [e.key for e in evs]
    assert len(keys) == len(set(keys))
    assert all(len(k) == 64 for k in keys)
    stint = next(e for e in evs if e.kind == "stint" and e.driver_number == 23)
    assert stint.payload["compound"] and stint.state.compound == stint.payload["compound"]
    pit = next(e for e in evs if e.kind == "pit_stop" and e.driver_number == 55)
    assert pit.state.last_pit_lap == pit.payload["lap_number"]
