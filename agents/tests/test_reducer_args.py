"""Every reducer the agents call: positional arg arrays in SCHEMA.md §6 order."""

import json

import pytest

from agents import reducers as R
from agents.stdb import none, some


def test_admin_and_role_reducers():
    assert R.bootstrap_admin() == []
    assert R.create_role_invite("ai_cap_analyst", "AI Cap Analyst", "code-1") == ["ai_cap_analyst", "AI Cap Analyst", "code-1"]
    assert R.claim_role("code-1") == ["code-1"]
    assert R.set_setting("materiality_usd_minor", 25000000) == ["materiality_usd_minor", "25000000"]
    assert R.lock_period("2026-01") == ["2026-01"]


def test_load_rulebook_entry_order():
    e = {"id": "STAFF_ENTERTAINMENT@SECD-ISS07", "category_code": "STAFF_ENTERTAINMENT", "treatment": "EXCLUDED",
         "rule_version": "SECD-ISS07", "article": "D5.1.1.u", "effective_from": "2026-01-01", "effective_to": None,
         "title": "All-staff entertainment", "text": "...", "cap_limit_usd_minor": 120000000}
    assert R.load_rulebook_entry(e) == [
        "STAFF_ENTERTAINMENT@SECD-ISS07", "STAFF_ENTERTAINMENT", "EXCLUDED", "SECD-ISS07", "D5.1.1.u",
        "2026-01-01", none(), "All-staff entertainment", "...", some(120000000)]
    e2 = dict(e, effective_to="2025-12-31", cap_limit_usd_minor=None)
    out = R.load_rulebook_entry(e2)
    assert out[6] == some("2025-12-31") and out[9] == none()


def test_upsert_gl_line_order():
    g = {"id": "gl-000123", "raw_ref": "gl_line:gl-000123:17", "posted_date": "2026-01-15", "period_key": "2026-01",
         "account_id": "acct-6410", "account_code": "6410", "department_id": "dept-AERO", "vendor_id": "ven-017",
         "bill_id": None, "amount_minor": 720000, "currency": "GBP", "fx_rate_e6": 1270000,
         "amount_usd_minor": 914400, "memo": "Canteen", "erp_category_code": "MARKETING", "entity": "RACING",
         "correction_of": None}
    assert R.upsert_gl_line(g) == [
        "gl-000123", "gl_line:gl-000123:17", "2026-01-15", "2026-01", "acct-6410", "6410", "dept-AERO",
        some("ven-017"), none(), 720000, "GBP", 1270000, 914400, "Canteen", "MARKETING", "RACING", none()]


def test_upsert_bill_line_vendor_fair_value_order():
    b = {"id": "bl-00042-3", "raw_ref": "bill_line:bl-00042-3:9", "bill_id": "bill-00042", "gl_line_id": "gl-000123",
         "line_no": 3, "description": "Sponsor dinner", "amount_minor": 1000, "bill_text": "INVOICE ...",
         "vendor_id": "ven-017", "bank_iban_on_bill": "GB11"}
    assert R.upsert_bill_line(b) == ["bl-00042-3", "bill_line:bl-00042-3:9", "bill-00042", some("gl-000123"), 3,
                                     "Sponsor dinner", 1000, "INVOICE ...", "ven-017", "GB11"]
    v = {"id": "ven-017", "raw_ref": "vendor:ven-017:2", "name": "Grove", "country": "GB", "related_party": True,
         "related_party_entity": "Technology Ltd", "bank_iban": "GB11", "category_hint": None}
    assert R.upsert_vendor(v) == ["ven-017", "vendor:ven-017:2", "Grove", "GB", True, some("Technology Ltd"),
                                  "GB11", none()]
    f = {"id": "fv-005", "raw_ref": "fair_value:fv-005:4", "counterparty_vendor_id": "ven-003", "item": "PU lease",
         "contract_value_minor": 100, "fair_value_minor": 150, "currency": "EUR", "effective_from": "2026-01-01",
         "basis": "benchmark"}
    assert R.upsert_fair_value(f) == ["fv-005", "fair_value:fv-005:4", "ven-003", "PU lease", 100, 150, "EUR",
                                      "2026-01-01", "benchmark"]


def test_work_item_reducers():
    # SCHEMA §10: capEffectUsdMinor? and proposalSource follow evidenceRefs
    assert R.propose(7, "CATERING", "CATERING@SECD-ISS07", 3, "pol-3 v1: canteen", ["gl-1", "bl-1"]) == [
        7, "CATERING", "CATERING@SECD-ISS07", some(3), "pol-3 v1: canteen", json.dumps(["gl-1", "bl-1"]),
        none(), "deterministic"]
    assert R.propose(7, "RELEVANT", "RELEVANT@SECD-ISS07", None, "r", [])[3] == none()
    adj = R.propose(7, "ADJ_RELATED_PARTY_FAIR_VALUE", "ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07", None, "r",
                    ["gl-1", "fv-2"], 158_750, "deterministic")
    assert adj[6:] == [some(158_750), "deterministic"]
    assert R.propose(7, "RELEVANT", "RELEVANT@SECD-ISS07", None, "r", ["gl-1"], None, "llm")[7] == "llm"
    assert R.propose(7, "RELEVANT", "RELEVANT@SECD-ISS07", None, "r", ["gl-1"], None, "human_text")[7] == "human_text"
    assert R.PROPOSAL_SOURCES == ("deterministic", "llm", "human_text")
    with pytest.raises(ValueError):
        R.propose(7, "RELEVANT", "RELEVANT@SECD-ISS07", None, "r", ["gl-1"], None, "model")
    assert R.ask(7, "why?") == [7, "why?"]
    assert R.answer(7, "because") == [7, "because"]
    assert R.approve(7, "ok") == [7, "ok"]
    assert R.reject(7, "no") == [7, "no"]
    assert R.post(7, "JE-2026-000417") == [7, "JE-2026-000417"]


def test_policy_reducers():
    args = R.propose_policy("vendor:ven-017|acct:6410", 2, "CATERING", "CATERING@SECD-ISS07",
                            {"vendor_id": "ven-017", "account_code": "6410"}, "canteen", ["h-1"], 214,
                            "2026-01-01", None)
    assert args == ["vendor:ven-017|acct:6410", 2, "CATERING", "CATERING@SECD-ISS07",
                    json.dumps({"account_code": "6410", "vendor_id": "ven-017"}, sort_keys=True), "canteen",
                    json.dumps(["h-1"]), 214, "2026-01-01", none(), none(), "[]"]
    # SCHEMA §11.2: parentPolicyId? and cornerstones appended after effectiveTo
    child = R.propose_policy("k/exc", 0, "RELEVANT", "RELEVANT@SECD-ISS07", {"memo_regex": "offsite"}, "r", ["h-1"],
                             3, "2026-01-01", None, 7, [{"ref": "gl-1", "category_code": "RELEVANT"}])
    assert child[10:] == [some(7), json.dumps([{"ref": "gl-1", "category_code": "RELEVANT"}])]
    assert R.approve_policy(4, "ok") == [4, "ok"]


def test_propose_allocations_order_and_encoding():
    args = R.propose_allocations(7, [
        {"basis": "bill_line", "basis_ref": "bl-1", "category_code": "CATERING", "rulebook_entry_id": "CATERING@SECD-ISS07",
         "policy_id": 3, "amount_usd_minor": 600},
        R.allocation("cap_limit_excess", "STAFF_ENTERTAINMENT", "RELEVANT", "RELEVANT@SECD-ISS07", None, 400),
    ], "split", ["gl-1", "bl-1"], "deterministic")
    assert R.PROPOSE_ALLOCATIONS == "proposeAllocations"
    assert args[0] == 7 and args[2:] == ["split", json.dumps(["gl-1", "bl-1"]), "deterministic"]
    # REDUCERS.md: each AllocationInput is a positional array in field order
    assert args[1] == [
        ["bill_line", "bl-1", "CATERING", "CATERING@SECD-ISS07", some(3), 600, none()],
        ["cap_limit_excess", "STAFF_ENTERTAINMENT", "RELEVANT", "RELEVANT@SECD-ISS07", none(), 400, none()]]
    assert R.ALLOCATION_FIELDS == ("basis", "basisRef", "categoryCode", "rulebookEntryId", "policyId",
                                   "amountUsdMinor", "capEffectUsdMinor")
    with pytest.raises(ValueError):
        R.allocation("line", "gl-1", "RELEVANT", "RELEVANT@SECD-ISS07", None, 1)  # 530 in the module
    with pytest.raises(ValueError):
        R.propose_allocations(7, [], "r", [], "model")
    assert R.reject_policy(4, "no") == [4, "no"]


def test_reducer_names_are_schema_names():
    names = {R.BOOTSTRAP_ADMIN, R.CREATE_ROLE_INVITE, R.CLAIM_ROLE, R.SET_SETTING, R.LOAD_RULEBOOK_ENTRY,
             R.LOCK_PERIOD, R.UPSERT_GL_LINE, R.UPSERT_BILL_LINE, R.UPSERT_VENDOR, R.UPSERT_FAIR_VALUE, R.PROPOSE,
             R.ASK, R.ANSWER, R.APPROVE, R.REJECT, R.POST, R.PROPOSE_POLICY, R.APPROVE_POLICY, R.REJECT_POLICY}
    assert names == {"bootstrapAdmin", "createRoleInvite", "claimRole", "setSetting", "loadRulebookEntry",
                     "lockPeriod", "upsertGlLine", "upsertBillLine", "upsertVendor", "upsertFairValue", "propose",
                     "ask", "answer", "approve", "reject", "post", "proposePolicy", "approvePolicy", "rejectPolicy"}
