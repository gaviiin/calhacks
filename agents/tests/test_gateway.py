import json

import pytest

from agents import reducers as R
from agents.gateway import Gateway, UnbalancedEntry, build_journal_entry, check_balanced

from .conftest import gl


def _totals(je):
    return sum(l["debit_minor"] for l in je["lines"]), sum(l["credit_minor"] for l in je["lines"])


def _item(**kw):
    row = {"id": 5, "kind": "classification", "subject_ref": "gl-000001", "period_key": "2026-01", "state": "APPROVED",
           "proposed_category_code": "CATERING", "proposed_rulebook_entry_id": "CATERING@SECD-ISS07",
           "reason": "pol-3 v1: canteen", "evidence_refs": json.dumps(["gl-000001", "bl-1"]), "amount_usd_minor": 720_000}
    row.update(kw)
    return row


def test_reclass_entry_balances():
    je = build_journal_entry(_item(), gl())
    d, c = _totals(je)
    assert d == c == 720_000
    assert je["lines"][0] == {"account_id": "capcat-CATERING", "debit_minor": 720_000, "credit_minor": 0}
    assert je["lines"][1] == {"account_id": "acct-6410", "debit_minor": 0, "credit_minor": 720_000}
    assert je["work_item_id"] == "5" and je["period_key"] == "2026-01"
    assert "work_item:5" in je["evidence_refs"] and "gl-000001" in je["evidence_refs"]


def test_negative_line_swaps_sides():
    je = build_journal_entry(_item(), gl(amount_usd_minor=-50_000))
    assert je["lines"][0]["account_id"] == "acct-6410" and je["lines"][0]["debit_minor"] == 50_000
    assert _totals(je) == (50_000, 50_000)


def test_fair_value_adjustment_entry_balances():
    fv = {"id": "fv-005", "currency": "USD", "contract_value_minor": 1_000_000, "fair_value_minor": 1_250_000}
    item = _item(proposed_category_code="ADJ_RELATED_PARTY_FAIR_VALUE",
                 proposed_rulebook_entry_id="ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07")
    je = build_journal_entry(item, gl(amount_usd_minor=1_000_000), fair_value=fv)
    accts = {l["account_id"]: l for l in je["lines"]}
    assert accts["capcat-RELEVANT"]["debit_minor"] == 1_000_000
    assert accts["capcat-ADJ_RELATED_PARTY_FAIR_VALUE"]["debit_minor"] == 250_000
    assert accts["capadj-NOTIONAL_OFFSET"]["credit_minor"] == 250_000
    assert _totals(je) == (1_250_000, 1_250_000)


def test_reversal_backs_out_original_and_books_corrected_amount():
    # REDUCERS.md: posting a reversal backs the original out in full and books the corrected amount
    orig = _item(id=5, state="POSTED", erp_entry_id="JE-1")
    rev = _item(id=9, kind="reversal", subject_ref="5", reason="source corrected", amount_usd_minor=700_000,
                proposed_category_code="RELEVANT", proposed_rulebook_entry_id="RELEVANT@SECD-ISS07")
    je = build_journal_entry(rev, gl(amount_usd_minor=700_000), original=orig, original_gl=gl())
    assert je["lines"][:2] == [{"account_id": "capcat-CATERING", "debit_minor": 0, "credit_minor": 720_000},
                               {"account_id": "acct-6410", "debit_minor": 720_000, "credit_minor": 0}]
    assert je["lines"][2:] == [{"account_id": "capcat-RELEVANT", "debit_minor": 700_000, "credit_minor": 0},
                               {"account_id": "acct-6410", "debit_minor": 0, "credit_minor": 700_000}]
    assert _totals(je) == (1_420_000, 1_420_000)


def test_gateway_reversal_uses_recorded_original_lines(stdb, actors, world, tmp_path):
    orig = _setup(stdb, actors)
    gw = Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=tmp_path / "p.json")
    gw.run_once()
    # the line is re-synced with a new account and amount; the module raises a reversal item
    stdb.tables["gl_line"][0].update(account_id="acct-7000", account_code="7000", amount_usd_minor=650_000)
    rev = stdb.add_item(kind="reversal", subject_ref=str(orig["id"]), period_key="2026-02", state="APPROVED",
                        amount_usd_minor=650_000, proposed_category_code="RELEVANT",
                        proposed_rulebook_entry_id="RELEVANT@SECD-ISS07",
                        evidence_refs=json.dumps(["gl-000001", f"work_item:{orig['id']}"]))
    [r] = gw.run_once()
    assert r["status"] == "posted" and stdb.item(rev["id"])["state"] == "POSTED"
    body = world.journal[str(rev["id"])]
    # backs out exactly what was posted (acct-6410, 720k), not today's golden row
    assert body["lines"][1] == {"account_id": "acct-6410", "debit_minor": 720_000, "credit_minor": 0}
    assert body["lines"][3] == {"account_id": "acct-7000", "debit_minor": 0, "credit_minor": 650_000}
    assert _totals(body) == (1_370_000, 1_370_000)


def test_check_balanced_rejects_bad_entries():
    with pytest.raises(UnbalancedEntry):
        check_balanced([{"account_id": "a", "debit_minor": 1, "credit_minor": 0},
                        {"account_id": "b", "debit_minor": 0, "credit_minor": 2}])
    with pytest.raises(UnbalancedEntry):
        check_balanced([{"account_id": "a", "debit_minor": 1, "credit_minor": 0}])


def _setup(stdb, actors, state="APPROVED"):
    stdb.tables["gl_line"].append(gl())
    return stdb.add_item(**{k: v for k, v in _item(state=state).items() if k != "id"})


def test_gateway_posts_once_and_is_idempotent(stdb, actors, world, tmp_path):
    item = _setup(stdb, actors)
    _setup(stdb, actors, state="PROPOSED")  # must never be posted
    gw = Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=tmp_path / "posted.json")
    res = gw.run_once()
    assert [r["status"] for r in res] == ["posted"]
    assert stdb.item(item["id"])["state"] == "POSTED"
    assert world.post_count == 1
    body = world.journal[str(item["id"])]
    assert sum(l["debit_minor"] for l in body["lines"]) == sum(l["credit_minor"] for l in body["lines"])
    req = [r for r in world.requests if r.url.path == "/erp/journal_entries"][0]
    assert req.headers["X-Gateway-Key"] == world.gateway_key
    (_, _, args), = stdb.reducer_calls(R.POST)
    assert args == [item["id"], body["erp_entry_id"]]

    # second run: nothing APPROVED, nothing posted
    assert Gateway(world.client(), stdb, actors["gateway"], world.gateway_key,
                   ledger_path=tmp_path / "posted.json").run_once() == []
    assert world.post_count == 1 and len(stdb.reducer_calls(R.POST)) == 1


def test_gateway_recovers_without_reposting_to_erp(stdb, actors, world, tmp_path):
    item = _setup(stdb, actors)
    stdb.raise_on.add(R.POST)  # ERP post succeeds, reducer call fails
    gw = Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=tmp_path / "posted.json")
    assert gw.run_once()[0]["status"] == "error"
    assert world.post_count == 1 and stdb.item(item["id"])["state"] == "APPROVED"
    erp_requests = len([r for r in world.requests if r.url.path == "/erp/journal_entries"])
    stdb.raise_on.clear()
    gw2 = Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=tmp_path / "posted.json")
    [r] = gw2.run_once()
    assert r["status"] == "posted" and r["reused_erp_entry"] is True
    assert len([r for r in world.requests if r.url.path == "/erp/journal_entries"]) == erp_requests
    assert stdb.item(item["id"])["state"] == "POSTED"


def test_gateway_skips_locked_period(stdb, actors, world, tmp_path):
    item = _setup(stdb, actors)
    stdb.tables["period"].append({"key": "2026-01", "locked": True})
    gw = Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=tmp_path / "p.json")
    [r] = gw.run_once()
    assert r["status"] == "skipped" and world.post_count == 0 and stdb.item(item["id"])["state"] == "APPROVED"


def test_gateway_requires_key(stdb, actors, world):
    with pytest.raises(ValueError):
        Gateway(world.client(), stdb, actors["gateway"], "")


def test_fair_value_uplift_is_fair_value_minus_invoiced_in_invoice_currency():
    """Plant P15: a GBP 665,000 recharge keyed as GBP 66,500 against a GBP 650,000 fair value."""
    from agents.gateway import fair_value_uplift

    line = gl(amount_usd_minor=8_445_500, amount_minor=6_650_000, currency="GBP", fx_rate_e6=1_270_000)
    fv = {"id": "fv-002", "currency": "GBP", "contract_value_minor": 66_500_000, "fair_value_minor": 65_000_000}
    assert fair_value_uplift(line, fv) == round((65_000_000 - 6_650_000) * 1.27)
    # invoiced at or above fair value: no uplift
    assert fair_value_uplift(gl(amount_minor=70_000_000, currency="GBP", fx_rate_e6=1_270_000), fv) == 0


def test_fair_value_in_another_currency_refuses_to_post():
    from agents.gateway import fair_value_uplift

    with pytest.raises(ValueError, match="EUR"):
        fair_value_uplift(gl(currency="GBP", amount_minor=100, fx_rate_e6=1_270_000),
                          {"id": "fv-9", "currency": "EUR", "contract_value_minor": 1, "fair_value_minor": 500})
