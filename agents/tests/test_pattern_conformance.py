"""SCHEMA §10 "Patterns": the shared conformance table rulebook/pattern_conformance.json, which the
module's test suite runs too, so the Python and JavaScript matchers cannot drift apart again."""

import json

import pytest

from agents import config
from agents import policy as pol

TABLE = json.loads((config.RULEBOOK_PATH.parent / "pattern_conformance.json").read_text())

# U+212A KELVIN SIGN has a canonical decomposition to "K", so NFKC (which SCHEMA §10 prescribes for
# the memo) turns it into an ASCII K and "kelvin" matches. The table row expecting False contradicts
# the normalisation rule it documents; it is the table that needs fixing (reported to the module team).
_KNOWN_TABLE_DEFECT = {("kelvin", "KELVIN probe")}


@pytest.mark.parametrize("case", TABLE["match_cases"], ids=lambda c: c["why"][:60])
def test_match_cases(case):
    assert pol.memo_matches(case["memo_regex"], case["memo"]) is case["expected"], case["why"]
    assert pol.matches({"memo_regex": case["memo_regex"]}, {"memo": case["memo"]}) is case["expected"]


@pytest.mark.parametrize("case", TABLE["rejected_regexes"], ids=lambda c: c["reason"])
def test_rejected_regexes(case):
    with pytest.raises(pol.PatternError):
        pol.validate_memo_regex(case["memo_regex"])
    with pytest.raises(pol.PatternError):
        pol.parse_pattern({"memo_regex": case["memo_regex"]})
    assert pol.matches({"memo_regex": case["memo_regex"]}, {"memo": "anything canteen"}) is False


@pytest.mark.parametrize("case", TABLE["pattern_acceptance"], ids=lambda c: json.dumps(c["pattern"]))
def test_pattern_acceptance(case):
    if case["accepted"]:
        assert pol.parse_pattern(case["pattern"])
    else:
        with pytest.raises(pol.PatternError):
            pol.parse_pattern(case["pattern"])


def test_memo_is_cut_to_500_code_points_and_astral_chars_never_match():
    assert len(pol.normalize_memo("x" * 900)) == 500
    assert pol.memo_matches("tail", "x" * 500 + " tail") is False  # beyond the cut
    assert pol.memo_matches("tail", "x" * 490 + " tail") is True
    assert pol.memo_matches("canteen", "canteen \U0001F3CE") is False  # astral code point in the memo


def test_nested_quantifier_detector_shapes():
    bad = [r"(a+)+", r"(?:\w+\s?)+canteen", r"(a?b+)*", r"(a{2})+", r"((ab)+)+", r"(x+){2,}"]
    good = [r"(ab)+", r"\b(grand prix|gp)\b", r"a+?b*", r"(?=x)y+", r"[a+]+", r"\(+", r"((a)+)", r"(a){2}"]
    for rx in bad:
        assert pol.has_nested_quantifier(rx), rx
    for rx in good:
        assert not pol.has_nested_quantifier(rx), rx


def test_learner_regexes_pass_the_rules():
    from agents.policy_learner import GP_REGEX

    assert pol.validate_memo_regex(GP_REGEX) == GP_REGEX
    assert pol.memo_matches(GP_REGEX, "Hotel - Monaco Grand Prix") and pol.memo_matches(GP_REGEX, "Flights MONZA gp")
    assert not pol.memo_matches(GP_REGEX, "Hotel - İmola - race team")  # dotted capital I is not ASCII i
    assert pol.validate_memo_regex(r"\boffsite\b")
