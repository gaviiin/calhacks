"""Cursor API and ERP endpoint (SCHEMA.md section 5)."""

from __future__ import annotations

from collections import defaultdict

import pytest
from fastapi.testclient import TestClient

from world.api import create_app
from world.generate import SOURCES


@pytest.fixture()
def client(out_dir, monkeypatch):
    monkeypatch.delenv("GATEWAY_KEY", raising=False)
    with TestClient(create_app(out_dir)) as c:
        yield c


def advance(c, days):
    r = c.post("/clock/advance", json={"days": days})
    assert r.status_code == 200, r.text
    return r.json()["sim_date"]


def drain(c, source, after=0, limit=500):
    out, cursor = [], after
    while True:
        page = c.get(f"/changes/{source}", params={"after": cursor, "limit": limit}).json()
        out += page["records"]
        if page["records"]:
            assert page["next_cursor"] == page["records"][-1]["cursor"]
        cursor = page["next_cursor"]
        if not page["has_more"]:
            return out, cursor


def test_clock_and_sources(client):
    assert client.get("/clock").json() == {"sim_date": "2026-01-01"}
    assert client.get("/sources").json() == SOURCES
    assert advance(client, 7) == "2026-01-08"
    assert advance(client, 0) == "2026-01-08"
    assert client.post("/clock/advance", json={"days": -1}).status_code == 422
    assert client.post("/clock/advance", json={"days": "3"}).status_code == 422
    assert client.get("/clock").json() == {"sim_date": "2026-01-08"}


def test_reference_and_history_visible_from_start(client, recs):
    for src in ("account", "department", "vendor", "contract", "history_2025_gl_line", "history_2025_cap_classification",
                "history_2025_approval"):
        got, _ = drain(client, src)
        assert len(got) == len(recs[src]), src
    issues, _ = drain(client, "rulebook_issue")
    assert [x["record"]["id"] for x in issues] == ["ISS22", "SECD-ISS07"]  # 2026 rules known on day one
    fvs, _ = drain(client, "fair_value")
    assert sorted(x["record"]["id"] for x in fvs) == ["fv-001", "fv-002", "fv-003", "fv-004"]
    assert drain(client, "gl_line")[0] == []  # nothing in the 2026 ledger on New Year's Day


def test_day_one_first_item_is_the_demo_invoice(client):
    advance(client, 1)
    page = client.get("/changes/gl_line", params={"after": 0, "limit": 3}).json()
    first = page["records"][0]
    assert first["cursor"] == 1 and first["op"] == "upsert"
    assert first["record"]["id"] == "gl-000001" and first["record"]["erp_category_code"] == "MARKETING"
    bl = client.get("/records/bill_line/bl-00001-3").json()
    assert bl["gl_line_id"] == "gl-000001" and bl["amount_minor"] == 720_000


def test_pagination_and_visibility_prefix(client):
    advance(client, 59)  # 2026-03-01
    small, end = drain(client, "gl_line", limit=37)
    big, end2 = drain(client, "gl_line", limit=5000)
    assert small == big and end == end2 == len(big)
    assert [x["cursor"] for x in big] == list(range(1, len(big) + 1))
    assert all(x["record"]["visible_at"] <= "2026-03-01" for x in big)
    # nothing new without the clock moving; cursor stays put
    page = client.get("/changes/gl_line", params={"after": end}).json()
    assert page == {"records": [], "next_cursor": end, "has_more": False}
    advance(client, 7)
    more, end3 = drain(client, "gl_line", after=end)
    assert more and more[0]["cursor"] == end + 1 and end3 > end


def test_re_emission_gets_a_later_cursor_and_records_returns_latest(client):
    advance(client, 364)  # 2026-12-31: everything visible
    allc, _ = drain(client, "gl_line", limit=5000)
    by_id = defaultdict(list)
    for ch in allc:
        by_id[ch["record"]["id"]].append(ch)
    multi = {k: v for k, v in by_id.items() if len(v) > 1}
    assert len(multi) >= 20
    for rid, chs in multi.items():
        assert chs[0]["cursor"] < chs[-1]["cursor"]
        assert chs[0]["record"]["updated_at"] < chs[-1]["record"]["updated_at"]
        assert client.get(f"/records/gl_line/{rid}").json() == chs[-1]["record"]
    fvs, _ = drain(client, "fair_value")
    assert [x["record"]["id"] for x in fvs].count("fv-002") == 2
    issues, _ = drain(client, "rulebook_issue")
    assert [x["record"]["id"] for x in issues] == ["ISS22", "SECD-ISS07"]


def test_late_record_and_mid_year_rule_change(client, recs, answer_key):
    p25 = next(r["record_id"] for r in answer_key if r["plant_id"] == "P25")
    advance(client, 59)  # 2026-03-01
    assert client.get(f"/records/gl_line/{p25}").status_code == 404
    advance(client, 115)  # 2026-06-24
    assert client.get(f"/records/gl_line/{p25}").json()["posted_date"] == "2026-01-27"
    advance(client, 1)  # 2026-06-25
    assert client.get("/records/rulebook_issue/SECD-ISS07").json()["published_on"] == "2026-06-25"
    # a re-emitted record: first version visible, correction not yet
    p35 = next(r["record_id"] for r in answer_key if r["plant_id"] == "P35")
    assert client.get(f"/records/gl_line/{p35}").json()["account_id"] == "acct-6420"
    advance(client, 13)  # 2026-07-08
    assert client.get(f"/records/gl_line/{p35}").json()["account_id"] == "acct-6410"


def test_unknown_source_and_bad_params(client):
    assert client.get("/changes/nope").status_code == 404
    assert client.get("/records/nope/x").status_code == 404
    assert client.get("/records/vendor/ven-999").status_code == 404
    assert client.get("/changes/gl_line", params={"after": -1}).status_code == 422
    assert client.get("/changes/gl_line", params={"limit": 0}).status_code == 422


BALANCED = {
    "work_item_id": "17", "period_key": "2026-01",
    "lines": [{"account_id": "capcat-CATERING", "debit_minor": 1934110, "credit_minor": 0},
              {"account_id": "acct-6420", "debit_minor": 0, "credit_minor": 1934110}],
    "memo": "WI-17 gl-000001 -> CATERING", "evidence_refs": ["gl_line:gl-000001:1"],
}


def test_erp_requires_gateway_key(client):
    assert client.post("/erp/journal_entries", json=BALANCED).status_code == 401
    assert client.post("/erp/journal_entries", json=BALANCED, headers={"X-Gateway-Key": "nope"}).status_code == 403
    assert client.post("/erp/journal_entries", json={"garbage": 1}).status_code == 401  # auth before validation
    assert client.get("/erp/journal_entries").json()["entries"] == []


def test_erp_rejects_unbalanced_and_malformed(client):
    h = {"X-Gateway-Key": "dev-gateway-key"}
    unbalanced = dict(BALANCED, lines=[dict(BALANCED["lines"][0]), dict(BALANCED["lines"][1], credit_minor=1934100)])
    r = client.post("/erp/journal_entries", json=unbalanced, headers=h)
    assert r.status_code == 422 and "unbalanced" in r.text
    both = dict(BALANCED, lines=[{"account_id": "acct-6420", "debit_minor": 5, "credit_minor": 5},
                                 {"account_id": "acct-6410", "debit_minor": 5, "credit_minor": 5}])
    assert client.post("/erp/journal_entries", json=both, headers=h).status_code == 422
    unknown = dict(BALANCED, lines=[dict(BALANCED["lines"][0]), dict(BALANCED["lines"][1], account_id="acct-9999")])
    assert client.post("/erp/journal_entries", json=unknown, headers=h).status_code == 422
    one_line = dict(BALANCED, lines=[BALANCED["lines"][0]])
    assert client.post("/erp/journal_entries", json=one_line, headers=h).status_code == 422
    assert client.post("/erp/journal_entries", json=dict(BALANCED, period_key="2026-13"), headers=h).status_code == 422
    assert client.post("/erp/journal_entries", content=b"not json", headers=h).status_code == 422
    assert client.get("/erp/journal_entries").json()["count"] == 0


def test_erp_posts_balanced_entry_idempotently(client):
    h = {"X-Gateway-Key": "dev-gateway-key"}
    r = client.post("/erp/journal_entries", json=BALANCED, headers=h)
    assert r.status_code == 200 and r.json() == {"erp_entry_id": "JE-2026-000001"}
    assert client.post("/erp/journal_entries", json=BALANCED, headers=h).json() == {"erp_entry_id": "JE-2026-000001"}
    changed = dict(BALANCED, lines=[dict(l, debit_minor=l["debit_minor"] and 10, credit_minor=l["credit_minor"] and 10) for l in BALANCED["lines"]])
    assert client.post("/erp/journal_entries", json=changed, headers=h).status_code == 409
    second = dict(BALANCED, work_item_id="18")
    assert client.post("/erp/journal_entries", json=second, headers=h).json() == {"erp_entry_id": "JE-2026-000002"}
    listed = client.get("/erp/journal_entries").json()
    assert listed["count"] == 2 and listed["entries"][0]["work_item_id"] == "17"
    assert listed["entries"][0]["total_minor"] == 1934110 and listed["entries"][0]["posted_on"] == "2026-01-01"


def test_erp_key_from_env(out_dir, monkeypatch):
    monkeypatch.setenv("GATEWAY_KEY", "s3cret")
    with TestClient(create_app(out_dir)) as c:
        assert c.post("/erp/journal_entries", json=BALANCED, headers={"X-Gateway-Key": "dev-gateway-key"}).status_code == 403
        assert c.post("/erp/journal_entries", json=BALANCED, headers={"X-Gateway-Key": "s3cret"}).status_code == 200


def test_answer_key_endpoint(client, out_dir):
    r = client.get("/answer_key")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert r.text == (out_dir / "answer_key.csv").read_text()
    assert r.text.startswith("plant_id,source,record_id,error_class,expected_action,expected_category_code,note")


def test_startup_fails_clearly_without_data(tmp_path):
    with pytest.raises(RuntimeError, match="world.generate"):
        with TestClient(create_app(tmp_path / "empty")):
            pass
