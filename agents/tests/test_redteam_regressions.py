"""Regression tests converted from research/review/redteam-repro/p1..p7 (inverted: they assert the
fixed behaviour). Module-side reproductions (RT1-RT17) live with the SpacetimeDB module."""

import json

from agents import policy as pol
from agents import reducers as R
from agents.cap_analyst import CapAnalyst, category_from_text, related_party_check
from agents.gateway import Gateway, build_journal_entry, classification_lines, fair_value_uplift
from agents.policy_learner import GP_REGEX

from .conftest import gl, policy, seed_line, vendor
from .fakes import FakeAnthropic


# ---- p1: regex semantics and ReDoS ----------------------------------------------------------------


def test_p1_unicode_lookalikes_do_not_match_under_ascii_semantics():
    for rx, memo in [(r"\bimola\b", "Hotel - İmola - race team"), (r"silverstone", "Hotel - ſilverstone test"),
                     (r"^\d{4} tyres$", "٢٠٢٦ tyres"), (r"Grove\sCatering", "Grove\x1cCatering canteen"),
                     (GP_REGEX, "Hotel - İmola - race team")]:
        if memo.startswith("Hotel - ſ"):
            # NFKC folds the long s to s on BOTH sides, so this one legitimately matches
            assert pol.matches({"memo_regex": rx}, {"memo": memo}) is True
            continue
        assert pol.matches({"memo_regex": rx}, {"memo": memo}) is False, (rx, memo)
    assert pol.matches({"memo_regex": r"canteen$"}, {"memo": "Factory canteen\n"}) is True  # stripped
    assert pol.matches({"memo_regex": r"\bcatering\b"}, {"memo": "écatering services"}) is True
    assert pol.matches({"memo_regex": r"^.$"}, {"memo": "\U0001F3CE"}) is False


def test_p1_empty_and_all_null_patterns_match_nothing_and_are_rejected():
    for p in ['{"memo_regex": null}', '{"vendor_id": null, "account_code": null}', "{}"]:
        assert pol.matches(p, {"memo": "x", "account_code": "1", "amount_usd_minor": 1}) is False
        try:
            pol.parse_pattern(p)
            assert False, p
        except pol.PatternError:
            pass


def test_p1_catastrophic_backtracking_pattern_is_rejected():
    evil = r"(\w+\s?)+canteen"
    try:
        pol.parse_pattern({"memo_regex": evil})
        assert False
    except pol.PatternError as e:
        assert "quantifier" in str(e)
    assert pol.matches({"memo_regex": evil}, {"memo": "a" * 40 + "!"}) is False  # returns at once


# ---- p2: LLM and human-text paths -----------------------------------------------------------------


def test_p2_f_category_from_text_no_longer_inverts_what_was_said(rulebook):
    codes = {e["category_code"] for e in rulebook}
    assert category_from_text("Definitely not a catering cost, it is a sponsor event", codes) is None
    assert category_from_text("Don't treat this as catering", codes) is None
    assert category_from_text("Fuel for the transporter trucks, normal road diesel", codes) is None
    assert category_from_text("Not CATERING. Not MARKETING. It is RELEVANT.", codes) == "RELEVANT"


def test_p2_b_c_d_e_are_covered_by_the_injection_suite():
    """Cases B (foreign evidence), C (policy_id on an LLM proposal), D (related party before the
    answer) and E (prompt truncation) are tests in test_prompt_injection.py."""
    from . import test_prompt_injection as t

    assert all(hasattr(t, n) for n in ("test_injection_cannot_borrow_evidence_from_another_work_item",
                                       "test_injection_cannot_make_the_model_cite_a_policy",
                                       "test_related_party_check_runs_before_the_answer_is_read",
                                       "test_long_bill_text_cannot_push_structured_facts_out_of_the_prompt"))


# ---- p3: gateway arithmetic -------------------------------------------------------------------------


def _capcat(lines, acct):
    return sum(l["debit_minor"] - l["credit_minor"] for l in lines if l["account_id"] == acct)


def test_p3_b_credit_note_gets_no_uplift():
    fv = {"id": "fv-005", "fair_value_minor": 10_000_000, "contract_value_minor": 1_000_000, "currency": "GBP"}
    credit = gl(amount_usd_minor=-1_270_000, amount_minor=-1_000_000, currency="GBP", fx_rate_e6=1_270_000)
    assert fair_value_uplift(credit, fv) == 0
    assert _capcat(classification_lines("ADJ_RELATED_PARTY_FAIR_VALUE", credit, fv), "capcat-ADJ_RELATED_PARTY_FAIR_VALUE") == 0


def test_p3_b_gateway_books_the_validated_cap_effect_from_the_proposal():
    """The analyst computed amount + uplift at propose time; the gateway books exactly that uplift, so
    the ERP sub-ledger and cap_position agree (SCHEMA §10 defect 4)."""
    line = gl(amount_usd_minor=1_270_000, amount_minor=1_000_000, currency="GBP", fx_rate_e6=1_270_000)
    fv = {"id": "fv-005", "fair_value_minor": 1_250_000, "contract_value_minor": 1_000_000, "currency": "GBP"}
    item = {"id": 5, "kind": "classification", "subject_ref": line["id"], "period_key": "2026-01",
            "proposed_category_code": "ADJ_RELATED_PARTY_FAIR_VALUE",
            "proposed_rulebook_entry_id": "ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07", "reason": "rp",
            "evidence_refs": json.dumps([line["id"], "fv-005"]), "amount_usd_minor": 1_270_000,
            "cap_effect_usd_minor": 1_270_000 + 317_500}
    je = build_journal_entry(item, line, fair_value=fv)
    assert _capcat(je["lines"], "capcat-ADJ_RELATED_PARTY_FAIR_VALUE") == 317_500
    assert _capcat(je["lines"], "capcat-RELEVANT") == 1_270_000
    # a proposal carrying a different validated cap effect wins over recomputation
    je2 = build_journal_entry(dict(item, cap_effect_usd_minor=1_270_000 + 100), line, fair_value=fv)
    assert _capcat(je2["lines"], "capcat-ADJ_RELATED_PARTY_FAIR_VALUE") == 100
    # without a cap effect on the item (older proposal) the gateway falls back to the fair value row
    je3 = build_journal_entry(dict(item, cap_effect_usd_minor=None), line, fair_value=fv)
    assert _capcat(je3["lines"], "capcat-ADJ_RELATED_PARTY_FAIR_VALUE") == 317_500


def test_p3_c_currency_mismatch_is_caught_by_the_analyst_as_a_question(stdb, analyst_tools):
    """Before: the gateway raised on every run and the item sat APPROVED with no trace in the system
    of work. Now the analyst asks before anything is proposed."""
    ven = vendor(id="ven-001", related_party=True)
    item = seed_line(stdb, gl(id="gl-000700", currency="GBP", amount_minor=1_000_000, fx_rate_e6=1_270_000,
                              amount_usd_minor=1_270_000), ven)
    stdb.tables["fair_value"].append({"id": "fv-009", "counterparty_vendor_id": "ven-001", "item": "x",
                                      "contract_value_minor": 1, "fair_value_minor": 2_000_000, "currency": "EUR",
                                      "effective_from": "2026-01-01", "basis": "b"})
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "ask" and "EUR" in d.question and stdb.item(item["id"])["state"] == "NEEDS_INFO"
    assert any(a["action"] == "ask" and a["allowed"] for a in stdb.tables["audit_log"])


def test_p3_a_stale_ledger_from_another_epoch_is_refused(stdb, actors, world, tmp_path):
    """H1: agents/state/gateway_posted.json survives `make stdb-publish`. With the epoch stamp the
    gateway refuses to start and names the file."""
    import pytest

    from agents.epoch import EpochMismatch

    stdb.tables["setting"].append({"key": "db_epoch", "value": "0123456789abcdef"})
    ledger = tmp_path / "gateway_posted.json"
    ledger.write_text(json.dumps({"db_epoch": "fedcba9876543210", "data": {"1": {"erp_entry_id": "JE-OLD", "lines": []}}}))
    with pytest.raises(EpochMismatch, match=str(ledger)):
        Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=ledger)
    # a legacy ledger without an epoch record is refused too (it reads as epoch None)
    legacy = tmp_path / "legacy.json"
    legacy.write_text(json.dumps({"1": {"erp_entry_id": "JE-OLD", "lines": []}}))
    with pytest.raises(EpochMismatch, match="no epoch record"):
        Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=legacy)


def test_p3_a_fresh_ledger_is_stamped_with_the_module_epoch(stdb, actors, world, tmp_path):
    stdb.tables["setting"].append({"key": "db_epoch", "value": "0123456789abcdef"})
    stdb.tables["gl_line"].append(gl())
    stdb.add_item(subject_ref="gl-000001", period_key="2026-01", amount_usd_minor=720_000, state="APPROVED",
                  proposed_category_code="CATERING", proposed_rulebook_entry_id="CATERING@SECD-ISS07",
                  evidence_refs='["gl-000001"]')
    ledger = tmp_path / "gateway_posted.json"
    gw = Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=ledger)
    assert gw.run_once()[0]["status"] == "posted"
    raw = json.loads(ledger.read_text())
    assert raw["db_epoch"] == "0123456789abcdef" and "1" in raw["data"]
    # the same epoch reopens fine and reuses the record
    gw2 = Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=ledger)
    assert gw2.ledger["1"]["erp_entry_id"] == raw["data"]["1"]["erp_entry_id"]


# ---- p5: denial back-off ----------------------------------------------------------------------------


def test_p5_denied_proposal_is_not_retried_the_analyst_asks_naming_the_denial(stdb, analyst_tools):
    stdb.tables["policy"].append(policy(id=1, category_code="RELEVANT", rulebook_entry_id="RELEVANT@SECD-ISS07",
                                        pattern={"vendor_id": "ven-011", "account_code": "6020"}))
    item = seed_line(stdb, gl(id="gl-P25", vendor_id="ven-011", account_code="6020", amount_usd_minor=5_372_100,
                              memo="PO-26-40118 - upright machining (invoice received late)"), vendor(id="ven-011"))
    stdb.tables["period"].append({"key": "2026-01", "locked": True})
    an = CapAnalyst(analyst_tools, offline=True)
    [d1] = an.run_once()  # first attempt: proposed, denied by the module (period locked)
    assert d1.action == "propose" and d1.result["ok"] is False
    denied = [a for a in stdb.tables["audit_log"] if not a["allowed"]]
    assert len(denied) == 1 and "period_locked" in denied[0]["reason"]
    [d2] = an.run_once()  # second run: no re-proposal, a question naming the denial
    assert d2.action == "ask" and d2.path == "denied" and "period_locked" in d2.question and "denied" in d2.question
    assert stdb.item(item["id"])["state"] == "NEEDS_INFO"
    assert len(stdb.reducer_calls(R.PROPOSE)) == 1 and len([a for a in stdb.tables["audit_log"] if not a["allowed"]]) == 1
    assert an.run_once() == []  # nothing NEW left


def test_p5_a_change_to_the_line_after_the_denial_lifts_the_block(stdb, analyst_tools):
    stdb.tables["policy"].append(policy(id=1, category_code="RELEVANT", rulebook_entry_id="RELEVANT@SECD-ISS07",
                                        pattern={"account_code": "6020"}))
    item = seed_line(stdb, gl(id="gl-1", account_code="6020"), vendor())
    stdb.tables["audit_log"].append({"id": 1, "at": 1000, "actor": "x", "actor_role": "ai_cap_analyst", "action": "propose",
                                     "resource_kind": "work_item", "subject_id": str(item["id"]), "allowed": False,
                                     "reason": "period_locked"})
    item["updated_at"] = 2000  # re-synced after the denial (the module reopens / refreshes in place)
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "propose"


# ---- p6: queue starvation ---------------------------------------------------------------------------


def test_p6_items_with_a_denial_history_go_to_the_back_of_the_queue(stdb, analyst_tools):
    stdb.tables["policy"].append(policy(id=1, category_code="RELEVANT", rulebook_entry_id="RELEVANT@SECD-ISS07",
                                        pattern={"account_code": "6020"}))
    stdb.tables["period"].append({"key": "2026-01", "locked": True})
    late = [seed_line(stdb, gl(id=f"gl-late-{k}", account_code="6020", period_key="2026-01", amount_usd_minor=1_000 * k,
                               posted_date=f"2026-01-0{k + 1}"), vendor(id=f"ven-{k}", name=f"Vendor {k}"))
            for k in range(3)]
    fresh = seed_line(stdb, gl(id="gl-feb-1", account_code="6020", period_key="2026-02", posted_date="2026-02-03"),
                      vendor(id="ven-9", name="Fresh Ltd"))
    an = CapAnalyst(analyst_tools, offline=True)
    r1 = an.run_once(limit=3)  # the three late items are tried first (ids 1-3), each denied
    assert [d.work_item_id for d in r1] == [i["id"] for i in late]
    r2 = an.run_once(limit=3)  # now the fresh item (no denial history) comes first
    assert r2[0].work_item_id == fresh["id"] and r2[0].action == "propose"
    assert stdb.item(fresh["id"])["state"] == "PROPOSED"
    assert all(d.action == "ask" and d.path == "denied" for d in r2[1:])


def test_p6_list_queue_orders_oldest_updated_first_after_undenied(stdb, analyst_tools):
    a = stdb.add_item(subject_ref="gl-a", period_key="2026-01", updated_at=300)
    b = stdb.add_item(subject_ref="gl-b", period_key="2026-01", updated_at=100)
    c = stdb.add_item(subject_ref="gl-c", period_key="2026-01", updated_at=50)
    stdb.tables["audit_log"].append({"id": 1, "action": "propose", "resource_kind": "work_item", "subject_id": str(c["id"]),
                                     "allowed": False, "reason": "period_locked"})
    assert [i["id"] for i in analyst_tools.list_queue("NEW", 10)] == [b["id"], a["id"], c["id"]]


# ---- p7: plant P15 -----------------------------------------------------------------------------------


def test_p7_p15_recharge_keyed_at_a_tenth_fires_the_related_party_check():
    """gl-001696: GBP 66,500 invoiced (should have been 665,000); fv-002 contract 665,000 / fair 650,000.
    Fair value is below contract value but far above the invoiced amount."""
    line = gl(id="gl-001696", vendor_id="ven-003", amount_minor=6_650_000, currency="GBP", fx_rate_e6=1_270_000,
              amount_usd_minor=8_445_500, posted_date="2026-06-30", period_key="2026-06")
    ven = vendor(id="ven-003", name="Meridian Technology Ltd", related_party=True)
    fv = {"id": "fv-002", "counterparty_vendor_id": "ven-003", "item": "monthly engineering recharge",
          "contract_value_minor": 66_500_000, "fair_value_minor": 65_000_000, "currency": "GBP",
          "effective_from": "2026-01-01", "basis": "benchmark"}
    rp = related_party_check(line, ven, [fv])
    assert rp.applies and rp.fair_value["id"] == "fv-002"
    assert rp.uplift_usd_minor == round((65_000_000 - 6_650_000) * 1.27) == fair_value_uplift(line, fv)
    # at or above fair value: nothing fires
    assert not related_party_check(dict(line, amount_minor=66_500_000), ven, [fv]).applies
