"""Pure parsing helpers for the FIA official-documents pages.

No network or Apify calls live here so the selectors can be unit-tested
against a saved copy of the official listing HTML.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup

FIA_ORIGIN = "https://www.fia.com"
F1_CHAMPIONSHIP_PATH = "/documents/championships/fia-formula-one-world-championship-14"
F1_CHAMPIONSHIP_URL = FIA_ORIGIN + F1_CHAMPIONSHIP_PATH

# Titles that indicate a stewards' decision or an official classification.
# Everything else on the event page (entry lists, track maps, scrutineering
# notes, ...) is skipped unless the caller asks for "all".
DECISION_OR_CLASSIFICATION = re.compile(
    r"infringement|decision|offence|summons|penalt|reprimand|disqualif|"
    r"classification|protest|right of review|appeal|warning|fine\b",
    re.IGNORECASE,
)
DOC_NUMBER = re.compile(r"^\s*Doc\s+(\d+)\s*-\s*", re.IGNORECASE)


@dataclass(frozen=True)
class DocumentRow:
    title: str
    document_url: str
    document_number: str
    published_at: str


@dataclass(frozen=True)
class ParsedListing:
    rows: list[DocumentRow]
    recalled_count: int


def slugify(text: str) -> str:
    """'São Paulo Grand Prix' -> 'sao-paulo-grand-prix'."""
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def canonical_url(href: str, base: str = FIA_ORIGIN) -> str:
    """Absolute, percent-encoded URL with lower-case host and no fragment.

    FIA hrefs contain raw spaces and parentheses; unquote-then-quote makes
    the result identical whether the input was encoded or not.
    """
    parts = urlsplit(urljoin(base, href.strip()))
    path = quote(unquote(parts.path), safe="/")
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def _option_values(html: str) -> list[tuple[str, str]]:
    soup = BeautifulSoup(html, "html.parser")
    return [(o.get("value", ""), o.get_text(strip=True)) for o in soup.select("select option")]


def find_season_url(championship_html: str, season: int) -> str | None:
    """Locate the season-filtered listing (e.g. /season/season-2024-2043)."""
    pattern = re.compile(rf"/season/season-{season}-\d+$")
    for value, label in _option_values(championship_html):
        if pattern.search(value) and label.upper() == f"SEASON {season}":
            return canonical_url(value)
    return None


def find_event_url(season_html: str, season: int, event_slug: str) -> tuple[str, str] | None:
    """Return (event_url, official event name) whose name slugifies to event_slug."""
    pattern = re.compile(rf"/season/season-{season}-\d+/event/([^/]+)$")
    for value, _label in _option_values(season_html):
        match = pattern.search(value)
        if not match:
            continue
        event_name = unquote(match.group(1))
        if slugify(event_name) == event_slug:
            return canonical_url(value), event_name
    return None


def parse_document_rows(event_html: str, page_url: str) -> ParsedListing:
    soup = BeautifulSoup(event_html, "html.parser")
    rows: list[DocumentRow] = []
    recalled = 0
    for li in soup.select("li.document-row"):
        # Recalled documents keep their title on the page but lose their link.
        if li.select_one(".recalled-document") is not None:
            recalled += 1
            continue
        link = li.select_one("a[href]")
        title_node = li.select_one(".title .field-item")
        if link is None or title_node is None:
            continue
        title = " ".join(title_node.get_text(" ", strip=True).split())
        number = DOC_NUMBER.match(title)
        published_node = li.select_one(".published .field-item")
        published = ""
        if published_node is not None:
            published = " ".join(published_node.get_text(" ", strip=True).split())
            published = re.sub(r"^Published on\s+", "", published, flags=re.IGNORECASE)
        rows.append(
            DocumentRow(
                title=title,
                document_url=canonical_url(link["href"], base=page_url),
                document_number=number.group(1) if number else "",
                published_at=published,
            )
        )
    return ParsedListing(rows=rows, recalled_count=recalled)


def is_decision_or_classification(title: str) -> bool:
    return DECISION_OR_CLASSIFICATION.search(title) is not None
