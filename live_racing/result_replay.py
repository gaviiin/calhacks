"""Milestone P1: an official sporting-result change replayed from the team's real FIA captures.

The 2024 Belgian Grand Prix: provisional classification (Russell P1, Hamilton P2), Doc 43 summons
for car 63, Doc 44 infringement (disqualification, underweight car), Doc 46 final classification.
Each document is a source-specific event at its real publication time (ingestion/captures via
finance.fia_bridge). Jev routes the documents; the arithmetic is the revenue desk's own contract
logic. The output is a corrected *provisional expected* bonus, never a booking: the desk's
seven-day hold and recognized-revenue policy gate still apply (make revenue-demo books it).
"""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Callable

from finance import fia_bridge

from .finance_projections import diff, forecast_for_rows, usd
from .health import feed_health
from .jev_router import JevRouter, deterministic_route
from .publisher import Publisher
from .races import Race
from .schemas import FinanceImpactUpdate, Handoff, JevDecision, OfficialDocument, ReplayStatus, ResultChangeSignal, Timestamps


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _seconds(a: str, b: str) -> float:
    return (datetime.fromisoformat(b.replace("Z", "+00:00")) - datetime.fromisoformat(a.replace("Z", "+00:00"))).total_seconds()


RACE_DOC_KINDS = ("provisional_race_classification", "summons", "infringement", "decision", "final_race_classification")


def document_events(race: Race) -> list[dict]:
    """The race session's documents for this event, in publication order, from the saved captures."""
    docs = [d for d in fia_bridge.weekend(race.season, race.slug) if d["session"] == "race" and d["kind"] in RACE_DOC_KINDS]
    return sorted(docs, key=lambda d: d["published_at_utc"])


@dataclass
class ResultReplayOptions:
    speed: float = 120.0
    jev: bool = True
    max_sleep_s: float = 20.0
    mode: str = "replay"


class ResultReplay:
    def __init__(self, race: Race, world, publisher: Publisher, jev: JevRouter, options: ResultReplayOptions | None = None, *,
                 now: Callable[[], str] = _now, log: Callable[[str], None] = print, replay_id: str | None = None):
        self.race, self.world, self.publisher, self.jev = race, world, publisher, jev
        self.o = options or ResultReplayOptions()
        self.now, self.log = now, log
        self.replay_id = replay_id or f"{race.race_id}:{uuid.uuid4().hex[:8]}"
        self.docs = document_events(race)
        self.team_cars = [n for n, i in world.car_map(race.season).items() if i["constructor_id"] == world.team]
        self.signals: list[ResultChangeSignal] = []
        self.decisions: list[dict] = []
        self.incidents: dict = {}
        self.jev_calls_by_kind: dict[str, int] = {}
        self._stop = threading.Event()
        self.status = ReplayStatus(replay_id=self.replay_id, race_id=race.race_id, mode=self.o.mode, speed=self.o.speed, events_total=len(self.docs),
                                   events_done=0, jev_mode=jev.describe(), sinks=publisher.names())

    def stop(self) -> None:
        self._stop.set()
        if self.status.state not in ("finished", "stopped", "error"):
            self.status.state = "stopped"

    def resume(self) -> None:
        pass

    def ack_finance_impact(self, update: FinanceImpactUpdate):
        raise KeyError(update.incident_id)

    def feed_health(self):
        now = self.signals[-1].after.amount_cents if self.signals else None
        first = self.signals[0].before.amount_cents if self.signals else None
        peak = max((s.before.amount_cents or 0) for s in self.signals) if self.signals else None
        return feed_health(self.replay_id, self.status, self.o.mode, self.now(), self.status.clock_utc, None, self.publisher, self.jev, "n/a (document replay)",
                           len(self.signals), now, first, peak, 0, 0)

    def _publish_status(self) -> None:
        self.status.sinks = self.publisher.names()
        self.status.jev_requests, self.status.jev_errors = self.jev.stats.requests, self.jev.stats.errors
        self.publisher.publish("replay_status", self.status, id=self.replay_id, version=self.status.events_done + 1, status=self.status.state)

    def run(self) -> ReplayStatus:
        try:
            self._run()
        except Exception as exc:  # noqa: BLE001
            self.status.state, self.status.error = "error", f"{exc.__class__.__name__}: {exc}"
            self._publish_status()
            raise
        return self.status

    def _run(self) -> None:
        r, w = self.race, self.world
        provisional = w.classification(r.season, r.round, "race", "provisional")
        final = w.classification(r.season, r.round, "race", "final")
        team = lambda rows: ", ".join(f"car {x.number} {x.driver_id} {'P' + str(x.pos) if x.pos else x.pos_text}" for x in w.team_rows(rows))  # noqa: E731
        current = forecast_for_rows(w, r, provisional, as_of_utc=None, type="provisional_classification", status="awaiting_official_classification",
                                    basis=f"provisional race classification: {team(provisional)}")
        after_dsq = forecast_for_rows(w, r, final, as_of_utc=None, type="provisional_classification", status="awaiting_official_classification",
                                      basis=f"provisional classification with the stewards' decision applied: {team(final)}")
        self.status.state = "running"
        self._publish_status()
        prev_t = None
        for i, d in enumerate(self.docs, 1):
            if self._stop.is_set():
                self.status.state = "stopped"
                break
            t = d["published_at_utc"]
            if prev_t and self.o.speed != float("inf"):
                self._stop.wait(min(self.o.max_sleep_s, max(0.0, _seconds(prev_t, t) / self.o.speed)))
            observed = self.now()
            doc = OfficialDocument(title=d["raw_title"], url=d.get("url"), document_number=d.get("document_number") or None, kind=d["kind"], cars=list(d.get("cars", [])),
                                   likely_outcome=d.get("likely_outcome"), published_at_utc=t, actor_run_id=d.get("actor_run_id") or None)
            cars = [c for c in doc.cars if c in self.team_cars]
            ctx = {"kind": doc.kind, "cars": cars, "likely_outcome": doc.likely_outcome}
            det = deterministic_route("result_document", ctx)
            material = doc.kind in ("summons", "infringement", "decision") and bool(cars)
            ts = Timestamps(source_event=t, adapter_received=observed)
            if doc.kind == "provisional_race_classification":
                sig = self._signal(doc, "provisional", current, current, diff(None, current), self._no_jev(det, "classification document; code refreshes the memo"),
                                   "provisional", f"Provisional classification published: expected sponsor bonuses {usd(current.amount_cents)} "
                                   f"({team(provisional)}). Memo only; nothing booked until the final classification (REV-02a).", t, observed, ts)
            elif material and doc.kind == "summons":
                decision = self._decide(doc, ctx, det, current, None, ts)
                sig = self._signal(doc, "result_at_risk", current, current, diff(current, current), decision, "at_risk",
                                   f"{doc.title}: car {cars[0]} summoned by the stewards; {usd(current.amount_cents)} of provisional expected bonuses "
                                   "are at risk. Nothing booked; the desk holds.", t, observed, ts, handoff=Handoff(target="revenue_desk", status="requested", requested_at_utc=observed))
            elif material and doc.likely_outcome in ("disqualification", "penalty"):
                change = diff(current, after_dsq)
                decision = self._decide(doc, ctx, det, current, change, ts)
                halcyon = lambda f: sum(l.amount_usd_cents for l in f.lines if l.sponsor_id == "halcyon")  # noqa: E731
                sig = self._signal(doc, "result_change", current, after_dsq, change, decision, "provisional_expected_bonus_corrected_awaiting_recognized_revenue_policy_gate",
                                   f"Provisional expected bonus corrected; awaiting recognized-revenue policy gate. {doc.title}: "
                                   f"{team(provisional)} -> {team(final)}. Halcyon Energy {usd(halcyon(current))} -> {usd(halcyon(after_dsq))}; all sponsors "
                                   f"{usd(current.amount_cents)} -> {usd(after_dsq.amount_cents)}. The team win bonus stays (car 44 inherits P1). "
                                   "No journal entry: the revenue desk books from the final classification under its seven-day hold.", t, observed, ts,
                                   handoff=Handoff(target="revenue_desk", status="requested", requested_at_utc=observed))
                current = after_dsq
            elif doc.kind == "final_race_classification":
                fin = forecast_for_rows(w, r, final, as_of_utc=None, type="final_classification", status="verified_final", basis=f"final race classification: {team(final)}")
                sig = self._signal(doc, "result_final", current, fin, diff(current, fin), self._no_jev(det, "final classification; the revenue desk books from it"), "final",
                                   f"Final classification published ({doc.title}): entitlements {usd(fin.amount_cents)} ({team(final)}). "
                                   "The revenue desk's kernel books these from the cached final result (make revenue-demo); this feed only forecast them.", t, observed, ts)
                current = fin
            else:
                self.status.events_done = i
                continue
            self.signals.append(sig)
            self.publisher.publish("result_change", sig, id=sig.signal_id, version=1, status=sig.status, adapter_received_utc=observed)
            self.log(f"{t[11:16]}Z {doc.title[:60]:<60} -> {sig.type:<16} {sig.jev.chosen_route:<14} [jev {sig.jev.status}] {usd(sig.before.amount_cents)} -> {usd(sig.after.amount_cents)}")
            self.status.events_done, self.status.clock_utc = i, t
            prev_t = t
        else:
            self.status.state = "finished"
        if self.status.state == "running":
            self.status.state = "finished"
        self._publish_status()

    def _no_jev(self, det: str, why: str) -> JevDecision:
        return JevDecision(used=False, status="disabled", deterministic_route=det, chosen_route=det, reason=why)

    def _decide(self, doc: OfficialDocument, ctx: dict, det: str, current, change, ts: Timestamps) -> JevDecision:
        if not self.o.jev:
            return self._no_jev(det, "Jev switched off for this replay")
        state = {"sporting_event": f"{self.race.race_id}:race:{doc.document_number or doc.kind}", "event_type": "result_document", "event_time_utc": doc.published_at_utc,
                 "race": self.race.name, "official_document": doc.title, "document_kind": doc.kind, "likely_outcome": doc.likely_outcome, "cars_named": ctx["cars"],
                 "team_car_positions": {str(l.car): l.position for l in current.lines}, "forecast_change": change.text if change else None,
                 "financial_impact_status": "provisional_bonus_at_risk"}
        ts.jev_started = self.now()
        d = self.jev.decide(state, det, True)
        ts.jev_finished = self.now()
        self.jev_calls_by_kind["result_document"] = self.jev_calls_by_kind.get("result_document", 0) + (1 if d.status not in ("disabled", "cached") else 0)
        self.decisions.append({"at": doc.published_at_utc, "kind": "result_document", "material": True, "message": doc.title, "decision": d.model_dump(mode="json")})
        self.publisher.publish("jev_decision", self.decisions[-1], id=f"result_document:{doc.published_at_utc}:{doc.document_number}", status=d.status)
        return d

    def _signal(self, doc, type_, before, after, change, decision, status, message, t, observed, ts, handoff=None) -> ResultChangeSignal:
        return ResultChangeSignal(signal_id=f"{self.race.race_id}:race:doc{doc.document_number or doc.kind}", type=type_, race_id=self.race.race_id, season=self.race.season,
                                  round=self.race.round, session="race", document=doc, before=before, after=after, change=change, jev=decision, status=status,
                                  message=message, handoff=handoff or Handoff(), event_time_utc=t, observed_at_utc=observed, mode=self.o.mode, timestamps=ts)

    def metrics(self) -> dict:
        return {"replay_id": self.replay_id, "state": self.status.state, "events_done": self.status.events_done, "events_total": len(self.docs),
                "signals": len(self.signals), "jev": {**self.jev.stats.summary(), "mode": self.jev.describe(), "calls_by_candidate_kind": dict(self.jev_calls_by_kind)},
                "publish": {"count": self.publisher.published}, "sinks": self.publisher.names()}
