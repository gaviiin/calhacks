from finance.sim import new_run
from finance.world import World


def test_fixture_provisional_reinstates_disqualified_car(world: World):
    final = world.team_rows(world.classification(2024, 14, "race", "final"))
    prov = world.team_rows(world.classification(2024, 14, "race", "provisional"))
    assert {r.number: r.pos for r in final} == {44: 1, 63: None}
    assert {r.number: r.pos for r in prov} == {63: 1, 44: 2}


def test_spa_timing_comes_from_the_real_fia_capture(world, tmp_path, store):
    run = new_run(2024, world=world, store=store, data_dir=tmp_path, requests=[], cash=False)
    spa = [e for e in run.events if e["payload"].get("round") == 14 and e["type"] != "month_end"]
    assert [(e["type"], e["at"]) for e in spa] == [
        ("race_provisional", "2024-07-28T14:40:00Z"),
        ("fia_document", "2024-07-28T16:23:00Z"),
        ("fia_document", "2024-07-28T16:53:00Z"),
        ("race_final", "2024-07-28T17:56:00Z"),
    ]


def test_dsq_reported_as_numbered_last_place_is_still_a_dsq():
    from finance.world import _row

    row = _row({"number": 63, "driver_id": "russell", "constructor_id": "mercedes", "position": 20,
                "position_text": "20", "status": "Disqualified", "points": 0})
    assert row.pos is None and row.pos_text == "D"


def test_one_ruling_teaches_the_rule_and_a_contrary_ruling_replaces_it(world, store):
    from types import SimpleNamespace

    from finance.agents.revenue import RevenueAgent

    agent = RevenueAgent(world, engine=None, store=store, run_id="t")
    ledger = SimpleNamespace(clock="2023-05-07T12:00:00Z", rules={})
    store.add_ruling("bonus|2023|R6|sprint|volta|5.1|car44", "VOLTA-SPRINT-01", "include", "controller",
                     ledger.clock, "t", "Do sprints count?", "Yes, sprints count.")
    out = agent._maybe_propose_rule("VOLTA-SPRINT-01", ledger)
    assert [o["type"] for o in out] == ["rule_learned"]
    assert store.approved() == {"VOLTA-SPRINT-01": "include"} and ledger.rules == {"VOLTA-SPRINT-01": "include"}
    assert store.rule("VOLTA-SPRINT-01")["approved_by"] == "controller"

    store.add_ruling("bonus|2023|R9|sprint|volta|5.1|car63", "VOLTA-SPRINT-01", "exclude", "controller",
                     "2023-07-01T12:00:00Z", "t", "Do sprints count?", "No, not for Volta.")
    agent._maybe_propose_rule("VOLTA-SPRINT-01", ledger)
    assert store.approved() == {"VOLTA-SPRINT-01": "exclude"}
