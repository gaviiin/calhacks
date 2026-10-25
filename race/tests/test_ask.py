"""Jev is the last resort after granted policies and precedents; when it is unsure, a person is asked."""

from race.effects import effects_for
from race.jev import offline_decide
from race.policies import Policy, PolicyBook
from race.precedents import Case, PrecedentMatch
from race.tests.test_effects import ctx, ev

CRASH = ("6050", "5200", "6300")
COLLISION = {"car_numbers": [81, 23], "team_involved": True, "reason": "CAUSING A COLLISION", "stage": "NOTED"}


def crash_lines(effects):
    return [x for x in effects if x.kind == "cost" and x.bucket in CRASH]


def test_plain_collision_asks_a_person_and_leads_with_the_question():
    e = ev("incident", payload=COLLISION)
    jev = offline_decide(e, {"team_cars": [23, 55]})
    assert jev.severity == "light" and abs(jev.confidence["severity"] - 0.45) < 1e-9
    effects = effects_for(e, jev, None, ctx())
    lines = crash_lines(effects)
    assert lines and all(x.status == "needs_person" for x in lines)
    assert lines[0].why.startswith("Asks the Head of Racing Finance: Jev is unsure (severity light, P=0.45 < 0.50).")
    assert all(x.status == "autonomous" for x in effects if x.kind == "cap_headroom")
    assert len(lines[0].wire(e, 0)["why"]) <= 512 and lines[0].wire(e, 0)["why"].startswith("Asks")


def test_heavy_retirement_is_sure_enough_and_stays_proposed():
    e = ev("retirement_suspected", payload={"last_lap": 12})
    jev = offline_decide(e, {"team_cars": [23, 55], "retired_within_laps": 0})
    lines = crash_lines(effects_for(e, jev, None, ctx()))
    assert lines and all(x.status == "proposed" for x in lines)
    assert not any(x.why.startswith("Asks") for x in lines)


def test_the_floor_is_a_setting(monkeypatch):
    monkeypatch.setenv("RACE_ASK_FLOOR", "0.65")
    e = ev("retirement_suspected", payload={"last_lap": 12})
    jev = offline_decide(e, {"team_cars": [23, 55], "retired_within_laps": 0})
    lines = crash_lines(effects_for(e, jev, None, ctx()))
    assert lines and all(x.status == "needs_person" for x in lines)
    assert "P=0.60 < 0.65" in lines[0].why


def test_revision_lines_ask_too():
    c = ctx()
    e1 = ev("retirement_suspected", payload={"last_lap": 12})
    effects_for(e1, offline_decide(e1, {"team_cars": [23, 55], "retired_within_laps": 0}), None, c)
    c.booked[23] = {"lap": 12, "low": 50_000, "mid": 100_000, "high": 200_000}  # a much smaller first booking: the stewards' message revises it
    e2 = ev("incident", lap=16, payload=COLLISION)
    revision = [x for x in effects_for(e2, offline_decide(e2, {"team_cars": [23, 55], "retired_within_laps": 4}), None, c) if x.bucket == "6050"]
    assert revision and "revision" in revision[0].memo.lower()
    assert revision[0].status == "needs_person" and revision[0].why.startswith("Asks")


def test_policy_and_precedent_paths_never_ask():
    e = ev("incident", payload=COLLISION)
    jev = offline_decide(e, {"team_cars": [23, 55]})  # unsure, but nobody asks Jev when something learned decides
    book = PolicyBook([Policy("light-contact", {"kind": "incident", "team_involved": True}, {"severity": "light"}, autonomy="GRANTED")])
    by_policy = crash_lines(effects_for(e, jev, book.resolve(e, {}), ctx()))
    assert by_policy and all(x.status == "autonomous" and not x.why.startswith("Asks") for x in by_policy)
    case = Case(case_id="aus25-55", kind="incident", outcome="light", reason="CAUSING A COLLISION")
    match = PrecedentMatch(outcome="light", similarity=0.95, agreement=1.0, cases=[case, case, case], all_considered=7)
    by_precedent = crash_lines(effects_for(e, jev, None, ctx(), match))
    assert by_precedent and all(x.status == "autonomous" and not x.why.startswith("Asks") for x in by_precedent)
