"""Classify FIA document titles and parse FIA publication times.

Pure functions, no network. Used by the finance router to turn an
`fia_document_discovered` envelope into a typed sporting event.

A title is evidence of what a document is about, never of what it decided:
`likely_outcome` is a hint for routing, and `outcome_confirmed` stays False
until the decision text itself has been read.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

# fia.com prints times labelled "CET" all year, but they are Central European
# *local* time (CEST in summer). Checked against real captures: the 2024 Belgian
# GP provisional classification at "16:40 CET" is 14:40 UTC, ten minutes after
# the chequered flag; the 2023 US GP one at "23:01 CET" is 21:01 UTC.
FIA_TZ = ZoneInfo("Europe/Paris")
_PUBLISHED = re.compile(r"^\s*(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})(?:\s+[A-Z]{3,4})?\s*$")

_DOC_PREFIX = re.compile(r"^\s*Doc\s+\d+\s*-\s*", re.IGNORECASE)
_CARS = re.compile(r"\bCars?\s+((?:\d{1,2})(?:\s*(?:,|and|&)\s*\d{1,2})*)", re.IGNORECASE)

KINDS = (
    "provisional_race_classification",
    "final_race_classification",
    "provisional_sprint_classification",
    "final_sprint_classification",
    "qualifying_classification",
    "infringement",
    "decision",
    "summons",
    "other",
)


@dataclass(frozen=True)
class DocClass:
    kind: str
    cars: tuple[int, ...] = field(default_factory=tuple)
    subject: str = ""
    likely_outcome: str | None = None  # 'disqualification' | 'penalty' | None
    outcome_confirmed: bool = False


def parse_published_at(text: str) -> str | None:
    """'28.07.24 16:40 CET' -> '2024-07-28T14:40:00Z'. None if unparseable."""
    match = _PUBLISHED.match(text or "")
    if not match:
        return None
    dd, mm, yy, hh, mi = (int(g) for g in match.groups())
    local = datetime(2000 + yy, mm, dd, hh, mi, tzinfo=FIA_TZ)
    return local.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _cars(title: str) -> tuple[int, ...]:
    match = _CARS.search(title)
    if not match:
        return ()
    return tuple(int(n) for n in re.findall(r"\d{1,2}", match.group(1)))


def classify_title(title: str) -> DocClass:
    bare = _DOC_PREFIX.sub("", " ".join((title or "").split()))
    low = bare.lower()
    cars = _cars(bare)

    if "classification" in low:
        stage = "provisional" if "provisional" in low else "final" if "final" in low else None
        if "qualifying" in low or "shootout" in low:
            return DocClass("qualifying_classification", cars, bare)
        if stage and "sprint" in low:
            return DocClass(f"{stage}_sprint_classification", cars, bare)
        if stage and "race" in low:
            return DocClass(f"{stage}_race_classification", cars, bare)
        return DocClass("other", cars, bare)

    if low.startswith("summons"):
        return DocClass("summons", cars, bare)

    if low.startswith("infringement") or "disqualif" in low:
        if "disqualif" in low or "technical non-compliance" in low:
            # Technical non-compliance after a race usually means disqualification,
            # but only the decision text can confirm it.
            return DocClass("infringement", cars, bare, likely_outcome="disqualification")
        if "deleted lap times" in low:
            return DocClass("infringement", cars, bare)
        return DocClass("infringement", cars, bare, likely_outcome="penalty")

    if low.startswith("decision"):
        outcome = "penalty" if re.search(r"penalt|time|grid|drive.through", low) else None
        return DocClass("decision", cars, bare, likely_outcome=outcome)

    return DocClass("other", cars, bare)


def weekend_timeline(items: list[dict]) -> list[dict]:
    """Order one event's documents by real publication time, classified.

    Returns dicts with published_at_utc, kind, cars, title, document_url,
    oldest first. Items whose time can't be parsed go last, in input order.
    """
    rows = []
    for index, item in enumerate(items):
        cls = classify_title(item.get("title", ""))
        rows.append(
            {
                "published_at_utc": parse_published_at(item.get("published_at", "")),
                "kind": cls.kind,
                "cars": list(cls.cars),
                "likely_outcome": cls.likely_outcome,
                "title": cls.subject,
                "document_url": item.get("document_url", ""),
                "_order": index,
            }
        )
    rows.sort(key=lambda r: (r["published_at_utc"] is None, r["published_at_utc"] or "", r["_order"]))
    for row in rows:
        del row["_order"]
    return rows
