"""Bridge: Apify `fia-document-monitor` dataset -> SpacetimeDB `fia_documents`.

    python ingestion/ingest.py run [--season 2024 --event-slug belgian-grand-prix --max-items 10]
    python ingestion/ingest.py run-id <APIFY_RUN_ID>
    python ingestion/ingest.py replay ingestion/captures/<capture>.json
    python ingestion/ingest.py fixture ingestion/sample_item.json
    python ingestion/ingest.py extract ingestion/captures/<capture>.json   (writes ingestion/captures/decisions/)

`run` starts the Actor and saves its dataset under ingestion/captures/ so the
same evidence can be replayed if the FIA site or Apify is unreachable.
Replayed rows are stored with ingest_mode=replay_captured_run; fixture rows
with ingest_mode=test_fixture, no run ID, and only ever into the test DB.

This script only records evidence. It never creates journal entries.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

import httpx
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
CAPTURES_DIR = REPO_ROOT / "ingestion" / "captures"
# Decision-reader output lives apart from listing captures, which finance/fia_bridge.py reads as listings.
DECISION_CAPTURES_DIR = CAPTURES_DIR / "decisions"
FIA_ORIGIN = "https://www.fia.com"
OFFICIAL_HOSTS = {"www.fia.com"}
EVENT_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DOC_KEY = re.compile(r"^[0-9a-f]{64}$")
PDF_SHA256 = re.compile(r"^[0-9a-f]{64}$")
CARS = re.compile(r"^(?:\d{1,2}(?:,\d{1,2})*)?$")
DECISION_OUTCOMES = {"", "no_further_action", "disqualification", "time_penalty", "fine", "reprimand", "warning"}
EXCERPT_MAX = 500
# SpacetimeDB answers 530 when a reducer throws SenderError.
REDUCER_REJECTED = 530


class IngestError(RuntimeError):
    pass


# Must stay identical to canonical_url in ingestion/actor/src/fia.py
# (tests/test_normalize.py checks this).
def canonical_url(href: str, base: str = FIA_ORIGIN) -> str:
    parts = urlsplit(urljoin(base, href.strip()))
    path = quote(unquote(parts.path), safe="/")
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))


def doc_key(source: str, season: int, event_slug: str, document_url: str) -> str:
    return hashlib.sha256(f"{source}|{season}|{event_slug}|{document_url}".encode()).hexdigest()


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _official(url: str) -> bool:
    parts = urlsplit(url)
    return parts.scheme == "https" and parts.netloc in OFFICIAL_HOSTS and len(parts.path) > 1


def normalize(item: dict, *, actor_run_id: str, ingest_mode: str, ingested_at: str) -> dict:
    """Map one Actor dataset item to reducer arguments, or raise ValueError."""

    def text(name: str) -> str:
        value = item.get(name)
        return value.strip() if isinstance(value, str) else ""

    source = text("source")
    if source != "fia":
        raise ValueError(f"source must be 'fia', got {source!r}")
    season = item.get("season")
    if isinstance(season, bool) or not isinstance(season, int) or not 1950 <= season <= 2100:
        raise ValueError("season missing or out of range")
    event_slug = text("event_slug")
    if not EVENT_SLUG.match(event_slug):
        raise ValueError("event_slug missing or malformed")
    title = " ".join(text("title").split())
    if not title:
        raise ValueError("title is blank")
    raw_url = text("document_url")
    if not raw_url:
        raise ValueError("document_url is blank")
    document_url = canonical_url(raw_url)
    if not _official(document_url):
        raise ValueError(f"document_url is not an official https FIA URL: {raw_url}")
    source_page_url = canonical_url(text("source_page_url"))
    if not _official(source_page_url):
        raise ValueError("source_page_url is not an official https FIA URL")

    return {
        "doc_key": doc_key(source, season, event_slug, document_url),
        "source": source,
        "season": season,
        "event_slug": event_slug,
        "event_name": text("event_name") or event_slug.replace("-", " ").title(),
        "document_number": text("document_number"),
        "title": title,
        "document_url": document_url,
        "source_page_url": source_page_url,
        "published_at": text("published_at"),
        "actor_run_id": actor_run_id,
        "ingest_mode": ingest_mode,
        "ingested_at": ingested_at,
    }


def normalize_fact(item: dict, *, actor_run_id: str, ingest_mode: str, extracted_at: str) -> dict:
    """Map one decision-reader item to ingest_decision arguments, or raise ValueError."""
    listing = normalize(item, actor_run_id=actor_run_id, ingest_mode=ingest_mode, ingested_at=extracted_at)
    cars = "".join(str(item.get("cars", "") or "").split())
    offence = " ".join(str(item.get("offence", "") or "").split())
    outcome = str(item.get("outcome", "") or "").strip()
    excerpt = " ".join(str(item.get("excerpt", "") or "").split())
    pdf_sha256 = str(item.get("pdf_sha256", "") or "").strip().lower()
    if not CARS.match(cars):
        raise ValueError(f"cars malformed: {cars!r}")
    if not offence:
        raise ValueError("offence is blank")
    if len(offence) > 512:
        raise ValueError("offence exceeds 512 chars")
    if outcome not in DECISION_OUTCOMES:
        raise ValueError(f"unknown outcome: {outcome!r}")
    if len(excerpt) > EXCERPT_MAX:
        raise ValueError("excerpt exceeds 500 chars")
    if not PDF_SHA256.match(pdf_sha256):
        raise ValueError("pdf_sha256 must be 64 hex chars")
    return {
        "doc_key": listing["doc_key"],
        "document_url": listing["document_url"],
        "cars": cars,
        "offence": offence,
        "outcome": outcome,
        "excerpt": excerpt,
        "pdf_hash": pdf_sha256,
        "actor_run_id": actor_run_id,
        "ingest_mode": ingest_mode,
        "extracted_at": extracted_at,
    }


def envelope(record: dict) -> dict:
    """Application-level event for later agent/finance routing (not persisted here)."""
    return {
        "type": "fia_document_discovered",
        "doc_key": record["doc_key"],
        "source": record["source"],
        "actor_run_id": record["actor_run_id"],
        "record": {
            "season": record["season"],
            "event_slug": record["event_slug"],
            "title": record["title"],
            "document_url": record["document_url"],
        },
    }


# --------------------------------------------------------------------------- SpacetimeDB


def local_cli_token() -> str:
    """Token of the `spacetime` CLI login (the identity that published the module)."""
    cli = shutil.which("spacetime") or str(Path.home() / ".local" / "bin" / "spacetime")
    try:
        out = subprocess.run(
            [cli, "login", "show", "--token"], capture_output=True, text=True, check=True, timeout=20
        ).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        raise IngestError(f"SPACETIME_TOKEN not set and `spacetime login show --token` failed: {exc}")
    match = re.search(r"auth token .* is (\S+)", out)
    if not match:
        raise IngestError("SPACETIME_TOKEN not set and no CLI login token found")
    return match.group(1)


class SpacetimeClient:
    def __init__(self, base_url: str, database: str, token: str):
        self.database = database
        self._db_url = f"{base_url.rstrip('/')}/v1/database/{database}"
        self._http = httpx.Client(timeout=20, headers={"Authorization": f"Bearer {token}"})

    def _post(self, path: str, **kwargs) -> httpx.Response:
        for attempt in range(3):
            try:
                response = self._http.post(self._db_url + path, **kwargs)
            except httpx.TransportError as exc:
                if attempt == 2:
                    raise IngestError(f"SpacetimeDB unreachable at {self._db_url}: {exc}")
            else:
                if response.status_code not in (502, 503, 504) or attempt == 2:
                    return response
            time.sleep(1 + attempt)
        raise AssertionError("unreachable")

    def sql(self, query: str) -> list[list]:
        response = self._post("/sql", content=query)
        if response.status_code != 200:
            raise IngestError(f"SQL failed ({response.status_code}): {response.text.strip()}")
        return response.json()[0]["rows"]

    def count(self) -> int:
        return int(self.sql("SELECT COUNT(*) AS n FROM fia_documents")[0][0])

    def exists(self, key: str) -> bool:
        if not DOC_KEY.match(key):
            raise ValueError("bad doc_key")
        return bool(self.sql(f"SELECT doc_key FROM fia_documents WHERE doc_key = '{key}'"))

    def ingest(self, record: dict) -> tuple[bool, str]:
        """Call ingest_document. Returns (ok, reducer message)."""
        return self._reducer("ingest_document", record)

    def count_facts(self) -> int:
        return int(self.sql("SELECT COUNT(*) AS n FROM fia_decision_facts")[0][0])

    def fact_exists(self, key: str) -> bool:
        if not DOC_KEY.match(key):
            raise ValueError("bad doc_key")
        return bool(self.sql(f"SELECT doc_key FROM fia_decision_facts WHERE doc_key = '{key}'"))

    def ingest_decision(self, record: dict) -> tuple[bool, str]:
        """Call ingest_decision. Returns (ok, reducer message)."""
        return self._reducer("ingest_decision", record)

    def _reducer(self, name: str, record: dict) -> tuple[bool, str]:
        response = self._post(f"/call/{name}", json=[record])
        if response.status_code == 200:
            return True, ""
        message = response.text.strip()
        if response.status_code == REDUCER_REJECTED and message.startswith("unauthorized"):
            raise IngestError(f"SpacetimeDB refused this identity: {message}")
        return False, f"{response.status_code}: {message}"


# --------------------------------------------------------------------------- Apify


@dataclass
class Batch:
    items: list[dict]
    actor_run_id: str
    ingest_mode: str
    provenance: dict = field(default_factory=dict)


def _apify_client():
    from apify_client import ApifyClient

    token = os.environ.get("APIFY_TOKEN", "").strip()
    if not token:
        raise IngestError("APIFY_TOKEN is not set (put it in .env)")
    return ApifyClient(token=token)


def _batch_from_run(client, run) -> Batch:
    if run is None:
        raise IngestError("Apify run not found")
    if run.status != "SUCCEEDED":
        raise IngestError(f"Apify run {run.id} finished with status {run.status}: {run.status_message}")
    items = list(client.dataset(run.default_dataset_id).iterate_items())
    summary = client.key_value_store(run.default_key_value_store_id).get_record("RUN_SUMMARY")
    provenance = {
        "actor_id": run.act_id,
        "actor_run_id": run.id,
        "dataset_id": run.default_dataset_id,
        "key_value_store_id": run.default_key_value_store_id,
        "run_started_at": run.started_at.isoformat(),
        "run_finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "run_summary": summary["value"] if summary else None,
    }
    return Batch(items=items, actor_run_id=run.id, ingest_mode="live_actor_run", provenance=provenance)


def attach_official_pdfs(items: list[dict]) -> list[dict]:
    """Fetch each official PDF here. FIA returns 404 to the Apify network."""
    from impit import Client

    attached = []
    with Client(browser="chrome", timeout=60) as client:
        for item in items:
            copy = dict(item)
            url = str(item.get("document_url", "") or "")
            try:
                response = client.get(url)
                response.raise_for_status()
                body = response.content
                if not body.startswith(b"%PDF"):
                    raise IngestError(f"response is not a PDF ({len(body)} bytes)")
                copy["pdf_base64"] = base64.b64encode(body).decode("ascii")
                print(f"  fetched {item.get('document_number') or '-'} ({len(body)} bytes)")
            except Exception as exc:
                print(f"  fetch failed for {url}: {exc}")
            attached.append(copy)
    return attached


def start_decision_actor(items: list[dict], max_items: int, document_number: str = "") -> Batch:
    client = _apify_client()
    actor_id = os.environ.get("APIFY_DECISION_ACTOR_ID", "").strip()
    if not actor_id:
        raise IngestError("APIFY_DECISION_ACTOR_ID is not set (e.g. <username>/fia-decision-reader)")
    run_input = {"items": items, "max_items": max_items, "document_number": document_number}
    print(f"Starting Apify Actor {actor_id} for {len(items)} listing items ...")
    run = client.actor(actor_id).call(run_input=run_input, wait_duration=timedelta(minutes=10))
    return _batch_from_run(client, run)


def save_decision_capture(batch: Batch) -> Path:
    first = batch.items[0] if batch.items else {}
    name = f"decision-{first.get('season', 'unknown')}-{first.get('event_slug', 'unknown')}-{batch.actor_run_id}.json"
    DECISION_CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
    path = DECISION_CAPTURES_DIR / name
    path.write_text(
        json.dumps({"captured_at": utc_now(), **batch.provenance, "items": batch.items}, indent=2) + "\n"
    )
    return path


def start_actor(season: int, event_slug: str, max_items: int) -> Batch:
    client = _apify_client()
    actor_id = os.environ.get("APIFY_ACTOR_ID", "").strip()
    if not actor_id:
        raise IngestError("APIFY_ACTOR_ID is not set (e.g. <username>/fia-document-monitor)")
    run_input = {"season": season, "event_slug": event_slug, "max_items": max_items}
    print(f"Starting Apify Actor {actor_id} with {run_input} ...")
    run = client.actor(actor_id).call(run_input=run_input, wait_duration=timedelta(minutes=5))
    return _batch_from_run(client, run)


def existing_run(run_id: str) -> Batch:
    client = _apify_client()
    return _batch_from_run(client, client.run(run_id).get())


def save_capture(batch: Batch) -> Path:
    summary = batch.provenance.get("run_summary") or {}
    name = f"{summary.get('season', 'unknown')}-{summary.get('event_slug', 'unknown')}-{batch.actor_run_id}.json"
    CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
    path = CAPTURES_DIR / name
    path.write_text(
        json.dumps({"captured_at": utc_now(), **batch.provenance, "items": batch.items}, indent=2) + "\n"
    )
    return path


def load_capture(path: Path) -> Batch:
    data = json.loads(path.read_text())
    run_id = data.get("actor_run_id", "")
    if not run_id or not isinstance(data.get("items"), list):
        raise IngestError(f"{path} is not a capture written by `ingest.py run`")
    provenance = {k: v for k, v in data.items() if k != "items"}
    return Batch(items=data["items"], actor_run_id=run_id, ingest_mode="replay_captured_run", provenance=provenance)


def load_fixture(path: Path) -> Batch:
    data = json.loads(path.read_text())
    items = data["items"] if isinstance(data, dict) else data
    return Batch(items=items, actor_run_id="", ingest_mode="test_fixture", provenance={"fixture": str(path)})


# --------------------------------------------------------------------------- main


def ingest_batch(batch: Batch, db: SpacetimeClient, events_out: Path | None = None) -> dict:
    ingested_at = utc_now()
    counts = {"added": 0, "duplicate": 0, "invalid": 0, "rejected": 0}
    before = db.count()
    events = []
    for index, item in enumerate(batch.items):
        try:
            record = normalize(
                item, actor_run_id=batch.actor_run_id, ingest_mode=batch.ingest_mode, ingested_at=ingested_at
            )
        except ValueError as exc:
            counts["invalid"] += 1
            print(f"  INVALID   item {index}: {exc}")
            continue
        label = f"{record['document_number'] or '-':>3} {record['title'][:70]}"
        if db.exists(record["doc_key"]):
            counts["duplicate"] += 1
            print(f"  DUPLICATE {label}")
            continue
        ok, message = db.ingest(record)
        if ok:
            counts["added"] += 1
            events.append(envelope(record))
            print(f"  ADDED     {label}")
        else:
            counts["rejected"] += 1
            print(f"  REJECTED  {label}\n            reducer said {message}")
    after = db.count()
    if events_out and events:
        with events_out.open("a") as fh:
            for event in events:
                fh.write(json.dumps(event) + "\n")
    print(
        f"\n{db.database}: {counts['added']} added, {counts['duplicate']} duplicate, "
        f"{counts['invalid']} invalid, {counts['rejected']} rejected by reducer | "
        f"fia_documents {before} -> {after}"
    )
    return {**counts, "before": before, "after": after}


def extract_batch(batch: Batch, db: SpacetimeClient) -> dict:
    extracted_at = utc_now()
    counts = {"added": 0, "duplicate": 0, "invalid": 0, "rejected": 0}
    before = db.count_facts()
    for index, item in enumerate(batch.items):
        try:
            record = normalize_fact(
                item, actor_run_id=batch.actor_run_id, ingest_mode=batch.ingest_mode, extracted_at=extracted_at
            )
        except ValueError as exc:
            counts["invalid"] += 1
            print(f"  INVALID   item {index}: {exc}")
            continue
        label = f"{item.get('document_number') or '-':>3} {record['offence'][:70]}"
        if db.fact_exists(record["doc_key"]):
            counts["duplicate"] += 1
            print(f"  DUPLICATE {label}")
            continue
        ok, message = db.ingest_decision(record)
        if ok:
            counts["added"] += 1
            print(f"  ADDED     {label}")
        else:
            counts["rejected"] += 1
            print(f"  REJECTED  {label}\n            reducer said {message}")
    after = db.count_facts()
    print(
        f"\n{db.database}: {counts['added']} added, {counts['duplicate']} duplicate, "
        f"{counts['invalid']} invalid, {counts['rejected']} rejected by reducer | "
        f"fia_decision_facts {before} -> {after}"
    )
    return {**counts, "before": before, "after": after}


def main(argv: list[str] | None = None) -> int:
    load_dotenv(REPO_ROOT / ".env")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", help="SpacetimeDB database (default: SPACETIME_DB, or SPACETIME_TEST_DB for fixtures)")
    parser.add_argument("--events-out", type=Path, help="append fia_document_discovered events (JSONL) for new rows")
    sub = parser.add_subparsers(dest="command", required=True)
    run_p = sub.add_parser("run", help="start the Apify Actor, capture its dataset, ingest it")
    run_p.add_argument("--season", type=int, default=2024)
    run_p.add_argument("--event-slug", default="belgian-grand-prix")
    run_p.add_argument("--max-items", type=int, default=100)
    sub.add_parser("run-id", help="ingest an already-finished Apify run").add_argument("run_id")
    sub.add_parser("replay", help="re-ingest a capture saved by `run`").add_argument("capture", type=Path)
    sub.add_parser("fixture", help="ingest a hand-written test fixture into the test DB").add_argument("path", type=Path)
    extract_p = sub.add_parser("extract", help="read PDFs for a saved listing capture and store decision extracts")
    extract_p.add_argument("capture", type=Path)
    extract_p.add_argument("--max-items", type=int, default=10)
    extract_p.add_argument("--document-number", default="", help="only this FIA document number")
    args = parser.parse_args(argv)

    main_db = os.environ.get("SPACETIME_DB", "pit-wall")
    test_db = os.environ.get("SPACETIME_TEST_DB", "pit-wall-test")
    database = args.db or (test_db if args.command == "fixture" else main_db)
    if args.command == "fixture" and database == main_db:
        print(f"Refusing to write test fixtures into the demo database '{main_db}'.", file=sys.stderr)
        return 2

    try:
        token = os.environ.get("SPACETIME_TOKEN", "").strip() or local_cli_token()
        db = SpacetimeClient(os.environ.get("SPACETIME_URL", "http://127.0.0.1:3000"), database, token)
        if args.command == "run":
            batch = start_actor(args.season, args.event_slug, args.max_items)
            print(f"Apify run {batch.actor_run_id} SUCCEEDED; capture saved to {save_capture(batch).relative_to(REPO_ROOT)}")
        elif args.command == "run-id":
            batch = existing_run(args.run_id)
            print(f"Apify run {batch.actor_run_id} SUCCEEDED; capture saved to {save_capture(batch).relative_to(REPO_ROOT)}")
        elif args.command == "replay":
            batch = load_capture(args.capture)
            print(f"REPLAY of captured Apify run {batch.actor_run_id} (captured {batch.provenance.get('captured_at')})")
        elif args.command == "extract":
            listing = load_capture(args.capture)
            chosen = []
            for item in listing.items:
                if args.document_number and str(item.get("document_number", "") or "") != args.document_number:
                    continue
                chosen.append(item)
                if len(chosen) >= args.max_items:
                    break
            if not chosen:
                raise IngestError("no listing items matched")
            print(f"Fetching {len(chosen)} official PDF(s) ...")
            chosen = attach_official_pdfs(chosen)
            batch = start_decision_actor(chosen, args.max_items, args.document_number)
            print(f"Apify run {batch.actor_run_id} SUCCEEDED; capture saved to {save_decision_capture(batch).relative_to(REPO_ROOT)}")
            summary = batch.provenance.get("run_summary") or {}
            for skip in summary.get("skipped") or []:
                print(f"  SKIPPED   {skip.get('reason')}")
            print(f"{len(batch.items)} decision items -> SpacetimeDB '{database}'")
            result = extract_batch(batch, db)
            return 1 if result["rejected"] else 0
        else:
            batch = load_fixture(args.path)
            print(f"TEST FIXTURE {args.path} -> {database} (no Apify run)")
        print(f"{len(batch.items)} dataset items -> SpacetimeDB '{database}'")
        result = ingest_batch(batch, db, args.events_out)
    except IngestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 1 if result["rejected"] else 0


if __name__ == "__main__":
    sys.exit(main())
