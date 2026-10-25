import time

from fastapi.testclient import TestClient

import live_racing.api as api


def wait_finished(c, timeout=20.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = c.get("/live/state").json()
        if s["replay"] and s["replay"]["state"] in ("finished", "error", "stopped"):
            return s
        time.sleep(0.05)
    raise AssertionError("replay did not finish")


def test_incident_reaches_the_handoff_and_person_2_answers_by_id(quiet):
    api._CURRENT.update(replay=None, thread=None, log=[])
    c = TestClient(api.app)
    assert c.get("/live/health").json()["jev"] == "deterministic_fallback"
    races = c.get("/live/races").json()
    assert {r["race_id"] for r in races} == {"2024_sao_paulo_gp", "2024_belgian_gp"}
    r = c.post("/live/replay", json={"race_id": "2024_sao_paulo_gp", "speed": 1e9, "from_lap": 30, "to_lap": 33, "corroborate_after_s": 30, "spacetime": False})
    assert r.status_code == 202, r.text
    s = wait_finished(c)
    assert s["replay"]["state"] == "finished" and s["race_state"]["lap"] >= 33
    inc = next(i for i in s["incidents"] if i["incident_id"].endswith("car43:crash_candidate"))
    assert inc["handoff"]["status"] == "requested" and inc["sporting_confirmation"] == "verified_historical_incident"
    iid = inc["incident_id"]

    bad = c.post(f"/live/incidents/{iid}/finance-impact", json={"incident_id": iid, "financial_status": "synthetic_projected_not_booked", "journal_entry": {"debit": 1}})
    assert bad.status_code == 422
    missing = c.post("/live/incidents/nope/finance-impact", json={"incident_id": "nope", "financial_status": "pending"})
    assert missing.status_code == 404
    mismatch = c.post(f"/live/incidents/{iid}/finance-impact", json={"incident_id": "other", "financial_status": "pending"})
    assert mismatch.status_code == 422

    ok = c.post(f"/live/incidents/{iid}/finance-impact", json={
        "incident_id": iid, "financial_status": "synthetic_projected_not_booked", "initial_exposure_cents": 40_000_000, "selected_recovery_cost_cents": 13_000_000,
        "forecast_headroom_after_cents": 107_000_000, "requires_engineering_approval": True, "requires_finance_approval": True,
        "accounting_rule_version": "demo-config", "evidence_refs": ["synthetic_garage_report:demo"]})
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["handoff"]["status"] == "assessed" and body["financial_impact"] == {"status": "synthetic_projected_not_booked", "amount_cents": 40_000_000, "currency": "USD"}
    latest = c.get(f"/live/incidents/{iid}").json()
    assert latest["version"] == body["version"] and latest["damage_confirmation"] == "synthetic_garage_report_received"
    assert "projected, not booked" in latest["message"]
    state = c.get("/live/state").json()
    assert state["finance_impacts"][0]["incident_id"] == iid and state["finance_impacts"][0]["received_at_utc"]
    ev = c.get("/live/events", params={"since": 0, "kinds": "incident_signal,finance_impact"}).json()
    assert [e["kind"] for e in ev["events"]][-2:] == ["finance_impact", "incident_signal"]
    m = c.get("/live/metrics").json()
    assert m["jev"]["requests"] == 0 and m["incidents"] >= 1


def test_spa_result_change_over_the_same_api(quiet):
    api._CURRENT.update(replay=None, thread=None, log=[])
    c = TestClient(api.app)
    r = c.post("/live/replay", json={"race_id": "2024_belgian_gp", "speed": 1e9, "spacetime": False})
    assert r.status_code == 202, r.text
    s = wait_finished(c)
    types = [x["type"] for x in s["result_changes"]]
    assert types == ["provisional", "result_at_risk", "result_change", "result_final"]
    change = s["result_changes"][2]
    assert change["status"] == "provisional_expected_bonus_corrected_awaiting_recognized_revenue_policy_gate"
    assert change["message"].startswith("Provisional expected bonus corrected; awaiting recognized-revenue policy gate")
    assert "Halcyon Energy $3.00M -> $2.00M" in change["message"]
    assert change["jev"]["chosen_route"] == "revenue_change" and change["jev"]["used"] is False
    assert change["handoff"]["target"] == "revenue_desk"
