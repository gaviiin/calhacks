"""HTTP API for the Pit Wall frontend.

    uvicorn finance.api:app --reload --port 8000

Runs live in memory (one SQLite ledger file each under data/runs/). Typical demo:
    POST /api/runs {"season": 2024, "stop_before_round": 14, "auto_people": false}
    POST /api/runs/{id}/advance {"round": 14}        # replay the Spa weekend
    GET  /api/runs/{id}/weekend/14                   # FIA documents + what Pit Wall did, on one time axis
    POST /api/runs/{id}/scenario {"round": 12, "car": 44, "action": "dsq"}
"""

from __future__ import annotations

import json
import os
import threading
from collections import defaultdict

from anyio import to_thread
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import fia_bridge, saboteur, scenario
from .agents.personas import DANA, PRIYA
from .agents.store import AgentStore
from .config import ACCOUNTS, DATA_DIR
from .eval import scorecard
from .explain import explain
from .money import fmt
from .sim import Run, new_run
from .world import World

app = FastAPI(title="Pit Wall", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("PITWALL_CORS", "*").split(","), allow_methods=["*"], allow_headers=["*"])

# Every request shares the runs' ledgers, one SQLite connection each, and the sync endpoints run on a
# thread pool. sqlite3 connections are not safe to use from two threads at once (a dashboard that
# loads six panels in parallel got "bad parameter or other API misuse" and phantom KeyErrors), so
# requests are served one at a time. A thread lock, taken off the event loop, so it also holds when
# requests arrive on different event loops (the test client runs one per thread).
_ONE_AT_A_TIME = threading.Lock()


@app.middleware("http")
async def one_request_at_a_time(request, call_next):
    await to_thread.run_sync(_ONE_AT_A_TIME.acquire)
    try:
        return await call_next(request)
    finally:
        _ONE_AT_A_TIME.release()

WORLD = World()
STORE = AgentStore(DATA_DIR / "agents.db")
RUNS: dict[str, Run] = {}
PEOPLE = {DANA: {"name": "Dana Okafor", "roles": ["controller"]}, PRIYA: {"name": "Priya Raman", "roles": ["cfo"]}}


def get_run(run_id: str) -> Run:
    if run_id not in RUNS:
        raise HTTPException(404, f"no run {run_id}")
    return RUNS[run_id]


def _result(r):
    if isinstance(r, dict):
        return r
    if hasattr(r, "status"):
        return {"status": r.status, "je_id": r.je_id, "reason": r.reason, "needs": r.needs}
    return {"memo_id": r} if isinstance(r, str) else str(r)


# --------------------------------------------------------------------------- runs


class NewRun(BaseModel):
    season: int
    stop_before_round: int | None = None
    auto_people: bool = True
    fresh_rules: bool = False
    cash: bool = True  # False: sponsors' remittances are not simulated (agents pay invoices instead, e.g. Fetch.ai demo)


@app.post("/api/runs")
def create_run(body: NewRun):
    if body.season not in WORLD.seasons():
        raise HTTPException(400, f"no cached results for {body.season}; run scripts/fetch_results.py {body.season}")
    if body.fresh_rules:
        STORE.reset()
    run = new_run(body.season, world=WORLD, store=STORE, auto_people=body.auto_people, cash=body.cash)
    notifier = getattr(run.ledger, "notifier", None)
    if notifier is None and os.environ.get("PITWALL_NOTIFY", "dry") != "off":
        from .notify.dispatcher import Notifier

        notifier = Notifier(run.ledger, run.run_id)
        run.ledger.listeners.append(notifier)
        run.ledger.notifier = notifier
    if notifier:
        notifier.muted = True  # no messages about history being fast-forwarded
    if body.stop_before_round:
        run.run_until(lambda e: e["payload"].get("round", 0) >= body.stop_before_round and e["type"] in ("race_provisional", "fia_document", "race_final"))
    else:
        run.run_all()
    if notifier:
        notifier.muted = False
    RUNS[run.run_id] = run
    return {"run_id": run.run_id, "events_done": run.cursor, "events_total": len(run.events), "clock": run.ledger.clock}


@app.get("/api/runs")
def list_runs():
    return [{"run_id": r.run_id, "season": r.season, "events_done": r.cursor, "events_total": len(r.events), "clock": r.ledger.clock}
            for r in RUNS.values()]


class Advance(BaseModel):
    n: int | None = None
    round: int | None = None


@app.post("/api/runs/{run_id}/advance")
def advance(run_id: str, body: Advance):
    """Step n events, or every event up to the end of a round's weekend."""
    run = get_run(run_id)
    done = []
    while run.cursor < len(run.events):
        nxt = run.events[run.cursor]
        if body.round is not None:
            if nxt["type"] in ("race_provisional", "fia_document", "race_final") and nxt["payload"]["round"] > body.round:
                break
        elif body.n is not None and len(done) >= body.n:
            break
        event, results = run.step()
        done.append({"event": event, "results": [_result(r) for r in results]})
        if body.round is None and body.n is None:
            break
    return {"done": done, "clock": run.ledger.clock, "events_done": run.cursor}


# --------------------------------------------------------------------------- reads


@app.get("/api/runs/{run_id}/tape")
def tape(run_id: str, since: str | None = None, limit: int = 200):
    """The transaction tape: journal entries in the order the system recorded them."""
    run = get_run(run_id)
    rows = run.ledger.q("SELECT je_id FROM journal_entries WHERE recorded_at > ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?",
                        since or "", limit)
    out = []
    for r in rows:
        e = run.ledger.entry(r["je_id"])
        out.append({k: e[k] for k in ("je_id", "kind", "status", "memo", "total_cents", "recorded_at", "effective_date", "sponsor_id",
                                       "preparer", "needs", "reason")})
    return out


@app.get("/api/runs/{run_id}/entries/{je_id}")
def entry(run_id: str, je_id: str):
    try:
        return get_run(run_id).ledger.entry(je_id)
    except KeyError:
        raise HTTPException(404, je_id)


@app.get("/api/runs/{run_id}/entries/{je_id}/why")
def why(run_id: str, je_id: str):
    run = get_run(run_id)
    return explain(run.ledger, je_id, run.router.agent.llm)


@app.get("/api/runs/{run_id}/queue")
def queue(run_id: str):
    led = get_run(run_id).ledger
    return {
        "parked": [{
            **{k: e[k] for k in ("je_id", "kind", "memo", "total_cents", "needs", "reason", "recorded_at")},
            "approved_roles": [a["role"] for a in e["approvals"] if a["decision"] == "approve"],
        } for e in led.entries(status="parked")],
        "questions": [dict(q) for q in led.q("SELECT q_id, to_role, subject, text, status, asked_at FROM questions WHERE status='open'")],
        "held_billing": [{"request_id": b["request_id"], "reason": b["reason_code"], **{k: b["payload"][k] for k in ("sponsor_id", "round", "session", "car", "amount_orig", "currency", "note")}}
                         for b in led.billings("hold")],
        "alerts": [{"key": m["key"], **m["payload"], "at": m["created_at"]} for m in led.memos("alert")],
    }


@app.get("/api/runs/{run_id}/timeline")
def timeline(run_id: str):
    """Revenue by stream per round (posted entries), cumulative, plus the prize estimate after each round."""
    run = get_run(run_id)
    led = run.ledger
    per = defaultdict(lambda: {"base": 0, "bonus": 0, "prize": 0})
    for e in led.entries(status="posted"):
        b = e["basis"]
        rnd = b.get("round") or b.get("through_round")
        if rnd is None:
            continue
        rev = sum(x["credit_cents"] - x["debit_cents"] for x in e["lines"] if x["account"].startswith("4"))
        stream = {"base_recognition": "base", "bonus": "bonus", "bonus_reversal": "bonus"}.get(e["kind"], "prize" if e["kind"].startswith("prize") else None)
        if stream:
            per[rnd][stream] += rev
    est = {r["through_round"]: dict(r) for r in led.q("SELECT * FROM prize_estimates WHERE season=?", run.season)}
    out, cum = [], {"base": 0, "bonus": 0, "prize": 0}
    for rnd in run.world.rounds(run.season):
        n = int(rnd["round"])
        for k in cum:
            cum[k] += per[n][k]
        out.append({"round": n, "name": rnd["name"], "slug": rnd["slug"], "date": rnd["date"], "final": led.is_final(run.season, n, "race"),
                    "revenue": dict(per[n]), "cumulative": dict(cum), "prize_estimate": est.get(n)})
    return out


@app.get("/api/runs/{run_id}/weekend/{rnd}")
def weekend(run_id: str, rnd: int):
    """One race weekend on a single time axis: the FIA's documents and what Pit Wall did about each."""
    run = get_run(run_id)
    led = run.ledger
    r = run.world.round(run.season, rnd)
    docs = [{"at": d["published_at_utc"], "kind": d["kind"], "title": d["raw_title"], "url": d["url"], "cars": d["cars"],
             "actor_run_id": d["actor_run_id"]} for d in fia_bridge.weekend(run.season, r["slug"])]
    actions = []
    for ev in led.q("SELECT * FROM events ORDER BY seq"):
        payload = json.loads(ev["payload"])
        if payload.get("round") != rnd and not (ev["type"] == "billing_request" and payload.get("round") == rnd):
            continue
        actions.append({"at": ev["at"], "event": ev["type"], "event_id": ev["event_id"], "payload": payload,
                        "results": json.loads(ev["results"])})
    memos = [{"key": m["key"], "kind": m["kind"], "status": m["status"], **m["payload"], "updated_at": m["updated_at"]}
             for m in led.memos(season=run.season, rnd=rnd)]
    return {"round": rnd, "name": r["name"], "slug": r["slug"], "fia_documents": docs, "actions": actions, "memos": memos,
            "billing": [b for b in led.billings() if b["payload"]["round"] == rnd]}


@app.get("/api/runs/{run_id}/trial-balance")
def trial_balance(run_id: str, as_of: str | None = None):
    return get_run(run_id).ledger.trial_balance(as_of)


@app.get("/api/runs/{run_id}/sponsors")
def sponsors(run_id: str):
    """Sponsor statements: what each sponsor owes, and bonuses earned, billed and credited."""
    run = get_run(run_id)
    led = run.ledger
    out = []
    for s in run.world.sponsors:
        usd, orig = led.ar(s["id"])
        bonuses = [e for e in led.entries(kind="bonus") if e["sponsor_id"] == s["id"] and e["status"] == "posted"]
        out.append({"sponsor_id": s["id"], "name": s["name"], "currency": s["currency"], "receivable_usd_cents": usd,
                    "receivable_orig_cents": orig, "receivable": fmt(orig, s["currency"]),
                    "bonuses_earned": len([b for b in bonuses if not b["reversed_by"]]),
                    "bonuses_reversed": len([b for b in bonuses if b["reversed_by"]]),
                    "billing": {st: len([b for b in led.billings(st) if b["payload"]["sponsor_id"] == s["id"]])
                                for st in ("billed", "hold", "rejected", "credited", "pending_approval")}})
    return out


@app.get("/api/runs/{run_id}/asof")
def as_of(run_id: str, t: str):
    led = get_run(run_id).ledger
    return {"t": t, "trial_balance": led.trial_balance(t),
            "entries": len(led.q("SELECT 1 FROM journal_entries WHERE status='posted' AND posted_at<=?", t))}


@app.get("/api/runs/{run_id}/scorecard")
def get_scorecard(run_id: str):
    return scorecard(get_run(run_id))


@app.get("/api/runs/{run_id}/saboteur")
def run_saboteur(run_id: str):
    run = get_run(run_id)
    return saboteur.run(run.ledger.path, run.world)


@app.get("/api/runs/{run_id}/costs")
def costs(run_id: str):
    run = get_run(run_id)
    return {**STORE.costs(run_id), "router": run.router.stats, "llm_enabled": run.router.agent.llm.enabled}


@app.get("/api/accounts")
def accounts():
    return ACCOUNTS


@app.get("/api/people")
def people():
    return PEOPLE


# --------------------------------------------------------------------------- people act


class Approval(BaseModel):
    je_id: str
    approver: str
    role: str
    decision: str = "approve"
    reason: str = ""


@app.post("/api/runs/{run_id}/approve")
def approve(run_id: str, body: Approval):
    run = get_run(run_id)
    res = run.ledger.approve(body.je_id, body.approver, body.role, body.decision, body.reason)
    run.router.engine.rereview(run.ledger)
    return _result(res)


class Answer(BaseModel):
    q_id: str
    answer: str


@app.post("/api/runs/{run_id}/answer")
def answer(run_id: str, body: Answer):
    run = get_run(run_id)
    led = run.ledger
    q = led.one("SELECT * FROM questions WHERE q_id=?", body.q_id)
    if q is None:
        raise HTTPException(404, body.q_id)
    led.answer(body.q_id, body.answer)
    out = run.router.agent.apply_answer(dict(led.one("SELECT * FROM questions WHERE q_id=?", body.q_id)), led)
    out += run.router.engine.rereview(led)
    return [_result(r) for r in out]


@app.get("/api/rules")
def rules():
    return STORE.rules()


class RuleApproval(BaseModel):
    version: int
    approver: str = DANA


@app.post("/api/rules/{rule_id}/approve")
def approve_rule(rule_id: str, body: RuleApproval):
    try:
        STORE.approve_rule(rule_id, body.version, body.approver, "now")
    except PermissionError as exc:
        raise HTTPException(403, str(exc))
    for run in RUNS.values():
        run.ledger.rules = STORE.approved()
    return STORE.rules()


class Scenario(BaseModel):
    round: int
    car: int
    action: str = "dsq"
    places: int = 0
    session: str = "race"
    reason: str = "Stewards' decision (hypothetical scenario)"


@app.post("/api/runs/{run_id}/scenario")
def stewards_decision(run_id: str, body: Scenario):
    run = get_run(run_id)
    try:
        return scenario.apply(run, season=run.season, rnd=body.round, car=body.car, action=body.action,
                              places=body.places, session=body.session, reason=body.reason)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


# --------------------------------------------------------------------------- red team sandbox
# An external red-team agent attacks a *copy* of a run's books through the same
# write path. Nothing it does touches the real ledger. Every attempt is scored.

import shutil  # noqa: E402
from pathlib import Path  # noqa: E402

from .ledger import Decision, Ledger, Line, Proposal, new_id  # noqa: E402

REDTEAM: dict[str, dict] = {}


class RedTeamStart(BaseModel):
    attacker: str = "redteam"


@app.post("/api/runs/{run_id}/redteam")
def redteam_start(run_id: str, body: RedTeamStart):
    run = get_run(run_id)
    sid = new_id("rt")
    path = Path(run.ledger.path).parent / f"{sid}.db"
    shutil.copy(run.ledger.path, path)
    led = Ledger(path, run.world)
    led.clock, led.rules = run.ledger.clock, dict(run.ledger.rules)
    REDTEAM[sid] = {"run": run, "ledger": led, "attacker": f"redteam:{body.attacker}", "attempts": []}
    return {"session_id": sid, "clock": led.clock, "hint": "POST proposals to /api/redteam/{sid}/propose; read /api/redteam/{sid}/report"}


def _session(sid: str) -> dict:
    if sid not in REDTEAM:
        raise HTTPException(404, sid)
    return REDTEAM[sid]


class RTLine(BaseModel):
    account: str
    debit: int = 0
    credit: int = 0
    currency: str = "USD"
    orig: int | None = None
    rate: str | None = None
    sponsor_id: str | None = None
    carrying: bool = False


class RTProposal(BaseModel):
    kind: str
    effective_date: str
    memo: str = "red team"
    lines: list[RTLine]
    question: str = "red team"
    answer: str = "red team"
    policy_ids: list[str] = []
    evidence: list[dict] = []
    key: str | None = None
    reverses_je_id: str | None = None
    sponsor_id: str | None = None
    basis: dict = {}
    label: str = "unlabelled attack"


@app.post("/api/redteam/{sid}/propose")
def redteam_propose(sid: str, body: RTProposal):
    s = _session(sid)
    p = Proposal(kind=body.kind, effective_date=body.effective_date, memo=body.memo, preparer=s["attacker"],
                 lines=[Line(**x.model_dump()) for x in body.lines], key=body.key, reverses_je_id=body.reverses_je_id,
                 sponsor_id=body.sponsor_id, basis=body.basis,
                 decision=Decision(body.question, body.answer, body.policy_ids, body.evidence))
    try:
        res = s["ledger"].propose_entry(p)
        failed = [c for c in res.checks if c["result"] == "fail"]
        out = {"status": res.status, "je_id": res.je_id, "reason": res.reason, "failed_checks": [c["id"] for c in failed], "needs": res.needs}
    except Exception as exc:  # malformed attacks are refusals too
        out = {"status": "refused", "reason": f"malformed proposal: {exc}", "failed_checks": ["schema"]}
    s["attempts"].append({"type": "propose", "label": body.label, **out})
    return out


class RTApprove(BaseModel):
    je_id: str
    approver: str
    role: str = "controller"
    label: str = "approval abuse"


@app.post("/api/redteam/{sid}/approve")
def redteam_approve(sid: str, body: RTApprove):
    s = _session(sid)
    try:
        res = s["ledger"].approve(body.je_id, body.approver, body.role)
        out = {"status": res.status, "reason": res.reason}
    except KeyError:
        out = {"status": "refused", "reason": "no such entry"}
    s["attempts"].append({"type": "approve", "label": body.label, **out})
    return out


class RTBilling(BaseModel):
    round: int
    session: str = "race"
    sponsor_id: str
    clause_id: str
    car: int
    amount_orig: int
    currency: str
    note: str = ""
    label: str = "fake billing request"


@app.post("/api/redteam/{sid}/billing")
def redteam_billing(sid: str, body: RTBilling):
    """Submit a bonus billing request as a rogue commercial team member."""
    s = _session(sid)
    run, led = s["run"], s["ledger"]
    req = {"request_id": new_id("RT"), "submitted_at": led.clock, "requested_by": s["attacker"], "season": run.season,
           **body.model_dump(exclude={"label"})}
    out = run.router.engine.review(req, led)
    s["attempts"].append({"type": "billing", "label": body.label, **{k: out.get(k) for k in ("status", "reason", "je_id")}})
    return out


@app.get("/api/redteam/{sid}/report")
def redteam_report(sid: str):
    s = _session(sid)
    att = s["attempts"]
    leaked = [a for a in att if a.get("status") in ("posted", "billed")]
    to_person = [a for a in att if a.get("status") in ("parked", "pending_approval", "hold")]
    return {"attacker": s["attacker"], "attempts": len(att), "refused": len(att) - len(leaked) - len(to_person),
            "reached_a_person": len(to_person), "leaked": leaked, "books_tie": s["ledger"].trial_balance()["ties"],
            "by_label": {lbl: [a["status"] for a in att if a["label"] == lbl] for lbl in sorted({a["label"] for a in att})},
            "attempt_log": att[-50:]}


# --------------------------------------------------------------------------- communication integrations
from .integrations_api import build_router  # noqa: E402

app.include_router(build_router(get_run, RUNS))

# --------------------------------------------------------------------------- independent auditor, impact, Microsoft integrations
from . import telemetry  # noqa: E402
from .microsoft_api import build_router as build_microsoft_router  # noqa: E402

telemetry.configure(app)
app.include_router(build_microsoft_router(get_run, STORE))

# --------------------------------------------------------------------------- outside agents (Fetch.ai Agentverse / ASI:One)
from .agent_api import build_router as build_agent_router  # noqa: E402

app.include_router(build_agent_router(get_run))

# --------------------------------------------------------------------------- cost cap strategy simulator
from capsim.api import router as capsim_router  # noqa: E402

app.include_router(capsim_router)
