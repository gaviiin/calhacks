"""fia-decision-reader: read official FIA decision PDFs already discovered.

Input is listing items from fia-document-monitor. This Actor downloads each
official PDF, quotes the decision text, and records cars, offence, and outcome
only when those words are in the PDF. It does not create a journal entry.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
from datetime import UTC, datetime

from apify import Actor
from impit import AsyncClient, HTTPError
from pypdf import PdfReader

from .extract import is_official_fia_url, parse_decision

MAX_ATTEMPTS = 3


async def download(client: AsyncClient, url: str):
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = await client.get(url)
            response.raise_for_status()
            return response
        except HTTPError as exc:
            if attempt == MAX_ATTEMPTS:
                raise
            Actor.log.warning(f"GET {url} failed ({exc!r}); retry {attempt}/{MAX_ATTEMPTS - 1}")
            await asyncio.sleep(2 * attempt)
    raise AssertionError("unreachable")


def supplied_pdf(item: dict) -> bytes | None:
    raw = item.get("pdf_base64")
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        data = base64.b64decode(raw, validate=True)
    except ValueError:
        return None
    if not data.startswith(b"%PDF") or len(data) > 8_000_000:
        return None
    return data


def pdf_text(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def _listing_fields(item: dict) -> dict:
    return {
        "source": item.get("source", ""),
        "season": item.get("season"),
        "event_slug": item.get("event_slug", ""),
        "event_name": item.get("event_name", ""),
        "document_number": str(item.get("document_number", "") or ""),
        "title": item.get("title", ""),
        "document_url": item.get("document_url", ""),
        "source_page_url": item.get("source_page_url", ""),
    }


async def main() -> None:
    async with Actor:
        actor_input = await Actor.get_input() or {}
        raw_items = actor_input.get("items") or []
        if not isinstance(raw_items, list):
            await Actor.fail(status_message="items must be a list of listing documents")
            return
        max_items = max(1, min(int(actor_input.get("max_items", 10)), 100))
        only_number = str(actor_input.get("document_number", "") or "").strip()
        selected = []
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            if only_number and str(item.get("document_number", "") or "") != only_number:
                continue
            selected.append(item)
            if len(selected) >= max_items:
                break

        extracted_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        pushed: list[dict] = []
        skipped: list[dict] = []
        hashes: dict[str, str] = {}

        async with AsyncClient(browser="chrome", timeout=60) as client:
            for item in selected:
                url = str(item.get("document_url", "") or "").strip()
                label = str(item.get("title", "") or url)
                if not is_official_fia_url(url):
                    skipped.append({"document_url": url, "reason": "not an official https://www.fia.com/ URL"})
                    Actor.log.warning(f"skip {label}: not an official FIA URL")
                    continue
                # FIA's file host answers 404 to Apify's network. The bridge may
                # attach the PDF it already fetched from the official URL.
                body = supplied_pdf(item)
                if body is None and item.get("pdf_base64"):
                    skipped.append({"document_url": url, "reason": "supplied pdf_base64 is not a PDF"})
                    Actor.log.warning(f"skip {label}: supplied pdf_base64 is not a PDF")
                    continue
                if body is None:
                    try:
                        response = await download(client, url)
                    except HTTPError as exc:
                        skipped.append({"document_url": url, "reason": f"download failed: {exc}"})
                        Actor.log.warning(f"skip {label}: download failed ({exc})")
                        continue
                    body = response.content
                    content_type = response.headers.get("content-type", "")
                    if "pdf" not in content_type.lower() and not body.startswith(b"%PDF"):
                        skipped.append({"document_url": url, "reason": "response is not a PDF"})
                        Actor.log.warning(f"skip {label}: response is not a PDF")
                        continue
                text = pdf_text(body)
                if not text.strip():
                    skipped.append({"document_url": url, "reason": "no extractable text"})
                    Actor.log.warning(f"skip {label}: no extractable text")
                    continue
                parsed = parse_decision(text, title=str(item.get("title", "") or ""))
                sha = hashlib.sha256(body).hexdigest()
                hashes[url] = sha
                pushed.append(
                    {
                        **_listing_fields(item),
                        "cars": parsed.cars,
                        "offence": parsed.offence,
                        "outcome": parsed.outcome,
                        "excerpt": parsed.excerpt,
                        "pdf_sha256": sha,
                        "extracted_at": extracted_at,
                    }
                )

        if pushed:
            await Actor.push_data(pushed)
        await Actor.set_value("PDF_SHA256", hashes)
        summary = {
            "items_requested": len(selected),
            "items_pushed": len(pushed),
            "skipped": skipped,
            "extracted_at": extracted_at,
        }
        await Actor.set_value("RUN_SUMMARY", summary)
        message = f"{len(pushed)} decisions read, {len(skipped)} skipped"
        Actor.log.info(message)
        await Actor.set_status_message(message)
