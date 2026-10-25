"""Deterministic, restartable replay of a race's normalized OpenF1 slice (plan P0-A/P0-C).

Events are fed to the race-state reducer in (event_time_utc, seq) order, never ahead of the replay
clock. Material candidates go to Jev (one typed request each, never per telemetry tick), race
state is published every few replay seconds and immediately on a material event, incident signals
are published with stable ids and versions, and corroboration arrives as a separate, labelled
step before the hand-off to the cost cap desk is requested.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from datetime import UTC, datetime
from typing import Callable

from .advisor import Advisor
from .cases import CaseBook, Refused
from .event_triggers import Candidate, TriggerEngine
from .finance_projections import diff, if_finished_now, usd
from .health import feed_health
from .incident_planner import plan_for
from .jev_router import JevRouter, deterministic_route
from .normalize import NormalizedEvent
from .publisher import Publisher
from .race_state import RaceState, lap_start_times
from .races import Race
from .schemas import (AdvisorNote, FeedHealth, FinanceCase, FinanceImpactUpdate, FinancialImpact, Forecast, ForecastChange, Handoff, IncidentPlan,
                      IncidentSignal, JevDecision, RaceStateUpdate, ReplayStatus, Timestamps)
from .strategy import strategy_advice
from .team import scope_of


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _seconds(a: str, b: str) -> float:
    return (datetime.fromisoformat(b.replace("Z", "+00:00")) - datetime.fromisoformat(a.replace("Z", "+00:00"))).total_seconds()


@dataclass
class ReplayOptions:
    speed: float = 20.0  # race seconds per wall second; float('inf') = as fast as possible
    from_lap: int | None = 1  # state is built silently before this lap (no publishing, no Jev)
    to_lap: int | None = None  # stop before this lap + 1 starts
    pause_at_lap: int | None = None
    step: bool = False
    state_every_s: float = 2.0  # replay seconds between routine state publishes
    jev: bool = True
    corroborate_after_s: float = 60.0  # kept for callers; corroboration now comes from the timing feed, not a timer
    max_sleep_s: float = 30.0
    mode: str = "replay"
    team: str = "mercedes"  # which constructor the customer mirrors for this replay (team.py)
    demo: bool = True  # own-team cases receive the synthetic garage report and invoice automatically, labelled synthetic
    demo_garage_after_s: float = 8.0  # wall seconds after the garage report is requested
    demo_invoice_after_s: float = 10.0  # wall seconds after the spend is authorized


class Replay:
    def __init__(self, race: Race, meta: dict, events: list[NormalizedEvent], world, publisher: Publisher, jev: JevRouter,
                 options: ReplayOptions | None = None, *, now: Callable[[], str] = _now, log: Callable[[str], None] = print,
                 replay_id: str | None = None, pause_handler: Callable[["Replay"], None] | None = None,
                 step_handler: Callable[["Replay", NormalizedEvent], None] | None = None, advisor: Advisor | None = None,
                 cases_jsonl: Path | None = None):
        self.race, self.meta, self.events, self.world = race, meta, events, world
        self.publisher, self.jev = publisher, jev
        self.advisor = advisor or Advisor(enabled=False)
        self.o = options or ReplayOptions()
        self.now, self.log = now, log
        self.replay_id = replay_id or f"{race.race_id}:{uuid.uuid4().hex[:8]}"
        self.pause_handler, self.step_handler = pause_handler, step_handler
        self.team_cars = [n for n, i in world.car_map(race.season).items() if i["constructor_id"] == world.team]
        self.state = RaceState(race.race_id, int(meta["session"]["session_key"]), meta["drivers"], self.team_cars)
        self.triggers = TriggerEngine(self.state, race)
        self.drivers_meta = {int(d["driver_number"]): d for d in meta["drivers"]}
        self.lap_starts = lap_start_times(events)
        self.incidents: dict[str, IncidentSignal] = {}
        self.decisions: list[dict] = []
        self.finance_impacts: list[FinanceImpactUpdate] = []
        self.jev_calls_by_kind: dict[str, int] = {}
        self.state_updates = 0
        self.last_forecast: Forecast | None = None
        self.pending_change: ForecastChange | None = None
        self.finance_recomputed_at: str | None = None
        self.last_state_pub_t: str | None = None
        self.scheduled: list[tuple[str, Callable[[], None]]] = []
        self.corroborated: set[str] = set()
        self.strategy_version = 0
        self.latest_strategy = None
        self.plans: dict[str, IncidentPlan] = {}
        self.exposure_at_join: int | None = None
        self.exposure_peak: int | None = None
        self._last_health_wall = 0.0
        self._advisor_threads: list[threading.Thread] = []
        self._stop = threading.Event()
        self._resume = threading.Event()
        self._resume.set()
        self._lock = threading.RLock()
        self._paused_once = False
        self.status = ReplayStatus(replay_id=self.replay_id, race_id=race.race_id, mode=self.o.mode, speed=self.o.speed, events_total=len(events),
                                   events_done=0, jev_mode=jev.describe(), sinks=publisher.names())
        self.cases = CaseBook(self.replay_id, race.race_id, world.team, lambda kind, obj, id, version, status: self.publisher.publish(kind, obj, id=id, version=version, status=status),
                              jsonl_path=cases_jsonl, now=now, log=log)
        self.retired: set[str] = set()  # incident ids whose car the timing feed has shown to be out
        self.cleared: set[str] = set()  # incident ids closed as no damage

    # ------------------------------------------------------------------ control

    def stop(self) -> None:
        self._stop.set()
        self._resume.set()
        # Mark it stopped before the thread wakes, so a new race can start immediately.
        if self.status.state not in ("finished", "stopped", "error"):
            self.status.state = "stopped"

    def resume(self) -> None:
        self._resume.set()

    def _sleep(self, seconds: float) -> None:
        if seconds <= 0 or self.o.speed == float("inf"):
            return
        self._stop.wait(min(seconds, self.o.max_sleep_s))

    def _publish_status(self) -> None:
        self.status.sinks = self.publisher.names()
        self.status.jev_requests = self.jev.stats.requests
        self.status.jev_errors = self.jev.stats.errors
        self.status.incidents = len(self.incidents)
        self.status.duplicates_suppressed = self.triggers.suppressed
        self.publisher.publish("replay_status", self.status, id=self.replay_id, version=self.status.events_done + 1, status=self.status.state)

    # ------------------------------------------------------------------ run

    def window(self) -> tuple[str | None, str | None]:
        from_t = self.lap_starts.get(self.o.from_lap) if self.o.from_lap else None
        to_t = self.lap_starts.get(self.o.to_lap + 1) if self.o.to_lap else None
        return from_t, to_t

    def run(self) -> ReplayStatus:
        try:
            self._run()
        except Exception as exc:  # noqa: BLE001
            self.status.state = "error"
            self.status.error = f"{exc.__class__.__name__}: {exc}"
            self._publish_status()
            raise
        return self.status

    def _run(self) -> None:
        from_t, to_t = self.window()
        live = from_t is None
        self.status.state = "running" if live else "fast_forward"
        self._publish_status()
        prev_t: str | None = None
        for ev in self.events:
            if self._stop.is_set():
                self.status.state = "stopped"
                break
            if to_t and ev.event_time_utc >= to_t:
                break
            if not live and ev.event_time_utc >= from_t:
                live = True
                self.status.state = "running"
                self.log(f"-- joined the replay at lap {self.o.from_lap}; state was built from {self.status.events_done} earlier records without publishing")
                self._recompute_forecast(ev)
                self.exposure_at_join = self.last_forecast.amount_cents if self.last_forecast else None
                self.exposure_peak = self.exposure_at_join
                self._publish_state(ev, self.now(), note=f"replay joined at lap {self.o.from_lap}; earlier state built silently")
                self._publish_strategy(ev, self.now())
                self._publish_status()
            if live and prev_t:
                self._sleep(_seconds(prev_t, ev.event_time_utc) / self.o.speed)
            observed = self.now()
            changes = self.state.apply(ev)
            candidates = self.triggers.on_event(ev, changes)
            team_moved = any(c.startswith("position:") and int(c.split(":")[1]) in self.team_cars for c in changes)
            flag_changed = any(c.startswith("flag:") for c in changes)
            if team_moved or "flag:FINISHED" in changes:
                change = self._recompute_forecast(ev)
                cand = self.triggers.financial_threshold(change, ev.event_time_utc, self.state.lap, ev) if change else None
                if cand:
                    candidates.append(cand)
            if live:
                self._fire_scheduled(ev.event_time_utc)
                if "lap" in changes:
                    self._check_incidents_against_timing(ev, observed)
                material = False
                for c in candidates:
                    material = self._handle(c, ev, observed) or material
                due = self.last_state_pub_t is None or _seconds(self.last_state_pub_t, ev.event_time_utc) >= self.o.state_every_s
                if material or due or self.pending_change is not None:
                    self._publish_state(ev, observed)
                if team_moved or flag_changed or ev.endpoint == "pit":
                    self._publish_strategy(ev, observed)
                if time.monotonic() - self._last_health_wall >= 5.0:
                    self._publish_health()
                self.status.clock_utc, self.status.lap = ev.event_time_utc, self.state.lap
                if self.o.pause_at_lap and not self._paused_once and self.state.lap is not None and self.state.lap >= self.o.pause_at_lap:
                    self._pause()
                if self.o.step and self.step_handler:
                    self.step_handler(self, ev)
            prev_t = ev.event_time_utc
            self.status.events_done += 1
        else:
            self.status.state = "finished"
        if self.status.state not in ("stopped", "error"):
            self.status.state = "finished"
        if self.state.last_event is not None:
            self._publish_state(self.state.last_event, self.now(), note=f"replay {self.status.state}")
        self._publish_status()
        self._publish_health()
        self.log(f"-- replay {self.status.state}: {self.status.events_done} events, {len(self.incidents)} incidents, Jev {self.jev.stats.summary()}")

    def _pause(self) -> None:
        self._paused_once = True
        self.status.state = "paused"
        self._publish_status()
        self.log(f"-- paused at lap {self.state.lap} ({self.state.now_utc})")
        if self.pause_handler:
            self.pause_handler(self)
        else:
            self._resume.clear()
            while not self._resume.wait(0.25):
                if self._stop.is_set():
                    return
        if not self._stop.is_set():
            self.status.state = "running"
            self._publish_status()

    def _fire_scheduled(self, t: str) -> None:
        due = [s for s in self.scheduled if s[0] <= t]
        self.scheduled = [s for s in self.scheduled if s[0] > t]
        for _, fn in due:
            fn()

    # ------------------------------------------------------------------ forecasts and state

    def _recompute_forecast(self, ev: NormalizedEvent) -> ForecastChange | None:
        fc = if_finished_now(self.world, self.race, self.state.positions(), as_of_utc=ev.event_time_utc, drivers_meta=self.meta["drivers"])
        self.finance_recomputed_at = self.now()
        change = diff(self.last_forecast, fc) if self.last_forecast is not None else None
        self.last_forecast = fc
        if fc.amount_cents is not None and self.status.state == "running":
            self.exposure_peak = fc.amount_cents if self.exposure_peak is None else max(self.exposure_peak, fc.amount_cents)
        if change and change.delta_cents:
            self.pending_change = change
        return change

    def _publish_state(self, ev: NormalizedEvent, observed: str, note: str | None = None) -> None:
        upd = RaceStateUpdate(event_id=f"{self.race.race_id}:state:{ev.event_id}", source_system=ev.source_system, source_url=ev.source_url,
                              event_time_utc=ev.event_time_utc, observed_at_utc=observed, session_key=self.state.session_key, race_id=self.race.race_id,
                              mode=self.o.mode, lap=self.state.lap, flag_status=self.state.flag_status, weather=self.state.weather,
                              driver_states=self.state.driver_states(), forecast=self.last_forecast or Forecast(as_of_utc=ev.event_time_utc),
                              forecast_change=self.pending_change, team_cars=self.team_cars,
                              timestamps=Timestamps(source_event=ev.event_time_utc, adapter_received=observed, finance_recomputed=self.finance_recomputed_at), note=note)
        self.state_updates += 1
        self.publisher.publish("race_state", upd, id=self.race.race_id, version=self.state_updates, status=self.state.flag_status or "", adapter_received_utc=observed)
        self.last_state_pub_t = ev.event_time_utc
        if self.pending_change is not None:
            self.log(f"{ev.event_time_utc[11:19]}Z lap {self.state.lap:>2} {self.state.flag_status or '':<12} {self.pending_change.text}")
        self.pending_change = None

    def _publish_strategy(self, ev: NormalizedEvent, observed: str) -> None:
        self.strategy_version += 1
        adv = strategy_advice(self.world, self.race, self.state, self.team_cars, version=self.strategy_version, observed_at=observed,
                              drivers_meta=self.meta["drivers"], exposure_at_join=self.exposure_at_join, exposure_peak=self.exposure_peak,
                              finance_recomputed=self.finance_recomputed_at)
        self.latest_strategy = adv
        self.publisher.publish("strategy_advice", adv, id=self.race.race_id, version=self.strategy_version, status=self.state.flag_status or "", adapter_received_utc=observed)

    def feed_health(self) -> FeedHealth:
        return feed_health(self.replay_id, self.status, self.o.mode, self.now(), self.state.now_utc, self.state.lap, self.publisher, self.jev,
                           self.advisor.describe(), self.state_updates, self.last_forecast.amount_cents if self.last_forecast else None,
                           self.exposure_at_join, self.exposure_peak, len(self.incidents), len(self.plans))

    def _publish_health(self) -> None:
        self._last_health_wall = time.monotonic()
        h = self.feed_health()
        self.publisher.publish("feed_health", h, id=self.replay_id, version=self.publisher.published + 1, status=h.state or "")

    def _plan_incident(self, sig: IncidentSignal, observed: str, incident_context: dict) -> None:
        """Price the outcomes for the car involved, publish them at once, then let the advisor draft
        off the ticker thread and publish again when it answers."""
        if sig.driver_number is None or sig.driver_number not in self.triggers.watched_cars:
            return
        with self._lock:
            prev = self.plans.get(sig.incident_id)
            version = (prev.version + 1) if prev else 1
            pending = AdvisorNote(used=False, status="pending" if self.advisor.enabled else "disabled")
            plan = plan_for(self.world, self.race, self.state, sig, self.team_cars, version=version, observed_at=observed, drivers_meta=self.meta["drivers"], advisor=pending)
            if plan is None:
                return
            self.plans[sig.incident_id] = plan
        self.publisher.publish("incident_plan", plan, id=sig.incident_id, version=version, status=plan.advisor.status, adapter_received_utc=observed)
        self.cases.on_plan(plan, self.state.now_utc)
        worst = min(plan.scenarios, key=lambda x: x.delta_cents)
        self.log(f"{sig.event_time_utc[11:19]}Z plan v{version} for car {plan.car}: {len(plan.scenarios)} outcomes priced, worst {worst.label.lower()} {usd(worst.delta_cents)}; "
                 f"advisor {plan.advisor.status}")
        if self.advisor.enabled:
            th = threading.Thread(target=self._advise, args=(sig.incident_id, version, incident_context), name=f"advisor-{sig.incident_id}", daemon=True)
            self._advisor_threads.append(th)
            th.start()

    def _advise(self, incident_id: str, version: int, incident_context: dict) -> None:
        plan = self.plans[incident_id]
        note = self.advisor.advise(plan, incident_context)
        with self._lock:
            current = self.plans.get(incident_id)
            if current is None or current.version != version:
                return  # a newer plan superseded this one while the model was thinking
            updated = current.model_copy(update={"version": version + 1, "advisor": note, "observed_at_utc": self.now()})
            self.plans[incident_id] = updated
        self.publisher.publish("incident_plan", updated, id=incident_id, version=updated.version, status=note.status)
        self.log(f"         advisor on {incident_id.split(':', 2)[-1]}: {note.status}"
                 + (f" in {note.latency_ms}ms -> {note.recommended_scenario} ({note.confidence}): {note.headline}" if note.used else f" ({note.error})"))

    def wait_for_advisor(self, timeout_s: float = 60.0) -> None:
        for th in self._advisor_threads:
            th.join(timeout_s)

    # ------------------------------------------------------------------ candidates

    def _jev_context(self, c: Candidate) -> dict:
        w = self.state.weather
        tyres = ", ".join(f"car {n}: {self.state.drivers[n].compound or '?'} age {self.state.drivers[n].tyre_age_laps}" for n in self.team_cars if n in self.state.drivers)
        crashish = c.kind in ("race_control_red_flag", "driver_stopped", "race_control_incident_noted")
        return {
            "sporting_event": f"{self.race.race_id}:race:lap{c.lap}:{c.kind}", "event_type": c.kind, "event_time_utc": c.event_time_utc,
            "race": self.race.name, "lap": c.lap, "flag_status": self.state.flag_status,
            "candidate_driver_number": (c.drivers[0] if c.drivers and crashish else None), "driver_attribution": c.context.get("attribution"),
            "race_control_message": c.context.get("race_control_message"),
            "weather_context": f"rainfall {'observed' if w.rainfall else 'none'}; track {w.track_temperature_c}C; team tyres: {tyres}",
            "team_car_positions": {str(n): p for n, p in self.state.team_positions().items()},
            "forecast_change": (self.pending_change.text if self.pending_change else None) if c.kind == "financial_threshold_crossed" else None,
            "damage_report_received": False, "cars_named": c.drivers if c.drivers else None,
            "financial_impact_status": "unknown_until_garage_confirmation" if crashish else "indicative_unbooked",
        }

    def _handle(self, c: Candidate, ev: NormalizedEvent, observed: str) -> bool:
        det = deterministic_route(c.kind, c.context)
        ts = Timestamps(source_event=c.event_time_utc, adapter_received=observed)
        if c.material and self.o.jev:
            ts.jev_started = self.now()
            decision = self.jev.decide(self._jev_context(c), det, True)
            ts.jev_finished = self.now()
            self.jev_calls_by_kind[c.kind] = self.jev_calls_by_kind.get(c.kind, 0) + (1 if decision.status not in ("disabled", "cached") else 0)
        else:
            decision = JevDecision(used=False, status="disabled", deterministic_route=det, chosen_route=det,
                                   reason="not a material candidate; no Jev call" if not c.material else "Jev switched off for this replay")
        rec = {"at": c.event_time_utc, "lap": c.lap, "kind": c.kind, "material": c.material, "drivers": c.drivers, "message": c.message,
               "decision": decision.model_dump(mode="json"), "timestamps": ts.model_dump(mode="json"), "incident_id": c.incident_id}
        self.decisions.append(rec)
        if c.material:
            self.publisher.publish("jev_decision", rec, id=f"{c.kind}:{c.event_time_utc}", status=decision.status, adapter_received_utc=observed)
            said = f", said {decision.route} {decision.route_confidence:.2f}" if decision.route and decision.route_confidence is not None else ""
            self.log(f"{c.event_time_utc[11:19]}Z lap {c.lap!s:>2} {c.kind:<28} -> {decision.chosen_route:<14} "
                     f"[jev {decision.status}{', ' + str(decision.latency_ms) + 'ms' if decision.latency_ms is not None else ''}{said}] {c.message[:90]}")
        if c.incident_id:
            self._incident(c, decision, ts, observed)
        return c.material

    def _incident(self, c: Candidate, decision: JevDecision, ts: Timestamps, observed: str) -> None:
        driver = c.drivers[0] if c.drivers else None
        attribution = c.context.get("attribution", "none")
        dm = self.drivers_meta.get(driver or -1, {})
        scope = scope_of(driver, self.team_cars)
        with self._lock:
            prev = self.incidents.get(c.incident_id)
            version = (prev.version + 1) if prev else 1
            kind = {"race_control_red_flag": "potential_crash" if driver else "red_flag_unattributed", "driver_stopped": "potential_crash",
                    "race_control_incident_noted": "incident_noted"}[c.kind]
            urgency = decision.urgency or ("urgent" if c.kind == "race_control_red_flag" and driver else "watch")
            sig = IncidentSignal(
                incident_id=c.incident_id, version=version, type=kind if not prev else (prev.type if prev.type == "potential_crash" else kind),
                sporting_source_date=self.race.sporting_source_date, race_id=self.race.race_id, lap=c.lap, driver_number=driver,
                driver_name=dm.get("full_name"), historical_team=dm.get("team_name"), driver_attribution=attribution,
                source_evidence=(prev.source_evidence if prev else []) + c.evidence,
                corroborating_source_url=prev.corroborating_source_url if prev else None, corroboration_note=prev.corroboration_note if prev else None,
                sporting_confirmation=prev.sporting_confirmation if prev and prev.sporting_confirmation == "verified_historical_incident"
                else ("incident_candidate" if driver else "needs_confirmation"),
                damage_confirmation=prev.damage_confirmation if prev else "none", jev=decision, urgency=urgency,
                financial_impact=prev.financial_impact if prev else FinancialImpact(), handoff=prev.handoff if prev else Handoff(),
                event_time_utc=c.event_time_utc, observed_at_utc=observed, mode=self.o.mode, timestamps=ts, scope=scope,
                message=c.message + ((" Our car: financial impact unknown until a garage report arrives; nothing is booked." if scope == "own_team"
                                      else " Competitor's car: only our projections can move; their garage and books are not ours.") if kind != "incident_noted" else ""))
            self.incidents[c.incident_id] = sig
        self.publisher.publish("incident_signal", sig, id=c.incident_id, version=version, status=sig.sporting_confirmation, adapter_received_utc=observed)
        self.status.incidents = len(self.incidents)
        if c.material and driver is not None:
            d = self.state.drivers.get(driver)
            case = self.cases.open(sig, scope, d.status if d else "unknown", self.state.now_utc)
            self.cases.on_jev(sig.incident_id, decision, self.state.now_utc)
            self._plan_incident(sig, observed, {"incident_id": sig.incident_id, "type": sig.type, "scope": scope, "message": sig.message,
                                                "attribution": sig.driver_attribution, "confirmation": sig.sporting_confirmation,
                                                "jev_route": decision.chosen_route, "urgency": sig.urgency, "case_id": case.case_id})
        elif c.context.get("follow_up") and c.incident_id in self.incidents and "NO FURTHER" in (c.context.get("race_control_message") or "").upper():
            d = self.state.drivers.get(driver) if driver is not None else None
            if d is not None and d.status == "running" and c.incident_id not in self.cleared:
                self.cleared.add(c.incident_id)
                self.cases.on_no_damage(c.incident_id, self.state.now_utc, f"stewards: {c.context.get('race_control_message')}; car {driver} running at P{d.position}")

    def _check_incidents_against_timing(self, ev: NormalizedEvent, observed: str) -> None:
        """The leader started a new lap. A car that stopped and is now two laps down has not taken the
        restart: the timing feed says it is out. A car in a noted collision that is two laps on at
        racing speed has shown no damage. Both are live, as-of facts; no post-race source is used."""
        for iid, sig in list(self.incidents.items()):
            n = sig.driver_number
            if n is None or self.state.lap is None:
                continue
            d = self.state.drivers.get(n)
            if d is None or d.lap is None:
                continue
            if d.status == "stopped_candidate" and self.state.lap - d.lap >= 2 and iid not in self.retired:
                self.retired.add(iid)
                self._retired_per_timing(iid, ev, observed, f"car {n} last started lap {d.lap} at {d.lap_started_at}; the leader is on lap {self.state.lap}; "
                                         f"speed 0 since {d.stopped_at}: the car did not take the restart")
            elif sig.type == "incident_noted" and d.status == "running" and sig.lap is not None and d.lap >= sig.lap + 2 and iid not in self.cleared:
                self.cleared.add(iid)
                self.cases.on_no_damage(iid, self.state.now_utc, f"car {n} has completed two laps since the lap-{sig.lap} contact and is running at P{d.position}")

    def _retired_per_timing(self, incident_id: str, ev: NormalizedEvent, observed: str, evidence: str) -> None:
        prev = self.incidents[incident_id]
        own = prev.scope == "own_team"
        decision = prev.jev
        if self.o.jev:
            ctx = {"sporting_event": f"{self.race.race_id}:race:lap{prev.lap}:retired_per_timing", "event_type": "incident_corroborated",
                   "event_time_utc": self.state.now_utc, "race": self.race.name, "lap": self.state.lap, "flag_status": self.state.flag_status,
                   "candidate_driver_number": prev.driver_number, "driver_attribution": "confirmed", "incident_note": evidence, "damage_report_received": False,
                   "team_car_positions": {str(n): p for n, p in self.state.team_positions().items()},
                   "financial_impact_status": "unknown_until_garage_confirmation" if own else "competitor_projection_only"}
            decision = self.jev.decide(ctx, "crash_finance" if own else "race_forecast", True)
            self.jev_calls_by_kind["incident_corroborated"] = self.jev_calls_by_kind.get("incident_corroborated", 0) + (1 if decision.status not in ("disabled", "cached") else 0)
            rec = {"at": self.state.now_utc, "lap": prev.lap, "kind": "incident_corroborated", "material": True, "drivers": [prev.driver_number],
                   "message": evidence, "decision": decision.model_dump(mode="json"), "incident_id": incident_id}
            self.decisions.append(rec)
            self.publisher.publish("jev_decision", rec, id=f"incident_corroborated:{incident_id}", status=decision.status, adapter_received_utc=observed)
        ref = None
        if self.race.corroboration:
            src = self.race.corroboration[0]
            ref = {"url": src.url, "publisher": src.publisher, "claim": src.claim, "read_on": src.read_on,
                   "available": "after the race; attached for the reader, not used as live evidence"}
        with self._lock:
            prev = self.incidents[incident_id]
            sig = prev.model_copy(update={
                "version": prev.version + 1, "sporting_confirmation": "retired_per_timing", "observed_at_utc": observed, "jev": decision,
                "urgency": decision.urgency or prev.urgency, "corroboration_note": evidence, "post_race_reference": ref,
                "damage_confirmation": "awaiting_synthetic_garage_report" if own else prev.damage_confirmation,
                "handoff": Handoff(target="cost_cap_agent", status="requested", requested_at_utc=observed) if own else Handoff(target="none", status="not_requested"),
                "message": f"{prev.message} Timing feed: {evidence}." + (" Hand-off to the cost cap agent requested; a garage report is needed before any exposure can be projected."
                                                                           if own else " Competitor retired: our projections updated; nothing of theirs is accessed."),
                "timestamps": prev.timestamps.model_copy(update={"adapter_received": observed}),
            })
            self.incidents[incident_id] = sig
        self.publisher.publish("incident_signal", sig, id=incident_id, version=sig.version, status=sig.sporting_confirmation, adapter_received_utc=observed)
        self.cases.on_retired(incident_id, self.state.now_utc, evidence)
        self._plan_incident(sig, observed, {"incident_id": sig.incident_id, "type": sig.type, "scope": sig.scope, "message": sig.message, "attribution": "confirmed",
                                            "confirmation": sig.sporting_confirmation, "jev_route": decision.chosen_route, "urgency": sig.urgency})
        case = self.cases._for(incident_id)
        if own and case is not None and case.state == "awaiting_evidence" and self.o.demo:
            cid = case.case_id
            self.cases.schedule(self.o.demo_garage_after_s, lambda: self._demo_garage(cid))
        self.log(f"{self.state.now_utc[11:19] if self.state.now_utc else '--:--:--'}Z retired per timing {incident_id} ({'own car' if own else 'competitor'}) "
                 f"[jev {decision.status}{', said ' + decision.route + ' ' + format(decision.route_confidence, '.2f') if decision.route else ''}]")

    def _demo_garage(self, case_id: str) -> None:
        try:
            self.cases.demo_garage_report(case_id, self.state.now_utc)
        except (KeyError, Refused) as exc:
            self.log(f"         demo garage report not applied: {exc}")

    # ------------------------------------------------------------------ approvals from the page

    def approve(self, case_id: str, role: str, by: str, decision: str, reason: str = "") -> FinanceCase:
        case = self.cases.approve(case_id, role, by, decision, reason)
        if case.state == "reconciling" and self.o.demo and case.procurement is not None:
            self.cases.schedule(self.o.demo_invoice_after_s, lambda: self._demo_invoice(case_id))
        return case

    def _demo_invoice(self, case_id: str) -> None:
        try:
            self.cases.demo_invoice(case_id)
        except (KeyError, Refused) as exc:
            self.log(f"         demo invoice not applied: {exc}")

    # ------------------------------------------------------------------ hand-off back

    def ack_finance_impact(self, update: FinanceImpactUpdate) -> IncidentSignal:
        """Person 2's answer by incident_id (plan 6C). Stored and published; the ledger is untouched."""
        with self._lock:
            prev = self.incidents.get(update.incident_id)
            if prev is None:
                raise KeyError(update.incident_id)
            received = self.now()
            update = update.model_copy(update={"received_at_utc": received})
            self.finance_impacts.append(update)
            assessed = update.financial_status == "synthetic_projected_not_booked"
            sig = prev.model_copy(update={
                "version": prev.version + 1, "observed_at_utc": received,
                "damage_confirmation": "synthetic_garage_report_received" if assessed else prev.damage_confirmation,
                "financial_impact": FinancialImpact(status=update.financial_status, amount_cents=update.initial_exposure_cents if assessed else None),
                "handoff": prev.handoff.model_copy(update={"target": "cost_cap_agent", "status": "assessed" if assessed else "acknowledged",
                                                           "acknowledged_at_utc": received, "finance_impact_ref": f"finance_impact:{update.incident_id}:{len(self.finance_impacts)}"}),
                "message": prev.message + (f" Cost cap desk: initial exposure {usd(update.initial_exposure_cents)}, selected recovery "
                                           f"{usd(update.selected_recovery_cost_cents)}, forecast headroom after {usd(update.forecast_headroom_after_cents)}; "
                                           "projected, not booked." if assessed else " Cost cap desk acknowledged; assessment pending."),
            })
            self.incidents[update.incident_id] = sig
        self.publisher.publish("finance_impact", update, id=f"{update.incident_id}:{len(self.finance_impacts)}", status=update.financial_status)
        self.publisher.publish("incident_signal", sig, id=update.incident_id, version=sig.version, status=sig.sporting_confirmation)
        return sig

    # ------------------------------------------------------------------ measurements

    def metrics(self) -> dict:
        return {
            "replay_id": self.replay_id, "state": self.status.state, "events_done": self.status.events_done, "events_total": len(self.events),
            "state_updates": self.state_updates, "incidents": len(self.incidents), "duplicates_suppressed": self.triggers.suppressed,
            "jev": {**self.jev.stats.summary(), "mode": self.jev.describe(), "calls_by_candidate_kind": dict(self.jev_calls_by_kind),
                    "calls_on_telemetry_ticks": 0},
            "publish": {"count": self.publisher.published, "adapter_received_to_published_p50_ms": self.publisher.percentile(0.5),
                        "adapter_received_to_published_p95_ms": self.publisher.percentile(0.95)},
            "sinks": self.publisher.names(),
            "exposure": {"now_cents": self.last_forecast.amount_cents if self.last_forecast else None, "at_join_cents": self.exposure_at_join,
                         "peak_cents": self.exposure_peak, "lost_from_peak_cents": (self.exposure_peak - (self.last_forecast.amount_cents or 0)) if self.exposure_peak is not None and self.last_forecast else None},
            "advisor": {"mode": self.advisor.describe(), "calls": self.advisor.calls, "errors": self.advisor.errors,
                        "latencies_ms": list(self.advisor.latencies_ms)},
            "incident_plans": len(self.plans),
            "cases": self.cases.summary(),
            "team": self.world.team,
        }
