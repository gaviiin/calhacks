import httpx
import pytest

from live_racing.cases import CaseBook, Refused
from live_racing.config import Config
from live_racing.jev_router import JevRouter
from live_racing.publisher import MemorySink, Publisher
from live_racing.replay import Replay, ReplayOptions
from live_racing.schemas import GarageOption, GarageReport, IncidentSignal, JevDecision
from live_racing.team import LiveWorld, scope_of

NOW = ["2026-01-01T00:00:00.000Z"]


def mk_book(team="williams", headroom=(5_000_000_000, "test headroom")):
    mem = MemorySink()
    pub = Publisher([mem])
    book = CaseBook("replay-1", "2024_sao_paulo_gp", team, lambda kind, obj, id, version, status: pub.publish(kind, obj, id=id, version=version, status=status),
                    now=lambda: NOW[0], log=lambda s: None, headroom=lambda: headroom)
    return book, mem


def sig(car, scope_cars):
    return IncidentSignal(incident_id=f"2024_sao_paulo_gp:race:lap32:car{car}:crash_candidate", sporting_source_date="2024-11-03", race_id="2024_sao_paulo_gp", lap=32,
                          driver_number=car, driver_name=f"driver {car}", jev=JevDecision(deterministic_route="crash_finance", chosen_route="crash_finance"),
                          event_time_utc="2024-11-03T16:37:22.000Z", observed_at_utc=NOW[0], scope=scope_of(car, scope_cars), message="RED FLAG; car stopped")


def test_own_team_case_runs_end_to_end_with_the_right_people():
    book, mem = mk_book()
    c = book.open(sig(43, [43, 23, 2]), "own_team", "stopped_candidate", "2024-11-03T16:37:22.000Z")
    assert c.state == "detected" and c.permissions["may_call_cost_cap_agent"] and not c.permissions["may_approve_spend"]
    assert c.exposure_status == "unknown_until_evidence" and c.exposure_cents is None
    book.on_jev(c.incident_id, JevDecision(used=True, status="ok", route="crash_finance", route_confidence=0.82, latency_ms=71, deterministic_route="crash_finance",
                                           chosen_route="crash_finance"), None)
    assert c.state == "investigating"
    book.on_retired(c.incident_id, "2024-11-03T17:01:15.000Z", "car 43 did not take the restart")
    assert c.state == "awaiting_evidence" and "garage damage report" in c.missing_evidence
    # the cost cap agent evaluates the garage's two options
    book.demo_garage_report(c.case_id)
    assert c.state == "awaiting_approval" and c.evaluation.recommended == "repair" and c.evaluation.avoided_cents == 27_000_000
    assert c.evaluation.headroom_before_cents == 5_000_000_000 and c.evaluation.options[0]["treatment"] == "RELEVANT"
    assert c.exposure_status == "estimated_from_garage_report" and c.exposure_cents == 13_000_000
    # guards: an agent may not approve; the controller cannot go before engineering; the same person cannot do both
    with pytest.raises(Refused):
        book.approve(c.case_id, "controller", "agent:financial_analyst", "authorized")
    with pytest.raises(Refused):
        book.approve(c.case_id, "controller", "dana", "authorized")
    book.approve(c.case_id, "engineering", "morgan", "cleared", "arm passed NDT")
    with pytest.raises(Refused):
        book.approve(c.case_id, "controller", "morgan", "authorized")
    assert len(book.refused) == 3 and c.state == "awaiting_approval"
    book.approve(c.case_id, "controller", "dana", "authorized", "within budget")
    assert c.state == "reconciling" and c.procurement is not None and c.procurement.amount_cents == 13_000_000 and c.procurement.mock
    assert c.exposure_status == "authorized"
    # the invoice matches within 2%: closed with a complete trail
    book.demo_invoice(c.case_id, 13_100_000)
    assert c.state == "closed" and c.invoice.matched and c.invoice.variance_cents == 100_000 and c.exposure_status == "reconciled"
    actors = [s.actor for s in c.steps if s.status != "refused"]
    assert actors[:3] == ["system", "jev", "financial_analyst"] and "cost_cap_agent" in actors and "engineering" in actors and "controller" in actors
    assert actors[-3:] == ["procurement", "reconciliation", "system"]
    assert all(st["status"] == "done" for st in c.stages)
    assert len([r for r in mem.records if r["kind"] == "finance_case"]) == c.version - 1
    assert book.summary()["refused_actions"] == 3 and book.summary()["closed_with_approvals"] == 1


def test_an_invoice_outside_tolerance_is_escalated_not_paid():
    book, _ = mk_book()
    c = book.open(sig(43, [43]), "own_team", "stopped_candidate", None)
    book.on_retired(c.incident_id, None, "out")
    book.demo_garage_report(c.case_id)
    book.approve(c.case_id, "engineering", "morgan", "not_cleared", "arm failed NDT")
    assert c.evaluation.recommended == "replace" and c.exposure_cents == 40_000_000
    book.approve(c.case_id, "controller", "dana", "authorized")
    book.demo_invoice(c.case_id, 46_000_000)
    assert c.state == "awaiting_approval" and c.invoice.matched is False and "differs" in c.escalation_reason and c.procurement.status == "disputed"


def test_a_competitor_case_never_touches_their_garage():
    book, _ = mk_book(team="mercedes")
    c = book.open(sig(43, [63, 44]), "competitor", "stopped_candidate", None)
    assert c.scope == "competitor" and not c.permissions["may_request_garage_report"] and not c.permissions["may_access_competitor_books"]
    with pytest.raises(Refused):
        book.receive_garage_report(c.case_id, GarageReport(reported_at_utc=NOW[0], car=43, options=[GarageOption(key="replace", label="x", cost_cents=1, lead_time="now")]))
    book.on_retired(c.incident_id, None, "car 43 did not take the restart")
    assert c.state == "closed" and "competitor retired" in c.closed_reason and c.garage_report is None


def test_no_damage_closes_without_an_expense():
    book, _ = mk_book(team="mercedes")
    s = sig(44, [63, 44])
    s = s.model_copy(update={"type": "incident_noted", "message": "TURN 1 INCIDENT INVOLVING CARS 44 (HAM) AND 30 (LAW) NOTED - CAUSING A COLLISION"})
    c = book.open(s, "own_team", "running", None)
    book.on_no_damage(c.incident_id, None, "stewards: no further investigation; car 44 running at P11")
    assert c.state == "closed" and "no repair bill invented" in c.closed_reason and c.exposure_cents is None and c.garage_report is None


def test_the_replay_as_williams_opens_our_case_and_as_mercedes_closes_the_competitor_one(brazil, slice_meta, slice_events, tmp_path, quiet):
    def run(team):
        mem = MemorySink()
        rp = Replay(brazil, slice_meta, slice_events, LiveWorld(team), Publisher([mem]), JevRouter(Config.from_env(), api_key=None, mode="api"),
                    ReplayOptions(speed=float("inf"), from_lap=30, to_lap=34, demo=False), log=lambda s: None, replay_id=f"t-{team}")
        rp.run()
        return rp, mem

    rp, mem = run("williams")
    assert rp.team_cars == [43, 23, 2] or sorted(rp.team_cars) == [2, 23, 43]
    c43 = rp.cases._for("2024_sao_paulo_gp:race:lap32:car43:crash_candidate")
    assert c43.scope == "own_team" and c43.state == "awaiting_evidence" and c43.exposure_cents is None
    assert any(s.action.startswith("Requested the signed garage damage report") and s.automatic for s in c43.steps)
    inc = rp.incidents[c43.incident_id]
    assert inc.sporting_confirmation == "retired_per_timing" and inc.handoff.status == "requested" and inc.post_race_reference["available"].startswith("after the race")
    plan = rp.plans[c43.incident_id]
    assert plan.scope == "own_team" and not any(s.feasible for s in plan.scenarios if s.key in ("continue", "pit_now"))
    rp2, _ = run("mercedes")
    c43m = rp2.cases._for("2024_sao_paulo_gp:race:lap32:car43:crash_candidate")
    assert c43m.scope == "competitor" and c43m.state == "closed" and c43m.garage_report is None
    c44 = rp2.cases._for("2024_sao_paulo_gp:race:lap33:car44:crash_candidate")
    assert c44 is not None and c44.scope == "own_team" and c44.state == "closed" and "no repair bill invented" in c44.closed_reason
    assert rp2.cases.summary()["closed_autonomously"] == 2 and rp2.cases.summary()["refused_actions"] == 0
