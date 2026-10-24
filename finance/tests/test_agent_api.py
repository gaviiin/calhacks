"""Outside agents' endpoints: summary, invoices, and agent payments booked through the kernel."""

import json

import pytest
from fastapi.testclient import TestClient

from finance.eval import generate


@pytest.fixture
def client(world, store, tmp_path, monkeypatch):
    import finance.api as api

    requests, _ = generate(world, 2024)
    (world.dir / "requests").mkdir(exist_ok=True)
    (world.dir / "requests" / "2024.json").write_text(json.dumps({"requests": requests}))
    monkeypatch.setattr(api, "WORLD", world)
    monkeypatch.setattr(api, "STORE", store)
    monkeypatch.setattr("finance.sim.DATA_DIR", tmp_path)
    return TestClient(api.app)


def test_agent_payment_books_cash_once_through_the_kernel(client):
    rid = client.post("/api/runs", json={"season": 2024, "cash": False}).json()["run_id"]
    s = client.get(f"/api/runs/{rid}/summary").json()
    assert s["books_tie"] and s["last_final_round"] > 0 and s["rounds"]
    inv = client.get(f"/api/runs/{rid}/invoices").json()
    assert inv and {"request_id", "amount_orig", "currency", "contract_quote", "final_classification_at", "invoiced_at"} <= set(inv[0])
    one = inv[0]
    owed_before = client.get(f"/api/runs/{rid}/sponsors").json()
    url = f"/api/runs/{rid}/invoices/{one['request_id']}/payment"
    assert client.post(url, json={"event": "completed", "payer": "ap"}).status_code == 409  # commit first
    assert client.post(url, json={"event": "committed", "payer": "ap", "transaction_id": "t1"}).json()["status"] == "committed"
    done = client.post(url, json={"event": "completed", "payer": "ap", "transaction_id": "t1"}).json()
    assert done["ok"] and done["status"] == "paid" and done["cash_je_id"]
    je = client.get(f"/api/runs/{rid}/entries/{done['cash_je_id']}").json()
    assert je["kind"] == "cash_receipt" and je["status"] == "posted" and all(c["result"] != "fail" for c in je["checks"])
    again = client.post(url, json={"event": "completed", "payer": "ap", "transaction_id": "t1"}).json()
    assert again["ok"] is False and "twice" in again["text"]
    assert one["request_id"] not in {i["request_id"] for i in client.get(f"/api/runs/{rid}/invoices").json()}
    after = {x["sponsor_id"]: x["receivable_orig_cents"] for x in client.get(f"/api/runs/{rid}/sponsors").json()}
    before = {x["sponsor_id"]: x["receivable_orig_cents"] for x in owed_before}
    assert before[one["sponsor_id"]] - after[one["sponsor_id"]] == one["amount_orig"]
    assert client.get(f"/api/runs/{rid}/trial-balance").json()["ties"]


def test_rejection_is_recorded_and_settled_invoices_are_not_open(client):
    rid = client.post("/api/runs", json={"season": 2024}).json()["run_id"]  # remittances simulated: everything settled
    assert client.get(f"/api/runs/{rid}/invoices").json() == []
    rid2 = client.post("/api/runs", json={"season": 2024, "cash": False}).json()["run_id"]
    inv = client.get(f"/api/runs/{rid2}/invoices").json()[0]
    out = client.post(f"/api/runs/{rid2}/invoices/{inv['request_id']}/payment",
                      json={"event": "rejected", "payer": "ap", "reason": "car not classified"}).json()
    assert out["status"] == "rejected"
    assert inv["request_id"] not in {i["request_id"] for i in client.get(f"/api/runs/{rid2}/invoices").json()}
    assert client.post(f"/api/runs/{rid2}/invoices/BR-nope/payment", json={"event": "committed"}).status_code == 404
