"""2025 (ISS22) practice -> 2026 (SECD-ISS07) policy, against the real rulebook.json."""

import pytest

from agents.rule_versions import Nature, Rulebook, map_to_2026


@pytest.fixture(scope="module")
def rb() -> Rulebook:
    return Rulebook.from_file()


def test_catering_relevant_in_2025_becomes_catering_excluded(rb):
    n = Nature(account_code="6410", account_name="Catering & canteen", account_default_category="CATERING",
               vendor_name="Grove Catering", memos=["Canteen Jan", "Canteen Feb"])
    m = map_to_2026("RELEVANT", n, rb, "RELEVANT@ISS22")
    assert m.status == "changed"
    assert (m.category_2026, m.entry_2026_id, m.treatment_2026) == ("CATERING", "CATERING@SECD-ISS07", "EXCLUDED")
    assert "DIFFERS FROM 2025 PRACTICE" in m.explanation and "RELEVANT@ISS22" in m.explanation
    assert "Catering" in m.source


def test_catering_by_account_default_alone(rb):
    # no canteen words anywhere, only master data: still caught by the override via the hint
    n = Nature(account_code="6410", account_name="Hospitality", account_default_category="CATERING")
    assert map_to_2026("RELEVANT", n, rb).category_2026 == "CATERING"


def test_one_stray_memo_does_not_flip_a_group(rb):
    n = Nature(account_code="5100", account_name="Wind tunnel consumables",
               memos=["resin", "carbon", "catering for visitors"] + ["tooling"] * 7)
    m = map_to_2026("RELEVANT", n, rb)
    assert m.status == "same" and m.category_2026 == "RELEVANT"


def test_depreciation_plant_and_equipment_becomes_relevant_under_d6_1_1_k(rb):
    n = Nature(account_code="8100", account_name="Depreciation - plant and machinery")
    m = map_to_2026("DEPRECIATION", n, rb, "DEPRECIATION@ISS22")
    assert m.status == "changed"
    # In 2026 plant & equipment depreciation is simply no longer excluded, so it is a Relevant
    # Cost. D6.1.1.k governs how it is measured (IAS 16 straight line, zero residual); it is an
    # adjustment only when the accounts deviate from that. The world's answer key agrees.
    assert m.category_2026 == "RELEVANT" and m.entry_2026_id == "RELEVANT@SECD-ISS07"
    assert m.treatment_2026 == "RELEVANT"
    assert "inside the cap (Relevant)" in m.explanation and "ADJ_DEPRECIATION_IAS16" in m.explanation


def test_property_depreciation_stays_excluded(rb):
    n = Nature(account_code="8200", account_name="Depreciation - freehold buildings")
    m = map_to_2026("DEPRECIATION", n, rb, "DEPRECIATION@ISS22")
    assert m.status == "same" and m.entry_2026_id == "DEPRECIATION@SECD-ISS07"


def test_unclear_depreciation_is_a_question(rb):
    m = map_to_2026("DEPRECIATION", Nature(account_code="8000", account_name="Depreciation"), rb)
    assert m.status == "ask" and m.category_2026 is None


def test_same_code_carries_forward(rb):
    m = map_to_2026("MARKETING", Nature(account_code="6100", account_name="Sponsorship activation"), rb)
    assert m.status == "same" and m.entry_2026_id == "MARKETING@SECD-ISS07"
    m = map_to_2026("STAFF_ENTERTAINMENT", Nature(account_code="6420", account_name="Staff events"), rb)
    assert m.status == "same" and "limit changes" in m.explanation


@pytest.mark.parametrize("code", ["SICK_COVER", "TERMINATION_2021_22", "ADJ_CAPEX_LIMIT", "ADJ_TERMINATION_REENGAGED",
                                  "ADJ_RDEC_EQUIVALENCE"])
def test_codes_only_in_iss22_become_questions(rb, code):
    assert code in rb.only_in("ISS22")  # read from rulebook.json, not a hard-coded list
    m = map_to_2026(code, Nature(account_code="7000"), rb)
    assert m.status == "ask" and m.category_2026 is None and "re-asked" in m.explanation


def test_grant_gross_up_direction_flip_is_a_question(rb):
    m = map_to_2026("ADJ_GRANT_GROSS_UP", Nature(account_code="4900", account_name="R&D grant income"), rb)
    assert m.status == "ask" and "direction flips" in m.explanation


def test_other_changes_md_rows(rb):
    ss = map_to_2026("RELEVANT", Nature(account_code="7020", account_name="Employer social security"), rb)
    assert ss.category_2026 == "SOCIAL_SECURITY" and ss.status == "changed"
    taxi = map_to_2026("RELEVANT", Nature(account_code="6200", account_name="Ground transport",
                                          memos=["Taxi hotel to circuit, Monaco GP"] * 3), rb)
    assert taxi.category_2026 == "COMPETITION_TRAVEL"
    fine = map_to_2026("RELEVANT", Nature(account_code="6900", account_name="FIA sporting fines"), rb)
    assert fine.category_2026 == "FINES"


def test_generic_new_exclusion_from_master_data(rb):
    n = Nature(account_code="6600", account_name="Site safety", account_default_category="HEALTH_SAFETY")
    m = map_to_2026("RELEVANT", n, rb)
    assert m.status == "changed" and m.entry_2026_id == "HEALTH_SAFETY@SECD-ISS07"
