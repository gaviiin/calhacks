"""Policy Learner. Identity: policy_learner (role ai_policy_learner).

May: read the system of work and the 2025 history in the world API, and `proposePolicy`.
May not: approve anything (the Head of Cost Cap approves policies), touch work items or records.

--onboard          mine the 2025 history (gl lines, and bill lines with their own classification
                   when history_2025_bill_line[_classification] exist) deterministically: groups by
                   (vendor_id, account_code), by account_code, by (account_code, department_id), by
                   memo keywords (Grand Prix / circuit names), and by department with
                   --department-policies. Every 2025 case is mapped to its own 2026 answer
                   (agents/rule_versions.py: CHANGES.md overrides incl. offsite catering, social
                   security and the 2026 bonus definition, new exclusions, same code, or ask), so
                   consistency is judged in 2026 terms. Exceptions become Ripple-Down Rule children
                   (SCHEMA §11.2): a discriminator (memo word, department, bill line description
                   word, entity; the account under a parent that does not pin one) covering >= 3
                   exceptions with one 2026 answer and matching none of the parent's own cases (the
                   cornerstone check, client-side, against history the module does not hold). A
                   group is a candidate at >= 10 cases, >= 70% right as a parent and >= 95% after its
                   children. Parents are proposed first with a sample of their cases as cornerstones,
                   then children with parentPolicyId and their exception cases as cornerstones. The
                   report (agents/out/onboarding_report.md) shows the tree.
--from-corrections scan precedents where a human rejected (or answered) with a category, group
                   alike (>= 3). Rejections of a line a policy decided become a CHILD of that policy
                   (cornerstones = the corrected lines); the rest a top-level policy, as before.
--offline          template rationales. Online, Claude writes the rationale and judges whether the
                   pattern generalises (structured output); the category and rule version stay code.

Usage:
  uv run python -m agents.policy_learner --onboard [--offline] [--dry-run]
  uv run python -m agents.policy_learner --from-corrections [--offline] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from pydantic import BaseModel

from . import config, identities, llm
from . import policy as pol
from .cap_analyst import category_from_text, fmt_usd, sim_date_or_unknown
from .recorder import NullRecorder, Recorder, digest, model_call_output
from .rule_versions import NEW_DATE, Nature, Rulebook, VersionMapping, map_to_2026
from .stdb import StdbClient
from .tools import AgentTools
from .world_client import WorldClient

log = logging.getLogger("agents.policy_learner")

MIN_PRECEDENTS = 10
MIN_CONSISTENCY = 0.95
MIN_ALIKE_CORRECTIONS = 3

# Race and circuit names (not nationalities: "British" would catch British Airways). Matching is
# always case-insensitive and ASCII-only on both sides (SCHEMA §10), no inline flags, <= 200 chars.
GP_REGEX = (
    r"\b(grand prix|gp|sakhir|bahrain|jeddah|melbourne|suzuka|shanghai|miami|imola|monaco|barcelona|montreal|"
    r"spielberg|silverstone|hungaroring|zandvoort|monza|baku|singapore|austin|interlagos|lusail)\b"
)
assert len(GP_REGEX) <= pol.MEMO_REGEX_MAX_CHARS, len(GP_REGEX)
_GP = re.compile(GP_REGEX, pol.MEMO_REGEX_FLAGS)


# ---- history -------------------------------------------------------------------------------------


@dataclass
class History:
    gl_lines: list[dict]
    classifications: dict[str, list[dict]]  # gl_line_id -> classification rows (several = a split)
    approvals: dict[str, dict]  # gl_line_id -> approval
    accounts: dict[str, dict]  # account code -> account
    vendors: dict[str, dict]  # vendor id -> vendor
    # gl_line_id -> its 2025 bill lines, each carrying its own classification (category_code,
    # rulebook_entry_id) when history_2025_bill_line_classification has one (SCHEMA §11.2 (c))
    bill_lines: dict[str, list[dict]] = field(default_factory=dict)

    def joined(self) -> list[tuple[dict, dict]]:
        """Lines with exactly one classification. Split lines (e.g. payroll split by department
        F1 share) cannot be expressed as a single-category policy; see split_lines()."""
        return [(g, self.classifications[g["id"]][0]) for g in self.gl_lines
                if len(self.classifications.get(g["id"], [])) == 1]

    def split_lines(self) -> list[tuple[dict, list[dict]]]:
        return [(g, self.classifications[g["id"]]) for g in self.gl_lines
                if len(self.classifications.get(g["id"], [])) > 1 and not self._fully_classified_bills(g["id"])]

    def _fully_classified_bills(self, gl_id: str) -> bool:
        bls = self.bill_lines.get(gl_id) or []
        return bool(bls) and all(b.get("category_code") for b in bls)

    def cases(self) -> list["Case"]:
        """The 2025 decisions as cases: one per bill line when every bill line of the gl line carries
        its own classification (so a mixed invoice teaches each of its parts), else one per gl line
        with exactly one classification. Split payroll lines (department shares) are left out."""
        out: list[Case] = []
        for g in self.gl_lines:
            line = dict(g, account_code=pol.line_account_code(g), bill_lines=self.bill_lines.get(g["id"]) or [])
            if self._fully_classified_bills(g["id"]):
                for b in line["bill_lines"]:
                    out.append(Case(f"history_2025_bill_line:{b['id']}", line, b, b["category_code"],
                                    b.get("rulebook_entry_id"), gl_id=g["id"]))
            elif len(self.classifications.get(g["id"], [])) == 1:
                c = self.classifications[g["id"]][0]
                out.append(Case(f"history_2025_gl_line:{g['id']}", line, None, c["category_code"],
                                c.get("rulebook_entry_id"), gl_id=g["id"]))
        return out


def _optional_records(world: WorldClient, source: str) -> list[dict]:
    try:
        return world.all_records(source)
    except Exception:  # an optional source the world does not serve
        return []


def load_history(world: WorldClient) -> History:
    gl = world.all_records("history_2025_gl_line")
    cls: dict[str, list[dict]] = defaultdict(list)
    for c in sorted(world.all_records("history_2025_cap_classification"), key=lambda c: c["id"]):
        cls[c["gl_line_id"]].append(c)
    appr = {a["gl_line_id"]: a for a in _optional_records(world, "history_2025_approval")}
    accounts = {}
    for a in world.all_records("account"):
        accounts[str(a.get("code") or pol.line_account_code({"account_id": a["id"]}))] = a
    vendors = {v["id"]: v for v in world.all_records("vendor")}
    # bill-line history (optional): history_2025_bill_line + history_2025_bill_line_classification
    # (rows keyed by bill_line_id; a classification carried inline on the bill line also works)
    bill_cls = {c.get("bill_line_id") or c.get("id"): c
                for c in _optional_records(world, "history_2025_bill_line_classification")}
    bills: dict[str, list[dict]] = defaultdict(list)
    for b in _optional_records(world, "history_2025_bill_line"):
        if not b.get("gl_line_id"):
            continue
        c = bill_cls.get(b["id"]) or {}
        row = dict(b)
        for k in ("category_code", "rulebook_entry_id", "reason"):
            if c.get(k) is not None:
                row[k] = c[k]
        bills[b["gl_line_id"]].append(row)
    for v in bills.values():
        v.sort(key=lambda b: int(b.get("line_no", 0)))
    return History(gl, cls, appr, accounts, vendors, dict(bills))


# ---- candidates ----------------------------------------------------------------------------------


@dataclass
class Case:
    """One 2025 decision: a gl line, or one bill line of it (bill-line context)."""

    ref: str  # history_2025_gl_line:<id> | history_2025_bill_line:<id> (a cornerstone ref)
    line: dict  # the history gl line, with account_code and its bill_lines
    bill_line: dict | None
    cat25: str
    entry25: str | None
    gl_id: str = ""
    cat26: str | None = None  # 2026 answer for this one case (None: ask)
    entry26: str | None = None
    mapping: VersionMapping | None = None

    @property
    def text(self) -> str:
        return (self.bill_line or {}).get("description") or self.line.get("memo") or ""

    def matches(self, pattern: dict, vendors: dict[str, dict]) -> bool:
        return pol.matches(pattern, self.line, vendors.get(self.line.get("vendor_id")), bill_line=self.bill_line)


@dataclass
class Candidate:
    policy_key: str
    kind: str  # vendor_account | account | account_department | memo | department | exception | rule_version | correction
    pattern: dict
    description: str
    category_2025: str
    entry_2025_id: str | None
    precedent_count: int
    consistency: float
    exceptions: list[str]
    evidence_refs: list[str]
    nature: Nature
    mapping: VersionMapping | None = None
    rationale: str = ""
    escalated: int = 0
    llm_concerns: str | None = None
    result: dict | None = None
    effective_from: str = NEW_DATE
    # Ripple-Down Rules (SCHEMA §11.2)
    cornerstones: list[dict] = field(default_factory=list)  # [{"ref", "category_code"}]
    children: list["Candidate"] = field(default_factory=list)
    parent: "Candidate | None" = None
    parent_policy_id: int | None = None  # for a child proposed under an existing policy
    residual_consistency: float | None = None
    majority_refs: list[str] = field(default_factory=list)  # every majority case (cornerstone check)

    @property
    def proposable(self) -> bool:
        return self.mapping is not None and self.mapping.status in ("same", "changed") and not self.llm_concerns

    def policy_like(self) -> dict:
        """As a policy row, for coverage estimation and tree checks (ids are policy keys)."""
        m = self.mapping
        return {"id": self.policy_key, "policy_key": self.policy_key, "version": 1, "state": "APPROVED",
                "category_code": m.category_2026 if m else None, "rulebook_entry_id": m.entry_2026_id if m else None,
                "pattern": json.dumps(self.pattern), "effective_from": self.effective_from, "effective_to": None,
                "parent_policy_id": self.parent.policy_key if self.parent is not None else None,
                "cornerstones": json.dumps(self.cornerstones)}

    def tree(self) -> list["Candidate"]:
        out = [self]
        for c in self.children:
            out += c.tree()
        return out


def _group_stats(rows: list[Case]) -> tuple[str, str | None, float, list[str], list[str]]:
    counts = Counter(c.cat25 for c in rows)
    modal, n = counts.most_common(1)[0]
    entries = Counter(c.entry25 for c in rows if c.cat25 == modal)
    entry = entries.most_common(1)[0][0] if entries else None
    exceptions = [c.gl_id for c in rows if c.cat25 != modal]
    sample = [c.gl_id for c in rows if c.cat25 == modal][:10]
    return modal, entry, n / len(rows), list(dict.fromkeys(exceptions)), list(dict.fromkeys(sample))


MIN_PARENT_SHARE = 0.70  # a parent must itself be right on this share of its lines, before exceptions
MAX_CORNERSTONES = 50
_STOP = {"with", "from", "for", "the", "and", "invoice", "inv", "ltd", "limited", "services", "costs", "cost",
         "week", "payroll", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}
_WORD = re.compile(r"[a-z]+")


def _tokens(text: str) -> list[tuple[str, str, int]]:
    """(label, regex, position) for every word (>= 4 letters) and adjacent word pair in a text."""
    words = [w for w in _WORD.findall(unicodedata.normalize("NFKC", text or "").lower())]
    out = []
    for i, w in enumerate(words):
        if len(w) >= 4 and w not in _STOP:
            out.append((w, rf"\b{w}\b", i))
        if i + 1 < len(words) and len(w) >= 3 and len(words[i + 1]) >= 3 and not {w, words[i + 1]} & _STOP:
            out.append((f"{w} {words[i + 1]}", rf"\b{w}\s+{words[i + 1]}\b", i))
    return out


def _discriminators(parent_pattern: dict, cases: list[Case]) -> list[tuple[tuple, str, dict, str]]:
    """Candidate child patterns for a group of exception cases: (sort key, kind, pattern, label).
    Lower sort key = preferred on equal coverage: the account first under a parent that does not
    pin one (a rule keyed on the account's nature, e.g. social security), then memo tokens,
    department, bill line description tokens, entity; single words before word pairs; words that
    come early in the text (the line's kind) before later ones."""
    out: list[tuple[tuple, str, dict, str]] = []
    if "account_code" not in parent_pattern:
        for a in sorted({str(c.line.get("account_code")) for c in cases if c.line.get("account_code")}):
            out.append(((0, 0, 0.0, a), "account", {"account_code": a}, f"account {a}"))
    for kind, prio, texts in (("memo", 1, lambda c: c.line.get("memo") or ""),
                              ("description", 3, lambda c: (c.bill_line or {}).get("description") or "")):
        if kind == "description" and not any(c.bill_line for c in cases):
            continue
        pos: dict[str, list[int]] = defaultdict(list)
        rx: dict[str, str] = {}
        for c in cases:
            seen = set()
            for label, r, p in _tokens(texts(c)):
                if label not in seen:
                    seen.add(label)
                    pos[label].append(p)
                    rx[label] = r
        for label, ps in pos.items():
            key = "memo_regex" if kind == "memo" else "description_regex"
            out.append(((prio, label.count(" "), sum(ps) / len(ps), label), kind, {key: rx[label]},
                        f"{'memo' if kind == 'memo' else 'description'} '{label}'"))
    if "department_id" not in parent_pattern:
        for d in sorted({c.line.get("department_id") for c in cases if c.line.get("department_id")}):
            out.append(((2, 0, 0.0, d), "department", {"department_id": d}, f"department {d}"))
    if "entity" not in parent_pattern:
        for e in sorted({c.line.get("entity") for c in cases if c.line.get("entity")}):
            out.append(((4, 0, 0.0, e), "entity", {"entity": e}, f"entity {e}"))
    return out


def discover_children(parent_pattern: dict, parent_cat25: str, majority: list[Case], exceptions: list[Case],
                      vendors: dict[str, dict], min_cover: int = 3) -> list[tuple[str, dict, str, list[Case], bool]]:
    """RDR exceptions for one parent: group the exception cases by their 2026 answer and, greedily,
    find a discriminator that covers at least `min_cover` of them and matches NONE of the parent's
    majority cases and no exception with another answer (the cornerstone check, client-side,
    against history the module does not hold). A rule-version exception (same 2025 answer as the
    parent, a different 2026 answer: social security under a department rule) keyed on the account
    needs only one line. Returns [(category_2026, own pattern, label, covered cases, rule_version)]."""
    found = []
    by_cat: dict[str, list[Case]] = defaultdict(list)
    for c in exceptions:
        if c.cat26:
            by_cat[c.cat26].append(c)
    for cat, group in sorted(by_cat.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        others = majority + [c for c in exceptions if c.cat26 != cat]
        pending = list(group)
        while pending:
            best = None
            for sort_key, kind, pattern, label in _discriminators(parent_pattern, pending):
                covered = [c for c in pending if c.matches(pattern, vendors)]
                rule_version = all(c.cat25 == parent_cat25 for c in covered)
                need = 1 if (rule_version and kind == "account") else min_cover
                if len(covered) < max(1, need):
                    continue
                if any(c.matches(pattern, vendors) for c in others):
                    continue  # would swallow a case it was not made for
                score = (-len(covered), sort_key)
                if best is None or score < best[0]:
                    best = (score, pattern, label, covered, rule_version)
            if best is None:
                break
            _, pattern, label, covered, rule_version = best
            found.append((cat, pattern, label, covered, rule_version))
            ids = {id(c) for c in covered}
            pending = [c for c in pending if id(c) not in ids]
    return found


_ANCILLARY = re.compile(r"^\s*(carriage|packaging|packing|delivery|postage|handling|service charge|freight)\b",
                        re.IGNORECASE)


def _case_mapping(case: Case, h: History, rb: Rulebook, cache: dict) -> None:
    acct = h.accounts.get(str(case.line.get("account_code")), {})
    ven = h.vendors.get(case.line.get("vendor_id"), {})
    key = (case.cat25, case.entry25, case.line.get("account_code"), case.line.get("vendor_id"), case.text,
           case.line.get("memo") if case.bill_line else None)
    if key not in cache:
        nature = Nature(account_code=str(case.line.get("account_code")), account_name=acct.get("name"),
                        account_default_category=acct.get("default_category_code"), vendor_name=ven.get("name"),
                        vendor_category_hint=ven.get("category_hint"),
                        # a bill line is read with its invoice's memo (carriage follows the goods);
                        # the line-level exemption looks at the bill line's own text only
                        memos=[case.text] + ([case.line.get("memo") or ""] if case.bill_line else []))
        # an ancillary bill line (carriage, packaging) follows the goods: its invoice memo decides
        own = case.text
        line_text = (case.line.get("memo") or own) if case.bill_line and _ANCILLARY.search(own) else own
        cache[key] = map_to_2026(case.cat25, nature, rb, case.entry25, line_text=line_text)
    m = cache[key]
    case.mapping = m
    ok = m.status in ("same", "changed")
    case.cat26, case.entry26 = (m.category_2026, m.entry_2026_id) if ok else (None, None)


def _child_candidate(parent: Candidate, cat: str, pattern: dict, label: str, covered: list[Case],
                     rule_version: bool, rb: Rulebook) -> Candidate | None:
    e26 = rb.in_force(cat, NEW_DATE)
    if e26 is None:
        return None
    cats25 = Counter(c.cat25 for c in covered)
    cat25 = cats25.most_common(1)[0][0]
    e25 = Counter(c.entry25 for c in covered if c.cat25 == cat25).most_common(1)[0][0]
    why = next((c.mapping.explanation for c in covered if c.mapping and c.mapping.status == "changed"), None)
    status = "changed" if any(c.mapping and c.mapping.status == "changed" for c in covered) else "same"
    expl = (why or f"same category in 2026: {cat} under {e26['id']}")
    mapping = VersionMapping(status, cat25, e25, cat, e26["id"], e26["treatment"], expl,
                             (covered[0].mapping.source if covered[0].mapping else "precedents"))
    kind = "rule_version" if rule_version else "exception"
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    key = f"{parent.policy_key}/exc:{slug}"
    refs = list(dict.fromkeys(c.ref for c in covered))
    nature = Nature(account_code=parent.nature.account_code, memos=[c.text for c in covered[:50]])
    child = Candidate(key, kind, pattern, f"{label} within {parent.description}", cat25, e25, len(covered), 1.0, [],
                      list(dict.fromkeys(c.gl_id for c in covered))[:25], nature, mapping=mapping, parent=parent,
                      cornerstones=[{"ref": r, "category_code": cat} for r in refs[:MAX_CORNERSTONES]],
                      effective_from=parent.effective_from, majority_refs=refs)
    return child


def mine_history(h: History, rb: Rulebook, min_precedents: int = MIN_PRECEDENTS,
                 min_consistency: float = MIN_CONSISTENCY,
                 kinds: Iterable[str] = ("vendor_account", "account", "account_department", "memo")
                 ) -> tuple[list[Candidate], list[Candidate]]:
    """Return (candidates above thresholds, near misses with enough volume but too many exceptions).

    Consistency is judged in 2026 terms: each 2025 case is mapped to its own 2026 answer (rule
    changes reach single lines: offsite catering is not premises catering, employer NI is social
    security whatever the department did). A group's exceptions are carved out as RDR children
    (discover_children); the group is a candidate when its parent is right on at least
    MIN_PARENT_SHARE of its cases and on at least `min_consistency` of what the children leave."""
    kinds = set(kinds)
    cases = h.cases()
    groups: dict[tuple, list[Case]] = defaultdict(list)
    for c in cases:
        g = c.line
        acct = g.get("account_code")
        if g.get("vendor_id") and "vendor_account" in kinds:
            groups[("vendor_account", g["vendor_id"], acct)].append(c)
        if "account" in kinds:
            groups[("account", None, acct)].append(c)
        if g.get("department_id") and "account_department" in kinds:
            groups[("account_department", g["department_id"], acct)].append(c)
        if g.get("department_id") and "department" in kinds:
            groups[("department", g["department_id"], None)].append(c)
        if _GP.search(g.get("memo") or "") and "memo" in kinds:
            groups[("memo", "grand_prix", acct)].append(c)

    cache: dict = {}
    for c in cases:
        _case_mapping(c, h, rb, cache)
    candidates: list[Candidate] = []
    near: list[Candidate] = []
    for (kind, k2, acct), rows in sorted(groups.items(), key=lambda kv: (kv[0][0], str(kv[0][1]), str(kv[0][2]))):
        if len(rows) < min_precedents:
            continue
        modal, entry, consistency25, exceptions25, sample = _group_stats(rows)
        account = h.accounts.get(str(acct), {}) if acct else {}
        vendor = h.vendors.get(k2, {}) if kind == "vendor_account" else {}
        if kind == "vendor_account":
            key, pattern = f"vendor:{k2}|acct:{acct}", {"vendor_id": k2, "account_code": str(acct)}
            desc = f"vendor {vendor.get('name', k2)} ({k2}) on account {acct} {account.get('name', '')}".strip()
        elif kind == "account":
            key, pattern = f"acct:{acct}", {"account_code": str(acct)}
            desc = f"account {acct} {account.get('name', '')}".strip()
        elif kind == "account_department":
            key, pattern = f"acct:{acct}|dept:{k2}", {"account_code": str(acct), "department_id": k2}
            desc = f"account {acct} {account.get('name', '')} in department {k2}".strip()
        elif kind == "department":
            key, pattern = f"dept:{k2}", {"department_id": k2}
            desc = f"department {k2}"
        else:
            key, pattern = f"memo:grand_prix|acct:{acct}", {"account_code": str(acct), "memo_regex": GP_REGEX}
            desc = f"account {acct} {account.get('name', '')} lines whose memo names a Grand Prix or circuit".strip()
        nature = Nature(
            account_code=str(acct) if acct else None, account_name=account.get("name"),
            account_default_category=account.get("default_category_code"),
            vendor_name=vendor.get("name"), vendor_category_hint=vendor.get("category_hint"),
            memos=[c.text for c in rows[:50]],
        )
        escalated = sum(1 for c in {c.gl_id: c for c in rows}.values() if (h.approvals.get(c.gl_id) or {}).get("escalated_to"))
        cand = Candidate(key, kind, pattern, desc, modal, entry, len(rows), consistency25, exceptions25[:20],
                         sample + exceptions25[:5], nature, escalated=escalated)
        cand.mapping = map_to_2026(modal, nature, rb, entry)
        if kind != "memo" and cand.mapping.source.endswith("Competition travel"):
            # that change only reaches race-weekend road transport: the memo group carries it, and the
            # rest of the account keeps its 2025 answer
            nature.memos = [c.text for c in rows if not _GP.search(c.line.get("memo") or "")][:50]
            cand.mapping = map_to_2026(modal, nature, rb, entry)
        m = cand.mapping
        if m.status not in ("same", "changed"):
            (candidates if consistency25 >= min_consistency else near).append(cand)
            continue
        if m.narrow_memo_regex and "memo_regex" not in pattern:
            # the 2026 rule only reaches lines whose memo says so (bonus definition): narrow the
            # policy, so a line whose memo is unclear matches nothing and is asked
            cand.pattern = pattern = dict(pattern, memo_regex=m.narrow_memo_regex)
            cand.policy_key = key = f"{key}|memo:{m.category_2026.lower()}-definition"
            rows = [c for c in rows if c.matches(pattern, h.vendors)]
            if len(rows) < min_precedents:
                near.append(cand)
                continue
        target = m.category_2026
        majority = [c for c in rows if c.cat26 == target]
        exc = [c for c in rows if c.cat26 != target]
        cand.precedent_count = len(rows)
        cand.consistency = len(majority) / len(rows)
        for cat, cpat, label, covered, rule_version in discover_children(pattern, modal, majority, exc, h.vendors):
            child = _child_candidate(cand, cat, cpat, label, covered, rule_version, rb)
            if child is not None:
                cand.children.append(child)
        covered_n = sum(ch.precedent_count for ch in cand.children)
        cand.residual_consistency = len(majority) / max(1, len(rows) - covered_n)
        child_refs = {s["ref"] for ch in cand.children for s in ch.cornerstones}
        cand.exceptions = list(dict.fromkeys(c.gl_id for c in exc if c.ref not in child_refs))[:20]
        cand.majority_refs = [c.ref for c in majority]
        cand.cornerstones = [{"ref": c.ref, "category_code": target} for c in majority[:10]]
        cand.evidence_refs = list(dict.fromkeys([c.gl_id for c in majority][:10] + cand.exceptions[:5]))
        ok = cand.consistency >= MIN_PARENT_SHARE and cand.residual_consistency >= min_consistency
        (candidates if ok else near).append(cand)

    acct_near = {(c.pattern.get("account_code"), c.precedent_count) for c in near if c.kind == "account"}
    near = [c for c in near if not (c.kind == "vendor_account" and
                                    (c.pattern.get("account_code"), c.precedent_count) in acct_near)]
    # drop narrower candidates the account-level tree already answers the same way on every one of
    # their own lines (they add nothing; with children this also covers the exceptions)
    acct_tree = {c.pattern["account_code"]: c for c in candidates if c.kind == "account" and c.proposable}
    by_ref = {c.ref: c for c in cases}
    out = []
    for c in candidates:
        top = acct_tree.get(c.pattern.get("account_code"))
        if c.kind not in ("account", "department") and top is not None and c.proposable and \
                _tree_agrees(top, c, by_ref, h.vendors):
            continue
        out.append(c)
    near = [c for c in near if c.kind != "account_department" or c.pattern.get("account_code") not in acct_tree]
    return out, near


def _tree_agrees(top: Candidate, narrow: Candidate, by_ref: dict[str, Case], vendors: dict[str, dict]) -> bool:
    """Does the account-level tree give every case of the narrower tree (its majority and each
    child's cornerstones) the answer the narrower tree gives?"""
    pols = [c.policy_like() for c in top.tree()]
    checked = 0
    for node in narrow.tree():
        want = node.mapping.category_2026 if node.mapping else None
        for ref in node.majority_refs:
            case = by_ref.get(ref)
            if case is None:
                continue
            checked += 1
            res = pol.resolve(pols, case.line, vendors.get(case.line.get("vendor_id")), "2026-01",
                              bill_line=case.bill_line)
            if res.result != "category" or res.category_code != want:
                return False
    if checked:
        return True
    m, t = narrow.mapping, top.mapping
    return (m.category_2026, m.entry_2026_id) == (t.category_2026, t.entry_2026_id) and not narrow.children


def template_rationale(c: Candidate) -> str:
    m = c.mapping
    if c.parent is not None:
        head = (f"Exception to {c.parent.policy_key} ({c.parent.mapping.category_2026 if c.parent.mapping else '?'}): "
                f"{c.precedent_count} 2025 cases matching {c.description} ({len(c.cornerstones)} kept as cornerstones), "
                f"which the parent rule must not decide.")
        if m is None:
            return head
        if m.status == "changed":
            return f"{head} {m.explanation}"
        return f"{head} 2026: {m.category_2026} under {m.entry_2026_id}, as in 2025 ({c.category_2025})."
    exc = f", {len(c.exceptions)} exceptions" if c.exceptions else ""
    head = (f"{c.precedent_count} precedents in 2025 ({c.consistency:.0%} consistent{exc}): {c.description} -> "
            f"{c.category_2025} under {c.entry_2025_id}.")
    if m is None:
        return head
    if m.status == "changed":
        return f"{head} {m.explanation} Source: {m.source}."
    return f"{head} 2026: {m.category_2026} under {m.entry_2026_id}, same as 2025 practice."


class PolicyReview(BaseModel):
    generalises: bool
    rationale: str
    concerns: str


REVIEW_SYSTEM = """\
You review draft cost cap policies that a deterministic miner drafted from a Formula 1 team's 2025 \
ledger and cost cap submission. The category and the 2026 rule version were chosen by code; do not \
change them. Write a two-sentence rationale a Head of Cost Cap can approve: what the lines are, how \
many precedents, and (if the 2026 rule differs from 2025 practice) that it differs and why. Do not \
write article numbers. Set generalises=false if the pattern is too broad for the evidence (for \
example mixed activities under one account, or exceptions that look like a different kind of cost), \
and say why in concerns; otherwise concerns is an empty string."""


def llm_review(client: Any, c: Candidate, rec: Any = None) -> PolicyReview | None:
    """Model review of one candidate; recorded as a model_call step (SCHEMA §6b) when `rec` is given."""
    rec = rec or NullRecorder()
    m = c.mapping
    payload = {
        "policy_key": c.policy_key, "pattern": c.pattern, "description": c.description,
        "precedent_count": c.precedent_count, "consistency": round(c.consistency, 4),
        "exceptions": c.exceptions[:10], "sample_memos": c.nature.memos[:15],
        "category_2025": c.category_2025, "entry_2025": c.entry_2025_id,
        "category_2026": m.category_2026 if m else None, "entry_2026": m.entry_2026_id if m else None,
        "rule_change": m.explanation if m and m.status == "changed" else None,
    }
    user = json.dumps(payload)
    prompt = {"purpose": "review policy candidate", "policy_key": c.policy_key,
              "prompt_digest": digest(REVIEW_SYSTEM + "\n" + user), "user": user}
    try:
        msg = client.beta.messages.parse(
            **llm.common_kwargs(4000),
            system=REVIEW_SYSTEM,
            messages=[{"role": "user", "content": user}],
            output_format=PolicyReview,
        )
    except Exception as e:
        log.warning("LLM review failed for %s: %s", c.policy_key, e)
        rec.record("error", "policy_learner.review", prompt, f"{type(e).__name__}: {e}", model=config.model())
        return None
    parsed = getattr(msg, "parsed_output", None)
    out = model_call_output(msg)
    out["parsed_output"] = parsed.model_dump() if hasattr(parsed, "model_dump") else parsed
    rec.record("model_call", "policy_learner.review", prompt, out, model=config.model())
    if llm.check_stop(msg, f"review {c.policy_key}"):
        return None
    return parsed


def _record_policy_decision(rec: Any, c: Candidate, action: str, why: str) -> None:
    """Every proposal (or deliberate non-proposal) is preceded by a decision step naming the
    candidate, what was weighed and why (SCHEMA §6b)."""
    m = c.mapping
    (rec or NullRecorder()).record("decision", f"{action}:policy_candidate", {
        "action": action, "policy_key": c.policy_key, "kind": c.kind, "pattern": c.pattern,
        "category_2025": c.category_2025, "entry_2025": c.entry_2025_id,
        "category_2026": m.category_2026 if m else None, "entry_2026": m.entry_2026_id if m else None,
        "mapping_status": m.status if m else None, "precedent_count": c.precedent_count,
        "consistency": round(c.consistency, 4), "exceptions": c.exceptions[:20],
        "llm_concerns": c.llm_concerns, "effective_from": c.effective_from, "why": why,
    })


def existing_policy(policies: Iterable[dict], key: str, category: str | None) -> dict | None:
    for p in policies:
        if p.get("policy_key") == key and p.get("category_code") == category and p.get("state") in ("PROPOSED", "APPROVED"):
            return p
    return None


def _propose_one(tools: AgentTools | None, c: Candidate, current: list[dict], dry_run: bool, rec: Any,
                 parent_id: int | None) -> int | None:
    """Propose one policy (or skip a duplicate); returns its policy id when known."""
    m = c.mapping
    if not c.proposable:
        why = c.llm_concerns or (m.explanation if m else "no 2026 mapping")
        _record_policy_decision(rec, c, "ask", f"not proposable: {why}")
        return None
    dup = existing_policy(current, c.policy_key, m.category_2026)
    if dup:
        c.result = {"ok": True, "skipped": f"already {dup['state']} as pol-{dup.get('id')} v{dup.get('version')}",
                    "policy_id": dup.get("id")}
        _record_policy_decision(rec, c, "skip", c.result["skipped"])
        return dup.get("id")
    _record_policy_decision(rec, c, "propose",
                            f"{c.precedent_count} precedents, {c.consistency:.0%} consistent; mapping {m.status}; "
                            f"{len(c.cornerstones)} cornerstones" + (f"; child of pol-{parent_id}" if parent_id else ""))
    if dry_run or tools is None:
        c.result = {"ok": True, "dry_run": True}
        return None
    c.result = tools.propose_policy(c.policy_key, m.category_2026, m.entry_2026_id, c.pattern, c.rationale,
                                    c.evidence_refs, c.precedent_count, c.effective_from, None,
                                    parent_policy_id=parent_id, cornerstones=c.cornerstones)
    return c.result.get("policy_id") if c.result.get("ok") else None


def propose_candidates(tools: AgentTools | None, cands: list[Candidate], dry_run: bool, rec: Any = None) -> None:
    """Propose each candidate, then its RDR children under the parent's new (or existing) id."""
    rec = rec or (tools.rec if tools is not None else NullRecorder())
    current = tools.all_policies() if tools is not None and not dry_run else []

    def walk(c: Candidate, parent_id: int | None) -> None:
        pid = _propose_one(tools, c, current, dry_run, rec, parent_id)
        for child in c.children:
            if pid is None and not dry_run:
                _record_policy_decision(rec, child, "skip", f"parent {c.policy_key} was not proposed")
                continue
            walk(child, pid)

    for c in cands:
        walk(c, c.parent_policy_id)


# ---- coverage ------------------------------------------------------------------------------------


def coverage(cands: list[Candidate], lines: list[dict], vendors: dict[str, dict], period: str = "2026-01") -> dict:
    """Share of January lines the proposed trees decide (RDR resolution, SCHEMA §11.2): a line with
    several bill lines counts as covered when every bill line resolves (a split is a decision)."""
    policies = [n.policy_like() for c in cands if c.proposable for n in c.tree() if n.proposable]
    eligible = pol.eligible_policies(policies, period)
    jan = [g for g in lines if g.get("period_key") == period]
    covered, conflict, usd_cov, usd_all, split = 0, 0, 0, 0, 0
    uncovered_accounts: Counter = Counter()
    for g in jan:
        amt = abs(int(g.get("amount_usd_minor") or 0))
        usd_all += amt
        ven = vendors.get(g.get("vendor_id"))
        bills = g.get("bill_lines") or []
        res = pol.resolve(policies, g, ven, period, bill_lines=bills, eligible=eligible)
        ok = res.result == "category"
        if len(bills) >= 2:
            per = [pol.resolve(policies, g, ven, period, bill_lines=bills, bill_line=b, eligible=eligible)
                   for b in bills]
            ok = all(r.result == "category" for r in per)
            if ok and len({r.category_code for r in per}) > 1:
                split += 1
            elif any(r.result == "conflict" for r in per):
                res = pol.Resolution("conflict", why="conflict")
        if ok:
            covered += 1
            usd_cov += amt
        else:
            if res.result == "conflict":
                conflict += 1
            uncovered_accounts[pol.line_account_code(g)] += 1
    n = len(jan)
    return {"period": period, "lines": n, "covered": covered, "conflicts": conflict, "split": split,
            "share": covered / n if n else 0.0, "usd_share": usd_cov / usd_all if usd_all else 0.0,
            "top_uncovered_accounts": uncovered_accounts.most_common(8)}


def _with_bill_lines(lines: list[dict], bill_lines: Iterable[dict]) -> list[dict]:
    by_gl: dict[str, list[dict]] = defaultdict(list)
    for b in bill_lines:
        if b.get("gl_line_id"):
            by_gl[b["gl_line_id"]].append(b)
    return [dict(g, bill_lines=sorted(by_gl.get(g["id"], []), key=lambda b: int(b.get("line_no", 0)))) for g in lines]


def january_lines(world: WorldClient) -> tuple[list[dict], str]:
    lines = [g for g in world.all_records("gl_line") if g.get("period_key") == "2026-01"]
    if lines:
        return _with_bill_lines(lines, _optional_records(world, "bill_line")), "world API /changes/gl_line"
    path = config.WORLD_OUT_DIR / "gl_line.jsonl"
    if path.exists():
        recs: dict[str, dict] = {}
        for raw in path.read_text().splitlines():
            if raw.strip():
                r = json.loads(raw)
                r = r.get("record", r)
                recs[r["id"]] = r
        bl_path = config.WORLD_OUT_DIR / "bill_line.jsonl"
        bls = [json.loads(r) for r in bl_path.read_text().splitlines() if r.strip()] if bl_path.exists() else []
        return _with_bill_lines([g for g in recs.values() if g.get("period_key") == "2026-01"],
                                [b.get("record", b) for b in bls]), \
            f"{path} (generator output; not yet visible at the sim date)"
    return [], "none available"


# ---- report --------------------------------------------------------------------------------------


def escalation_envelope(h: History) -> dict:
    escalated = [abs(int(a.get("amount_usd_minor") or 0)) for a in h.approvals.values() if a.get("escalated_to")]
    not_esc = [abs(int(a.get("amount_usd_minor") or 0)) for a in h.approvals.values() if not a.get("escalated_to")]
    return {"approvals": len(h.approvals), "escalated": len(escalated),
            "min_escalated_usd_minor": min(escalated) if escalated else None,
            "max_unescalated_usd_minor": max(not_esc) if not_esc else None}


def write_report(path: Path, h: History, cands: list[Candidate], near: list[Candidate], cov: dict,
                 cov_source: str, offline: bool) -> str:
    proposable = [c for c in cands if c.proposable]
    changed = [c for c in proposable if c.mapping.status == "changed"]
    asks = [c for c in cands if not c.proposable] + near
    confident = [c for c in proposable if c.consistency >= 0.99 and c.precedent_count >= 30]
    env = escalation_envelope(h)
    L: list[str] = []
    L.append("# Onboarding report: Policy Learner\n")
    L.append(f"Mode: {'offline (template rationales)' if offline else 'online (Claude rationales, code-chosen categories)'}. "
             f"All policies are PROPOSED; none takes effect until the Head of Cost Cap approves it.\n")
    L.append("## Inputs\n")
    splits = h.split_lines()
    L.append(f"- 2025 GL lines: {len(h.gl_lines)}; with one 2025 cost cap classification: {len(h.joined())}; "
             f"split across categories: {len(splits)}; 2025 bill lines with their own classification: "
             f"{sum(1 for v in h.bill_lines.values() for b in v if b.get('category_code'))}")
    L.append(f"- 2025 approvals log rows: {env['approvals']} ({env['escalated']} escalated to the Head of Cost Cap)")
    L.append(f"- Accounts: {len(h.accounts)}; vendors: {len(h.vendors)}")
    L.append(f"- Thresholds: >= {MIN_PRECEDENTS} precedents and >= {MIN_CONSISTENCY:.0%} consistency\n")
    L.append("## What I learned\n")
    n_children = sum(len(c.tree()) - 1 for c in proposable)
    L.append(f"{len(proposable)} policies proposed, plus {n_children} exceptions under them, effective from "
             f"{NEW_DATE} under SECD-ISS07.\n")
    L.append("| policy_key | covers | 2025 practice | 2026 policy | precedents | consistent | exceptions | status |")
    L.append("|---|---|---|---|---|---|---|---|")
    for c in sorted(proposable, key=lambda c: -c.precedent_count):
        m = c.mapping
        res = c.result or {}
        status = "rule change" if m.status == "changed" else "same as 2025"
        if res.get("skipped"):
            status += f" ({res['skipped']})"
        L.append(f"| `{c.policy_key}` | {c.description} | {c.category_2025} ({c.entry_2025_id}) | "
                 f"**{m.category_2026}** ({m.entry_2026_id}) | {c.precedent_count} | {c.consistency:.1%} | "
                 f"{len(c.exceptions)} | {status} |")
    L.append("")
    trees = [c for c in proposable if c.children]
    L.append("### Policy tree (Ripple-Down Rules)\n")
    L.append(f"{sum(len(c.tree()) - 1 for c in proposable)} exceptions under {len(trees)} parents. Each exception "
             f"keeps the 2025 cases it was made for as cornerstones, and matches none of its parent's own "
             f"cases (checked against history before proposing).\n")
    for c in sorted(proposable, key=lambda c: -c.precedent_count):
        if not c.children:
            continue
        L.append(f"- `{c.policy_key}` -> **{c.mapping.category_2026}** ({c.precedent_count} cases, "
                 f"{len(c.cornerstones)} cornerstones)")
        for node in c.tree()[1:]:
            depth = 0
            p = node.parent
            while p is not None:
                depth += 1
                p = p.parent
            L.append(f"{'  ' * depth}- `{node.policy_key}` `{json.dumps(node.pattern)}` -> **{node.mapping.category_2026}** "
                     f"({node.kind.replace('_', ' ')}, {node.precedent_count} cases, {len(node.cornerstones)} cornerstones)")
    L.append("")
    if changed:
        L.append("### Where 2026 differs from 2025 practice\n")
        for c in changed:
            L.append(f"- `{c.policy_key}`: {c.mapping.explanation} ({c.mapping.source})")
        L.append("")
    L.append("## What I'm confident on\n")
    if confident:
        for c in confident:
            L.append(f"- `{c.policy_key}`: {c.precedent_count} precedents, {c.consistency:.1%} consistent -> "
                     f"{c.mapping.category_2026}")
    else:
        L.append("- Nothing reaches 99% consistency over 30+ precedents; every policy above needs a look.")
    L.append("")
    L.append("## What I'll ask about\n")
    if not asks:
        L.append("- Nothing outstanding from history.")
    for c in asks:
        if c in near:
            L.append(f"- `{c.policy_key}` ({c.description}): {c.precedent_count} lines but only "
                     f"{c.consistency:.0%} consistent (mostly {c.category_2025}); exceptions e.g. "
                     f"{', '.join(c.exceptions[:5])}. I will ask per line rather than draft a policy.")
        elif c.llm_concerns:
            L.append(f"- `{c.policy_key}`: reviewer concern: {c.llm_concerns}")
        else:
            L.append(f"- `{c.policy_key}` ({c.description}): {c.mapping.explanation}")
    if splits:
        depts = Counter(g.get("department_id") for g, _ in splits)
        sample = splits[0][1]
        L.append(f"- {len(splits)} lines were split across categories in 2025 (mostly "
                 f"{', '.join(f'{d} ({n})' for d, n in depts.most_common(3))}; e.g. {splits[0][0]['id']}: "
                 f"{' + '.join(c['category_code'] for c in sample)}). A policy cites one category, so I will "
                 f"ask about these per line.")
    L.append("")
    L.append("## Operating envelope learned from 2025 approvals\n")
    L.append(f"- Smallest amount escalated to the Head of Cost Cap: {fmt_usd(env['min_escalated_usd_minor'])}")
    L.append(f"- Largest amount approved without escalation: {fmt_usd(env['max_unescalated_usd_minor'])}")
    L.append(f"- 2026 materiality setting: {fmt_usd(config.MATERIALITY_USD_MINOR)}\n")
    L.append("## Estimated coverage of January 2026\n")
    L.append(f"Source: {cov_source}.\n")
    if cov["lines"]:
        L.append(f"- {cov['covered']} of {cov['lines']} January lines ({cov['share']:.1%}; {cov['usd_share']:.1%} by USD) "
                 f"would be covered by a proposed policy (exactly one match, several that agree, or one refining "
                 f"the rest), if all are approved.")
        L.append(f"- {cov['conflicts']} lines match policies that disagree: those become questions.")
        if cov.get("split"):
            L.append(f"- {cov['split']} lines would be split by bill line across categories (allocations).")
        if cov["top_uncovered_accounts"]:
            L.append("- Most uncovered accounts: " + ", ".join(f"{a} ({n})" for a, n in cov["top_uncovered_accounts"]))
    else:
        L.append("- No January 2026 lines available yet.")
    text = "\n".join(L) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return text


# ---- onboarding ----------------------------------------------------------------------------------


DEFAULT_KINDS = ("vendor_account", "account", "account_department", "memo")


def onboard(world: WorldClient, rb: Rulebook, tools: AgentTools | None, *, client: Any = None, offline: bool = True,
            dry_run: bool = False, report_path: Path | None = None, rec: Any = None,
            kinds: Iterable[str] = DEFAULT_KINDS) -> dict:
    rec = rec or (tools.rec if tools is not None else NullRecorder())
    h = load_history(world)
    rec.record("read", "world:history_2025", {"sources": ["history_2025_gl_line", "history_2025_cap_classification",
                                                          "history_2025_approval", "history_2025_bill_line",
                                                          "history_2025_bill_line_classification", "account",
                                                          "vendor"]},
               {"gl_lines": len(h.gl_lines), "classified": len(h.joined()), "splits": len(h.split_lines()),
                "bill_lines": sum(len(v) for v in h.bill_lines.values()),
                "approvals": len(h.approvals), "accounts": len(h.accounts), "vendors": len(h.vendors)})
    cands, near = mine_history(h, rb, kinds=kinds)
    rec.record("note", "mine_history", {"min_precedents": MIN_PRECEDENTS, "min_consistency": MIN_CONSISTENCY},
               {"candidates": [c.policy_key for c in cands], "near_misses": [c.policy_key for c in near]})
    for c in cands:
        for child in c.tree()[1:]:
            child.rationale = template_rationale(child)
        c.rationale = template_rationale(c)
        if not offline and client is not None and c.mapping and c.mapping.status in ("same", "changed"):
            review = llm_review(client, c, rec)
            if review is not None:
                if not review.generalises:
                    c.llm_concerns = review.concerns or "reviewer judged the pattern too broad"
                elif review.rationale.strip():
                    # the rule-version statement stays deterministic and comes first
                    prefix = f"{c.mapping.explanation} " if c.mapping.status == "changed" else ""
                    c.rationale = f"{prefix}{review.rationale.strip()} ({c.precedent_count} precedents, " \
                                  f"{c.consistency:.0%} consistent)"
    propose_candidates(tools, cands, dry_run, rec)
    lines, source = january_lines(world)
    cov = coverage(cands, lines, h.vendors)
    rec.record("note", "coverage", {"source": source}, cov)
    report = write_report(Path(report_path or config.ONBOARDING_REPORT_PATH), h, cands, near, cov, source, offline)
    rec.record("note", "onboarding_report", {"path": str(report_path or config.ONBOARDING_REPORT_PATH)}, report)
    return {"candidates": cands, "near_misses": near, "coverage": cov, "report": report}


# ---- from corrections ----------------------------------------------------------------------------


def _common_memo_tokens(memos: list[str]) -> list[str]:
    """Every word (>= 4 letters, not a stop word) shared by all memos, longest first."""
    stop = {"with", "from", "for", "the", "and", "invoice", "inv", "ltd", "limited", "services", "costs", "cost"}
    sets = [set(re.findall(r"[a-z]{4,}", (m or "").lower())) - stop for m in memos]
    if not sets:
        return []
    return sorted(set.intersection(*sets), key=lambda t: (-len(t), t))


def _common_memo_token(memos: list[str]) -> str | None:
    stop = {"with", "from", "for", "the", "and", "invoice", "inv", "ltd", "limited", "services", "costs", "cost"}
    sets = [set(re.findall(r"[a-z]{4,}", (m or "").lower())) - stop for m in memos]
    if not sets:
        return None
    common = set.intersection(*sets)
    return sorted(common, key=lambda t: (-len(t), t))[0] if common else None


def _history_lines(world: WorldClient | None) -> dict[str, dict]:
    """History cornerstone ref -> a matchable line (with bill_line context), for the client-side
    cornerstone check of refs the module does not hold."""
    if world is None:
        return {}
    try:
        h = load_history(world)
    except Exception as e:  # history unavailable: the module still checks gl_line refs
        log.warning("history unavailable for the cornerstone check: %s", e)
        return {}
    return {c.ref: {"line": c.line, "bill_line": c.bill_line} for c in h.cases()}


def _correction_child(tools: AgentTools, parent: dict, policies: list[dict], cat: str, rows: list[dict],
                      history: dict[str, dict], rb_rows: list[dict], min_alike: int) -> Candidate | dict:
    """A child of the policy that fired (SCHEMA §11.2 "Corrections become exceptions"): its own
    pattern is the narrowest discriminator shared by every corrected line that matches none of the
    parent's own cornerstones. Returns the Candidate, or {"why": ...} when none exists."""
    lines = []
    for r in rows:
        g = tools.gl_line(r["gl_line_id"]) if r.get("gl_line_id") else None
        if g is None:
            return {"why": f"corrected line {r.get('gl_line_id')} is not in the system of work"}
        lines.append(g)
    by_id = {str(p["id"]): p for p in policies}
    try:
        ppat = pol.effective_pattern(parent, by_id) or {}
    except Exception:
        ppat = {}
    options: list[tuple[str, dict]] = []
    for token in _common_memo_tokens([g.get("memo") for g in lines]):
        options.append((f"memo-{token}", {"memo_regex": rf"\b{re.escape(token)}\b"}))
    for key, label in (("department_id", "dept"), ("vendor_id", "vendor"), ("entity", "entity"),
                       ("erp_category_code", "erp")):
        vals = {g.get(key) for g in lines}
        if len(vals) == 1 and None not in vals and key not in ppat:
            v = vals.pop()
            options.append((f"{label}-{v}", {key: v}))
    stones = json.loads(parent.get("cornerstones") or "[]") if isinstance(parent.get("cornerstones"), str) else \
        list(parent.get("cornerstones") or [])
    own = [c for c in stones if c.get("category_code") == parent.get("category_code")]
    for slug, pattern in options:
        vend = lambda g: tools.vendor(g.get("vendor_id"))  # noqa: E731
        if not all(pol.matches(pattern, g, vend(g)) for g in lines):
            continue
        clash = []
        for c in own:
            g = tools.gl_line(c["ref"]) if str(c.get("ref", "")).startswith("gl-") else None
            if g is not None:
                if pol.matches(pattern, g, vend(g)):
                    clash.append(c["ref"])
            elif c["ref"] in history:
                hl = history[c["ref"]]
                if pol.matches(pattern, hl["line"], None, bill_line=hl["bill_line"]):
                    clash.append(c["ref"])
        if clash:
            continue
        periods = sorted(r.get("period_key") or "9999-12" for r in rows)
        effective_from = max(parent.get("effective_from") or NEW_DATE,
                             pol.period_bounds(periods[0])[0] if periods[0] != "9999-12" else NEW_DATE)
        entry = pol.rulebook_entry_in_force(rb_rows, cat, effective_from)
        if entry is None:
            return {"why": f"no {cat} entry in force on {effective_from}"}
        refs = [r["ref"] for r in rows] + [g["id"] for g in lines]
        reasons = "; ".join(sorted({(r.get("human_text") or "").strip()[:80] for r in rows})[:3])
        key = f"{parent.get('policy_key')}/corr:{cat}:{slug}"
        rationale = (f"Exception to {pol.policy_ref(parent)} ({parent.get('category_code')}) from {len(rows)} alike "
                     f"human corrections ({', '.join(r['ref'] for r in rows)}) of lines it decided: {cat} under "
                     f"{entry['id']} where {json.dumps(pattern)}. Human reasons: {reasons}.")
        mapping = VersionMapping("same", cat, entry["id"], cat, entry["id"], entry["treatment"],
                                 "from 2026 human corrections", "precedents")
        c = Candidate(key, "correction", pattern, f"{slug} under {pol.policy_ref(parent)}", cat, entry["id"],
                      len(rows), 1.0, [], refs, Nature(memos=[g.get("memo") or "" for g in lines]), mapping=mapping,
                      rationale=rationale, effective_from=effective_from, parent_policy_id=int(parent["id"]),
                      cornerstones=[{"ref": g["id"], "category_code": cat} for g in lines])
        return c
    return {"why": f"no discriminator shared by all {len(rows)} corrected lines avoids the cornerstones of "
                   f"{pol.policy_ref(parent)}"}


def from_corrections(tools: AgentTools, *, client: Any = None, offline: bool = True, dry_run: bool = False,
                     min_alike: int = MIN_ALIKE_CORRECTIONS, world: WorldClient | None = None) -> list[Candidate]:
    """Generalise >= `min_alike` alike human corrections. A correction of a line a policy decided
    becomes a CHILD of that policy (the corrected items are its cornerstones); corrections of
    lines no policy decided become a top-level policy, as before."""
    rb_rows = tools.rulebook()
    codes = {e["category_code"] for e in rb_rows}
    # precedent.reason is prefixed with the decision by the module: "reject: ...", "answer: Q: .. A: .."
    precedents = tools.search_precedents(limit=100000, join_items=True)
    all_pols = tools.all_policies()
    by_pid = {str(p["id"]): p for p in all_pols}
    groups: dict[tuple, list[dict]] = defaultdict(list)
    fired_groups: dict[tuple, list[dict]] = defaultdict(list)
    for pr in precedents:
        if pr.get("decision") not in ("reject", "answer"):
            continue
        corrected = category_from_text(pr.get("human_text"), codes)
        if corrected is None or pr.get("account_code") is None:
            continue
        pr = dict(pr, corrected=corrected, human_kind=pr["decision"])
        fired = by_pid.get(str(pr.get("proposed_policy_id"))) if pr["decision"] == "reject" else None
        if fired is not None and fired.get("category_code") != corrected:
            fired_groups[(str(fired["id"]), corrected)].append(pr)
            continue
        groups[(corrected, pr.get("vendor_id"), str(pr["account_code"]))].append(pr)

    out: list[Candidate] = []
    history = _history_lines(world) if fired_groups else {}
    for (pid, cat), rows in sorted(fired_groups.items()):
        parent = by_pid[pid]
        if len(rows) < min_alike:
            continue
        child = _correction_child(tools, parent, all_pols, cat, rows, history, rb_rows, min_alike)
        if isinstance(child, dict):
            tools.rec.record("decision", "ask:correction_child", {"parent": pol.policy_ref(parent), "category": cat,
                                                                  "precedents": [r["ref"] for r in rows],
                                                                  "why": child["why"]})
            continue
        if not offline and client is not None:
            review = llm_review(client, child, tools.rec)
            if review is not None and not review.generalises:
                child.llm_concerns = review.concerns or "reviewer judged the pattern too broad"
        dup = existing_policy(all_pols, child.policy_key, cat)
        if dup:
            child.result = {"ok": True, "skipped": f"already {dup['state']} as pol-{dup.get('id')}"}
            _record_policy_decision(tools.rec, child, "skip", child.result["skipped"])
        elif not child.proposable:
            _record_policy_decision(tools.rec, child, "ask", f"not proposable: {child.llm_concerns}")
        else:
            _record_policy_decision(tools.rec, child, "propose", f"{len(rows)} corrections of {pol.policy_ref(parent)}")
            if not dry_run:
                child.result = tools.propose_policy(child.policy_key, cat, child.mapping.entry_2026_id, child.pattern,
                                                    child.rationale, child.evidence_refs, len(rows),
                                                    child.effective_from, None, parent_policy_id=int(parent["id"]),
                                                    cornerstones=child.cornerstones)
        out.append(child)
    # fall back to account-level groups for corrections spread over vendors
    by_acct: dict[tuple, list[dict]] = defaultdict(list)
    for (cat, vend, acct), rows in groups.items():
        if len(rows) < min_alike:
            by_acct[(cat, None, acct)].extend(rows)
    final = {k: v for k, v in groups.items() if len(v) >= min_alike}
    final.update({k: v for k, v in by_acct.items() if len(v) >= min_alike})

    current = all_pols
    for (cat, vend, acct), rows in sorted(final.items(), key=lambda kv: str(kv[0])):
        periods = sorted(r.get("period_key") or "9999-12" for r in rows)
        effective_from = pol.period_bounds(periods[0])[0] if periods[0] != "9999-12" else NEW_DATE
        # module rule for proposePolicy: the entry must be in force on effective_from
        entry = pol.rulebook_entry_in_force(rb_rows, cat, effective_from)
        if entry is None:
            continue
        pattern: dict[str, Any] = {"account_code": acct}
        key = f"corr:{cat}|acct:{acct}"
        if vend:
            pattern["vendor_id"] = vend
            key = f"corr:{cat}|vendor:{vend}|acct:{acct}"
        token = _common_memo_token([r.get("memo") for r in rows])
        if token:
            pattern["memo_regex"] = rf"\b{re.escape(token)}\b"
            key += f"|memo:{token}"
        refs = [r["ref"] for r in rows] + [r["gl_line_id"] for r in rows if r.get("gl_line_id")]
        reasons = "; ".join(sorted({(r.get("human_text") or "").strip()[:80] for r in rows})[:3])
        what = f"account {acct}" + (f", vendor {vend}" if vend else "") + (f", memo '{token}'" if token else "")
        rationale = (f"Generalised from {len(rows)} alike human decisions ({', '.join(r['ref'] for r in rows)}) on "
                     f"{what}: classified {cat} under {entry['id']}. Human reasons: {reasons}.")
        nature = Nature(account_code=acct, memos=[r.get("memo") or "" for r in rows])
        mapping = VersionMapping("same", cat, entry["id"], cat, entry["id"], entry["treatment"],
                                 "from 2026 human decisions", "precedents")
        c = Candidate(key, "correction", pattern, what, cat, entry["id"], len(rows), 1.0, [], refs, nature,
                      mapping=mapping, rationale=rationale, effective_from=effective_from)
        if not offline and client is not None:
            review = llm_review(client, c, tools.rec)
            if review is not None:
                if not review.generalises:
                    c.llm_concerns = review.concerns or "reviewer judged the pattern too broad"
                elif review.rationale.strip():
                    c.rationale = f"{review.rationale.strip()} (precedents: {', '.join(r['ref'] for r in rows)})"
        dup = existing_policy(current, key, cat)
        if dup:
            c.result = {"ok": True, "skipped": f"already {dup['state']} as pol-{dup.get('id')}"}
            _record_policy_decision(tools.rec, c, "skip", c.result["skipped"])
        elif not c.proposable:
            _record_policy_decision(tools.rec, c, "ask", f"not proposable: {c.llm_concerns}")
        else:
            _record_policy_decision(tools.rec, c, "propose", f"{len(rows)} alike human decisions: {reasons}")
            if not dry_run:
                c.result = tools.propose_policy(key, cat, entry["id"], pattern, c.rationale, refs, len(rows),
                                                c.effective_from, None,
                                                cornerstones=[{"ref": r["gl_line_id"], "category_code": cat}
                                                              for r in rows if r.get("gl_line_id")])
        out.append(c)
    return out


# ---- CLI -----------------------------------------------------------------------------------------


def _load_rulebook(tools: AgentTools | None) -> Rulebook:
    if config.RULEBOOK_PATH.exists():
        return Rulebook.from_file()
    if tools is not None:
        return Rulebook(tools.rulebook())
    raise FileNotFoundError(config.RULEBOOK_PATH)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.policy_learner",
                                 description="Policy Learner: propose versioned policies (identity: policy_learner).")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--onboard", action="store_true", help="mine 2025 history and propose 2026 policies")
    mode.add_argument("--from-corrections", action="store_true", help="generalise >= 3 alike human corrections")
    ap.add_argument("--offline", action="store_true", help="template rationales, no LLM")
    ap.add_argument("--dry-run", action="store_true", help="compute and report; call no reducers")
    ap.add_argument("--report", type=Path, default=config.ONBOARDING_REPORT_PATH)
    ap.add_argument("--department-policies", action="store_true",
                    help="also mine department-level policies (payroll on-costs under them become exceptions)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING)

    client, offline = None, args.offline
    if not offline:
        try:
            client = llm.make_client()
        except llm.LLMUnavailable as e:
            print(f"warning: {e}; running offline", file=sys.stderr)
            offline = True
    # The learner records every step like the analyst (SCHEMA §6b); --dry-run records to the file.
    actor = identities.get("policy_learner")
    stdb = StdbClient()
    rec = Recorder(actor, stdb, sim_date_or_unknown(), to_file=args.dry_run)
    tools = AgentTools(actor, stdb, recorder=rec)
    mode = "onboard" if args.onboard else "from_corrections"
    with rec.run(f"policy_learner:{mode}", {**{k: str(v) for k, v in vars(args).items()}, "offline": offline,
                                            "model": None if offline else config.model()}):
        if args.onboard:
            rb = _load_rulebook(tools)
            kinds = DEFAULT_KINDS + (("department",) if args.department_policies else ())
            res = onboard(WorldClient(), rb, tools, client=client, offline=offline, dry_run=args.dry_run,
                          report_path=args.report, rec=rec, kinds=kinds)
            proposed = [c for c in res["candidates"] if c.proposable]
            print(f"candidates: {len(res['candidates'])}, proposable: {len(proposed)}, "
                  f"near misses: {len(res['near_misses'])}")
            cov = res["coverage"]
            print(f"January coverage: {cov['covered']}/{cov['lines']} ({cov['share']:.1%})")
            print(f"report: {args.report}")
        else:
            cands = from_corrections(tools, client=client, offline=offline, dry_run=args.dry_run, world=WorldClient())
            for c in cands:
                print(f"{c.policy_key}: {c.precedent_count} precedents -> {c.category_2025}; {c.result}")
            if not cands:
                print("no group of >= 3 alike corrections yet")
    print(f"run {rec.run_id}: {len(rec.steps)} steps recorded to {rec.sink}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
