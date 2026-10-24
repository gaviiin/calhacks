import json

import pytest

from finance import saboteur, scenario
from finance.eval import generate, scorecard
from finance.explain import explain
from finance.sim import new_run


@pytest.fixture
def season(world, store, tmp_path):
    requests, key = generate(world, 2024)
    (tmp_path / "keys").mkdir()
    (tmp_path / "keys" / "2024.json").write_text(json.dumps({"requests": key}))
    return requests, tmp_path / "keys"


def test_full_season_scores_clean(world, store, tmp_path, season):
    requests, keys = season
    run = new_run(2024, world=world, store=store, data_dir=tmp_path, requests=requests)
    run.run_all()
    sc = scorecard(run, keys_dir=keys)
    assert sc["books_tie"]
    assert sc["bonuses"]["wrong_postings"] == [] and sc["bonuses"]["missing"] == []
    assert sc["billing"]["planted"] >= 15
    assert sc["billing"]["planted_caught"] == sc["billing"]["planted"]
    assert sc["billing"]["false_alarms"] == 0
    assert sc["expected_bonuses_avoided"] == 5  # Spa: Russell's win and every bonus it implied, never booked
    assert sc["controller_questions"] == 2 and sc["rules_approved"] == ["VOLTA-SPRINT-01"]


def test_second_run_uses_the_learned_rule_without_asking(world, store, tmp_path, season):
    requests, keys = season
    new_run(2024, world=world, store=store, data_dir=tmp_path, requests=requests).run_all()
    run2 = new_run(2024, world=world, store=store, data_dir=tmp_path, requests=requests)
    run2.run_all()
    sc = scorecard(run2, keys_dir=keys)
    assert sc["controller_questions"] == 0
    assert sc["billing"]["correct"] == sc["billing"]["requests"]


def test_spa_billing_request_held_then_rejected(world, store, tmp_path, season):
    requests, _ = season
    run = new_run(2024, world=world, store=store, data_dir=tmp_path, requests=requests)
    run.run_all()
    win = next(b for b in run.ledger.billings() if b["payload"]["round"] == 14 and b["payload"]["car"] == 63
               and b["payload"]["sponsor_id"] == "halcyon")
    assert [h["status"] for h in win["history"]][0] == "hold"
    assert (win["status"], win["reason_code"]) == ("rejected", "overturned")
    alerts = run.ledger.memos("alert", 2024, 14)
    assert alerts and "Car 63" in alerts[0]["payload"]["text"] or "car 63" in alerts[0]["payload"]["text"]
    booked = {e["key"] for e in run.ledger.entries(kind="bonus") if e["basis"]["round"] == 14}
    assert not any("car63" in k for k in booked)
    assert any(k.startswith("bonus|2024|R14|race|halcyon|4.1|car44") for k in booked)  # Hamilton's inherited win


def test_stewards_decision_reverses_and_parks(world, store, tmp_path, season):
    requests, _ = season
    run = new_run(2024, world=world, store=store, data_dir=tmp_path, requests=requests, auto_people=False)
    run.run_all()
    out = scenario.apply(run, season=2024, rnd=12, car=44)
    kinds = {(e["kind"], e["status"]) for e in out["entries"]}
    assert ("bonus_reversal", "parked") in kinds
    halcyon = next(e for e in out["entries"] if "Halcyon" in e["memo"])
    assert halcyon["needs"] == ["controller", "cfo"]  # $1M, the post-amendment podium rate
    assert out["revenue_delta_cents"] < 0
    assert run.ledger.approve(halcyon["je_id"], "agent:revenue", "controller").status == "refused"
    assert run.ledger.approve(halcyon["je_id"], "dana", "controller").status == "parked"
    assert run.ledger.approve(halcyon["je_id"], "dana", "cfo").status == "refused"  # one person, two approvals
    assert run.ledger.approve(halcyon["je_id"], "priya", "cfo").status == "posted"
    assert run.ledger.trial_balance()["ties"]
    why = explain(run.ledger, halcyon["je_id"])
    assert "REV-02a" in why["text"] and any("Stewards' decision" in x for x in why["evidence"])


def test_saboteur_is_refused_every_time(world, store, tmp_path, season):
    requests, _ = season
    run = new_run(2024, world=world, store=store, data_dir=tmp_path, requests=requests)
    run.run_all()
    report = saboteur.run(run.ledger.path, world)
    assert report["proposed"] == 200 and report["refused"] == 200 and report["leaked"] == []
    assert report["caught_by_intended_check"] == 200


def test_agent_code_never_reads_the_answer_key():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    for path in list((root / "agents").glob("*.py")) + [root / f for f in ("engine.py", "kernel.py", "router.py", "bonuses.py", "ledger.py")]:
        text = path.read_text()
        assert "keys/" not in text and "KEYS_DIR" not in text and "from .eval" not in text and "finance.eval" not in text, path
