from race.events import CarState, RaceEvent
from race.jev import PARTS_ASKED, JevAnswers, decide, offline_decide


def _ev(kind, payload, car=23, pos=8):
    return RaceEvent(kind=kind, at="2026-05-24T16:25:37+00:00", session_key=1, meeting_key=1, lap=12, driver_number=car, team_name="Williams",
                     payload=payload, state=CarState(car, "Williams", position=pos, lap=12, updated_at="2026-05-24T16:25:37+00:00"))


def test_offline_answers_have_the_full_shape():
    a = offline_decide(_ev("incident", {"car_numbers": [81, 23], "team_involved": True, "reason": "CAUSING A COLLISION"}), {"team_cars": [23, 55]})
    assert a.offline and a.model == "offline-rules"
    assert abs(sum(a.p("severity").values()) - 1) < 1e-6
    assert abs(sum(a.p("fault").values()) - 1) < 1e-6
    assert abs(sum(a.p("bonus_risk").values()) - 1) < 1e-6
    assert set(a.parts) == set(PARTS_ASKED) and all(0 <= p < 1 for p in a.parts.values())
    assert 0 <= a.relevant <= 1 and 0 <= a.needs_forecast <= 1 and 0 <= a.bonus_risk <= 3
    log = a.log()
    assert log["severity"] == a.severity and "p" in log and "parts" in log


def test_retirement_reads_as_heavy_and_wants_a_forecast():
    a = offline_decide(_ev("retirement_suspected", {"last_lap": 12}), {"team_cars": [23, 55], "retired_within_laps": 0})
    assert a.severity == "heavy" and a.needs_forecast > 0.5 and a.parts["floor"] > a.parts["wheel_speed_sensor"] if "wheel_speed_sensor" in a.parts else True
    assert a.parts["gearbox"] > 0.4


def test_other_teams_events_are_not_relevant():
    a = offline_decide(_ev("incident", {"car_numbers": [81, 4], "team_involved": False, "reason": "CAUSING A COLLISION"}, car=81), {"team_cars": [23, 55]})
    assert a.relevant < 0.1 and a.severity == "none"


def test_decide_falls_back_offline_without_a_key(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    a = decide(_ev("penalty", {"car": 23, "what": "5 SECOND TIME PENALTY", "team_involved": True}), {"team_cars": [23, 55]})
    assert isinstance(a, JevAnswers) and a.offline
