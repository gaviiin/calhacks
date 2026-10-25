"""Cap Analyst deterministic path (offline): propose with one policy, ask on zero / conflicting."""

import json

from agents import reducers as R
from agents.cap_analyst import CapAnalyst, category_from_text

from .conftest import gl, policy, seed_line, vendor


def _analyst(tools, **kw):
    return CapAnalyst(tools, offline=True, **kw)


def test_one_policy_matches_propose_citing_it(stdb, analyst_tools):
    bl = {"id": "bl-00001-1", "bill_id": "bill-00001", "gl_line_id": "gl-000001", "line_no": 1,
          "description": "Canteen", "amount_minor": 720_000}
    item = seed_line(stdb, gl(bill_id="bill-00001"), vendor(), [bl])
    stdb.tables["policy"].append(policy(id=3, version=1))
    stdb.tables["precedent"].append({"id": 12, "work_item_id": 99, "category_code": "CATERING", "reason": "ok",
                                     "pattern_summary": ""})
    stdb.add_item(id=99, subject_ref="gl-000099", period_key="2025-12", state="APPROVED")
    stdb.tables["gl_line"].append(gl(id="gl-000099", amount_usd_minor=640_000, posted_date="2025-12-10",
                                     period_key="2025-12"))

    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and d.path == "policy"
    assert (d.category_code, d.rulebook_entry_id, d.policy_id) == ("CATERING", "CATERING@SECD-ISS07", 3)
    assert d.reason.startswith("pol-3 v1: Grove Catering is the factory canteen")
    assert d.evidence_refs[:2] == ["gl-000001", "bl-00001-1"]
    assert "prec-12" in d.evidence_refs and "h25-gl-1" in d.evidence_refs
    assert d.result["ok"] and stdb.item(item["id"])["state"] == "PROPOSED"
    (_, name, args), = [c for c in stdb.calls if c[1] == R.PROPOSE]
    assert args[0] == item["id"] and args[3] == {"some": 3} and json.loads(args[5]) == d.evidence_refs
    # SCHEMA §10: no cap effect on an EXCLUDED category; a deterministic proposal says so
    assert args[6] == {"none": []} and args[7] == "deterministic"
    assert stdb.item(item["id"])["proposal_source"] == "deterministic"


def test_no_policy_asks_naming_whats_missing(stdb, analyst_tools):
    item = seed_line(stdb, gl(memo="Offsite lunch, wind tunnel session"), vendor())
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "ask" and d.path == "template"
    assert "No approved policy covers gl-000001" in d.question and "Missing" in d.question
    assert "Grove Catering" in d.question and "6410" in d.question
    assert stdb.item(item["id"])["state"] == "NEEDS_INFO"
    assert not stdb.reducer_calls(R.PROPOSE)


def test_conflicting_policies_ask(stdb, analyst_tools):
    item = seed_line(stdb, gl(), vendor())
    stdb.tables["policy"] += [
        policy(id=3, policy_key="a", pattern={"vendor_id": "ven-001"}),
        policy(id=4, policy_key="b", category_code="RELEVANT", rulebook_entry_id="RELEVANT@SECD-ISS07",
               pattern={"account_code": "6410"}),
    ]
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "ask" and "disagree" in d.question and "pol-3 v1" in d.question and "pol-4 v1" in d.question
    assert stdb.item(item["id"])["state"] == "NEEDS_INFO"


def test_learned_exception_refines_broad_policy(stdb, analyst_tools):
    seed_line(stdb, gl(memo="Offsite lunch, wind tunnel session"), vendor())
    stdb.tables["policy"] += [
        policy(id=3, policy_key="acct:6410", pattern={"account_code": "6410"}),
        policy(id=31, policy_key="corr", category_code="RELEVANT", rulebook_entry_id="RELEVANT@SECD-ISS07",
               pattern={"account_code": "6410", "vendor_id": "ven-001", "memo_regex": "\\boffsite\\b"},
               rationale="Generalised from 3 corrections"),
    ]
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and d.policy_id == 31 and d.category_code == "RELEVANT"
    assert d.reason.startswith("pol-31 v1: Generalised") and "refines" in d.note


def test_agreeing_policies_cite_deepest_then_lowest_id(stdb, analyst_tools):
    # SCHEMA §11.2: agreeing conclusions cite the deepest policy, ties broken by the lowest id
    seed_line(stdb, gl(), vendor())
    stdb.tables["policy"] += [policy(id=3, policy_key="a", pattern={"account_code": "6410"}),
                              policy(id=4, policy_key="b"),
                              policy(id=5, policy_key="c", pattern={"memo_regex": "canteen"}, parent_policy_id=4)]
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and d.policy_id == 5 and d.result["ok"]


def test_unapproved_or_out_of_window_policies_are_ignored(stdb, analyst_tools):
    seed_line(stdb, gl(), vendor())
    stdb.tables["policy"] += [policy(id=3, state="PROPOSED"), policy(id=4, policy_key="z", effective_from="2026-03-01")]
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "ask"


def test_policy_citing_rule_not_in_force_asks(stdb, analyst_tools):
    seed_line(stdb, gl(), vendor())
    stdb.tables["policy"].append(policy(id=3, category_code="RELEVANT", rulebook_entry_id="RELEVANT@ISS22",
                                        effective_from="2025-01-01"))
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "ask" and "not in force" in d.question


def test_material_item_still_proposed_but_flagged(stdb, analyst_tools):
    seed_line(stdb, gl(amount_usd_minor=30_000_000), vendor())
    stdb.tables["policy"].append(policy(id=3))
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and "MATERIAL" in d.reason and "Head of Cost Cap" in d.reason


def test_material_tag_uses_the_absolute_amount(stdb, analyst_tools):
    """Review: the analyst flagged on the signed amount while the module compares |amount|."""
    seed_line(stdb, gl(amount_usd_minor=-30_000_000), vendor())
    stdb.tables["policy"].append(policy(id=3))
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and "MATERIAL" in d.reason and "material" in d.note


# Related party (SCHEMA §10 "Related party"): a GBP line invoiced at 100,000 (= $1,270.00).
def _rp_setup(stdb, fv_rows, amount_minor=100_000, currency="GBP"):
    ven = vendor(id="ven-009", name="Technology Ltd", related_party=True, related_party_entity="Parent group")
    item = seed_line(stdb, gl(id="gl-000050", vendor_id="ven-009", account_code="7300", memo="Q1 engineering recharge",
                              amount_minor=amount_minor, currency=currency, fx_rate_e6=1_270_000,
                              amount_usd_minor=round(amount_minor * 1.27)), ven)
    stdb.tables["fair_value"] += fv_rows
    # a policy that would otherwise classify this at the invoiced value
    stdb.tables["policy"].append(policy(id=8, category_code="RELEVANT", rulebook_entry_id="RELEVANT@SECD-ISS07",
                                        pattern={"vendor_id": "ven-009"}))
    return item


def _fv(id, cv, fv, item="engineering recharge", currency="GBP"):
    return {"id": id, "raw_ref": f"fair_value:{id}:1", "counterparty_vendor_id": "ven-009", "item": item,
            "contract_value_minor": cv, "fair_value_minor": fv, "currency": currency, "effective_from": "2026-01-01",
            "basis": "benchmarked day rates"}


def test_related_party_below_fair_value_proposes_adjustment_with_cap_effect(stdb, analyst_tools):
    item = _rp_setup(stdb, [_fv("fv-005", 100_000, 125_000)])
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and d.path == "related_party"
    assert d.category_code == "ADJ_RELATED_PARTY_FAIR_VALUE"
    assert d.rulebook_entry_id == "ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07"
    assert "fv-005" in d.evidence_refs and "gl-000050" in d.evidence_refs
    # uplift = (fair 125,000 - invoiced 100,000) GBP x 1.27 = $317.50; cap effect = line $1,270.00 + uplift
    assert "+25.0%" in d.reason and "$317.50" in d.reason and "invoiced 100,000 GBP" in d.reason
    assert d.cap_effect_usd_minor == 127_000 + 31_750
    row = stdb.item(item["id"])
    assert row["proposed_category_code"] == "ADJ_RELATED_PARTY_FAIR_VALUE"
    assert row["cap_effect_usd_minor"] == 158_750 and row["proposal_source"] == "deterministic"
    (_, _, args), = stdb.reducer_calls(R.PROPOSE)
    assert args[6] == {"some": 158_750}


def test_related_party_fires_on_fair_value_above_invoiced_not_contract(stdb, analyst_tools):
    """Plant P15: a GBP 665,000 recharge keyed as GBP 66,500; the schedule's contract value (665,000)
    is above its fair value (650,000), so a contract-value comparison never fires. Invoiced does."""
    item = _rp_setup(stdb, [_fv("fv-002", 66_500_000, 65_000_000, "monthly engineering recharge")],
                     amount_minor=6_650_000)
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and d.category_code == "ADJ_RELATED_PARTY_FAIR_VALUE"
    uplift = round((65_000_000 - 6_650_000) * 1.27)
    assert d.cap_effect_usd_minor == round(6_650_000 * 1.27) + uplift
    assert stdb.item(item["id"])["cap_effect_usd_minor"] == d.cap_effect_usd_minor


def test_related_party_ambiguous_fair_value_asks(stdb, analyst_tools):
    _rp_setup(stdb, [_fv("fv-005", 100, 125_000, "wind tunnel hire"), _fv("fv-006", 100, 140_000, "simulator hire")])
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "ask" and "fv-005" in d.question and "fv-006" in d.question


def test_related_party_answer_naming_the_fair_value_item_resolves_ambiguity(stdb, analyst_tools):
    item = _rp_setup(stdb, [_fv("fv-005", 100, 125_000, "wind tunnel hire"), _fv("fv-006", 100, 140_000, "simulator hire")])
    item.update(answer="It is the simulator hire, fv-006.")
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and "fv-006" in d.evidence_refs and d.cap_effect_usd_minor == 127_000 + round(40_000 * 1.27)


def test_related_party_at_or_above_fair_value_uses_normal_path(stdb, analyst_tools):
    _rp_setup(stdb, [_fv("fv-005", 125_000, 100_000)])  # fair value equals the invoiced amount
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and d.policy_id == 8 and d.category_code == "RELEVANT"
    assert d.cap_effect_usd_minor is None


def test_related_party_negative_line_gets_no_uplift(stdb, analyst_tools):
    _rp_setup(stdb, [_fv("fv-005", 100_000, 125_000)], amount_minor=-100_000)  # a credit note
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and d.category_code == "RELEVANT" and d.policy_id == 8


def test_related_party_currency_mismatch_is_a_question_not_a_crash(stdb, analyst_tools):
    item = _rp_setup(stdb, [_fv("fv-005", 100_000, 125_000, currency="EUR")])
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "ask" and d.path == "related_party"
    assert "EUR" in d.question and "GBP" in d.question and "fv-005" in d.question
    assert stdb.item(item["id"])["state"] == "NEEDS_INFO"
    # an empty currency on the schedule row is a mismatch too (review M4)
    stdb2 = stdb
    stdb2.tables["fair_value"][0]["currency"] = ""
    item["state"] = "NEW"
    [d2] = _analyst(analyst_tools).run_once()
    assert d2.action == "ask" and "no currency" in d2.question


def test_related_party_runs_before_the_human_text_path(stdb, analyst_tools):
    """Review H3 / p2 case D: an answer saying 'Relevant' must not talk a below-fair-value line down."""
    item = _rp_setup(stdb, [_fv("fv-005", 100_000, 1_000_000)])
    item.update(answer="Relevant, it is the usual engineering recharge.")
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and d.category_code == "ADJ_RELATED_PARTY_FAIR_VALUE" and d.path == "related_party"


def test_answered_item_uses_the_answer_and_never_reasks(stdb, analyst_tools):
    item = seed_line(stdb, gl(), vendor())
    item.update(answer="Offsite lunch at a wind tunnel session, away from team premises. Relevant.")
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and d.path == "answer" and d.category_code == "RELEVANT"
    assert f"answer:{item['id']}" in d.evidence_refs
    assert d.proposal_source == "human_text" and stdb.item(item["id"])["proposal_source"] == "human_text"


def test_negated_answer_is_not_parsed_into_a_category(stdb, analyst_tools):
    """Review M2: 'Definitely not a catering cost' used to parse as CATERING."""
    item = seed_line(stdb, gl(), vendor())
    item.update(answer="Definitely not a catering cost, it is a sponsor event")
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "skip" and not stdb.reducer_calls(R.PROPOSE) and not stdb.reducer_calls(R.ASK)


def test_adjustment_named_by_human_needs_a_cap_effect(stdb, analyst_tools):
    item = seed_line(stdb, gl(account_code="7900", memo="Heritage parts transfer"), vendor())
    item.update(answer="ADJ_USED_INVENTORY, the parts were raced in 2026.")
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "ask" and "cap effect" in d.question and "ADJ_USED_INVENTORY" in d.question
    # the human names the amount: proposed with that cap effect
    item.update(state="NEW", answer="ADJ_USED_INVENTORY, cap effect $12,500.00 (parts raced in 2026).")
    [d2] = _analyst(analyst_tools).run_once()
    assert d2.action == "propose" and d2.category_code == "ADJ_USED_INVENTORY" and d2.cap_effect_usd_minor == 1_250_000
    assert stdb.item(item["id"])["cap_effect_usd_minor"] == 1_250_000


def test_grant_gross_up_on_a_credit_has_zero_cap_effect(stdb, analyst_tools):
    """SCHEMA §10: a grant / tax credit gross-up on a credit is 0 (the credit does not reduce Relevant Costs)."""
    item = seed_line(stdb, gl(account_code="8100", amount_usd_minor=-138_000_000, memo="Q1 RDEC credit"), vendor())
    item.update(answer="ADJ_GRANT_GROSS_UP")
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "propose" and d.category_code == "ADJ_GRANT_GROSS_UP" and d.cap_effect_usd_minor == 0
    assert stdb.item(item["id"])["cap_effect_usd_minor"] == 0 and "MATERIAL" in d.reason


def test_policy_on_an_adjustment_without_computable_cap_effect_asks(stdb, analyst_tools):
    seed_line(stdb, gl(account_code="7900"), vendor())
    stdb.tables["policy"].append(policy(id=3, category_code="ADJ_USED_INVENTORY",
                                        rulebook_entry_id="ADJ_USED_INVENTORY@SECD-ISS07",
                                        pattern={"account_code": "7900"}))
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "ask" and d.path == "policy_cap_effect" and "pol-3 v1" in d.question


def test_unparseable_answer_offline_is_left_not_reasked(stdb, analyst_tools):
    item = seed_line(stdb, gl(), vendor())
    item.update(answer="ask Sarah in procurement")
    [d] = _analyst(analyst_tools).run_once()
    assert d.action == "skip" and not stdb.reducer_calls(R.ASK)


def test_category_from_text():
    codes = {"RELEVANT", "CATERING", "COMPETITION_TRAVEL", "MARKETING", "FUEL"}
    assert category_from_text("this is competition travel", codes) == "COMPETITION_TRAVEL"
    assert category_from_text("Relevant.", codes) == "RELEVANT"
    assert category_from_text("either marketing or catering", codes) is None
    assert category_from_text(None, codes) is None
    # a sentence with a negation names nothing (SCHEMA §10 / review M2)
    assert category_from_text("not at a Competition, Relevant.", codes) is None
    assert category_from_text("not relevant: catering", codes) is None
    assert category_from_text("Definitely not a catering cost, it is a sponsor event", codes) is None
    assert category_from_text("Don't treat this as catering", codes) is None
    assert category_from_text("It isn't marketing", codes) is None
    # ...but a separate, non-negated sentence still counts, and exact code tokens win over keyword guesses
    assert category_from_text("Not CATERING. Not MARKETING. It is RELEVANT.", codes) == "RELEVANT"
    assert category_from_text("Catering service for the marketing team. Code: CATERING", codes) == "CATERING"
    # FUEL only on the explicit phrase or the code token: road diesel for the trucks is not FIA fuel
    assert category_from_text("Fuel for the transporter trucks, normal road diesel", codes) is None
    assert category_from_text("FIA homologated fuel for the test", codes) == "FUEL"
    assert category_from_text("FUEL", codes) == "FUEL"


def test_amount_from_text():
    from agents.cap_analyst import amount_from_text

    assert amount_from_text("ADJ_USED_INVENTORY, cap effect $12,500.00") == 1_250_000
    assert amount_from_text("cap effect: -$1,250.50") == -125_050
    assert amount_from_text("cap effect 1250000") == 1_250_000  # bare integer = minor units
    assert amount_from_text("USD 12,500 please") == 1_250_000
    assert amount_from_text("costs $100 or $200") is None  # ambiguous
    assert amount_from_text("no amount here") is None and amount_from_text(None) is None


def test_dry_run_calls_nothing(stdb, analyst_tools):
    seed_line(stdb, gl(), vendor())
    stdb.tables["policy"].append(policy(id=3))
    [d] = _analyst(analyst_tools, dry_run=True).run_once()
    assert d.action == "propose" and d.result is None and not stdb.calls


def test_analyst_only_calls_propose_and_ask(stdb, analyst_tools):
    seed_line(stdb, gl(id="gl-1"), vendor())
    seed_line(stdb, gl(id="gl-2", vendor_id="ven-777", amount_usd_minor=5_000, posted_date="2026-01-20"), None)
    stdb.tables["policy"].append(policy(id=3))
    _analyst(analyst_tools).run_once()
    assert {c[1] for c in stdb.calls} <= {R.PROPOSE, R.ASK}
