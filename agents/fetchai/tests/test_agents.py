"""Fetch.ai agents: the sponsor's verification, question parsing, answers, and a full Bureau run of both agents."""

import asyncio
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
REPO = HERE.parents[1]
sys.path[:0] = [str(HERE), str(REPO)]

from brain import parse, respond  # noqa: E402
from verify import check_invoice  # noqa: E402

SPA = dict(sponsor_id="halcyon", season=2024, round=14, session="race", car=63, clause_id="4.1", amount_orig=200_000_000, currency="USD",
           final_classification_at="2024-07-28T17:56:00Z", invoiced_at="2024-07-28T14:45:00Z", reference="R1")
ROUNDS = {"14": "Belgian Grand Prix", "18": "Singapore Grand Prix", "19": "United States Grand Prix"}


def test_sponsor_refuses_russells_disqualified_win():
    v = check_invoice(SPA, set(), offline=True)
    assert not v.pay and not v.checks["result_earns_it"] and not v.checks["invoiced_after_final"]
    assert "DSQ" in v.summary()


def test_sponsor_pays_hamiltons_inherited_win_once():
    ok = {**SPA, "car": 44, "invoiced_at": "2024-07-29T09:00:00Z"}
    assert check_invoice(ok, set(), offline=True).pay
    assert not check_invoice(ok, {"R1"}, offline=True).pay


@pytest.mark.parametrize("change,why", [
    ({"amount_orig": 220_000_000}, "differs from the contract"),
    ({"sponsor_id": "northwind", "clause_id": "6.3", "amount_orig": 15_000_000, "session": "sprint", "round": 6, "car": 44}, "sprints"),
    ({"clause_id": "9.9"}, "not in"),
    ({"sponsor_id": "acme"}, "not acme"),
])
def test_sponsor_rejects_bad_claims(change, why):
    v = check_invoice({**SPA, "car": 44, "invoiced_at": "2024-07-29T09:00:00Z", **change}, set(), offline=True)
    assert not v.pay and why in v.summary()


def test_parse_questions():
    assert parse("What happened at Spa?", ROUNDS) == {"intent": "weekend", "round": 14, "sponsor": None}
    assert parse("tell me about COTA", ROUNDS)["round"] == 19
    assert parse("round 18 please", ROUNDS)["round"] == 18
    assert parse("What does Halcyon owe us?", ROUNDS)["intent"] == "sponsor"
    assert parse("approve je_8f2 now", ROUNDS)["intent"] == "approve"
    assert parse("what's waiting for approval", ROUNDS)["intent"] == "approvals"
    assert parse("which invoices are unpaid", ROUNDS)["intent"] == "invoices"
    assert parse("run the audit", ROUNDS)["intent"] == "audit"
    assert parse("hello", ROUNDS)["intent"] == "help"


class DownPitWall:
    base = "http://nowhere"

    def summary(self):
        raise ConnectionError("down")


def test_respond_never_raises_and_never_approves():
    assert "couldn't reach" in respond("how much revenue?", DownPitWall())


@pytest.fixture
def api_client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    import finance.api as api

    monkeypatch.setattr("finance.sim.DATA_DIR", tmp_path)
    return TestClient(api.app)


def test_chat_answers_come_from_the_books(api_client):
    from pitwall_client import PitWall

    rid = api_client.post("/api/runs", json={"season": 2024, "stop_before_round": 15, "auto_people": False, "cash": False}).json()["run_id"]
    pw = PitWall(base="http://testserver", http=api_client, run_id=rid)
    spa = respond("What happened at Spa?", pw)
    assert "Belgian Grand Prix" in spa and "car 63" in spa and "Never booked" in spa
    assert "Round 14" in respond("how much revenue have we booked", pw)
    assert "K11" in respond("approve that entry", pw)
    assert "not been run" in respond("what happened at round 20", pw) or "hasn't been run" in respond("what happened at round 20", pw)


def test_both_agents_settle_invoices_end_to_end(api_client, monkeypatch):
    pytest.importorskip("uagents")
    monkeypatch.setenv("AGENT_MAILBOX", "0")
    monkeypatch.setenv("PITWALL_COLLECT_EVERY", "1")
    monkeypatch.setenv("PITWALL_COLLECT_BATCH", "5")
    monkeypatch.setenv("VERIFY_OFFLINE", "1")
    for m in ("pitwall_agent", "sponsor_agent"):
        sys.modules.pop(m, None)
    import pitwall_agent as P
    import sponsor_agent as S
    from pitwall_client import PitWall
    from uagents import Bureau

    rid = api_client.post("/api/runs", json={"season": 2024, "stop_before_round": 4, "auto_people": False, "cash": False}).json()["run_id"]
    P.pw = PitWall(base="http://testserver", http=api_client, run_id=rid)
    monkeypatch.setenv("SPONSOR_AGENT", S.agent.address)
    loop = P.agent._loop
    bureau = Bureau(port=8097, loop=loop, shutdown_timeout=1)
    bureau.add(P.agent)
    bureau.add(S.agent)
    def paid_count():
        inv = api_client.get(f"/api/runs/{rid}/invoices", params={"status": "all"}).json()
        return sum(i["payment"]["status"] == "paid" for i in inv)

    async def until_paid():
        task = asyncio.ensure_future(bureau.run_async())
        for _ in range(80):  # registration on an unreachable network takes ~10 s before handlers run
            await asyncio.sleep(0.5)
            if paid_count() >= 3:
                break
        task.cancel()

    try:
        loop.run_until_complete(until_paid())
    except (asyncio.TimeoutError, asyncio.CancelledError):
        pass
    inv = api_client.get(f"/api/runs/{rid}/invoices", params={"status": "all"}).json()
    paid = [i for i in inv if i["payment"]["status"] == "paid"]
    assert paid, "no invoice was paid agent to agent"
    for i in paid:
        assert i["payment"]["events"][-1]["cash_je_id"]
    assert api_client.get(f"/api/runs/{rid}/trial-balance").json()["ties"]
    os.environ.pop("SPONSOR_AGENT", None)


def test_client_recovers_when_the_api_restarts(api_client):
    from pitwall_client import PitWall

    pw = PitWall(base="http://testserver", http=api_client, run_id="2024-gone")
    api_client.post("/api/runs", json={"season": 2024, "stop_before_round": 2, "cash": False})
    assert pw.summary()["season"] == 2024 and pw.run_id != "2024-gone"
