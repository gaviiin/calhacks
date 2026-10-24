import json

import pytest

from agents import policy as pol

LINE = {"id": "gl-1", "vendor_id": "ven-001", "account_code": "6410", "department_id": "dept-AERO",
        "memo": "Canteen - Silverstone factory, January", "amount_usd_minor": 720_000}
VEN = {"id": "ven-001", "related_party": False}


@pytest.mark.parametrize("pattern,expected", [
    ({"vendor_id": "ven-001"}, True),
    ({"vendor_id": "ven-002"}, False),
    ({"account_code": "6410"}, True),
    ({"account_code": 6410}, True),
    ({"account_code": "6411"}, False),
    ({"department_id": "dept-AERO"}, True),
    ({"department_id": "dept-PU"}, False),
    ({"memo_regex": r"\bCanteen\b"}, True),
    ({"memo_regex": r"\bcanteen\b"}, True),  # always case-insensitive (SCHEMA §10)
    ({"memo_regex": r"(?i)\bCANTEEN\b"}, False),  # inline flags are rejected on both sides
    ({"memo_regex": r"Silverstone"}, True),  # search, not full match
    ({"memo_regex": r"grand prix"}, False),
    ({"related_party": False}, True),
    ({"related_party": True}, False),
    ({"min_amount_usd_minor": 720_000}, True),  # inclusive
    ({"min_amount_usd_minor": 720_001}, False),
    ({"max_amount_usd_minor": 720_000}, True),  # inclusive
    ({"max_amount_usd_minor": 719_999}, False),
    ({"vendor_id": "ven-001", "account_code": "6410", "memo_regex": "canteen"}, True),
    ({"vendor_id": "ven-001", "account_code": "6499"}, False),  # every present key must match
])
def test_each_key(pattern, expected):
    assert pol.matches(pattern, LINE, VEN) is expected
    assert pol.matches(json.dumps(pattern), LINE, VEN) is expected


def test_conservative_cases():
    assert pol.matches({}, LINE, VEN) is False  # empty pattern matches nothing
    assert pol.matches({"vendor": "ven-001"}, LINE, VEN) is False  # unknown key
    assert pol.matches({"memo_regex": "("}, LINE, VEN) is False  # bad regex
    # Python-only syntax the module's JS RegExp cannot compile is rejected
    for bad in (r"(?P<x>Canteen)", r"\ACanteen", r"January\Z", r"(?s)Canteen", r"(?i)(?i)canteen", r"(?<=a)b",
                r"(\w+\s?)+canteen", "x" * 201):
        assert pol.matches({"memo_regex": bad}, LINE, VEN) is False, bad
        with pytest.raises(pol.PatternError):
            pol.parse_pattern({"memo_regex": bad})
    # lookahead and plain groups are fine
    assert pol.matches({"memo_regex": r"(?=.*Silverstone)(Can|Kan)teen"}, LINE, VEN) is True
    assert pol.matches("not json", LINE, VEN) is False
    # related_party needs a vendor row: no row, or no vendor at all, never matches (as in the module)
    assert pol.matches({"related_party": False}, LINE, None) is False
    assert pol.matches({"related_party": False}, dict(LINE, vendor_id=None), None) is False
    assert pol.matches({"related_party": True}, LINE, {"id": "ven-001", "related_party": True}) is True
    # integer strings are accepted for amounts, as the module does
    assert pol.matches({"min_amount_usd_minor": "720000"}, LINE, VEN) is True


def test_parse_pattern_validation():
    with pytest.raises(pol.PatternError):
        pol.parse_pattern({"min_amount_usd_minor": 10, "max_amount_usd_minor": 5})
    with pytest.raises(pol.PatternError):
        pol.parse_pattern({"related_party": "yes"})
    with pytest.raises(pol.PatternError):
        pol.parse_pattern({"min_amount_usd_minor": 1.5})
    assert pol.parse_pattern({"vendor_id": "v", "account_code": None}) == {"vendor_id": "v"}


def test_account_code_derived_from_world_record():
    world_line = {"account_id": "acct-6410", "vendor_id": "ven-001"}
    assert pol.matches({"account_code": "6410"}, world_line, VEN)


def test_in_force():
    e25 = {"effective_from": "2021-01-01", "effective_to": "2025-12-31"}
    e26 = {"effective_from": "2026-01-01", "effective_to": None}
    assert pol.in_force_for_period(e25, "2025-12") and not pol.in_force_for_period(e25, "2026-01")
    assert pol.in_force_for_period(e26, "2026-01") and not pol.in_force_for_period(e26, "2025-12")
    assert pol.in_force_on(e25, "2025-12-31")  # effective_to inclusive
    # the window must cover the WHOLE period (module windowCoversPeriod)
    mid = {"effective_from": "2026-03-15", "effective_to": None}
    assert not pol.in_force_for_period(mid, "2026-03")
    assert pol.in_force_for_period(mid, "2026-04")
    ends = {"effective_from": "2026-01-01", "effective_to": "2026-03-15"}
    assert pol.in_force_for_period(ends, "2026-02") and not pol.in_force_for_period(ends, "2026-03")
    assert pol.in_force(ends, "2026-03-10") and not pol.in_force(ends, "2026-03")
    assert pol.period_bounds("2026-02") == ("2026-02-01", "2026-02-28")
    assert pol.period_bounds("2028-02") == ("2028-02-01", "2028-02-29")


def _p(id, version=1, key="k", state="APPROVED", cat="CATERING", entry="CATERING@SECD-ISS07", pattern=None, **kw):
    return dict({"id": id, "version": version, "policy_key": key, "state": state, "category_code": cat,
                 "rulebook_entry_id": entry, "pattern": json.dumps(pattern or {"vendor_id": "ven-001"}),
                 "effective_from": "2026-01-01", "effective_to": None}, **kw)


def test_matching_policies_filters_state_window_and_versions():
    pols = [
        _p(1, 1, key="a"),
        _p(2, 2, key="a", cat="RELEVANT", entry="RELEVANT@SECD-ISS07"),  # supersedes v1
        _p(3, key="b", state="PROPOSED"),
        _p(4, key="c", effective_from="2026-06-01"),
        _p(5, key="d", pattern={"vendor_id": "ven-999"}),
        _p(6, key="e", effective_to="2025-12-31", effective_from="2025-01-01"),
    ]
    got = pol.matching_policies(pols, LINE, VEN, "2026-01")
    assert [p["id"] for p in got] == [2]


def test_resolve_matches():
    assert pol.resolve_matches([]) == (None, "none")
    one = _p(1)
    assert pol.resolve_matches([one]) == (one, "one")
    broad = _p(2, key="x", pattern={"account_code": "6410"})
    narrow = _p(3, key="y", pattern={"account_code": "6410", "vendor_id": "ven-001"})
    p, why = pol.resolve_matches([broad, narrow])
    assert why == "agreeing" and p["id"] == 3
    other = _p(4, key="z", cat="RELEVANT", entry="RELEVANT@SECD-ISS07", pattern={"vendor_id": "ven-001"})
    assert pol.resolve_matches([broad, other]) == (None, "conflict")  # neither refines the other
    # an exception learned from corrections refines the broad rule: it wins
    exception = _p(5, key="e", cat="RELEVANT", entry="RELEVANT@SECD-ISS07",
                   pattern={"account_code": "6410", "vendor_id": "ven-001", "memo_regex": "offsite"})
    assert pol.resolve_matches([broad, exception]) == (exception, "refinement")
    # it must refine EVERY other match; a third policy it does not refine makes it a conflict again
    memo = _p(6, key="m", cat="MARKETING", entry="MARKETING@SECD-ISS07", pattern={"memo_regex": "lunch"})
    assert pol.resolve_matches([broad, exception, memo]) == (None, "conflict")
    assert pol.refines(exception, broad) and not pol.refines(exception, memo) and not pol.refines(broad, exception)


def test_resolve_matches_with_string_ids():
    # the learner's coverage estimate uses candidate policies keyed by policy_key
    a = _p("acct:6410", key="acct:6410", pattern={"account_code": "6410"})
    b = _p("vendor:ven-001|acct:6410", key="vendor:ven-001|acct:6410",
           pattern={"account_code": "6410", "vendor_id": "ven-001"})
    assert pol.resolve_matches([a, b]) == (b, "agreeing")


def test_entry_valid_for(rulebook):
    by_id = {e["id"]: e for e in rulebook}
    assert pol.entry_valid_for(by_id["CATERING@SECD-ISS07"], "CATERING", "2026-02")[0]
    ok, why = pol.entry_valid_for(by_id["RELEVANT@ISS22"], "RELEVANT", "2026-02")
    assert not ok and "not in force" in why
    assert not pol.entry_valid_for(by_id["CATERING@SECD-ISS07"], "MARKETING", "2026-02")[0]
    # the module requires category == the entry's category, so no RELEVANT-under-an-ADJ-entry
    assert not pol.entry_valid_for(by_id["ADJ_DEPRECIATION_IAS16@SECD-ISS07"], "RELEVANT", "2026-02")[0]
    assert pol.entry_valid_for(by_id["ADJ_DEPRECIATION_IAS16@SECD-ISS07"], "ADJ_DEPRECIATION_IAS16", "2026-02")[0]
    assert pol.entry_valid_for(by_id["CATERING@SECD-ISS07"], "CATERING", "2026-01-01")[0]  # a date
    assert not pol.entry_valid_for(by_id["RELEVANT@ISS22"], "RELEVANT", "2026-01-01")[0]
    assert not pol.entry_valid_for(None, "RELEVANT", "2026-02")[0]
    assert pol.rulebook_entry_in_force(rulebook, "CATERING", "2025-12") is None
    assert pol.rulebook_entry_in_force(rulebook, "RELEVANT", "2025-12")["id"] == "RELEVANT@ISS22"
