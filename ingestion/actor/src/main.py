"""fia-document-monitor: discover official FIA decision documents for one event.

Emits metadata only (title, official link, document number, publication
time). It does not download PDFs and makes no claim about what a document
decided — a listing entry is evidence that a document exists, nothing more.
"""

from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime

import httpx
from apify import Actor

from .fia import (
    F1_CHAMPIONSHIP_URL,
    FIA_ORIGIN,
    find_event_url,
    find_season_url,
    is_decision_or_classification,
    parse_document_rows,
)

USER_AGENT = "Mozilla/5.0 (compatible; PitWall-FIA-Document-Monitor/0.1)"
MAX_ATTEMPTS = 3


async def fetch(client: httpx.AsyncClient, url: str) -> str:
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = await client.get(url)
            response.raise_for_status()
            return response.text
        except httpx.HTTPError as exc:
            if attempt == MAX_ATTEMPTS:
                raise
            Actor.log.warning(f"GET {url} failed ({exc!r}); retry {attempt}/{MAX_ATTEMPTS - 1}")
            await asyncio.sleep(2 * attempt)
    raise AssertionError("unreachable")


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        season = int(actor_input.get("season", 2024))
        event_slug = str(actor_input.get("event_slug", "belgian-grand-prix")).strip().lower()
        max_items = max(1, min(int(actor_input.get("max_items", 100)), 100))
        document_filter = actor_input.get("document_filter", "decisions_and_classifications")

        async with httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT},
            timeout=30,
            follow_redirects=True,
        ) as client:
            championship_html = await fetch(client, F1_CHAMPIONSHIP_URL)
            season_url = find_season_url(championship_html, season)
            if season_url is None:
                await Actor.fail(status_message=f"Season {season} not listed on {F1_CHAMPIONSHIP_URL}")
                return

            event = find_event_url(await fetch(client, season_url), season, event_slug)
            if event is None:
                await Actor.fail(status_message=f"Event '{event_slug}' not listed for season {season}")
                return
            event_url, event_name = event

            event_html = await fetch(client, event_url)

        listing = parse_document_rows(event_html, page_url=event_url)
        selected = [
            row
            for row in listing.rows
            if document_filter == "all" or is_decision_or_classification(row.title)
        ][:max_items]

        discovered_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        items = [
            {
                "source": "fia",
                "season": season,
                "event_slug": event_slug,
                "event_name": event_name,
                "document_number": row.document_number,
                "title": row.title,
                "document_url": row.document_url,
                "source_page_url": event_url,
                "published_at": row.published_at,
                "discovered_at": discovered_at,
            }
            for row in selected
            if row.document_url.startswith(FIA_ORIGIN + "/")
        ]
        await Actor.push_data(items)

        # Keep the exact listing page this run parsed, so every dataset item
        # can be traced back to bytes the FIA actually served.
        listing_sha256 = hashlib.sha256(event_html.encode()).hexdigest()
        await Actor.set_value("LISTING_SNAPSHOT", event_html, content_type="text/html; charset=utf-8")
        await Actor.set_value(
            "RUN_SUMMARY",
            {
                "season": season,
                "event_slug": event_slug,
                "event_name": event_name,
                "source_page_url": event_url,
                "listing_sha256": listing_sha256,
                "documents_on_page": len(listing.rows),
                "recalled_skipped": listing.recalled_count,
                "document_filter": document_filter,
                "items_pushed": len(items),
                "discovered_at": discovered_at,
            },
        )
        message = (
            f"{len(items)} documents pushed for {season} {event_name} "
            f"({len(listing.rows)} listed, {listing.recalled_count} recalled skipped)"
        )
        Actor.log.info(message)
        await Actor.set_status_message(message)
