"""Turn saved Apify captures of FIA documents into timed race-weekend events.

Uses the classifier in ingestion/actor/src/classify.py. A document only ever
becomes evidence plus a routing hint: the books change because the Final
Classification (the cached results) says so, never because of a title.
"""

from __future__ import annotations

import json
import sys
from functools import lru_cache

from .config import CAPTURES_DIR, REPO

sys.path.insert(0, str(REPO / "ingestion" / "actor"))
from src.classify import weekend_timeline  # noqa: E402


@lru_cache(maxsize=None)
def _captures(captures_dir: str) -> dict[tuple[int, str], list[dict]]:
    """(season, event_slug) -> merged, de-duplicated items from every capture of that event."""
    from pathlib import Path

    out: dict[tuple[int, str], dict[str, dict]] = {}
    for path in sorted(Path(captures_dir).glob("*.json")):
        data = json.loads(path.read_text())
        for item in data.get("items", []):
            bucket = out.setdefault((int(item["season"]), item["event_slug"]), {})
            bucket[item["document_url"]] = {**item, "actor_run_id": data.get("actor_run_id", "")}
    return {k: list(v.values()) for k, v in out.items()}


def weekend(season: int, slug: str, captures_dir=CAPTURES_DIR) -> list[dict]:
    """Classified FIA documents for one event in publication order, with session and provenance."""
    items = _captures(str(captures_dir)).get((season, slug), [])
    by_url = {i["document_url"]: i for i in items}
    rows = []
    for r in weekend_timeline(items):
        if r["published_at_utc"] is None:
            continue
        title = r["title"].lower()
        session = "sprint" if "sprint" in title else "qualifying" if ("qualifying" in title or "shootout" in title) else "race"
        src = by_url.get(r["document_url"], {})
        rows.append({**r, "session": session, "url": r["document_url"], "actor_run_id": src.get("actor_run_id", ""),
                     "document_number": src.get("document_number", ""), "raw_title": src.get("title", r["title"])})
    return rows


def has_capture(season: int, slug: str, captures_dir=CAPTURES_DIR) -> bool:
    return (season, slug) in _captures(str(captures_dir))
