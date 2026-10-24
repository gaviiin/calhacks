"""Build rulebook/rulebook.json from the extracted FIA Financial Regulations text.

Two rule versions:
  ISS22       FIA Formula 1 Financial Regulations, Issue 22 (11 Dec 2024), in force 2021-01-01 .. 2025-12-31.
              Exclusions are Article 3.1(a)-(y); adjustments are Article 4.1(a)-(n).
  SECD-ISS07  2026 F1 Regulations Section D (Financial, F1 Teams), Issue 07 (25 Jun 2026), in force from 2026-01-01.
              Exclusions are Article D5.1.1.a-aa; adjustments are Article D6.1.1.a-q.

Each entry's `text` is copied from the regulation, not paraphrased. The agents cite entries by id;
code resolves the article, so the model never types an article number.

Run:  uv run python -m rulebook.build_rulebook
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIA = ROOT / "research" / "fia"
OUT = ROOT / "rulebook" / "rulebook.json"


@dataclass(frozen=True)
class Version:
    rule_version: str
    source_file: str
    effective_from: str
    effective_to: str | None
    exclusion_start: str  # regex for the first line of the exclusions article
    exclusion_end: str  # regex for the line after the last exclusion item
    adjustment_start: str
    adjustment_end: str
    label_style: str  # "dot" for "a." labels, "paren" for "(a)" labels
    exclusion_article: str  # format string, {letter}
    adjustment_article: str
    furniture: tuple[str, ...]


SECD = Version(
    rule_version="SECD-ISS07",
    source_file="secD_iss07.txt",
    effective_from="2026-01-01",
    effective_to=None,
    exclusion_start=r"^D5\.1\.1\s",
    exclusion_end=r"^D5\.1\.2\s",
    adjustment_start=r"^D6\.1\.1\s",
    adjustment_end=r"^D6\.1\.2\s",
    label_style="dot",
    exclusion_article="D5.1.1.{letter}",
    adjustment_article="D6.1.1.{letter}",
    furniture=(
        r"^=== PAGE \d+ ===$",
        r"^SECTION D: FINANCIAL REGULATIONS",
        r"^D\d+ 2026 Formula 1: Financial Regulations",
        r"^©2026 Fédération",
        r"^25 June 2026$",
        r"^Issue 07$",
        r"^0$",
        r"^D$",
    ),
)

ISS22 = Version(
    rule_version="ISS22",
    source_file="finreg_iss22_2024.txt",
    effective_from="2021-01-01",
    effective_to="2025-12-31",
    exclusion_start=r"^3\.1\s",
    exclusion_end=r"^3\.2\s",
    adjustment_start=r"^4\.1\s",
    adjustment_end=r"^4\.2\s",
    label_style="paren",
    exclusion_article="3.1({letter})",
    adjustment_article="4.1({letter})",
    furniture=(
        r"^=== PAGE \d+ ===$",
        r"^Formula 1 Financial Regulations\s+\d+\s+11 December 2024$",
        r"^© 2024 Fédération",
    ),
)

# letter -> (category_code, keyword that must appear in the item's first line, after normalisation)
# The keyword disambiguates top-level items from nested sub-items that reuse the same label.
SECD_EXCLUSIONS = {
    "a": ("MARKETING", "marketing activities"),
    "b": ("F1_DRIVER", "f1 driver"),
    "c": ("OTHER_DRIVER_ACADEMY", "other racing driver and academy"),
    "d": ("EXCLUDED_PERSONS", "three individuals"),
    "e": ("HERITAGE", "heritage asset"),
    "f": ("FINANCE_COSTS", "finance costs"),
    "g": ("CORP_TAX", "corporate income tax"),
    "h": ("NON_F1", "non-f1 activities"),
    "i": ("HR_FINANCE_LEGAL", "human resources"),
    "j": ("PROPERTY", "property costs"),
    "k": ("BONUS", "employee bonus costs"),
    "l": ("FIA_FEES", "the following amounts"),
    "m": ("FINES", "financial penalties"),
    "n": ("PU_SUPPLY", "power unit supply perimeter"),
    "o": ("DEPRECIATION", "all amounts of"),
    "p": ("FX", "foreign exchange"),
    "q": ("SOCIAL_SECURITY", "social security"),
    "r": ("COMPETITION_TRAVEL", "hotel costs"),
    "s": ("ALT_FUEL_DEV", "alternative fuel"),
    "t": ("FUEL", "homologated fuel"),
    "u": ("STAFF_ENTERTAINMENT", "entertainment"),
    "v": ("PARENTAL_LEAVE", "maternity leave"),
    "w": ("INDEFINITE_SICK", "consideration"),
    "x": ("SUSTAINABILITY", "sustainability"),
    "y": ("HEALTH_SAFETY", "health and safety"),
    "z": ("CATERING", "catering"),
    "aa": ("BCDR", "business continuity"),
}

ISS22_EXCLUSIONS = {
    "a": ("MARKETING", "marketing activities"),
    "b": ("F1_DRIVER", "f1 driver"),
    "c": ("OTHER_DRIVER_ACADEMY", "other racing driver"),
    "d": ("EXCLUDED_PERSONS", "three individuals"),
    "e": ("HERITAGE", "heritage asset"),
    "f": ("FINANCE_COSTS", "finance costs"),
    "g": ("CORP_TAX", "corporate income tax"),
    "h": ("NON_F1", "with respect to non-f1"),
    "i": ("HR_FINANCE_LEGAL", "human resources"),
    "j": ("PROPERTY", "property costs"),
    "k": ("BONUS", "employee bonus costs"),
    "l": ("FIA_FEES", "the following amounts"),
    "m": ("FINES", "financial penalties"),
    "n": ("PU_SUPPLY", "power unit supply perimeter"),
    "o": ("DEPRECIATION", "depreciation"),
    "p": ("FX", "foreign exchange"),
    "q": ("SOCIAL_SECURITY", "social"),
    "r": ("COMPETITION_TRAVEL", "flight, rail travel"),
    "s": ("ALT_FUEL_DEV", "alternative fuel"),
    "t": ("STAFF_ENTERTAINMENT", "entertainment"),
    "u": ("PARENTAL_LEAVE", "maternity leave"),
    "v": ("SICK_COVER", "consideration"),
    "w": ("INDEFINITE_SICK", "consideration"),
    "x": ("TERMINATION_2021_22", "termination benefits"),
    "y": ("SUSTAINABILITY", "sustainability"),
}

SECD_ADJUSTMENTS = {
    "a": ("ADJ_RELATED_PARTY_FAIR_VALUE", "related party transactions"),
    "b": ("ADJ_GRANT_GROSS_UP", "offsetting of income"),
    "c": ("ADJ_RND_TIMING", "research and development"),
    "d": ("ADJ_CAR_CAPITALISATION", "capitalisation of f1 cars"),
    "e": ("ADJ_USED_INVENTORY", "inventories"),
    "f": ("ADJ_PU_SSC_FAIR_VALUE", "use of power units"),
    "g": ("ADJ_UNRECORDED_COSTS", "unrecorded costs"),
    "h": ("ADJ_FX_RETRANSLATION", "foreign exchange transaction"),
    "i": ("ADJ_TYRE_TEST_DAYS", "tyre test days"),
    "j": ("ADJ_NON_F1_REVERSAL", "non-f1 activities pursuant to fia-doc-101"),
    "k": ("ADJ_DEPRECIATION_IAS16", "measurement of costs of plant"),
    "l": ("ADJ_PE_CLAWBACK", "plant and equipment clawback"),
    "m": ("ADJ_IMPAIRMENT_CLAWBACK", "impairment clawback"),
    "n": ("ADJ_UNUSED_CAP_CARRYFORWARD", "unused cost cap amount"),
    "o": ("ADJ_CONSIDERATION_FACTOR", "relevant employee consideration"),
    "p": ("ADJ_SPRINT", "sprint"),
    "q": ("ADJ_PU_INTEGRATION_2027_28", "2027 and 2028 power unit"),
}

ISS22_ADJUSTMENTS = {
    "a": ("ADJ_RELATED_PARTY_FAIR_VALUE", "related party transactions"),
    "b": ("ADJ_GRANT_GROSS_UP", "offsetting of income"),
    "c": ("ADJ_RND_TIMING", "research and development"),
    "d": ("ADJ_CAR_CAPITALISATION", "capitalisation of f1 cars"),
    "e": ("ADJ_CAPEX_LIMIT", "capital expenditure"),
    "f": ("ADJ_USED_INVENTORY", "inventories"),
    "g": ("ADJ_PU_SSC_FAIR_VALUE", "use of power units"),
    "h": ("ADJ_UNRECORDED_COSTS", "unrecorded costs"),
    "i": ("ADJ_FX_RETRANSLATION", "foreign exchange transaction"),
    "j": ("ADJ_TERMINATION_REENGAGED", "employee termination benefits"),
    "k": ("ADJ_TYRE_TEST_DAYS", "tyre test days"),
    "l": ("ADJ_SPRINT", "sprint"),
    "m": ("ADJ_RDEC_EQUIVALENCE", "rdec equivalence"),
    "n": ("ADJ_NON_F1_REVERSAL", "during the reporting period, conditions"),
}

TITLES = {
    "RELEVANT": "Relevant Costs (inside the cap)",
    "MARKETING": "Marketing Activities",
    "F1_DRIVER": "F1 driver consideration, travel and accommodation",
    "OTHER_DRIVER_ACADEMY": "Other racing drivers and Academy programme",
    "EXCLUDED_PERSONS": "Three highest-paid individuals",
    "HERITAGE": "Heritage Asset Activities",
    "FINANCE_COSTS": "Finance Costs",
    "CORP_TAX": "Corporate Income Tax",
    "NON_F1": "Non-F1 Activities",
    "HR_FINANCE_LEGAL": "Human Resources, Finance and Legal Activities",
    "PROPERTY": "Property Costs",
    "BONUS": "Employee Bonus Costs (up to the limit)",
    "FIA_FEES": "FIA entry, super licence and Commercial Rights Holder payments",
    "FINES": "FIA financial penalties and fines",
    "PU_SUPPLY": "Power Unit Supply Perimeter purchases up to the maximum price",
    "DEPRECIATION": "Depreciation, amortisation, impairment and disposals (excluded portion)",
    "FX": "Foreign exchange gains and losses",
    "SOCIAL_SECURITY": "Mandatory employer social security contributions",
    "COMPETITION_TRAVEL": "Travel and accommodation for Competitions and testing",
    "ALT_FUEL_DEV": "Alternative fuel and oil development with the PU supplier",
    "FUEL": "FIA homologated fuel",
    "STAFF_ENTERTAINMENT": "All-staff entertainment (up to the limit)",
    "PARENTAL_LEAVE": "Parental leave",
    "SICK_COVER": "Cover for employees on sick leave",
    "INDEFINITE_SICK": "Indefinite sick or disability leave",
    "TERMINATION_2021_22": "Employee termination benefits 2021-2022",
    "SUSTAINABILITY": "Sustainability Initiative Costs",
    "HEALTH_SAFETY": "Health and Safety Costs",
    "CATERING": "Catering at Competitions, testing and team premises",
    "BCDR": "Business continuity and disaster recovery (up to the limit)",
    "ADJ_RELATED_PARTY_FAIR_VALUE": "Related party, exchange, inter-team and PU transactions at fair value",
    "ADJ_GRANT_GROSS_UP": "Offsetting of income and costs (gross up)",
    "ADJ_RND_TIMING": "R&D recognised in the period incurred",
    "ADJ_CAR_CAPITALISATION": "Capitalised F1 car costs expensed",
    "ADJ_CAPEX_LIMIT": "Capital expenditure above the limit",
    "ADJ_USED_INVENTORY": "Inventories: used, unused and redundant",
    "ADJ_PU_SSC_FAIR_VALUE": "In-group power units and standard supply components at fair value",
    "ADJ_UNRECORDED_COSTS": "Unrecorded costs or losses",
    "ADJ_FX_RETRANSLATION": "Foreign exchange retranslation at the Applicable Rate",
    "ADJ_TERMINATION_REENGAGED": "Termination benefits clawed back on re-engagement",
    "ADJ_TYRE_TEST_DAYS": "Tyre test day downward adjustment",
    "ADJ_NON_F1_REVERSAL": "Non-F1 exclusions reversed when conditions cease",
    "ADJ_DEPRECIATION_IAS16": "Plant and equipment measured on IAS 16 straight line, zero residual",
    "ADJ_PE_CLAWBACK": "Clawback of 2023-25 accelerated depreciation",
    "ADJ_IMPAIRMENT_CLAWBACK": "Clawback of excluded impairments",
    "ADJ_UNUSED_CAP_CARRYFORWARD": "Unused cost cap amount carried forward",
    "ADJ_CONSIDERATION_FACTOR": "Relevant Employee Consideration factor",
    "ADJ_SPRINT": "Sprint downward adjustment",
    "ADJ_RDEC_EQUIVALENCE": "RDEC equivalence for non-UK teams",
    "ADJ_PU_INTEGRATION_2027_28": "2027/28 power unit integration downward adjustment",
}

# USD minor units (cents). Only where the regulation states a fixed USD ceiling.
CAP_LIMITS = {
    ("SECD-ISS07", "STAFF_ENTERTAINMENT"): 120_000_000,  # USD 1,200,000
    ("ISS22", "STAFF_ENTERTAINMENT"): 100_000_000,  # USD 1,000,000
    ("SECD-ISS07", "BCDR"): 150_000_000,  # USD 1,500,000
    ("SECD-ISS07", "ADJ_UNUSED_CAP_CARRYFORWARD"): 200_000_000,  # USD 2,000,000
}


@dataclass
class Entry:
    id: str
    category_code: str
    treatment: str
    rule_version: str
    article: str
    effective_from: str
    effective_to: str | None
    title: str
    text: str
    cap_limit_usd_minor: int | None


def normalise(s: str) -> str:
    s = s.replace("‐", "-").replace("‑", "-").replace("’", "'")
    s = s.replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip()


def clean_lines(path: Path, furniture: tuple[str, ...]) -> list[str]:
    pats = [re.compile(p) for p in furniture]
    out = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        # Issue 22's text layer uses non-breaking spaces everywhere; collapse all whitespace
        # first so the furniture patterns (written with plain spaces) match.
        line = normalise(raw)
        if not line or any(p.search(line) for p in pats):
            continue
        out.append(line)
    return out


def article_block(lines: list[str], start: str, end: str) -> list[str]:
    s, e = re.compile(start), re.compile(end)
    begin = next((i for i, ln in enumerate(lines) if s.search(ln)), None)
    if begin is None:
        raise SystemExit(f"start marker {start!r} not found")
    stop = next((i for i in range(begin + 1, len(lines)) if e.search(lines[i])), None)
    if stop is None:
        raise SystemExit(f"end marker {end!r} not found after {start!r}")
    return lines[begin:stop]


def label_regex(letter: str, style: str) -> re.Pattern[str]:
    if style == "dot":
        # SECD uses "a. text", and occasionally "w  text" with the dot lost in extraction.
        return re.compile(rf"^{letter}(?:\.\s*|\s{{2,}}|\s+(?=all\b))(.*)$")
    return re.compile(rf"^\({letter}\)\s*(.*)$")


def split_items(block: list[str], spec: dict[str, tuple[str, str]], style: str) -> dict[str, str]:
    """Walk the block once, starting a new item only at the expected next label whose first
    line contains the expected keyword. Nested sub-items reuse labels (h.a, c.i, ...), so the
    keyword check is what keeps them attached to their parent."""
    letters = list(spec)
    items: dict[str, list[str]] = {}
    current: str | None = None
    want = 0
    for line in block[1:]:  # skip the article's own opening line
        if want < len(letters):
            letter = letters[want]
            m = label_regex(letter, style).match(line)
            if m:
                _, keyword = spec[letter]
                # the keyword may wrap onto the next line; check this line plus a little lookahead
                if keyword in normalise(m.group(1)).lower() or _keyword_soon(block, line, keyword):
                    current = letter
                    items[current] = [m.group(1)]
                    want += 1
                    continue
        if current is not None:
            items[current].append(line)
    missing = [ltr for ltr in letters if ltr not in items]
    if missing:
        raise SystemExit(f"could not locate items {missing}")
    return {ltr: normalise(" ".join(parts)) for ltr, parts in items.items()}


def _keyword_soon(block: list[str], line: str, keyword: str) -> bool:
    i = block.index(line)
    window = normalise(" ".join(block[i : i + 3])).lower()
    return keyword in window


def relevant_definition(lines: list[str]) -> str:
    """The definition of "Relevant Costs" from the definitions section."""
    start = next(
        (i for i, ln in enumerate(lines) if re.match(r'^["“]Relevant\s+Costs["”]\s+means', ln)),
        None,
    )
    if start is None:
        # Issue 22 states it inside Article 3 rather than as a quoted definition.
        start = next(
            (i for i, ln in enumerate(lines) if re.search(r"Relevant\s+Costs", ln) and "calculating" in ln),
            None,
        )
    if start is None:
        raise SystemExit("Relevant Costs definition not found")
    parts = [lines[start]]
    for ln in lines[start + 1 : start + 8]:
        if re.match(r'^["“][A-Z]', ln) or re.match(r"^\d+\.\d+\s", ln):
            break
        parts.append(ln)
    return normalise(" ".join(parts))


def build_version(v: Version, exclusions: dict, adjustments: dict) -> list[Entry]:
    lines = clean_lines(FIA / v.source_file, v.furniture)
    entries: list[Entry] = []

    def add(code: str, treatment: str, article: str, text: str) -> None:
        entries.append(
            Entry(
                id=f"{code}@{v.rule_version}",
                category_code=code,
                treatment=treatment,
                rule_version=v.rule_version,
                article=article,
                effective_from=v.effective_from,
                effective_to=v.effective_to,
                title=TITLES[code],
                text=text,
                cap_limit_usd_minor=CAP_LIMITS.get((v.rule_version, code)),
            )
        )

    add("RELEVANT", "RELEVANT", "Definitions: Relevant Costs", relevant_definition(lines))

    excl = split_items(article_block(lines, v.exclusion_start, v.exclusion_end), exclusions, v.label_style)
    for letter, (code, _) in exclusions.items():
        add(code, "EXCLUDED", v.exclusion_article.format(letter=letter), excl[letter])

    adj = split_items(article_block(lines, v.adjustment_start, v.adjustment_end), adjustments, v.label_style)
    for letter, (code, _) in adjustments.items():
        add(code, "ADJUSTMENT", v.adjustment_article.format(letter=letter), adj[letter])

    return entries


def main() -> int:
    entries = build_version(ISS22, ISS22_EXCLUSIONS, ISS22_ADJUSTMENTS) + build_version(
        SECD, SECD_EXCLUSIONS, SECD_ADJUSTMENTS
    )
    ids = [e.id for e in entries]
    assert len(ids) == len(set(ids)), "duplicate rulebook ids"
    OUT.write_text(json.dumps([asdict(e) for e in entries], indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    by_version: dict[str, int] = {}
    for e in entries:
        by_version[e.rule_version] = by_version.get(e.rule_version, 0) + 1
    print(f"wrote {OUT.relative_to(ROOT)}: {len(entries)} entries {by_version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
