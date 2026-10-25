from fastapi.testclient import TestClient

import finance.api as api
from finance.eval import generate


def test_demo_flow_over_http(world, store, tmp_path, monkeypatch):
    requests, _ = generate(world, 2024)
    (world.dir / "requests").mkdir(exist_ok=True)
    import json

    (world.dir / "requests" / "2024.json").write_text(json.dumps({"requests": requests}))
    monkeypatch.setattr(api, "WORLD", world)
    monkeypatch.setattr(api, "STORE", store)
    monkeypatch.setattr("finance.sim.DATA_DIR", tmp_path)
    c = TestClient(api.app)

    run = c.post("/api/runs", json={"season": 2024, "stop_before_round": 14, "auto_people": False}).json()
    rid = run["run_id"]
    assert run["events_done"] < run["events_total"]

    adv = c.post(f"/api/runs/{rid}/advance", json={"round": 14}).json()
    types = [d["event"]["type"] for d in adv["done"] if d["event"]["payload"].get("round") == 14]
    assert types[:1] == ["race_provisional"] and "race_final" in types

    wk = c.get(f"/api/runs/{rid}/weekend/14").json()
    assert [d["kind"] for d in wk["fia_documents"] if d["cars"] == [63]] == ["summons", "infringement"]
    assert any(m["status"] == "avoided" for m in wk["memos"])

    q = c.get(f"/api/runs/{rid}/queue").json()
    assert {"parked", "questions", "held_billing", "alerts"} <= set(q)

    tape = c.get(f"/api/runs/{rid}/tape").json()
    assert tape and {"je_id", "kind", "status", "memo"} <= set(tape[0])
    why = c.get(f"/api/runs/{rid}/entries/{tape[0]['je_id']}/why").json()
    assert why["text"]

    c.post(f"/api/runs/{rid}/advance", json={"n": 10_000})
    out = c.post(f"/api/runs/{rid}/scenario", json={"round": 12, "car": 44}).json()
    parked = [e for e in out["entries"] if e["status"] == "parked"]
    assert parked
    r = c.post(f"/api/runs/{rid}/approve", json={"je_id": parked[0]["je_id"], "approver": "agent:revenue", "role": "controller"}).json()
    assert r["status"] == "refused"
    assert c.get(f"/api/runs/{rid}/trial-balance").json()["ties"]
    assert len(c.get(f"/api/runs/{rid}/timeline").json()) == 14
    assert c.get(f"/api/runs/{rid}/sponsors").json()[0]["sponsor_id"] == "halcyon"


def test_parallel_reads_do_not_corrupt_the_shared_ledger(world, store, tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    monkeypatch.setattr(api, "WORLD", world)
    monkeypatch.setattr(api, "STORE", store)
    monkeypatch.setattr("finance.sim.DATA_DIR", tmp_path)
    c = TestClient(api.app)
    rid = c.post("/api/runs", json={"season": 2024, "stop_before_round": 14, "auto_people": False}).json()["run_id"]
    paths = [f"/api/runs/{rid}/{p}" for p in ("queue", "scorecard", "sponsors", "timeline", "impact", "tape")] * 6
    with ThreadPoolExecutor(max_workers=12) as pool:
        codes = list(pool.map(lambda p: c.get(p).status_code, paths))
    assert codes == [200] * len(paths)
