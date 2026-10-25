"""Checks on rulebook/rulebook.json. Rebuild first: uv run python -m rulebook.build_rulebook"""

import json
from pathlib import Path

import pytest

RB_PATH = Path(__file__).resolve().parents[1] / "rulebook.json"

# From SCHEMA.md section 4.
BOTH = {
    "RELEVANT", "MARKETING", "F1_DRIVER", "OTHER_DRIVER_ACADEMY", "EXCLUDED_PERSONS", "HERITAGE",
    "FINANCE_COSTS", "CORP_TAX", "NON_F1", "HR_FINANCE_LEGAL", "PROPERTY", "BONUS", "FIA_FEES",
    "FINES", "PU_SUPPLY", "DEPRECIATION", "FX", "SOCIAL_SECURITY", "COMPETITION_TRAVEL",
    "ALT_FUEL_DEV", "STAFF_ENTERTAINMENT", "PARENTAL_LEAVE", "INDEFINITE_SICK", "SUSTAINABILITY",
}
ISS22_ONLY = {"SICK_COVER", "TERMINATION_2021_22"}
SECD_ONLY = {"FUEL", "HEALTH_SAFETY", "CATERING", "BCDR"}
REQUIRED_ADJUSTMENTS = {"ADJ_RELATED_PARTY_FAIR_VALUE", "ADJ_GRANT_GROSS_UP", "ADJ_USED_INVENTORY"}
# 2026 replaced the separate capex limit with depreciation inside Relevant Costs (IAS 16).
ADJ_ISS22_ONLY = {"ADJ_CAPEX_LIMIT", "ADJ_TERMINATION_REENGAGED", "ADJ_RDEC_EQUIVALENCE"}
ADJ_SECD_ONLY = {"ADJ_DEPRECIATION_IAS16", "ADJ_PE_CLAWBACK", "ADJ_IMPAIRMENT_CLAWBACK",
                 "ADJ_UNUSED_CAP_CARRYFORWARD", "ADJ_CONSIDERATION_FACTOR", "ADJ_PU_INTEGRATION_2027_28"}
FIELDS = {"id", "category_code", "treatment", "rule_version", "article", "effective_from", "effective_to", "title", "text", "cap_limit_usd_minor"}
FURNITURE = ["Formula 1 Financial Regulations", "©", "SECTION D:", "=== PAGE", "Fédération"]


@pytest.fixture(scope="module")
def rb():
    return json.loads(RB_PATH.read_text(encoding="utf-8"))


def codes(rb, version):
    return {e["category_code"] for e in rb if e["rule_version"] == version}


def test_fields_and_unique_ids(rb):
    assert all(set(e) == FIELDS for e in rb)
    ids = [e["id"] for e in rb]
    assert len(ids) == len(set(ids))
    assert all(e["id"] == f'{e["category_code"]}@{e["rule_version"]}' for e in rb)


def test_category_coverage_matches_schema(rb):
    iss22, secd = codes(rb, "ISS22"), codes(rb, "SECD-ISS07")
    assert BOTH <= iss22 and BOTH <= secd
    assert ISS22_ONLY <= iss22 and not (ISS22_ONLY & secd)
    assert SECD_ONLY <= secd and not (SECD_ONLY & iss22)
    assert REQUIRED_ADJUSTMENTS <= iss22 and REQUIRED_ADJUSTMENTS <= secd
    assert ADJ_ISS22_ONLY <= iss22 and not (ADJ_ISS22_ONLY & secd)
    assert ADJ_SECD_ONLY <= secd and not (ADJ_SECD_ONLY & iss22)


def test_catering_is_the_headline_rule_change(rb):
    """Catering sat inside the cap through 2025 and is excluded from 2026."""
    secd = {e["category_code"]: e for e in rb if e["rule_version"] == "SECD-ISS07"}
    assert secd["CATERING"]["article"] == "D5.1.1.z"
    assert "catering services" in secd["CATERING"]["text"]
    assert not any("catering" in e["text"].lower() for e in rb if e["rule_version"] == "ISS22")


def test_effective_windows_do_not_overlap(rb):
    by_code: dict[str, list[tuple[str, str]]] = {}
    for e in rb:
        by_code.setdefault(e["category_code"], []).append((e["effective_from"], e["effective_to"] or "9999-12-31"))
    for code, windows in by_code.items():
        windows.sort()
        for (_, end), (start, _) in zip(windows, windows[1:]):
            assert end < start, code


def test_treatments(rb):
    for e in rb:
        if e["category_code"] == "RELEVANT":
            assert e["treatment"] == "RELEVANT"
        elif e["category_code"].startswith("ADJ_"):
            assert e["treatment"] == "ADJUSTMENT"
        else:
            assert e["treatment"] == "EXCLUDED"


def test_text_is_clean_and_nonempty(rb):
    for e in rb:
        assert len(e["text"]) >= 15, e["id"]
        for junk in FURNITURE:
            assert junk not in e["text"], (e["id"], junk)


def test_cap_limits(rb):
    by_id = {e["id"]: e for e in rb}
    assert by_id["STAFF_ENTERTAINMENT@SECD-ISS07"]["cap_limit_usd_minor"] == 120_000_000
    assert by_id["STAFF_ENTERTAINMENT@ISS22"]["cap_limit_usd_minor"] == 100_000_000
    assert by_id["BCDR@SECD-ISS07"]["cap_limit_usd_minor"] == 150_000_000
    assert by_id["BONUS@SECD-ISS07"]["cap_limit_usd_minor"] == 1_200_000_000
    assert by_id["PU_SUPPLY@SECD-ISS07"]["cap_limit_usd_minor"] is None  # EUR limit, redline unresolved
