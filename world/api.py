"""Systems-of-record cursor API (SCHEMA.md section 5), served on :8010.

    uv run python -m world.generate --seed 7 --out world/out
    uv run uvicorn world.api:app --port 8010

Loads world/out/*.jsonl at startup (WORLD_OUT_DIR overrides the directory) and refuses to start
if a source file is missing. The file order of each JSONL is its cursor order (cursor = line
number), sorted by visible_at, so the records visible at the sim date are always a prefix and
cursors only ever grow. A re-emitted record (same id) has a later line, hence a later cursor.

The sim clock lives in memory, starts at 2026-01-01 and only moves forward (POST /clock/advance).
The ERP journal is in memory too: restart the server to reset both.

POST /erp/journal_entries requires X-Gateway-Key == env GATEWAY_KEY (default "dev-gateway-key").
Lines may book to statutory accounts (acct-<code>, must exist) or to cost cap sub-ledger accounts
(capcat-<CODE>, capadj-<NAME>); debits must equal credits. work_item_id is the idempotency key.
"""

from __future__ import annotations

import bisect
import json
import os
import re
import threading
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field, ValidationError

from .generate import SOURCES

DEFAULT_OUT = Path(__file__).resolve().parent / "out"
SIM_START = date(2026, 1, 1)
DEFAULT_GATEWAY_KEY = "dev-gateway-key"
# A race entry (evidence ref race_entry:<key>) is accepted only when pit-wall authorized it (or a person approved it):
# the gateway key alone is not enough. ERP_REQUIRE_PITWALL=0 turns the check off for tests of the ERP itself.
PITWALL_OK = ("authorized", "approved", "posted")


def pitwall_posting_status(entry_key: str) -> str | None:
    """race_postings.status for an entry in pit-wall, '' when there is no row, None when pit-wall cannot be asked."""
    import httpx

    base = os.environ.get("SPACETIME_URL", "http://127.0.0.1:3000").rstrip("/")
    db = os.environ.get("SPACETIME_DB", "pit-wall")
    q = "SELECT status FROM race_postings WHERE entry_key = '" + entry_key.replace("'", "''") + "'"
    try:
        r = httpx.post(f"{base}/v1/database/{db}/sql", content=q, headers={"Content-Type": "text/plain"}, timeout=4)
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    rows = [row for stmt in r.json() for row in stmt.get("rows", [])]
    return str(rows[0][0]) if rows else ""
SUBLEDGER_ACCOUNT = re.compile(r"^cap(cat|adj)-[A-Z0-9_]+$")


class WorldData:
    def __init__(self, out_dir: Path):
        out_dir = Path(out_dir)
        missing = [s for s in SOURCES if not (out_dir / f"{s}.jsonl").is_file()]
        if missing:
            raise RuntimeError(
                f"world data missing in {out_dir}: {', '.join(m + '.jsonl' for m in missing)}. "
                "Generate it first: uv run python -m world.generate --seed 7 --out world/out")
        self.out_dir = out_dir
        self.rows: dict[str, list[dict]] = {}
        self.visible: dict[str, list[str]] = {}
        self.by_id: dict[str, dict[str, list[int]]] = {}
        for src in SOURCES:
            recs = []
            with (out_dir / f"{src}.jsonl").open(encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        recs.append(json.loads(line))
            vis = [r["visible_at"] for r in recs]
            if vis != sorted(vis):
                raise RuntimeError(f"{src}.jsonl is not sorted by visible_at; regenerate world/out")
            idx: dict[str, list[int]] = {}
            for i, r in enumerate(recs):
                idx.setdefault(r["id"], []).append(i)
            self.rows[src], self.visible[src], self.by_id[src] = recs, vis, idx
        ak = out_dir / "answer_key.csv"
        self.answer_key = ak.read_text(encoding="utf-8") if ak.is_file() else None
        self.account_ids = set(self.by_id["account"])

    def visible_count(self, src: str, sim_date: date) -> int:
        return bisect.bisect_right(self.visible[src], sim_date.isoformat())


class JournalLine(BaseModel):
    account_id: str = Field(min_length=1)
    debit_minor: int = Field(default=0, ge=0)
    credit_minor: int = Field(default=0, ge=0)


class JournalEntry(BaseModel):
    work_item_id: str = Field(min_length=1)
    period_key: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    lines: list[JournalLine] = Field(min_length=2)
    memo: str = ""
    evidence_refs: list[str] = Field(default_factory=list)


class State:
    def __init__(self, data: WorldData):
        self.data = data
        self.sim_date = SIM_START
        self.journal: list[dict] = []
        self.by_work_item: dict[str, dict] = {}
        self.lock = threading.Lock()


def create_app(out_dir: Path | str | None = None) -> FastAPI:
    """App factory. The data directory is read at startup (lifespan), not at import."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        path = Path(out_dir or os.environ.get("WORLD_OUT_DIR") or DEFAULT_OUT)
        app.state.world = State(WorldData(path))
        yield

    app = FastAPI(title="Meridian Racing systems of record", version="1.0", lifespan=lifespan)

    def st(request: Request) -> State:
        return request.app.state.world

    @app.get("/clock")
    def get_clock(request: Request):
        return {"sim_date": st(request).sim_date.isoformat()}

    @app.post("/clock/advance")
    async def advance(request: Request):
        try:
            body = await request.json()
        except ValueError:
            body = {}
        days = body.get("days", 0) if isinstance(body, dict) else 0
        if isinstance(days, bool) or not isinstance(days, int) or days < 0:
            raise HTTPException(422, "days must be a non-negative integer")
        s = st(request)
        with s.lock:
            s.sim_date = s.sim_date + timedelta(days=days)
            return {"sim_date": s.sim_date.isoformat()}

    @app.get("/sources")
    def sources():
        return list(SOURCES)

    @app.get("/changes/{source}")
    def changes(request: Request, source: str, after: int = Query(0, ge=0), limit: int = Query(500, ge=1, le=5000)):
        s = st(request)
        if source not in s.data.rows:
            raise HTTPException(404, f"unknown source {source!r}; see /sources")
        n = s.data.visible_count(source, s.sim_date)
        start = min(after, n)
        page = s.data.rows[source][start:min(n, start + limit)]
        recs = [{"cursor": start + i + 1, "op": "upsert", "record": r} for i, r in enumerate(page)]
        nxt = recs[-1]["cursor"] if recs else after
        return {"records": recs, "next_cursor": nxt, "has_more": start + len(page) < n}

    @app.get("/records/{source}/{record_id}")
    def record(request: Request, source: str, record_id: str):
        s = st(request)
        if source not in s.data.rows:
            raise HTTPException(404, f"unknown source {source!r}")
        n = s.data.visible_count(source, s.sim_date)
        hits = [i for i in s.data.by_id[source].get(record_id, []) if i < n]
        if not hits:
            raise HTTPException(404, f"{source}/{record_id} not visible on {s.sim_date.isoformat()}")
        return s.data.rows[source][hits[-1]]

    @app.post("/erp/journal_entries")
    async def post_journal(request: Request):
        expected = os.environ.get("GATEWAY_KEY") or DEFAULT_GATEWAY_KEY
        key = request.headers.get("X-Gateway-Key")
        if not key:
            return JSONResponse({"detail": "missing X-Gateway-Key"}, status_code=401)
        if key != expected:
            return JSONResponse({"detail": "invalid X-Gateway-Key"}, status_code=403)
        try:
            entry = JournalEntry.model_validate(await request.json())
        except ValueError as e:  # JSON decode or pydantic ValidationError
            detail = e.errors(include_url=False) if isinstance(e, ValidationError) else str(e)
            return JSONResponse({"detail": detail}, status_code=422)
        if os.environ.get("ERP_REQUIRE_PITWALL", "1") != "0":
            for ref in entry.evidence_refs:
                if not ref.startswith("race_entry:"):
                    continue
                key = ref.split(":", 1)[1]
                status = pitwall_posting_status(key)
                if status is None:  # fail closed: no authorization can be read, so none is assumed
                    return JSONResponse({"detail": f"pit-wall unreachable: race entry {key} cannot be authorized"}, status_code=503)
                if status not in PITWALL_OK:
                    return JSONResponse({"detail": f"pit-wall has not authorized race entry {key} ({status or 'never requested'})"}, status_code=403)
        s = st(request)
        for ln in entry.lines:
            if (ln.debit_minor > 0) == (ln.credit_minor > 0):
                return JSONResponse({"detail": f"line {ln.account_id}: exactly one of debit_minor/credit_minor must be > 0"}, status_code=422)
            if not (ln.account_id in s.data.account_ids or SUBLEDGER_ACCOUNT.match(ln.account_id)):
                return JSONResponse({"detail": f"unknown account {ln.account_id!r}"}, status_code=422)
        debits = sum(ln.debit_minor for ln in entry.lines)
        credits = sum(ln.credit_minor for ln in entry.lines)
        if debits != credits:
            return JSONResponse({"detail": f"unbalanced entry: debits {debits} != credits {credits}"}, status_code=422)
        body = entry.model_dump()
        with s.lock:
            prior = s.by_work_item.get(entry.work_item_id)
            if prior is not None:
                same = all(prior[k] == body[k] for k in ("period_key", "lines"))
                if not same:
                    return JSONResponse({"detail": f"work_item_id {entry.work_item_id} already posted as {prior['erp_entry_id']} "
                                                   "with different lines"}, status_code=409)
                return {"erp_entry_id": prior["erp_entry_id"]}
            erp_id = f"JE-{entry.period_key[:4]}-{len(s.journal) + 1:06d}"
            rec = {"erp_entry_id": erp_id, **body, "total_minor": debits, "posted_on": s.sim_date.isoformat()}
            s.journal.append(rec)
            s.by_work_item[entry.work_item_id] = rec
        return {"erp_entry_id": erp_id}

    @app.get("/erp/journal_entries")
    def list_journal(request: Request):
        s = st(request)
        return {"entries": list(s.journal), "count": len(s.journal)}

    @app.get("/answer_key")
    def answer_key(request: Request):
        s = st(request)
        if s.data.answer_key is None:
            raise HTTPException(404, "answer_key.csv not generated")
        return PlainTextResponse(s.data.answer_key, media_type="text/csv")

    return app


app = create_app()
