"""Build a season's event stream and run it through the router.

Events, in time order: race-weekend sessions (provisional and final
classifications, FIA summons and infringements at their real publication
times when a capture exists), the commercial team's bonus billing requests,
sponsor remittances and month-end closes.

    python -m finance.sim 2023            # training season, people answer automatically
    python -m finance.sim 2024 --fresh    # hidden test season, cold run
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from . import fia_bridge
from .agents.personas import Personas
from .agents.revenue import RevenueAgent
from .agents.store import AgentStore
from .config import DATA_DIR, WORLD_DIR
from .engine import Engine
from .ledger import Ledger, new_id
from .router import Router
from .world import World

ORDER = {"race_provisional": 0, "fia_document": 1, "race_final": 2, "billing_request": 3, "cash_received": 4, "month_end": 5, "season_end": 6}


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def weekend_events(world: World, season: int, rnd: dict, captures_dir=None) -> list[dict]:
    n, slug = int(rnd["round"]), rnd["slug"]
    docs = fia_bridge.weekend(season, slug, captures_dir) if captures_dir else fia_bridge.weekend(season, slug)
    events = []
    for session in ("sprint", "race"):
        if not rnd.get(session):
            continue
        start = world.race_start(season, n, session)
        prov_doc = next((d for d in docs if d["kind"] == f"provisional_{session}_classification"), None)
        final_doc = next((d for d in docs if d["kind"] == f"final_{session}_classification"), None)
        prov_at = _parse(prov_doc["published_at_utc"]) if prov_doc else start + timedelta(minutes=100 if session == "race" else 50)
        final_at = _parse(final_doc["published_at_utc"]) if final_doc else prov_at + timedelta(hours=2)
        if final_at <= prov_at:
            final_at = prov_at + timedelta(minutes=30)
        base = {"season": season, "round": n, "session": session, "slug": slug}
        events.append({"id": f"{season}-R{n:02d}-{session}-provisional", "type": "race_provisional", "at": iso(prov_at),
                       "payload": {**base, "source": prov_doc["raw_title"] if prov_doc else "provisional classification (no capture)",
                                   "url": prov_doc["url"] if prov_doc else None}})
        for d in docs:
            if d["session"] != session or d["kind"] not in ("summons", "infringement", "decision") or not d["cars"]:
                continue
            at = _parse(d["published_at_utc"])
            if prov_at <= at <= final_at + timedelta(days=14):
                doc_id = d["document_number"] or hashlib.sha1(d["url"].encode()).hexdigest()[:8]
                events.append({"id": f"{season}-R{n:02d}-fia-{doc_id}",
                               "type": "fia_document", "at": d["published_at_utc"],
                               "payload": {**base, "kind": d["kind"], "cars": d["cars"], "likely_outcome": d["likely_outcome"],
                                           "title": d["raw_title"], "url": d["url"], "actor_run_id": d["actor_run_id"]}})
        events.append({"id": f"{season}-R{n:02d}-{session}-final", "type": "race_final", "at": iso(final_at),
                       "payload": {**base, "source": final_doc["raw_title"] if final_doc else "final classification (no capture)",
                                   "url": final_doc["url"] if final_doc else None}})
    return events


def season_events(world: World, season: int, requests: list[dict] | None = None, cash: bool = True) -> list[dict]:
    events = []
    for rnd in world.rounds(season):
        events += weekend_events(world, season, rnd)
    for r in requests or []:
        events.append({"id": r["request_id"], "type": "billing_request", "at": r["submitted_at"], "payload": r})
    if events:
        first = min(_parse(e["at"]) for e in events)
        last = max(_parse(e["at"]) for e in events)
        # Month-end closes on the 5th of the next month.
        m = datetime(first.year, first.month, 1, tzinfo=first.tzinfo)
        current = datetime(last.year, last.month, 1, tzinfo=last.tzinfo)
        while m < current:  # the month the run ends in stays open
            nxt = (m.replace(day=28) + timedelta(days=4)).replace(day=1)
            events.append({"id": f"close-{m:%Y-%m}", "type": "month_end", "at": iso(nxt + timedelta(days=4)),
                           "payload": {"period_id": f"{m:%Y-%m}"}})
            m = nxt
        if cash:
            for month in (4, 7, 10):
                for s in world.sponsors:
                    late, fraction = (60, 0.95) if s["id"] == "ridgeline" else (30, 1.0)
                    at = datetime(season, month, 1, 12, tzinfo=first.tzinfo) + timedelta(days=late)
                    if at <= last + timedelta(days=60):
                        events.append({"id": f"cash-{season}-{month:02d}-{s['id']}", "type": "cash_received", "at": iso(at),
                                       "payload": {"sponsor_id": s["id"], "fraction": fraction}})
        events.append({"id": f"season-end-{season}", "type": "season_end", "at": iso(last + timedelta(days=1)), "payload": {"season": season}})
    return sorted(events, key=lambda e: (e["at"], ORDER[e["type"]], e["id"]))


@dataclass
class Run:
    run_id: str
    season: int
    world: World
    ledger: Ledger
    router: Router
    store: AgentStore
    events: list[dict]
    cursor: int = 0

    def step(self) -> tuple[dict, list] | None:
        if self.cursor >= len(self.events):
            return None
        event = self.events[self.cursor]
        self.cursor += 1
        return event, self.router.dispatch(event, self.ledger)

    def run_until(self, stop=lambda e: False) -> int:
        n = 0
        while self.cursor < len(self.events) and not stop(self.events[self.cursor]):
            self.step()
            n += 1
        return n

    def run_all(self) -> int:
        return self.run_until()


def load_requests(world: World, season: int) -> list[dict]:
    path = Path(world.dir) / "requests" / f"{season}.json"
    return json.loads(path.read_text())["requests"] if path.exists() else []


def new_run(season: int, *, world: World | None = None, run_id: str | None = None, auto_people: bool = True,
            store: AgentStore | None = None, data_dir: Path | None = None, requests: list[dict] | None = None,
            cash: bool = True) -> Run:
    world = world or World(WORLD_DIR)
    data_dir = Path(data_dir) if data_dir else DATA_DIR
    run_id = run_id or f"{season}-{new_id('run')[4:]}"
    store = store or AgentStore(data_dir / "agents.db")
    ledger = Ledger(data_dir / "runs" / run_id / "ledger.db", world)
    engine = Engine(world)
    agent = RevenueAgent(world, engine, store, run_id)
    router = Router(world, engine, agent, Personas(world, agent, store), auto_people=auto_people)
    from .notify.dispatcher import maybe_attach as attach_notifier
    from .spacetime_mirror import maybe_attach

    from .audit.seal import attach as attach_sealer

    attach_sealer(ledger, run_id)  # evidence seals for the independent auditor (PITWALL_SEALS=0 to turn off)
    from .telemetry import attach as attach_telemetry

    attach_telemetry(ledger)  # Azure Monitor metrics, only when APPLICATIONINSIGHTS_CONNECTION_STRING is set
    maybe_attach(ledger, run_id)
    attach_notifier(ledger, run_id)
    reqs = load_requests(world, season) if requests is None else requests
    return Run(run_id, season, world, ledger, router, store, season_events(world, season, reqs, cash))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("season", type=int)
    ap.add_argument("--fresh", action="store_true", help="forget learned rules first (cold run)")
    ap.add_argument("--run-id")
    args = ap.parse_args()
    store = AgentStore(DATA_DIR / "agents.db")
    if args.fresh:
        store.reset()
    run = new_run(args.season, store=store, run_id=args.run_id)
    run.run_all()
    tb = run.ledger.trial_balance()
    print(f"run {run.run_id}: {run.router.stats}, books tie: {tb['ties']}")
    from .eval import scorecard

    print(json.dumps(scorecard(run), indent=2))


if __name__ == "__main__":
    main()
