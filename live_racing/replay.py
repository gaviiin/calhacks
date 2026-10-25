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
from datetime import UTC, datetime
from typing import Callable

from .event_triggers import Candidate, TriggerEngine
from .finance_projections import diff, if_finished_now, usd
from .jev_router import JevRouter, deterministic_route
from .normalize import NormalizedEvent
from .publisher import Publisher
from .race_state import RaceState, lap_start_times, plus_seconds
from .races import Race
from .schemas import (FinanceImpactUpdate, FinancialImpact, Forecast, ForecastChange, Handoff, IncidentSignal, JevDecision, RaceStateUpdate,
                      ReplayStatus, Timestamps)


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
    corroborate_after_s: float = 60.0  # replay seconds after an attributed incident before the corroborating source is applied
    max_sleep_s: float = 30.0
    mode: str = "replay"


class Replay:
    def __init__(self, race: Race, meta: dict, events: list[NormalizedEvent], world, publisher: Publisher, jev: JevRouter,
                 options: ReplayOptions | None = None, *, now: Callable[[], str] = _now, log: Callable[[str], None] = print,
                 replay_id: str | None = None, pause_handler: Callable[["Replay"], None] | None = None,
                 step_handler: Callable[["Replay", NormalizedEvent], None] | None = None):
        self.race, self.meta, self.events, self.world = race, meta, events, world
        self.publisher, self.jev = publisher, jev
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
        self._stop = threading.Event()
        self._resume = threading.Event()
        self._resume.set()
        self._lock = threading.RLock()
        self._paused_once = False
        self.status = ReplayStatus(replay_id=self.replay_id, race_id=race.race_id, mode=self.o.mode, speed=self.o.speed, events_total=len(events),
                                   events_done=0, jev_mode=jev.describe(), sinks=publisher.names())

    # ------------------------------------------------------------------ control

    def stop(self) -> None:
        self._stop.set()
        self._resume.set()

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
                self._publish_state(ev, self.now(), note=f"replay joined at lap {self.o.from_lap}; earlier state built silently")
                self._publish_status()
            if live and prev_t:
                self._sleep(_seconds(prev_t, ev.event_time_utc) / self.o.speed)
            observed = self.now()
            changes = self.state.apply(ev)
            candidates = self.triggers.on_event(ev, changes)
            if any(c.startswith("position:") and int(c.split(":")[1]) in self.team_cars for c in changes) or "flag:FINISHED" in changes:
                change = self._recompute_forecast(ev)
                cand = self.triggers.financial_threshold(change, ev.event_time_utc, self.state.lap, ev) if change else None
                if cand:
                    candidates.append(cand)
            if live:
                self._fire_scheduled(ev.event_time_utc)
                material = False
                for c in candidates:
                    material = self._handle(c, ev, observed) or material
                due = self.last_state_pub_t is None or _seconds(self.last_state_pub_t, ev.event_time_utc) >= self.o.state_every_s
                if material or due or self.pending_change is not None:
                    self._publish_state(ev, observed)
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
                event_time_utc=c.event_time_utc, observed_at_utc=observed, mode=self.o.mode, timestamps=ts,
                message=c.message + (" Financial impact unknown until a garage report arrives; nothing is booked." if kind != "incident_noted" else ""))
            self.incidents[c.incident_id] = sig
        self.publisher.publish("incident_signal", sig, id=c.incident_id, version=version, status=sig.sporting_confirmation, adapter_received_utc=observed)
        self.status.incidents = len(self.incidents)
        focus = {f.driver_number for f in self.race.incident_focus}
        if (driver in focus and attribution != "none" and c.incident_id not in self.corroborated and self.race.corroboration
                and not any(iid == c.incident_id for _, iid in [(t, getattr(fn, "incident_id", None)) for t, fn in self.scheduled])):
            when = plus_seconds(c.event_time_utc, self.o.corroborate_after_s)

            def fire(iid=c.incident_id):
                self._corroborate(iid)

            fire.incident_id = c.incident_id  # type: ignore[attr-defined]
            self.scheduled.append((when, fire))

    def _corroborate(self, incident_id: str) -> None:
        """Apply the public race report to the incident: the crash is historical fact; damage and
        money are not. Then request the cost cap desk's investigation."""
        if incident_id in self.corroborated:
            return
        self.corroborated.add(incident_id)
        src = self.race.corroboration[0]
        observed = self.now()
        prev = self.incidents[incident_id]
        # The confirmation is a new material fact, so Jev is asked once more with the confirmed attribution.
        # The hand-off to the cost cap desk is code's decision (a verified crash always gets one); Jev's
        # answer sets the urgency and is recorded on the signal.
        decision = prev.jev
        if self.o.jev:
            ctx = {"sporting_event": f"{self.race.race_id}:race:lap{prev.lap}:incident_corroborated", "event_type": "incident_corroborated",
                   "event_time_utc": self.state.now_utc, "race": self.race.name, "lap": prev.lap, "flag_status": self.state.flag_status,
                   "candidate_driver_number": prev.driver_number, "driver_attribution": "confirmed",
                   "incident_note": f"{src.publisher}: {src.claim}", "damage_report_received": False,
                   "team_car_positions": {str(n): p for n, p in self.state.team_positions().items()},
                   "financial_impact_status": "unknown_until_garage_confirmation"}
            decision = self.jev.decide(ctx, "crash_finance", True)
            self.jev_calls_by_kind["incident_corroborated"] = self.jev_calls_by_kind.get("incident_corroborated", 0) + (1 if decision.status not in ("disabled", "cached") else 0)
            rec = {"at": self.state.now_utc, "lap": prev.lap, "kind": "incident_corroborated", "material": True, "drivers": [prev.driver_number],
                   "message": f"corroborated: {src.claim}", "decision": decision.model_dump(mode="json"), "incident_id": incident_id}
            self.decisions.append(rec)
            self.publisher.publish("jev_decision", rec, id=f"incident_corroborated:{incident_id}", status=decision.status, adapter_received_utc=observed)
        with self._lock:
            prev = self.incidents[incident_id]
            sig = prev.model_copy(update={
                "version": prev.version + 1, "driver_attribution": "confirmed", "sporting_confirmation": "verified_historical_incident",
                "jev": decision, "urgency": decision.urgency or prev.urgency,
                "corroborating_source_url": src.url, "corroboration_note": f"{src.publisher}, read {src.read_on}: {src.claim} (inserted into the replay "
                f"{self.o.corroborate_after_s:.0f} replay-seconds after the flag; in a live race this waits for the real report)",
                "damage_confirmation": "awaiting_synthetic_garage_report", "observed_at_utc": observed,
                "handoff": Handoff(target="cost_cap_agent", status="requested", requested_at_utc=observed),
                "message": f"{prev.message} Corroborated by {src.publisher}: {src.claim} Hand-off to the cost cap agent requested; "
                "a synthetic Meridian garage report is needed before any exposure can be projected.",
                "timestamps": prev.timestamps.model_copy(update={"adapter_received": observed}),
            })
            self.incidents[incident_id] = sig
        self.publisher.publish("incident_signal", sig, id=incident_id, version=sig.version, status=sig.sporting_confirmation, adapter_received_utc=observed)
        self.log(f"{self.state.now_utc[11:19] if self.state.now_utc else '--:--:--'}Z corroborated {incident_id} -> handoff requested to the cost cap agent "
                 f"[jev {decision.status}{', ' + str(decision.latency_ms) + 'ms' if decision.latency_ms is not None else ''}"
                 f"{', said ' + decision.route + ' ' + format(decision.route_confidence, '.2f') if decision.route else ''}; urgency {decision.urgency or 'n/a'}]")

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
        }
