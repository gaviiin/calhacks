"""Runs against a local `spacetime start` server; skipped when none is running.

Republishes the module to a throwaway database (wiping it) on every run.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest

import ingest

REPO = Path(__file__).resolve().parents[2]
URL = os.environ.get("SPACETIME_TEST_URL", "http://127.0.0.1:3000")
DB = "pit-wall-itest"
CLI = shutil.which("spacetime") or str(Path.home() / ".local" / "bin" / "spacetime")


def server_up() -> bool:
    try:
        return httpx.get(f"{URL}/v1/ping", timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(not (server_up() and Path(CLI).exists()), reason="no local SpacetimeDB")


@pytest.fixture(scope="module")
def owner_db():
    subprocess.run(
        [CLI, "publish", "--server", "local", "--module-path", str(REPO / "spacetimedb"),
         "--delete-data=always", "-y", DB],
        check=True, capture_output=True, timeout=180,
    )
    return ingest.SpacetimeClient(URL, DB, ingest.local_cli_token())


@pytest.fixture(scope="module")
def stranger_token():
    return httpx.post(f"{URL}/v1/identity").json()["token"]


def fixture_batch(name="sample_item.json"):
    return ingest.load_fixture(REPO / "ingestion" / name)


def record(**overrides):
    item = fixture_batch().items[0]
    base = ingest.normalize(item, actor_run_id="", ingest_mode="test_fixture", ingested_at=ingest.utc_now())
    return {**base, **overrides}


def test_first_ingest_adds_and_replay_adds_nothing(owner_db):
    first = ingest.ingest_batch(fixture_batch(), owner_db)
    assert (first["added"], first["after"]) == (1, first["before"] + 1)
    second = ingest.ingest_batch(fixture_batch(), owner_db)
    assert (second["added"], second["duplicate"], second["after"]) == (0, 1, first["after"])


def test_reducer_is_idempotent_even_without_bridge_dedupe(owner_db):
    before = owner_db.count()
    assert owner_db.ingest(record()) == (True, "")
    assert owner_db.count() == before


def test_invalid_rows_rejected_by_bridge(owner_db):
    result = ingest.ingest_batch(fixture_batch("sample_invalid_items.json"), owner_db)
    assert result["invalid"] == 6 and result["after"] == result["before"]


@pytest.mark.parametrize(
    "overrides",
    [
        {"document_url": "http://www.fia.com/x.pdf"},
        {"document_url": "https://evil.example/x.pdf"},
        {"title": "  "},
        {"doc_key": "not-a-hash"},
        {"actor_run_id": "FAKERUNID12345678"},  # a fixture may not claim an Apify run
        {"ingest_mode": "live_actor_run"},  # ...and a live row must carry one
    ],
)
def test_reducer_validates_independently(owner_db, overrides):
    if "doc_key" not in overrides:
        overrides["doc_key"] = ingest.doc_key("fia", 2024, "x", json.dumps(overrides))
    ok, message = owner_db.ingest(record(**overrides))
    assert not ok and "invalid document" in message


def test_second_key_for_same_url_is_a_conflict(owner_db):
    ok, message = owner_db.ingest(record(doc_key="f" * 64))
    assert not ok and "conflict" in message


def test_stranger_identity_cannot_ingest(owner_db, stranger_token):
    stranger = ingest.SpacetimeClient(URL, DB, stranger_token)
    before = owner_db.count()
    with pytest.raises(ingest.IngestError, match="unauthorized"):
        stranger.ingest(record(doc_key="e" * 64, document_url="https://www.fia.com/stranger.pdf"))
    assert owner_db.count() == before


def test_anonymous_request_cannot_ingest(owner_db):
    response = httpx.post(f"{URL}/v1/database/{DB}/call/ingest_document", json=[record(doc_key="d" * 64)])
    assert response.status_code == ingest.REDUCER_REJECTED and "unauthorized" in response.text


def test_stranger_cannot_read_config_or_take_over_ingestion(stranger_token):
    headers = {"Authorization": f"Bearer {stranger_token}"}
    sql = httpx.post(f"{URL}/v1/database/{DB}/sql", content="SELECT * FROM config", headers=headers)
    assert sql.status_code != 200
    takeover = httpx.post(
        f"{URL}/v1/database/{DB}/call/set_ingestor", headers=headers,
        json=[{"__identity__": "0x" + "00" * 32}],
    )
    assert takeover.status_code != 200


def fact_record(**overrides):
    parent = record()
    base = {
        "doc_key": parent["doc_key"],
        "document_url": parent["document_url"],
        "cars": "63",
        "offence": "Breach of Article 4.1 of the FIA Formula One Technical Regulations.",
        "outcome": "disqualification",
        "excerpt": "Car 63 is disqualified from the Race classification.",
        "pdf_hash": "ab" * 32,
        "actor_run_id": "",
        "ingest_mode": "test_fixture",
        "extracted_at": ingest.utc_now(),
    }
    return {**base, **overrides}


def test_decision_fact_is_idempotent(owner_db):
    assert owner_db.ingest(record()) == (True, "")
    before = owner_db.count_facts()
    assert owner_db.ingest_decision(fact_record()) == (True, "")
    assert owner_db.count_facts() == before + 1
    assert owner_db.ingest_decision(fact_record()) == (True, "")
    assert owner_db.count_facts() == before + 1


def test_decision_fact_without_parent_is_rejected(owner_db):
    ok, message = owner_db.ingest_decision(
        fact_record(doc_key="a" * 64, document_url="https://www.fia.com/missing-parent.pdf")
    )
    assert not ok and "parent document" in message


def test_decision_fact_rejects_a_non_fia_url(owner_db):
    ok, message = owner_db.ingest_decision(fact_record(document_url="https://evil.example/x.pdf"))
    assert not ok and "documentUrl" in message


def test_stranger_cannot_store_a_decision(owner_db, stranger_token):
    stranger = ingest.SpacetimeClient(URL, DB, stranger_token)
    before = owner_db.count_facts()
    with pytest.raises(ingest.IngestError, match="unauthorized"):
        stranger.ingest_decision(fact_record(doc_key="c" * 64, document_url="https://www.fia.com/stranger-decision.pdf"))
    assert owner_db.count_facts() == before


def test_anonymous_cannot_store_a_decision(owner_db):
    response = httpx.post(f"{URL}/v1/database/{DB}/call/ingest_decision", json=[fact_record()])
    assert response.status_code == ingest.REDUCER_REJECTED and "unauthorized" in response.text


def test_module_tables_are_the_evidence_and_finance_mirror(owner_db):
    out = subprocess.run([CLI, "describe", "--server", "local", "--json", DB],
                         check=True, capture_output=True, text=True).stdout
    tables = {
        t["source_name"]
        for section in json.loads(out)["sections"] if "Tables" in section
        for t in section["Tables"]
    }
    assert tables == {
        "fiaDocuments",
        "fiaDecisionFacts",
        "config",
        "journalEntries",
        "jeLines",
        "pitWallItems",
        "writers",
        # race desk (race/): the live race tape and its money consequences
        "raceEvents",
        "carState",
        "raceEffects",
        "raceForecasts",
        "racePolicies",
        "racePrecedents",
        # race day (race/weekend.py): the flow after the tape
        "raceIncidents",
        "raceBeliefs",
        "raceActions",
        "raceEntries",
        "raceEntryLines",
        "raceQuestions",
        "raceSims",
        "raceCloses",
        "raceOptions",
        "racePostings",
        "raceHealth",
    }
