"""SCHEMA §11.2: the shared Ripple-Down Rule cases in rulebook/rdr_conformance.json, which the
module's suite runs too, plus the new pattern keys."""

import json

import pytest

from agents import config
from agents import policy as pol

TABLE = json.loads((config.RULEBOOK_PATH.parent / "rdr_conformance.json").read_text())


def _policies(case):
    return [dict(p, pattern=json.dumps(p["pattern"])) for p in case["policies"]]


@pytest.mark.parametrize("case", TABLE["cases"], ids=lambda c: c["name"])
def test_rdr_case(case):
    line = case["line"]
    ctx = case.get("context") or {}
    bill_line = None
    if ctx.get("bill_line_id"):
        bill_line = next(b for b in line["bill_lines"] if b["id"] == ctx["bill_line_id"])
    res = pol.resolve(_policies(case), line, None, case["period"], bill_line=bill_line)
    exp = case["expected"]
    assert res.result == exp["result"], (res.why, [p["id"] for p in res.conclusions])
    if exp["result"] == "category":
        assert res.category_code == exp["category_code"]
        assert res.policy["id"] == exp["policy_id"]


def test_applying_children_names_the_exception():
    case = next(c for c in TABLE["cases"] if c["name"] == "exception child overrides parent")
    pols = _policies(case)
    kids = pol.applying_children(pols[0], pols, case["line"], None, case["period"])
    assert [k["id"] for k in kids] == [2]


def test_new_pattern_keys():
    line = {"entity": "RACING", "erp_category_code": "MARKETING", "memo": "x",
            "bill_lines": [{"id": "b1", "description": "Factory canteen"}, {"id": "b2", "description": "Canteen drinks"}]}
    assert pol.matches({"entity": "RACING"}, line) and not pol.matches({"entity": "TECHNOLOGY"}, line)
    assert pol.matches({"erp_category_code": "MARKETING"}, line)
    assert pol.matches({"description_regex": r"\bcanteen\b"}, line)  # every bill line
    assert not pol.matches({"description_regex": "factory"}, line)
    assert pol.matches({"description_regex": "factory"}, line, bill_line=line["bill_lines"][0])
    assert not pol.matches({"description_regex": "canteen"}, dict(line, bill_lines=[]))
    with pytest.raises(pol.PatternError):
        pol.parse_pattern({"description_regex": "(a+)+"})


def test_parent_out_of_play_disables_children():
    parent = {"id": 1, "policy_key": "p", "version": 1, "state": "PROPOSED", "category_code": "CATERING",
              "pattern": json.dumps({"account_code": "6410"}), "effective_from": "2026-01-01", "effective_to": None}
    child = dict(parent, id=2, policy_key="c", state="APPROVED", category_code="RELEVANT", parent_policy_id=1,
                 pattern=json.dumps({"memo_regex": "offsite"}))
    res = pol.resolve([parent, child], {"account_code": "6410", "memo": "offsite lunch"}, None, "2026-01")
    assert res.result == "none"


def test_tree_lines():
    pols = [{"id": 1, "policy_key": "acct:6420", "category_code": "MARKETING", "cornerstones": "[{}, {}]"},
            {"id": 2, "policy_key": "acct:6420/canteen", "category_code": "CATERING", "parent_policy_id": 1,
             "cornerstones": "[{}]"}]
    assert pol.tree_lines(pols) == ["- acct:6420 -> MARKETING (2 cornerstones)",
                                    "  - acct:6420/canteen -> CATERING (1 cornerstones)"]
