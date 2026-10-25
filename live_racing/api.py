"""Small FastAPI adapter for the live racing feed (plan 6D): read, SSE, and the one write that is
allowed, Person 2's FinanceImpactUpdate by incident_id.

    uv run uvicorn live_racing.api:app --port 8020

It runs beside the revenue desk API (:8000) on purpose: that app serves one request at a time to
protect its SQLite ledgers, and a streaming endpoint would hold its lock. This app owns no ledger.
The dashboard dev server proxies /live to it. There is no endpoint that accepts a journal entry,
changes a balance or approves anything.
"""

from __future__ import annotations

import json
import queue
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .config import Config
from .publisher import MemorySink
from .races import RACES
from .replay import ReplayOptions
from .result_replay import ResultReplayOptions
from .runtime import make_replay, slice_dir
from .cases import Refused
from .schemas import FinanceImpactUpdate, GarageReport
from .team import TEAMS

app = FastAPI(title="Pit Wall live racing", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

BUS = MemorySink()
_LOCK = threading.Lock()
_CURRENT: dict[str, Any] = {"replay": None, "thread": None, "log": []}


def _log(line: str) -> None:
    _CURRENT["log"].append(line)
    del _CURRENT["log"][:-400]


class StartReplay(BaseModel):
    race_id: str = "2024_sao_paulo_gp"
    speed: float = Field(20.0, gt=0)
    from_lap: int | None = 28
    to_lap: int | None = 34
    pause_at_lap: int | None = None
    jev: bool = True
    corroborate_after_s: float = 60.0
    state_every_s: float = 2.0
    spacetime: bool = True
    advisor: bool | None = None  # None = on when ANTHROPIC_API_KEY is set and LIVE_ADVISOR is not off
    team: str = "mercedes"  # mercedes (championship money) | alpine (strategy upside) | williams (the crash as our own car)
    demo: bool = True  # own-team cases receive the synthetic garage report and invoice automatically


def current():
    return _CURRENT["replay"]


@app.get("/live/health")
def health():
    cfg = Config.from_env()
    return {"ok": True, "jev": "api" if cfg.typesafe_api_key and cfg.jev_mode == "api" else "deterministic_fallback",
            "spacetime": f"{cfg.spacetime_url}/{cfg.spacetime_db}", "finance_agent_url": bool(cfg.finance_agent_url)}


@app.get("/live/races")
def races():
    cfg = Config.from_env()
    return [{"race_id": r.race_id, "name": r.name, "season": r.season, "round": r.round, "kind": "openf1_replay" if slice_dir(cfg, r).joinpath("events.jsonl").exists()
             else "fia_documents_replay", "cached": slice_dir(cfg, r).joinpath("events.jsonl").exists() or r.race_id == "2024_belgian_gp",
             "corroboration": [c.__dict__ for c in r.corroboration], "note": r.team_cars_note} for r in RACES.values()]


@app.post("/live/replay", status_code=202)
def start(body: StartReplay):
    with _LOCK:
        rp = current()
        if rp is not None and rp.status.state in ("fast_forward", "running", "paused"):
            rp.stop()
        if body.race_id not in RACES:
            raise HTTPException(404, f"unknown race {body.race_id}")
        if body.race_id == "2024_belgian_gp":
            options: Any = ResultReplayOptions(speed=body.speed, jev=body.jev)
        else:
            if body.team not in TEAMS:
                raise HTTPException(422, f"unknown team {body.team}; one of {sorted(TEAMS)}")
            options = ReplayOptions(speed=body.speed, from_lap=body.from_lap, to_lap=body.to_lap, pause_at_lap=body.pause_at_lap, jev=body.jev,
                                    corroborate_after_s=body.corroborate_after_s, state_every_s=body.state_every_s, team=body.team, demo=body.demo)
        _CURRENT["log"] = []
        try:
            rp = make_replay(body.race_id, options, memory=BUS, spacetime=body.spacetime, log=_log, advisor=body.advisor)
        except FileNotFoundError as exc:
            raise HTTPException(409, str(exc)) from exc
        th = threading.Thread(target=rp.run, name=f"replay-{rp.replay_id}", daemon=True)
        _CURRENT.update(replay=rp, thread=th)
        th.start()
        return {"replay_id": rp.replay_id, "state": rp.status.state, "jev": rp.jev.describe(), "sinks": rp.publisher.names(),
                "advisor": getattr(getattr(rp, "advisor", None), "describe", lambda: "n/a")()}


@app.post("/live/replay/resume")
def resume():
    rp = current()
    if rp is None:
        raise HTTPException(404, "no replay")
    rp.resume()
    return {"replay_id": rp.replay_id, "state": rp.status.state}


@app.post("/live/replay/stop")
def stop():
    rp = current()
    if rp is None:
        raise HTTPException(404, "no replay")
    rp.stop()
    return {"replay_id": rp.replay_id, "state": rp.status.state}


@app.get("/live/state")
def state():
    rp = current()
    latest_state = BUS.latest.get(("race_state", rp.race.race_id)) if rp is not None else None
    return {
        "replay": rp.status.model_dump(mode="json") if rp is not None else None,
        "race_state": latest_state["payload"] if latest_state else None,
        "incidents": [r["payload"] for r in BUS.of_kind("incident_signal")],
        "result_changes": [r["payload"] for r in BUS.of_kind("result_change")],
        "jev_decisions": [r["payload"] for r in BUS.of_kind("jev_decision")][-50:],
        "finance_impacts": [r["payload"] for r in BUS.of_kind("finance_impact")],
        "cases": [r["payload"] for r in BUS.of_kind("finance_case")],
        "team": {"id": rp.world.team, "label": TEAMS.get(rp.world.team, {}).get("label")} if rp is not None and hasattr(rp, "world") else None,
        "strategy": (BUS.latest.get(("strategy_advice", rp.race.race_id)) or {}).get("payload") if rp is not None else None,
        "incident_plans": [r["payload"] for r in BUS.of_kind("incident_plan")],
        "timeline": (BUS.latest.get(("race_timeline", rp.race.race_id)) or {}).get("payload") if rp is not None else None,
        "workflows": [r["payload"] for r in BUS.of_kind("agent_workflow") if rp is None or r["payload"].get("replay_id") == rp.replay_id][-40:],
        "feed": rp.feed_health().model_dump(mode="json") if rp is not None else None,
        "metrics": rp.metrics() if rp is not None else None,
        "log": _CURRENT["log"][-60:],
        "seq": BUS.seq,
    }


@app.get("/live/incidents")
def incidents():
    return [r["payload"] for r in BUS.of_kind("incident_signal")]


@app.get("/live/incidents/{incident_id:path}")
def incident(incident_id: str):
    r = BUS.latest.get(("incident_signal", incident_id))
    if r is None:
        raise HTTPException(404, "no such incident")
    return r["payload"]


@app.post("/live/incidents/{incident_id:path}/finance-impact")
def finance_impact(incident_id: str, body: FinanceImpactUpdate):
    """Person 2 answers by incident_id. The schema forbids extra fields, so a journal entry, a balance
    or an approval cannot be smuggled in; the ledger is not reachable from here."""
    rp = current()
    if rp is None:
        raise HTTPException(404, "no replay")
    if body.incident_id != incident_id:
        raise HTTPException(422, "incident_id in the body must match the path")
    try:
        sig = rp.ack_finance_impact(body)
    except KeyError:
        raise HTTPException(404, f"no such incident {incident_id}") from None
    return {"incident_id": incident_id, "version": sig.version, "handoff": sig.handoff.model_dump(mode="json"), "financial_impact": sig.financial_impact.model_dump(mode="json")}


@app.get("/live/events")
def events(since: int = 0, kinds: str | None = None, limit: int = 500):
    out = BUS.since(since, kinds.split(",") if kinds else None)[:limit]
    return {"events": out, "seq": BUS.seq}


@app.get("/live/feed")
def feed():
    """Measured liveness: cadence, the race clock, each sink's writes (SpacetimeDB rows), Jev, the exposure tally."""
    rp = current()
    if rp is None:
        raise HTTPException(404, "no replay")
    return rp.feed_health()


@app.get("/live/strategy")
def strategy():
    rp = current()
    r = BUS.latest.get(("strategy_advice", rp.race.race_id)) if rp is not None else None
    if r is None:
        raise HTTPException(404, "no strategy advice yet")
    return r["payload"]


@app.get("/live/timeline")
def timeline():
    rp = current()
    r = BUS.latest.get(("race_timeline", rp.race.race_id)) if rp is not None else None
    if r is None:
        raise HTTPException(404, "no timeline yet")
    return r["payload"]


@app.get("/live/workflows")
def workflows():
    return [r["payload"] for r in BUS.of_kind("agent_workflow")]


@app.get("/live/plans")
def plans():
    return [r["payload"] for r in BUS.of_kind("incident_plan")]


# ---------------------------------------------------------------- financial cases


class ApproveBody(BaseModel):
    role: str
    by: str
    decision: str
    reason: str = ""


class InvoiceBody(BaseModel):
    amount_cents: int | None = None


def _book():
    rp = current()
    if rp is None or not hasattr(rp, "cases"):
        raise HTTPException(404, "no replay with cases")
    return rp


@app.get("/live/cases")
def cases():
    return [r["payload"] for r in BUS.of_kind("finance_case")]


@app.get("/live/cases/{case_id:path}")
def case(case_id: str):
    r = BUS.latest.get(("finance_case", case_id))
    if r is None:
        raise HTTPException(404, "no such case")
    return r["payload"]


@app.post("/live/cases/{case_id:path}/garage-report")
def garage_report(case_id: str, body: GarageReport | None = None):
    """The garage's signed damage report. With no body the synthetic demo report is applied, labelled synthetic."""
    rp = _book()
    if case_id not in rp.cases.cases:
        raise HTTPException(404, "no such case")
    try:
        c = rp.cases.demo_garage_report(case_id) if body is None else rp.cases.receive_garage_report(case_id, body)
    except Refused as exc:
        raise HTTPException(403, str(exc)) from None
    return c


@app.post("/live/cases/{case_id:path}/approve")
def approve(case_id: str, body: ApproveBody):
    """A person's decision: engineering clears or refuses the repair; the controller authorizes or rejects the
    spend. Agents are refused; the same person cannot do both."""
    rp = _book()
    if case_id not in rp.cases.cases:
        raise HTTPException(404, "no such case")
    try:
        return rp.approve(case_id, body.role, body.by, body.decision, body.reason)
    except Refused as exc:
        raise HTTPException(403, str(exc)) from None


@app.post("/live/cases/{case_id:path}/invoice")
def invoice(case_id: str, body: InvoiceBody | None = None):
    """A supplier invoice (synthetic): matched to the authorized order within 2% or escalated."""
    rp = _book()
    if case_id not in rp.cases.cases:
        raise HTTPException(404, "no such case")
    try:
        return rp.cases.demo_invoice(case_id, body.amount_cents if body else None)
    except Refused as exc:
        raise HTTPException(403, str(exc)) from None


@app.get("/live/scorecard")
def scorecard():
    """Measured proof written by scripts/live_scorecard.py; 404 until it has been run."""
    path = Path(__file__).resolve().parent / "out" / "scorecard.json"
    if not path.exists():
        raise HTTPException(404, "no scorecard yet: uv run python scripts/live_scorecard.py")
    return json.loads(path.read_text())


@app.get("/live/metrics")
def metrics():
    rp = current()
    if rp is None:
        raise HTTPException(404, "no replay")
    return rp.metrics()


@app.get("/live/stream")
def stream(since: int = 0, kinds: str | None = None):
    """Server-sent events: every published record, as `event: <kind>` with the record as JSON data."""
    ks = set(kinds.split(",")) if kinds else None

    def gen():
        q = BUS.subscribe()
        try:
            for r in BUS.since(since, ks):
                yield f"id: {r['seq']}\nevent: {r['kind']}\ndata: {json.dumps(r, default=str)}\n\n"
            last = time.monotonic()
            while True:
                try:
                    r = q.get(timeout=1.0)
                except queue.Empty:
                    if time.monotonic() - last > 15:
                        yield ": keepalive\n\n"
                        last = time.monotonic()
                    continue
                last = time.monotonic()
                if ks is None or r["kind"] in ks:
                    yield f"id: {r['seq']}\nevent: {r['kind']}\ndata: {json.dumps(r, default=str)}\n\n"
        finally:
            BUS.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-store", "x-accel-buffering": "no"})
