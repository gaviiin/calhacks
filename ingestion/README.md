# Ingestion: Apify → SpacetimeDB

```
fia.com listing ─► Apify Actor (actor/) ─► Apify dataset ─► ingest.py ─► SpacetimeDB reducer ingest_document ─► fia_documents
                                                              │
                                                              └─► captures/<season>-<event>-<runId>.json  (replay fallback)
```

| Path | What it is |
| --- | --- |
| `actor/` | `fia-document-monitor`, the Python Apify Actor (see `actor/README.md`) |
| `ingest.py` | Bridge: Apify run → validate → `doc_key` → authenticated reducer call |
| `schema/fia_document_item.schema.json` | Shared contract for an Actor dataset item |
| `sample_item.json` | **Test fixture** (hand-written, Doc 44 metadata, no Apify run) |
| `sample_invalid_items.json` | **Test fixture**: six items that must be rejected |
| `captures/` | Datasets saved from real Apify runs, used for `replay` |
| `tests/` | Parser, normalization and live-SpacetimeDB integration tests |

## Commands

```bash
# Real Apify run: starts the Actor, waits, saves a capture, ingests
.venv/bin/python ingestion/ingest.py run --season 2024 --event-slug belgian-grand-prix --max-items 10

# Ingest a run that already finished (e.g. started from the Apify console)
.venv/bin/python ingestion/ingest.py run-id <APIFY_RUN_ID>

# Offline fallback: replay a capture from an earlier real run (rows marked replay_captured_run)
.venv/bin/python ingestion/ingest.py replay ingestion/captures/<file>.json

# Test fixture → pit-wall-test only (refuses to write fixtures into the demo DB)
.venv/bin/python ingestion/ingest.py fixture ingestion/sample_item.json
```

Each run prints one line per item (`ADDED`, `DUPLICATE`, `INVALID`, `REJECTED`) and a summary such as `1 added, 9 duplicate, 0 invalid, 0 rejected by reducer | fia_documents 10 -> 11`. Add `--events-out events.jsonl` to append a `fia_document_discovered` envelope for every new row; that envelope is the hand-off point for the later finance router.

## Identity and dedupe

- `doc_key = sha256("fia|<season>|<event_slug>|<canonical document_url>")`. The canonical URL is absolute, percent-encoded, has a lower-case host and no fragment. The Actor and the bridge use the same function (a test checks this).
- The bridge checks whether a key exists before calling the reducer, so it can report duplicates. The reducer is idempotent on its own as well: an existing key is a no-op, never an overwrite. A *different* key for the same URL is rejected as a conflict.
- Only the identity stored in the module's private `config` table can call `ingest_document`. By default that is the identity that published the module. The bridge uses `SPACETIME_TOKEN`, or the `spacetime` CLI login if that is empty.

## Ingest modes stored on each row

| `ingest_mode` | `actor_run_id` | Meaning |
| --- | --- | --- |
| `live_actor_run` | real run ID | Ingested straight from an Apify run via `run`/`run-id` |
| `replay_captured_run` | real run ID | Re-ingested from a saved capture of a real run |
| `test_fixture` | empty (enforced) | Hand-written test data, test DB only |

The reducer rejects a fixture row that carries a run ID, and a live or replay row that doesn't.

## Tests

```bash
.venv/bin/python -m pytest -q ingestion/tests
```

The integration tests need `spacetime start` running. They republish the module to a throwaway `pit-wall-itest` database each time and check: a replay adds nothing, invalid rows are rejected by both the bridge and the reducer, a stranger or anonymous identity cannot ingest, the private `config` table is unreadable, and the module has no ledger tables.
