from race.events import RaceEvent
from race.policies import Policy, PolicyBook, flat_view, matches


def _ev(kind, payload):
    return RaceEvent(kind=kind, at="2026-05-24T16:25:37Z", session_key=1, meeting_key=1, lap=5, driver_number=23, team_name="Williams", payload=payload)


def test_pattern_operators():
    v = {"kind": "incident", "reason": "CAUSING A COLLISION", "retired_within_laps": 1, "car_count": 2}
    assert matches({"kind": "incident"}, v)
    assert matches({"reason": {"contains": "collision"}}, v)
    assert matches({"retired_within_laps": {"lte": 2}}, v) and not matches({"retired_within_laps": {"gt": 2}}, v)
    assert matches({"kind": {"in": ["incident", "penalty"]}}, v) and not matches({"kind": {"in": ["penalty"]}}, v)
    assert not matches({"missing": {"lte": 2}}, v)
    assert not matches({"kind": {"regex": "x"}}, v), "unknown operators never match"


def test_child_overrides_parent_and_revoked_is_ignored():
    parent = Policy("contact", {"kind": "incident", "team_involved": True}, {"severity": "light"}, autonomy="GRANTED")
    child = Policy("contact-retired", {"kind": "incident", "team_involved": True, "retired_within_laps": {"lte": 2}}, {"severity": "heavy"},
                   autonomy="GRANTED", parent_policy_id="contact")
    revoked = Policy("contact-all-heavy", {"kind": "incident"}, {"severity": "heavy"}, autonomy="REVOKED")
    book = PolicyBook([parent, child, revoked])
    e = _ev("incident", {"team_involved": True, "car_numbers": [23, 1]})
    assert book.resolve(e, {"retired_within_laps": 1}).policy_id == "contact-retired"
    assert book.resolve(e, {"retired_within_laps": 9}).policy_id == "contact"
    assert book.resolve(_ev("pit_stop", {}), {}) is None
    # a retirement carries no stewards' flag; the car's own team makes it "team_involved"
    stopped = Policy("stopped", {"kind": "retirement_suspected", "team_involved": True}, {"severity": "heavy"}, autonomy="GRANTED")
    assert PolicyBook([stopped]).resolve(_ev("retirement_suspected", {"last_lap": 12}), {"team": "Williams"}).policy_id == "stopped"
    assert PolicyBook([stopped]).resolve(_ev("retirement_suspected", {"last_lap": 12}), {"team": "McLaren"}) is None


def test_from_rows_and_flat_view():
    book = PolicyBook.from_rows([{"policy_id": "p", "pattern": '{"kind":"pit_stop","under":"sc"}', "effect_template": '{"cost":0}', "autonomy": "SHADOW",
                                  "parent_policy_id": "", "title": "SC stop", "hits": 3, "contradictions": 0, "precedent_count": 12}])
    e = _ev("pit_stop", {"under": "sc", "lap_number": 5})
    assert book.resolve(e, {}).autonomy == "SHADOW"
    assert flat_view(e, {"track_status": "sc"})["under"] == "sc"
