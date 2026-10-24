import json
from pathlib import Path

import pytest

import ingest
from src import fia

INGESTION = Path(__file__).resolve().parent.parent
GOOD = json.loads((INGESTION / "sample_item.json").read_text())["items"][0]
INVALID = json.loads((INGESTION / "sample_invalid_items.json").read_text())["items"]
NOW = "2026-10-24T06:00:00Z"


def norm(item, mode="live_actor_run", run_id="AbCdEfGhIjKlMnOpQ"):
    return ingest.normalize(item, actor_run_id=run_id, ingest_mode=mode, ingested_at=NOW)


def test_normalizes_fixture_to_reducer_args():
    record = norm(GOOD)
    assert record["document_url"].endswith("Technical%20non-compliance%20%28Weight%29.pdf")
    assert record["doc_key"] == ingest.doc_key("fia", 2024, "belgian-grand-prix", record["document_url"])
    assert set(record) == {
        "doc_key", "source", "season", "event_slug", "event_name", "document_number", "title",
        "document_url", "source_page_url", "published_at", "actor_run_id", "ingest_mode", "ingested_at",
    }


def test_doc_key_is_stable_across_url_encodings_and_runs():
    encoded = dict(GOOD, document_url=fia.canonical_url(GOOD["document_url"]))
    assert norm(GOOD)["doc_key"] == norm(encoded, run_id="ZZZZZZZZZZZZZZZZZ")["doc_key"]


def test_doc_key_differs_per_event():
    assert norm(GOOD)["doc_key"] != norm(dict(GOOD, event_slug="british-grand-prix"))["doc_key"]


@pytest.mark.parametrize("item", INVALID, ids=lambda i: i.get("title") or "blank-title")
def test_rejects_invalid_items(item):
    with pytest.raises(ValueError):
        norm(item)


@pytest.mark.parametrize(
    "change",
    [{"source": "fake"}, {"season": "2024"}, {"season": True}, {"event_slug": "Belgian GP"},
     {"source_page_url": "https://evil.example/"}],
)
def test_rejects_bad_fields(change):
    with pytest.raises(ValueError):
        norm(dict(GOOD, **change))


@pytest.mark.parametrize(
    "href",
    [
        "/sites/default/files/decision-document/2024 Belgian Grand Prix - Doc (1).pdf",
        "https://WWW.FIA.COM/sites/default/files/decision-document/2024%20Belgian%20Grand%20Prix%20-%20Doc%20%281%29.pdf#p2",
    ],
)
def test_bridge_and_actor_canonicalize_identically(href):
    assert ingest.canonical_url(href) == fia.canonical_url(href)
    assert ingest.canonical_url(ingest.canonical_url(href)) == ingest.canonical_url(href)


def test_envelope_shape():
    event = ingest.envelope(norm(GOOD))
    assert event["type"] == "fia_document_discovered"
    assert event["actor_run_id"] == "AbCdEfGhIjKlMnOpQ"
