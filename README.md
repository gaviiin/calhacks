# Pit Wall: FIA evidence ingestion

Meridian Racing (a fictional F1 constructor) watches real FIA documents. This repo holds the **ingestion MVP**: an official FIA document shows up on the Pit Wall dashboard, with provenance, without anyone refreshing the page.

```
FIA official documents ─► Apify Actor fia-document-monitor ─► dataset ─► ingestion/ingest.py
        ─► SpacetimeDB reducer ingest_document (authorised identity only) ─► fia_documents
        ─► React subscription ─► Evidence feed (live)
```

This pipeline records **evidence only**. It has no path to a journal entry. The finance backend (FastAPI, SQLite ledger, `propose_entry()`, kernel, controller approval) keeps ownership of every financial decision.

| Dir | Contents |
| --- | --- |
| `ingestion/actor/` | Python Apify Actor |
| `ingestion/ingest.py` | Bridge script ([ingestion/README.md](ingestion/README.md)) |
| `spacetimedb/` | TypeScript module: public `fia_documents`, private `config`, reducers `ingest_document` and `set_ingestor` |
| `frontend/` | Vite + React evidence feed using generated SpacetimeDB bindings |

## Setup (once)

```bash
cp .env.example .env              # then fill in APIFY_TOKEN; never commit .env
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -r ingestion/requirements.txt
npm install                       # repo tooling: apify-cli
(cd spacetimedb && npm install)
(cd frontend && npm install)
```

SpacetimeDB CLI: `curl -sSf https://install.spacetimedb.com | sh`

## Run it locally

```bash
spacetime start                                   # terminal 1
npm run stdb:publish:local                        # publishes spacetimedb/ as "pit-wall"
npm run dev --prefix frontend                     # http://localhost:5173
npm run actor:push                                # once: deploy the Actor to Apify
#   then set APIFY_ACTOR_ID=<username>/fia-document-monitor in .env
.venv/bin/python ingestion/ingest.py run          # real Actor run → rows appear live
.venv/bin/python ingestion/ingest.py run          # again → "0 added, N duplicate"
```

After changing the module: `npm run stdb:publish:local && npm run stdb:generate`.

## Environment (`.env`, server-side only)

| Var | Used by | Notes |
| --- | --- | --- |
| `APIFY_TOKEN` | ingest.py, `npm run actor:push` | Never in the browser or git |
| `APIFY_ACTOR_ID` | ingest.py | `<username>/fia-document-monitor` |
| `SPACETIME_URL` | ingest.py | `http://127.0.0.1:3000` locally |
| `SPACETIME_DB` | ingest.py | `pit-wall` (demo); fixtures go to `SPACETIME_TEST_DB` (`pit-wall-test`) |
| `SPACETIME_TOKEN` | ingest.py | Ingestor identity's token; if empty, falls back to the `spacetime` CLI login |

The frontend only needs `VITE_SPACETIMEDB_HOST` and `VITE_SPACETIMEDB_DB_NAME` (see `frontend/.env.example`). Neither is secret.

## MVP checklist

- [ ] One genuine Apify run retrieves metadata for at least one official FIA document. *(Actor verified locally against live fia.com; cloud run pending `APIFY_TOKEN`)*
- [ ] Every displayed record keeps a working FIA source URL and Apify run ID. *(UI shows both; needs the real run)*
- [x] Inserting a dataset increases the document count once.
- [x] Running ingestion a second time produces no duplicate rows.
- [x] A second browser tab sees new records without a refresh.
- [x] An invalid URL or missing required field is rejected and reported, by both the bridge and the reducer.
- [x] A browser or anonymous identity cannot invoke the protected ingest reducer.
- [x] An ingested document produces no automatic journal entry. *(the module has no ledger tables; tested)*
- [ ] The team can replay saved dataset items if the external site goes down. *(`ingest.py replay` built; needs a capture from a real run)*
