"""Pure parsing for one official FIA decision PDF.

No network and no Apify calls. A field is filled only when the text contains it.
An empty outcome means the PDF did not use a recognized decision phrase.
"""

from __future__ import annotations

import re
import unicodedata
from typing import NamedTuple
from urllib.parse import urlsplit

EXCERPT_MAX = 500
OUTCOMES = (
    "no_further_action",
    "disqualification",
    "time_penalty",
    "fine",
    "reprimand",
    "warning",
)
_OUTCOME_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("no_further_action", re.compile(r"no further action", re.IGNORECASE)),
    ("disqualification", re.compile(r"disqualif", re.IGNORECASE)),
    ("time_penalty", re.compile(r"time penalty|\d+\s+seconds?\b", re.IGNORECASE)),
    ("fine", re.compile(r"\bfines?\b|\bfined\b", re.IGNORECASE)),
    ("reprimand", re.compile(r"reprimand", re.IGNORECASE)),
    ("warning", re.compile(r"\bwarning\b", re.IGNORECASE)),
)
_SECTION_LABELS = ("Fact", "Infringement", "Offence", "Decision", "Reason")
_CAR = re.compile(r"\bCar\s+(\d{1,2})\b", re.IGNORECASE)
_DRIVER_NO = re.compile(r"No\s*/\s*Driver\s+(\d{1,2})\b", re.IGNORECASE)


class DecisionExtract(NamedTuple):
    cars: str
    offence: str
    outcome: str
    excerpt: str


def is_official_fia_url(url: str) -> bool:
    parts = urlsplit(url.strip())
    return parts.scheme == "https" and parts.netloc == "www.fia.com" and len(parts.path) > 1


def normalize_pdf_text(text: str) -> str:
    """Turn PDF extraction whitespace into readable lines."""
    normalized = unicodedata.normalize("NFKC", text or "")
    normalized = normalized.replace("\u00a0", " ").replace("\u202f", " ")
    lines = [" ".join(line.split()) for line in normalized.splitlines()]
    return "\n".join(line for line in lines if line)


def _section(text: str, label: str) -> str:
    following = "|".join(_SECTION_LABELS)
    match = re.search(
        rf"(?:^|\n){label}\s+(.*?)(?=\n(?:{following})\s|\Z)",
        text,
        re.DOTALL,
    )
    if not match:
        return ""
    return " ".join(match.group(1).split())


def _cars(text: str) -> str:
    found = {int(n) for n in _CAR.findall(text)}
    found.update(int(n) for n in _DRIVER_NO.findall(text))
    return ",".join(str(n) for n in sorted(found))


def _outcome(decision: str) -> str:
    for name, pattern in _OUTCOME_PATTERNS:
        if pattern.search(decision):
            return name
    return ""


def _clip(text: str, limit: int = EXCERPT_MAX) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def parse_decision(text: str, *, title: str = "") -> DecisionExtract:
    """Read cars, offence, outcome, and a quote from PDF text."""
    cleaned = normalize_pdf_text(text)
    decision = _section(cleaned, "Decision")
    offence = _section(cleaned, "Infringement") or _section(cleaned, "Offence") or _section(cleaned, "Fact")
    if not offence:
        offence = " ".join((title or "").split())
    excerpt_source = decision or cleaned
    return DecisionExtract(
        cars=_cars(cleaned),
        offence=offence,
        outcome=_outcome(decision),
        excerpt=_clip(excerpt_source),
    )
