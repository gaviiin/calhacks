r"""Policy pattern matching and effective-window logic. Pure functions, no I/O.

Pattern (SCHEMA.md §6) is a JSON object with optional keys:

    vendor_id, account_code, department_id      exact string equality
    memo_regex                                  regex SEARCH over the memo, always case-insensitive,
                                                ASCII-only character classes (SCHEMA §10 "Patterns")
    related_party                               bool, compared to the vendor row's related_party;
                                                no vendor row (or no vendor) = no match
    min_amount_usd_minor, max_amount_usd_minor  inclusive bounds on the signed amount_usd_minor
    entity, erp_category_code                   exact string equality (SCHEMA §11.2)
    description_regex                           regex SEARCH over bill line descriptions, same rules
                                                as memo_regex (SCHEMA §11.2): in bill-line context
                                                (an allocation) against that one bill line; for a
                                                whole line, it must match EVERY bill line of the line,
                                                and a line with no bill lines never matches

A line matches when EVERY present key matches. This mirrors `patternMismatches` in
system_of_work/spacetimedb/src/util.ts (the module re-checks every cited policy). Both sides
follow SCHEMA §10: the memo and the regex are NFKC-normalised, the memo is stripped and cut to 500
code points, matching is `re.ASCII | re.IGNORECASE` (JavaScript: no `u` flag, `i`), a pattern needs
at least one non-null key, and a `memo_regex` is rejected when it is longer than 200 characters,
contains inline flags, lookbehind, Python-only syntax, or a quantifier applied to a group that
itself contains a quantifier (catastrophic backtracking). A memo containing characters outside the
Basic Multilingual Plane never matches a regex (JS counts them as two code units, Python as one).
`rulebook/pattern_conformance.json` is the shared conformance table.

Effective windows (rulebook entries and policies): `effective_from` / `effective_to` are inclusive
ISO dates, `effective_to` null = open-ended. An object is in force for a period `YYYY-MM` when its
window covers the WHOLE period (from <= first day, to null or >= last day), as the module's
`windowCoversPeriod` requires.
"""

from __future__ import annotations

import calendar
import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable

PATTERN_KEYS = (
    "vendor_id",
    "account_code",
    "department_id",
    "memo_regex",
    "related_party",
    "min_amount_usd_minor",
    "max_amount_usd_minor",
    "description_regex",
    "entity",
    "erp_category_code",
)

_STR_KEYS = ("vendor_id", "account_code", "department_id", "memo_regex", "description_regex", "entity",
             "erp_category_code")
_REGEX_KEYS = ("memo_regex", "description_regex")
_INT_KEYS = ("min_amount_usd_minor", "max_amount_usd_minor")

MEMO_REGEX_MAX_CHARS = 200
MEMO_MAX_CODE_POINTS = 500
MEMO_REGEX_FLAGS = re.ASCII | re.IGNORECASE

# Syntax the module's JS RegExp cannot compile, or that SCHEMA §10 forbids on both sides.
_PY_ONLY_REGEX = re.compile(r"\(\?P[<=]|\\A|\\Z|\(\?#")
_INLINE_FLAGS = re.compile(r"\(\?[aiLmsux-]+[):]")
_LOOKBEHIND = re.compile(r"\(\?<[=!]")
_QUANT_BRACES = re.compile(r"\{\d+(,\d*)?\}")


class PatternError(ValueError):
    pass


def normalize_memo(memo: str | None) -> str:
    """NFKC, strip surrounding whitespace, cut to MEMO_MAX_CODE_POINTS (SCHEMA §10)."""
    s = unicodedata.normalize("NFKC", memo or "").strip()
    return s[:MEMO_MAX_CODE_POINTS]


def _has_astral(s: str) -> bool:
    return any(ord(ch) > 0xFFFF for ch in s)


def has_nested_quantifier(regex: str) -> bool:
    r"""True when a quantifier is applied to a group that itself contains a quantifier,
    e.g. `(\w+\s?)+` or `(a+)*` (the ReDoS shape SCHEMA §10 rejects)."""
    stack: list[bool] = []  # per open group: does it contain a quantifier so far
    i, n = 0, len(regex)
    in_class = False
    while i < n:
        ch = regex[i]
        if ch == "\\":
            i += 2
            continue
        if in_class:
            if ch == "]":
                in_class = False
            i += 1
            continue
        if ch == "[":
            in_class = True
            i += 1
            continue
        if ch == "(":
            stack.append(False)
            # skip the `?:` / `?=` / `?!` opener so its `?` is not read as a quantifier
            if regex[i + 1: i + 2] == "?":
                i += 2
                while i < n and regex[i] in "=!:<>P":
                    i += 1
                continue
            i += 1
            continue
        if ch == ")":
            had = stack.pop() if stack else False
            i += 1
            m = _QUANT_BRACES.match(regex, i) if i < n and regex[i] == "{" else None
            if i < n and (regex[i] in "*+?" or m):
                if had:
                    return True
                # the quantified group counts as a quantifier for the enclosing group
                if stack:
                    stack[-1] = True
                i = m.end() if m else i + 1
            continue
        quant = ch in "*+?" or (ch == "{" and _QUANT_BRACES.match(regex, i))
        if quant and stack:
            stack[-1] = True
        i += 1
    return False


def validate_memo_regex(src: Any) -> str:
    """Return the NFKC-normalised regex, or raise PatternError (SCHEMA §10 rules)."""
    if not isinstance(src, str):
        raise PatternError("memo_regex must be a string")
    rx = unicodedata.normalize("NFKC", src)
    if not rx.strip():
        raise PatternError("memo_regex is empty")
    if len(rx) > MEMO_REGEX_MAX_CHARS:
        raise PatternError(f"memo_regex is longer than {MEMO_REGEX_MAX_CHARS} characters")
    if _INLINE_FLAGS.search(rx):
        raise PatternError("memo_regex may not use inline flags such as (?i); matching is always case-insensitive")
    if _LOOKBEHIND.search(rx):
        raise PatternError("memo_regex may not use lookbehind")
    if _PY_ONLY_REGEX.search(rx):
        raise PatternError("memo_regex uses Python-only syntax the module (JS RegExp) cannot compile")
    if has_nested_quantifier(rx):
        raise PatternError("memo_regex applies a quantifier to a group that contains a quantifier")
    try:
        re.compile(rx, MEMO_REGEX_FLAGS)
    except re.error as e:
        raise PatternError(f"bad memo_regex: {e}") from e
    return rx


def parse_pattern(p: str | dict | None) -> dict:
    """Parse and validate a pattern (JSON string or dict). Raises PatternError."""
    if p is None:
        raise PatternError("pattern is null")
    if isinstance(p, str):
        try:
            p = json.loads(p)
        except ValueError as e:
            raise PatternError(f"pattern is not JSON: {e}") from e
    if not isinstance(p, dict):
        raise PatternError("pattern must be a JSON object")
    unknown = set(p) - set(PATTERN_KEYS)
    if unknown:
        raise PatternError(f"unknown pattern keys: {sorted(unknown)}")
    out: dict[str, Any] = {}
    for k, v in p.items():
        if v is None:
            continue
        if k in _STR_KEYS:
            if not isinstance(v, (str, int)) or isinstance(v, bool):
                raise PatternError(f"{k} must be a string")
            out[k] = str(v)
        elif k == "related_party":
            if not isinstance(v, bool):
                raise PatternError("related_party must be a bool")
            out[k] = v
        elif k in _INT_KEYS:
            if isinstance(v, str) and re.fullmatch(r"\s*-?\d+\s*", v):
                v = int(v)
            if isinstance(v, bool) or not isinstance(v, int):
                raise PatternError(f"{k} must be an integer (USD minor units)")
            out[k] = v
    for k in _REGEX_KEYS:
        if k in out:
            out[k] = validate_memo_regex(out[k])
    if not out:
        raise PatternError("empty pattern (no keys, or all keys null) would match every line")
    if "min_amount_usd_minor" in out and "max_amount_usd_minor" in out:
        if out["min_amount_usd_minor"] > out["max_amount_usd_minor"]:
            raise PatternError("min_amount_usd_minor > max_amount_usd_minor")
    return out


def pattern_json(p: dict) -> str:
    """Canonical JSON for a pattern (sorted keys) after validation."""
    return json.dumps(parse_pattern(p), sort_keys=True)


def line_account_code(line: dict) -> str | None:
    """account_code of a golden gl_line, or derived from a world record's account_id (acct-6410)."""
    code = line.get("account_code")
    if code not in (None, ""):
        return str(code)
    acct = line.get("account_id")
    if isinstance(acct, str) and acct.startswith("acct-"):
        return acct[len("acct-"):]
    return None


def memo_matches(memo_regex: str, memo: str | None) -> bool:
    """SCHEMA §10 memo matching: normalised memo, ASCII + IGNORECASE search, no astral chars."""
    try:
        rx = validate_memo_regex(memo_regex)
    except PatternError:
        return False
    text = normalize_memo(memo)
    if _has_astral(text):
        return False
    return re.search(rx, text, MEMO_REGEX_FLAGS) is not None


def description_matches(regex: str, line: dict, bill_lines: list[dict] | None = None,
                        bill_line: dict | None = None) -> bool:
    """SCHEMA §11.2 `description_regex`: in bill-line context, that bill line's description; for a
    whole line, every bill line's description (a line with no bill lines never matches)."""
    if bill_line is not None:
        return memo_matches(regex, bill_line.get("description"))
    lines = line.get("bill_lines") if bill_lines is None else bill_lines
    lines = list(lines or [])
    return bool(lines) and all(memo_matches(regex, b.get("description")) for b in lines)


def matches(pattern: str | dict, line: dict, vendor: dict | None = None, *, bill_lines: list[dict] | None = None,
            bill_line: dict | None = None) -> bool:
    """True when every present key of `pattern` matches `line` (and its vendor row).

    `bill_line` given = bill-line context (an allocation): `description_regex` is matched against
    that bill line only. Otherwise `description_regex` must match every one of `bill_lines`
    (default: `line["bill_lines"]`). Every other key is matched against the gl line itself."""
    try:
        p = parse_pattern(pattern)
    except PatternError:
        return False
    if "entity" in p and line.get("entity") != p["entity"]:
        return False
    if "erp_category_code" in p and line.get("erp_category_code") != p["erp_category_code"]:
        return False
    if "description_regex" in p and not description_matches(p["description_regex"], line, bill_lines, bill_line):
        return False
    if "vendor_id" in p and line.get("vendor_id") != p["vendor_id"]:
        return False
    if "account_code" in p and line_account_code(line) != p["account_code"]:
        return False
    if "department_id" in p and line.get("department_id") != p["department_id"]:
        return False
    if "memo_regex" in p:
        if not memo_matches(p["memo_regex"], line.get("memo")):
            return False
    if "related_party" in p:
        if line.get("vendor_id") is None or vendor is None or vendor.get("id") not in (None, line.get("vendor_id")):
            return False  # no vendor row: unknown, never matches (as in the module)
        if bool(vendor.get("related_party")) != p["related_party"]:
            return False
    amount = line.get("amount_usd_minor")
    if "min_amount_usd_minor" in p:
        if amount is None or int(amount) < p["min_amount_usd_minor"]:
            return False
    if "max_amount_usd_minor" in p:
        if amount is None or int(amount) > p["max_amount_usd_minor"]:
            return False
    return True


def specificity(pattern: str | dict) -> int:
    try:
        return len(parse_pattern(pattern))
    except PatternError:
        return 0


# ---- effective windows -------------------------------------------------------------------------


def period_bounds(period_key: str) -> tuple[str, str]:
    """('2026-02-01', '2026-02-28') for '2026-02'."""
    y, m = (int(x) for x in period_key.split("-"))
    last = calendar.monthrange(y, m)[1]
    return f"{y:04d}-{m:02d}-01", f"{y:04d}-{m:02d}-{last:02d}"


def in_force_on(obj: dict, date: str) -> bool:
    """effective_from <= date <= effective_to (inclusive; effective_to None = open)."""
    frm = obj.get("effective_from")
    to = obj.get("effective_to")
    if frm and date < frm:
        return False
    if to and date > to:
        return False
    return True


def in_force_for_period(obj: dict, period_key: str) -> bool:
    """The window covers the whole period (module: windowCoversPeriod)."""
    first, last = period_bounds(period_key)
    return in_force_on(obj, first) and in_force_on(obj, last)


def in_force(obj: dict, period_or_date: str) -> bool:
    """'YYYY-MM' -> whole-period rule; 'YYYY-MM-DD' -> in force on that date."""
    if len(period_or_date) == 7:
        return in_force_for_period(obj, period_or_date)
    return in_force_on(obj, period_or_date)


def period_date(period_key_or_date: str) -> str:
    """Accept 'YYYY-MM' or 'YYYY-MM-DD'; return the period's first day or the date."""
    if len(period_key_or_date) == 7:
        return period_bounds(period_key_or_date)[0]
    return period_key_or_date


# ---- policies ----------------------------------------------------------------------------------


def policy_ref(policy: dict) -> str:
    return f"pol-{policy['id']} v{policy['version']}"


def latest_versions(policies: Iterable[dict]) -> list[dict]:
    """Per policy_key keep only the highest version (a new version supersedes the old one)."""
    best: dict[str, dict] = {}
    for p in policies:
        key = p.get("policy_key") or f"id:{p.get('id')}"
        if key not in best or int(p.get("version", 0)) > int(best[key].get("version", 0)):
            best[key] = p
    return list(best.values())


def matching_policies(policies: Iterable[dict], line: dict, vendor: dict | None, period_key: str) -> list[dict]:
    """APPROVED policies in force for the period whose pattern matches the line.

    Versions are resolved per policy_key first: among APPROVED versions in force for the period,
    the highest wins, then it must match the line.
    """
    eligible = [
        p for p in policies
        if p.get("state") == "APPROVED" and in_force_for_period(p, period_key)
    ]
    return [p for p in latest_versions(eligible) if matches(p.get("pattern"), line, vendor)]


def refines(specific: dict, general: dict) -> bool:
    """True when `specific`'s pattern contains every key/value of `general`'s and more."""
    try:
        s, g = parse_pattern(specific.get("pattern")), parse_pattern(general.get("pattern"))
    except PatternError:
        return False
    return len(s) > len(g) and all(k in s and s[k] == v for k, v in g.items())


def _id_key(p: dict) -> tuple:
    i = p.get("id", 0)
    return (0, int(i), "") if isinstance(i, int) or str(i).isdigit() else (1, 0, str(i))


def resolve_matches(matched: list[dict]) -> tuple[dict | None, str]:
    """Decide what a set of matching policies means.

    Returns (policy, why). `policy` is None when there is nothing to cite:
      - none matched                          -> (None, "none")
      - exactly one                           -> (p, "one")
      - several that agree on category and    -> (most specific, "agreeing")
        rulebook entry
      - several that disagree, but one is a   -> (that one, "refinement")
        strict refinement of all the others      e.g. an exception learned from corrections
        (same keys and values, plus more)        (vendor + account + memo) over an account rule
      - several that disagree otherwise       -> (None, "conflict")
    """
    if not matched:
        return None, "none"
    if len(matched) == 1:
        return matched[0], "one"
    answers = {(p.get("category_code"), p.get("rulebook_entry_id")) for p in matched}
    if len(answers) == 1:
        best = sorted(matched, key=lambda p: (-specificity(p.get("pattern")), _id_key(p)))[0]
        return best, "agreeing"
    refiners = [p for p in matched if all(p is q or refines(p, q) for q in matched)]
    if len(refiners) == 1:
        return refiners[0], "refinement"
    return None, "conflict"


# ---- Ripple-Down Rule resolution (SCHEMA §11.2) -------------------------------------------------


def parent_id(policy: dict) -> Any:
    """parent_policy_id of a policy row, or None (top-level). Accepts SATS-JSON options."""
    v = policy.get("parent_policy_id")
    if isinstance(v, dict) and len(v) == 1:
        v = v.get("some")
    return None if v in (None, "") else v


def _same_id(a: Any, b: Any) -> bool:
    return a is not None and b is not None and str(a) == str(b)


def eligible_policies(policies: Iterable[dict], period_key: str) -> list[dict]:
    """The policies that take part in resolution for a period: APPROVED, in force for the whole
    period, and not superseded by a higher APPROVED version of the same policy_key in force."""
    approved = [p for p in policies if p.get("state") == "APPROVED" and in_force_for_period(p, period_key)]
    return latest_versions(approved)


def _by_id(policies: Iterable[dict]) -> dict[str, dict]:
    return {str(p.get("id")): p for p in policies}


def ancestors(policy: dict, by_id: dict[str, dict]) -> list[dict]:
    """Parent first, then grandparent, ...; stops at a missing parent or a cycle."""
    out: list[dict] = []
    seen = {str(policy.get("id"))}
    cur = policy
    while parent_id(cur) is not None:
        pid = str(parent_id(cur))
        if pid in seen or pid not in by_id:
            if pid not in by_id:
                out.append({"id": pid, "_missing": True})
            break
        seen.add(pid)
        cur = by_id[pid]
        out.append(cur)
    return out


def depth(policy: dict, by_id: dict[str, dict]) -> int:
    return len([a for a in ancestors(policy, by_id) if not a.get("_missing")])


def effective_pattern(policy: dict, by_id: dict[str, dict]) -> dict | None:
    """The conjunction of a policy's own pattern keys and its ancestors' (None if unparsable)."""
    out: dict[str, Any] = {}
    chain = [policy] + [a for a in ancestors(policy, by_id) if not a.get("_missing")]
    for p in reversed(chain):  # root first: a descendant's value wins on the (odd) same key
        try:
            out.update(parse_pattern(p.get("pattern")))
        except PatternError:
            return None
    return out


def strictly_refines(a: dict, b: dict, by_id: dict[str, dict]) -> bool:
    """a's effective pattern is a strict superset of b's, with equal values on b's keys."""
    ea, eb = effective_pattern(a, by_id), effective_pattern(b, by_id)
    if ea is None or eb is None:
        return False
    return len(ea) > len(eb) and all(k in ea and ea[k] == v for k, v in eb.items())


def applies(policy: dict, by_id: dict[str, dict], line: dict, vendor: dict | None = None, *,
            bill_lines: list[dict] | None = None, bill_line: dict | None = None) -> bool:
    """SCHEMA §11.2 "Applies": its own pattern matches and its parent applies (recursively). A
    parent that does not take part (not APPROVED, out of force, superseded, unknown) never applies,
    so neither do its descendants."""
    seen: set[str] = set()
    cur: dict | None = policy
    while cur is not None:
        cid = str(cur.get("id"))
        if cid in seen:
            return False
        seen.add(cid)
        if not matches(cur.get("pattern"), line, vendor, bill_lines=bill_lines, bill_line=bill_line):
            return False
        pid = parent_id(cur)
        if pid is None:
            return True
        cur = by_id.get(str(pid))
    return False


@dataclass
class Resolution:
    """What the policy tree says about one line (or one bill line).

    result: "category" | "none" | "conflict"; `policy` is the one to cite when result is
    "category"; `conclusions` are the applicable policies none of whose applicable children apply."""

    result: str
    policy: dict | None = None
    category_code: str | None = None
    conclusions: list[dict] = field(default_factory=list)
    applicable: list[dict] = field(default_factory=list)
    why: str = ""

    @property
    def rulebook_entry_id(self) -> str | None:
        return (self.policy or {}).get("rulebook_entry_id")


def resolve(policies: Iterable[dict], line: dict, vendor: dict | None, period_key: str, *,
            bill_lines: list[dict] | None = None, bill_line: dict | None = None,
            eligible: list[dict] | None = None) -> Resolution:
    """SCHEMA §11.2 resolution, exactly:

    - only APPROVED, in-force, non-superseded policies take part;
    - a policy applies when its pattern matches and its parent applies (recursively);
    - conclusions = applicable policies none of whose applicable approved children apply;
    - one conclusion, or several that agree on category -> that category, citing the deepest
      (ties: lowest id);
    - several that disagree -> the one that strictly refines ALL the others (effective pattern =
      own keys + ancestors' keys, strict superset with equal values), else conflict.

    `bill_line` given = resolve for that one bill line (allocation context)."""
    pols = eligible if eligible is not None else eligible_policies(policies, period_key)
    by_id = _by_id(pols)
    kw = {"bill_lines": bill_lines, "bill_line": bill_line}
    applicable = [p for p in pols if applies(p, by_id, line, vendor, **kw)]
    app_ids = {str(p.get("id")) for p in applicable}
    conclusions = [p for p in applicable
                   if not any(_same_id(parent_id(c), p.get("id")) and str(c.get("id")) in app_ids for c in applicable)]
    conclusions.sort(key=_id_key)
    if not conclusions:
        return Resolution("none", why="none", applicable=applicable)
    cats = {p.get("category_code") for p in conclusions}
    if len(cats) == 1:
        best = sorted(conclusions, key=lambda p: (-depth(p, by_id), _id_key(p)))[0]
        why = "one" if len(conclusions) == 1 else "agreeing"
        return Resolution("category", best, best.get("category_code"), conclusions, applicable, why)
    refiners = [p for p in conclusions if all(p is q or strictly_refines(p, q, by_id) for q in conclusions)]
    if len(refiners) == 1:
        p = refiners[0]
        return Resolution("category", p, p.get("category_code"), conclusions, applicable, "refinement")
    return Resolution("conflict", None, None, conclusions, applicable, "conflict")


def applying_children(policy: dict, policies: Iterable[dict], line: dict, vendor: dict | None, period_key: str,
                      *, bill_lines: list[dict] | None = None, bill_line: dict | None = None) -> list[dict]:
    """Approved, in-force children of `policy` that apply to the line (the module's
    `exception_applies` check)."""
    pols = eligible_policies(policies, period_key)
    by_id = _by_id(pols)
    return [c for c in pols if _same_id(parent_id(c), policy.get("id"))
            and applies(c, by_id, line, vendor, bill_lines=bill_lines, bill_line=bill_line)]


def tree_lines(policies: Iterable[dict]) -> list[str]:
    """A policy tree as indented text lines (for reports): `pol-3 v1 acct:6420 -> MARKETING`."""
    pols = list(policies)
    by_id = _by_id(pols)
    kids: dict[str, list[dict]] = {}
    roots = []
    for p in pols:
        pid = parent_id(p)
        if pid is None or str(pid) not in by_id:
            roots.append(p)
        else:
            kids.setdefault(str(pid), []).append(p)
    out: list[str] = []

    def walk(p: dict, level: int) -> None:
        n = len(json.loads(p.get("cornerstones") or "[]")) if isinstance(p.get("cornerstones"), str) \
            else len(p.get("cornerstones") or [])
        out.append(f"{'  ' * level}- {p.get('policy_key')} -> {p.get('category_code')} ({n} cornerstones)")
        for c in sorted(kids.get(str(p.get("id")), []), key=_id_key):
            walk(c, level + 1)

    for r in sorted(roots, key=_id_key):
        walk(r, 0)
    return out


# ---- rulebook ----------------------------------------------------------------------------------


def rulebook_entry_in_force(rulebook: Iterable[dict], category_code: str, when: str) -> dict | None:
    """The rulebook entry for `category_code` in force for a period ('YYYY-MM', whole period) or on
    a date ('YYYY-MM-DD'), if any."""
    for e in rulebook:
        if e.get("category_code") == category_code and in_force(e, when):
            return e
    return None


def entry_valid_for(entry: dict | None, category_code: str, when: str) -> tuple[bool, str]:
    """Check a cited rulebook entry the way the module's `rulebook_invalid` rule does: it exists,
    its category_code equals the proposed category, and it is in force for the whole period (or on
    the date, for a policy's effective_from)."""
    if entry is None:
        return False, "unknown rulebook_entry_id"
    if entry.get("category_code") != category_code:
        return False, f"{entry['id']} is for category {entry.get('category_code')}, not {category_code}"
    if not in_force(entry, when):
        span = "for the whole period" if len(when) == 7 else "on"
        return False, f"{entry['id']} is not in force {span} {when}"
    return True, "ok"
