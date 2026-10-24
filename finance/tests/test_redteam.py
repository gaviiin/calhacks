import json

from fastapi.testclient import TestClient

import finance.api as api
from finance.eval import generate


def test_red_team_sandbox(world, store, tmp_path, monkeypatch):
    requests, _ = generate(world, 2024)
    (world.dir / "requests").mkdir(exist_ok=True)
    (world.dir / "requests" / "2024.json").write_text(json.dumps({"requests": requests}))
    monkeypatch.setattr(api, "WORLD", world)
    monkeypatch.setattr(api, "STORE", store)
    monkeypatch.setattr("finance.sim.DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    c = TestClient(api.app)
    rid = c.post("/api/runs", json={"season": 2024}).json()["run_id"]
    real_tb = c.get(f"/api/runs/{rid}/trial-balance").json()
    sid = c.post(f"/api/runs/{rid}/redteam", json={"attacker": "friend"}).json()["session_id"]

    r = c.post(f"/api/redteam/{sid}/propose", json={"kind": "bonus", "effective_date": "2024-08-30", "label": "unbalanced",
                                                   "lines": [{"account": "1300", "debit": 100}, {"account": "4010", "credit": 99}]}).json()
    assert r["status"] == "refused" and "K1" in r["failed_checks"], r
    r = c.post(f"/api/redteam/{sid}/billing", json={"round": 2, "sponsor_id": "arcadia", "clause_id": "4.2", "car": 63,
                                                   "amount_orig": 40_000_000, "currency": "GBP", "label": "claim P4 as podium"}).json()
    assert r["status"] == "rejected" and r["reason"] == "not_earned"
    rep = c.get(f"/api/redteam/{sid}/report").json()
    assert rep["attempts"] == 2 and rep["leaked"] == [] and rep["books_tie"]
    assert c.get(f"/api/runs/{rid}/trial-balance").json() == real_tb  # the real books never moved
