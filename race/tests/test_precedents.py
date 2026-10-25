from race.effects import EffectsContext, effects_for
from race.events import CarState, RaceEvent
from race.jev import JevAnswers, offline_decide
from race.policies import Policy, PolicyBook, flat_view
from race.precedents import Case, PrecedentStore, similarity, wilson_lower

TEAM_OF = {23: "Williams", 55: "Williams", 81: "McLaren"}


def _ev(kind, payload, car=23, lap=12, compound="MEDIUM", age=10):
    return RaceEvent(kind=kind, at="2026-05-24T16:25:37Z", session_key=11291, meeting_key=1, lap=lap, driver_number=car, team_name="Williams",
                     payload=payload, state=CarState(car, "Williams", position=9, lap=lap, compound=compound, tyre_age=age, updated_at="2026-05-24T16:25:37Z"))


def _store():
    cases = [Case(f"c{i}", "incident", "light", "CAUSING A COLLISION", None, None, "green", True, summary=f"collision {i}") for i in range(4)]
    cases += [Case(f"r{i}", "retirement_suspected", "heavy", "", 0, None, "green", False, summary=f"stopped {i}") for i in range(5)]
    cases += [Case(f"p{i}", "pit_stop", "free_stop", "", None, None, "sc", False, compound="MEDIUM", tyre_age=0, summary=f"sc stop {i}") for i in range(6)]
    cases += [Case(f"g{i}", "pit_stop", "tyre_set", "", None, None, "green", False, compound="HARD", tyre_age=0, summary=f"green stop {i}") for i in range(6)]
    return PrecedentStore(cases)


def test_similarity_and_wilson():
    c = Case("a", "incident", "light", "CAUSING A COLLISION", None, None, "green", True)
    v = {"kind": "incident", "reason": "CAUSING A COLLISION", "retired_within_laps": None, "pit_within_laps": None, "under": "green", "damage_likely": True}
    assert similarity(v, c) == 1.0
    assert similarity({**v, "retired_within_laps": 1}, c) < 0.85
    assert similarity({**v, "reason": "TRACK LIMITS", "damage_likely": False}, c) < 0.8
    assert round(wilson_lower(52, 52), 2) == 0.95 and wilson_lower(3, 3) < 0.75 and wilson_lower(12, 12) > 0.75


def test_near_identical_cases_make_a_protocol_and_a_lone_case_does_not():
    store = _store()
    view = flat_view(_ev("incident", {"car_numbers": [81, 23], "team_involved": True, "reason": "CAUSING A COLLISION", "damage_likely": True}), {"team": "Williams"})
    m = store.match(view)
    assert m is not None and m.outcome == "light" and len(m.cases) == 4 and m.similarity >= 0.85
    assert m.effect_template() == {"severity": "light"} and "near-identical" in m.why()
    assert store.match(flat_view(_ev("penalty", {"car": 23, "what": "5 SECOND TIME PENALTY", "team_involved": True}), {"team": "Williams"})) is None
    # three cases that disagree are no protocol
    mixed = PrecedentStore([Case("x1", "incident", "light", "COLLISION", None, None, "green", True), Case("x2", "incident", "heavy", "COLLISION", None, None, "green", True),
                            Case("x3", "incident", "moderate", "COLLISION", None, None, "green", True)])
    assert mixed.match(view) is None


def test_precedent_books_the_crash_on_its_own_authority_without_jev():
    store = _store()
    ctx = EffectsContext(team="Williams", team_of=TEAM_OF, positions={23: 9, 55: 12, 81: 1})
    e = _ev("retirement_suspected", {"last_lap": 12})
    m = store.match(flat_view(e, {"team": "Williams", "retired_within_laps": 0}))
    assert m is not None and m.outcome == "heavy"
    effects = effects_for(e, JevAnswers(), None, ctx, m)
    cost = next(x for x in effects if x.bucket == "6050")
    assert cost.status == "autonomous" and cost.decided_by.startswith("precedent:r") and cost.basis == "precedent" and cost.mid_cents > 0
    assert "near-identical" in cost.why


def test_tyre_stop_protocol_fires_from_precedent_and_from_a_granted_policy():
    store = _store()
    ctx = EffectsContext(team="Williams", team_of=TEAM_OF, positions={23: 9, 55: 12})
    e = _ev("pit_stop", {"lap_number": 30, "under": "sc", "stop_duration": 2.4}, car=55, lap=30, compound="MEDIUM", age=0)
    m = store.match(flat_view(e, {"team": "Williams", "track_status": "sc"}))
    assert m is not None and m.outcome == "free_stop"
    eff = effects_for(e, JevAnswers(), None, ctx, m)
    assert len(eff) == 1 and eff[0].bucket == "tyres" and eff[0].mid_cents == 0 and eff[0].status == "autonomous" and "free stop" in eff[0].memo
    pol = Policy("race-green-pit-stop", {"kind": "pit_stop"}, {"cost": 0}, autonomy="GRANTED", title="Routine pit stop")
    e2 = _ev("pit_stop", {"lap_number": 31, "under": "green"}, car=55, lap=31, compound="HARD", age=0)
    eff2 = effects_for(e2, JevAnswers(), PolicyBook([pol]).resolve(e2, {}), ctx, None)
    assert eff2[0].decided_by == "policy:race-green-pit-stop" and "no cost line" in eff2[0].memo
    # a shadow policy and no precedent: nothing learned decides, nothing is booked for a pit stop
    shadow = Policy("race-green-pit-stop", {"kind": "pit_stop"}, {"cost": 0}, autonomy="SHADOW")
    assert effects_for(e2, JevAnswers(), shadow, ctx, None) == []


def test_store_round_trip(tmp_path):
    store = _store()
    path = tmp_path / "p.jsonl"
    store.save(path)
    again = PrecedentStore.load(path)
    assert len(again) == len(store) and again.counts() == store.counts()
    again.add(Case("c0", "incident", "heavy", "CAUSING A COLLISION", 1, None, "green", True))
    assert len(again) == len(store) and next(c for c in again.cases if c.case_id == "c0").outcome == "heavy"
