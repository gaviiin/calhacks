"""2025 (ISS22) -> 2026 (SECD-ISS07) mapping of a classification. Pure, deterministic.

The Policy Learner learns house practice from 2025 precedents, but a 2025 precedent can be the
wrong answer in 2026. Before proposing a 2026 policy it maps each learned 2025 category through:

1. Explicit overrides from rulebook/CHANGES.md, for cases where the category code still exists in
   2026 but the 2026 answer differs (canteen RELEVANT -> CATERING; plant & equipment DEPRECIATION
   -> RELEVANT, measured on IAS 16 terms under D6.1.1.k: the policy cites RELEVANT@SECD-ISS07
   because the module requires the category to equal the cited entry's category, and the
   rationale names ADJ_DEPRECIATION_IAS16@SECD-ISS07; assets used solely for excluded activities
   stay DEPRECIATION; employer social security; race-weekend road transport; sporting fines; grant
   gross-up direction flip -> ask).
   Each override names its CHANGES.md row.
2. Generic "new exclusion" rule: if the lines' master data (account default category, vendor
   category hint) points at a category that exists only in the 2026 rulebook, use it.
3. Generic: the same category_code exists in 2026 -> same category, 2026 entry.
4. Otherwise the code has no 2026 home (codes present only in ISS22, read from rulebook.json, e.g.
   SICK_COVER, TERMINATION_2021_22, ADJ_CAPEX_LIMIT): status "ask", never a policy.

Category codes are read from the rulebook, not copied here; overrides only name the codes they
move between.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from . import config
from .policy import in_force_on

OLD_VERSION = "ISS22"
NEW_VERSION = "SECD-ISS07"
OLD_DATE = "2025-12-31"
NEW_DATE = "2026-01-01"


class Rulebook:
    def __init__(self, entries: Iterable[dict]):
        self.entries = list(entries)
        self.by_id = {e["id"]: e for e in self.entries}

    @classmethod
    def from_file(cls, path: Path | None = None) -> "Rulebook":
        data = json.loads(Path(path or config.RULEBOOK_PATH).read_text())
        if isinstance(data, dict):
            data = data.get("entries", [])
        return cls(data)

    def in_force(self, category_code: str, date: str) -> dict | None:
        for e in self.entries:
            if e["category_code"] == category_code and in_force_on(e, date):
                return e
        return None

    def codes(self, version: str) -> set[str]:
        return {e["category_code"] for e in self.entries if e["rule_version"] == version}

    def only_in(self, version: str) -> set[str]:
        others = {e["category_code"] for e in self.entries if e["rule_version"] != version}
        return self.codes(version) - others

    def get(self, entry_id: str) -> dict | None:
        return self.by_id.get(entry_id)


@dataclass
class Nature:
    """What the lines in a candidate group are, from master data and memos."""

    account_code: str | None = None
    account_name: str | None = None
    account_default_category: str | None = None
    vendor_name: str | None = None
    vendor_category_hint: str | None = None
    memos: list[str] = field(default_factory=list)

    def master_text(self) -> str:
        parts = [self.account_name, self.vendor_name, self.vendor_category_hint]
        return " | ".join(p for p in parts if p).lower()

    def memo_share(self, rx: re.Pattern) -> float:
        memos = [m for m in self.memos if m]
        return sum(1 for m in memos if rx.search(m)) / len(memos) if memos else 0.0

    def hints(self) -> list[str]:
        out = []
        for h in (self.account_default_category, self.vendor_category_hint):
            if h:
                code = str(h).strip().upper().replace(" ", "_").replace("-", "_")
                if code not in out:
                    out.append(code)
        return out


@dataclass
class VersionMapping:
    status: str  # "same" | "changed" | "ask"
    category_2025: str
    entry_2025_id: str | None
    category_2026: str | None
    entry_2026_id: str | None
    treatment_2026: str | None
    explanation: str
    source: str

    @property
    def changed(self) -> bool:
        return self.status == "changed"


@dataclass
class Override:
    name: str
    changes_row: str  # row title in rulebook/CHANGES.md
    applies: Callable[[str, Nature, Rulebook], bool]
    # returns (category_code, rulebook_entry_id) or None to mean "ask"
    target: Callable[[str, Nature, Rulebook], tuple[str, str] | None]
    why: str


def _rx(pattern: str) -> Callable[[Nature], bool]:
    """A nature test: master data (account / vendor names, vendor hint) mentions it, or at least
    half of the group's memos do. One stray memo never flips a whole group."""
    r = re.compile(pattern, re.IGNORECASE)
    return lambda n: bool(r.search(n.master_text())) or n.memo_share(r) >= 0.5


_is_canteen = _rx(r"\b(canteen|catering|caterer|cafeteria|staff restaurant)\b")
_is_property = _rx(r"\b(property|building|buildings|freehold|leasehold|land|premises|right[- ]of[- ]use)\b")
_is_plant_equipment = _rx(
    r"\b(plant|machinery|equipment|tooling|toolings|wind tunnel|simulator|cnc|autoclave|dyno|"
    r"it hardware|computers?|vehicles?|p&e|ppe)\b"
)
_is_social_security = _rx(r"(social security|employer'?s? (ni|nic|national insurance)|\bnics?\b|employer contributions)")
_is_road_transfer = _rx(r"\b(taxi|taxis|transfer|transfers|car hire|chauffeur|shuttle|minibus|uber|ground transport)\b")
_is_race_weekend = _rx(r"(grand prix|\bgp\b|race weekend|circuit|testing)")
_is_solely_excluded = _rx(r"(used (only|solely|exclusively) for|non[- ]?f1)")
_is_fia_fine = _rx(r"\b(fine|fines|penalty|penalties)\b")
_is_fia = _rx(r"\b(fia|steward|stewards|sporting)\b")


def _entry(rb: Rulebook, code: str) -> str:
    e = rb.in_force(code, NEW_DATE)
    if e is None:
        raise KeyError(code)
    return e["id"]


def _depreciation_target(cat: str, n: Nature, rb: Rulebook) -> tuple[str, str] | None:
    if _is_solely_excluded(n):  # D5.1.1.o still excludes assets used solely for excluded activities
        return "DEPRECIATION", _entry(rb, "DEPRECIATION")
    if _is_property(n) and not _is_plant_equipment(n):
        return "DEPRECIATION", _entry(rb, "DEPRECIATION")
    if _is_plant_equipment(n) and not _is_property(n):
        _entry(rb, "ADJ_DEPRECIATION_IAS16")  # the measurement rule must exist in the 2026 rulebook
        return "RELEVANT", _entry(rb, "RELEVANT")
    return None  # asset class unclear: ask


OVERRIDES: list[Override] = [
    Override(
        name="catering",
        changes_row="Catering",
        applies=lambda cat, n, rb: cat == "RELEVANT" and ("CATERING" in n.hints() or _is_canteen(n)),
        target=lambda cat, n, rb: ("CATERING", _entry(rb, "CATERING")),
        why="catering was not mentioned in ISS22, so canteen costs were inside the cap; SECD-ISS07 "
            "excludes catering at Competitions, testing and team premises",
    ),
    Override(
        name="depreciation",
        changes_row="Depreciation",
        applies=lambda cat, n, rb: cat == "DEPRECIATION",
        target=_depreciation_target,
        why="ISS22 excluded all depreciation; SECD-ISS07 excludes only property depreciation and assets "
            "used solely for excluded activities, and brings plant and equipment depreciation inside "
            "the cap (Relevant), measured on IAS 16 terms per ADJ_DEPRECIATION_IAS16@SECD-ISS07",
    ),
    Override(
        name="social_security",
        changes_row="Employer social security",
        applies=lambda cat, n, rb: cat == "RELEVANT" and _is_social_security(n),
        target=lambda cat, n, rb: ("SOCIAL_SECURITY", _entry(rb, "SOCIAL_SECURITY")),
        why="ISS22 excluded only the employer social security above 13.8% of remuneration; SECD-ISS07 "
            "excludes all mandatory employer contributions",
    ),
    Override(
        name="competition_road_transport",
        changes_row="Competition travel",
        applies=lambda cat, n, rb: cat == "RELEVANT" and _is_road_transfer(n) and _is_race_weekend(n),
        target=lambda cat, n, rb: ("COMPETITION_TRAVEL", _entry(rb, "COMPETITION_TRAVEL")),
        why="ISS22 excluded flight, rail and hotel only; SECD-ISS07 adds road transport between "
            "airport or station, hotel and venue",
    ),
    Override(
        name="sporting_fines",
        changes_row="Fines",
        applies=lambda cat, n, rb: cat == "RELEVANT" and _is_fia_fine(n) and _is_fia(n),
        target=lambda cat, n, rb: ("FINES", _entry(rb, "FINES")),
        why="ISS22 excluded only Financial Regulations fines; SECD-ISS07 excludes any FIA fine under "
            "Sections A-F",
    ),
    Override(
        name="grant_gross_up",
        changes_row="R&D grant income",
        applies=lambda cat, n, rb: cat == "ADJ_GRANT_GROSS_UP",
        target=lambda cat, n, rb: None,
        why="the direction flips: ISS22 offset grant income against R&D costs (a downward adjustment), "
            "SECD-ISS07 requires the offset to be grossed up (an upward adjustment); a human must "
            "confirm the 2026 treatment before any policy",
    ),
]


def _fmt_entry(e: dict | None) -> str:
    if not e:
        return "?"
    return f"{e['id']} ({e['article']})"


def map_to_2026(category_2025: str, nature: Nature, rb: Rulebook,
                entry_2025_id: str | None = None) -> VersionMapping:
    """Map a learned 2025 category to its 2026 classification. See the module docstring."""
    e25 = rb.get(entry_2025_id) if entry_2025_id else rb.in_force(category_2025, OLD_DATE)
    e25_id = e25["id"] if e25 else entry_2025_id

    # 1. explicit overrides (CHANGES.md)
    for o in OVERRIDES:
        if not o.applies(category_2025, nature, rb):
            continue
        try:
            tgt = o.target(category_2025, nature, rb)
        except KeyError as missing:
            return VersionMapping("ask", category_2025, e25_id, None, None, None,
                                  f"rule change '{o.changes_row}' applies but the 2026 entry for {missing} "
                                  f"is missing from the rulebook", f"rulebook/CHANGES.md: {o.changes_row}")
        if tgt is None:
            return VersionMapping(
                "ask", category_2025, e25_id, None, None, None,
                f"2025 practice was {category_2025} under {_fmt_entry(e25)}, but {o.why}. "
                f"Not proposing a policy until a human decides.",
                f"rulebook/CHANGES.md: {o.changes_row}")
        code, entry_id = tgt
        e26 = rb.get(entry_id)
        if code == category_2025 and e25 and e26 and e26["treatment"] == e25["treatment"]:
            return VersionMapping("same", category_2025, e25_id, code, entry_id, e26["treatment"],
                                  f"same as 2025: {category_2025} under {_fmt_entry(e26)} ({o.why}; "
                                  f"these lines are on the unchanged side of that change)",
                                  f"rulebook/CHANGES.md: {o.changes_row}")
        return VersionMapping(
            "changed", category_2025, e25_id, code, entry_id, e26["treatment"] if e26 else None,
            f"DIFFERS FROM 2025 PRACTICE: in 2025 these lines were {category_2025} under "
            f"{_fmt_entry(e25)}; from {NEW_DATE} they are {code} ({(e26 or {}).get('treatment', '?')}) "
            f"under {_fmt_entry(e26)}, because {o.why}.",
            f"rulebook/CHANGES.md: {o.changes_row}")

    # 2. generic new exclusion pointed at by master data
    new_only = rb.only_in(NEW_VERSION)
    for hint in nature.hints():
        if hint in new_only and hint != category_2025 and category_2025 == "RELEVANT":
            e26 = rb.in_force(hint, NEW_DATE)
            if e26:
                return VersionMapping(
                    "changed", category_2025, e25_id, hint, e26["id"], e26["treatment"],
                    f"DIFFERS FROM 2025 PRACTICE: in 2025 these lines were {category_2025} under "
                    f"{_fmt_entry(e25)}; {hint} is a new category in {NEW_VERSION} "
                    f"({_fmt_entry(e26)}: {e26['title']}), effective {NEW_DATE}.",
                    "rulebook/CHANGES.md: New exclusions")

    # 3. same code in 2026
    e26 = rb.in_force(category_2025, NEW_DATE)
    if e26:
        notes = []
        if e25 and e25["treatment"] != e26["treatment"]:
            notes.append(f"treatment changes from {e25['treatment']} to {e26['treatment']}")
        if e25 and e25.get("cap_limit_usd_minor") != e26.get("cap_limit_usd_minor"):
            notes.append(f"limit changes from {e25.get('cap_limit_usd_minor')} to "
                         f"{e26.get('cap_limit_usd_minor')} USD minor")
        if notes and e25 and e25["treatment"] != e26["treatment"]:
            status = "changed"
        else:
            status = "same"
        expl = f"same category in {NEW_VERSION}: {category_2025} under {_fmt_entry(e26)}"
        if e25:
            expl += f" (2025: {_fmt_entry(e25)})"
        if notes:
            expl += "; " + "; ".join(notes)
        return VersionMapping(status, category_2025, e25_id, category_2025, e26["id"], e26["treatment"],
                              expl, "generic: same category_code")

    # 4. no 2026 home
    removed = rb.only_in(OLD_VERSION)
    why = (f"{category_2025} exists only in {OLD_VERSION} and was removed in {NEW_VERSION}"
           if category_2025 in removed else f"{category_2025} has no entry in force on {NEW_DATE}")
    return VersionMapping("ask", category_2025, e25_id, None, None, None,
                          f"2025 practice was {category_2025} under {_fmt_entry(e25)}, but {why}; "
                          f"these lines must be re-asked, not carried forward.",
                          "generic: no 2026 entry")
