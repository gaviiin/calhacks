"""The race-long financial timeline and the agents' per-event workflow, built as the replay runs.

The timeline starts at the first record of the race, including the part replayed silently before the
viewer joined, so the money chart always shows the whole race up to the replay clock and never a
point past it. Each point is the if-finished-now team payout as of its own time; each marker is a
real record (a flag, the rain, a team stop, a car out, a money move, a Jev decision, an incident).

A workflow follows one material event through the agents. Its steps are filled from what the replay
actually did, at the time it did it; a step that did not happen is `skipped`, `waiting` or
`not_required`, never `done`.
"""

from __future__ import annotations

from .finance_projections import usd
from .race_state import RaceState
from .races import Race
from .schemas import AgentWorkflow, FinanceCase, Forecast, ForecastChange, JevDecision, RaceTimeline, TimelineMarker, TimelinePoint, WorkflowStep

FLAG_LABEL = {"GREEN": "Green flag", "VSC": "Virtual Safety Car", "VSC_ENDING": "VSC ending", "SAFETY_CAR": "Safety Car",
              "SAFETY_CAR_ENDING": "Safety Car in this lap", "RED_FLAG": "Red flag", "FINISHED": "Chequered flag"}
FLAG_TONE = {"GREEN": "ok", "VSC": "hold", "VSC_ENDING": "hold", "SAFETY_CAR": "hold", "SAFETY_CAR_ENDING": "hold", "RED_FLAG": "alert", "FINISHED": "neutral"}
ROUTE_LABEL = {"crash_finance": "crash investigation", "revenue_change": "revenue change", "race_forecast": "race forecast",
               "human_review": "a person", "no_action": "no action"}
KIND_TITLE = {"race_control_red_flag": "Red flag", "race_control_safety_car": "Safety Car / VSC", "driver_stopped": "Car stopped on track",
              "race_control_incident_noted": "Incident noted by race control", "financial_threshold_crossed": "Sponsor clause crossed",
              "weather_change": "Weather changed", "incident_corroborated": "Incident confirmed by timing"}


class TimelineBuilder:
    def __init__(self, race: Race, replay_id: str, team_cars: list[int], mode: str = "replay"):
        self.team_cars = list(team_cars)
        self.tl = RaceTimeline(race_id=race.race_id, replay_id=replay_id, mode=mode, scheduled_laps=race.scheduled_laps, team_cars=self.team_cars)
        self.dirty = True
        self._rain: bool | None = None
        self._seq = 0

    def _marker(self, t: str, lap: int | None, kind: str, label: str, detail: str = "", car: int | None = None, delta: int | None = None,
                tone: str = "neutral", ref: str | None = None) -> None:
        self._seq += 1
        self.tl.markers.append(TimelineMarker(id=f"{kind}:{self._seq}", t=t, lap=lap, kind=kind, label=label, detail=detail, car=car, delta_cents=delta,
                                              tone=tone, ref=ref))
        self.dirty = True

    def on_event(self, state: RaceState, t: str, changes: list[str], name) -> None:
        self.tl.now_utc, self.tl.lap = t, state.lap
        if self.tl.start_utc is None:
            self.tl.start_utc = t
        for c in changes:
            if c == "lap" and state.lap is not None:
                if not self.tl.laps or self.tl.laps[-1]["lap"] != state.lap:
                    self.tl.laps.append({"lap": state.lap, "t": t})
                    if state.lap == 1:
                        self.tl.start_utc = t
                    self.dirty = True
            elif c.startswith("flag:"):
                flag = c.split(":", 1)[1]
                self.tl.flags.append({"from": t, "flag": flag})
                self._marker(t, state.lap, "flag", FLAG_LABEL.get(flag, flag.replace("_", " ").title()), tone=FLAG_TONE.get(flag, "neutral"))
            elif c == "weather":
                rain = bool(state.weather.rainfall)
                if rain != self._rain:
                    self.tl.rain.append({"from": t, "rain": rain})
                    if self._rain is not None:
                        self._marker(t, state.lap, "rain", "Rain starts" if rain else "Rain stops",
                                     f"track {state.weather.track_temperature_c}°C at the sensor", tone="hold" if rain else "neutral")
                    self._rain = rain
            elif c.startswith("pit:"):
                n = int(c.split(":")[1])
                if n in self.team_cars:
                    d = state.drivers.get(n)
                    self._marker(t, state.lap, "pit", f"{name(n)} pits", f"from P{d.position if d else '?'} on {(d.compound or '?').lower() if d else '?'}s, "
                                 f"under {FLAG_LABEL.get(state.flag_status or 'GREEN', 'green').lower()}", car=n, tone="hold")
            elif c.startswith(("retired:", "dns:")):
                n = int(c.split(":")[1])
                d = state.drivers.get(n)
                ours = n in self.team_cars
                self._marker(t, state.lap, "out", f"{name(n)} {'did not start' if c.startswith('dns') else 'out'}" + (" (our car)" if ours else ""),
                             d.out_reason or "" if d else "", car=n, tone="alert" if ours else "neutral")

    def on_forecast(self, state: RaceState, t: str, fc: Forecast, change: ForecastChange | None) -> None:
        cents = fc.amount_cents or 0
        cp = state.classified_positions()
        positions = {str(n): cp.get(n) for n in self.team_cars}
        last = self.tl.points[-1] if self.tl.points else None
        if last is not None and last.cents == cents and last.positions == positions:
            return
        delta = (cents - last.cents) if last is not None else None
        cause = None
        if change is not None and (change.gained or change.lost):
            cause = "; ".join([f"gained {g}" for g in change.gained] + [f"lost {x}" for x in change.lost])
        self.tl.points.append(TimelinePoint(t=t, lap=state.lap, cents=cents, delta_cents=delta, cause=cause, flag=state.flag_status, positions=positions))
        if delta:
            self._marker(t, state.lap, "money", f"{'+' if delta > 0 else ''}{usd(delta)}", cause or "", delta=delta, tone="ok" if delta > 0 else "alert")
        self.dirty = True

    def on_join(self, t: str, lap: int | None) -> None:
        self.tl.joined_at_utc, self.tl.joined_lap = t, lap
        self.dirty = True

    def on_jev(self, t: str, lap: int | None, kind: str, decision: JevDecision, ref: str, car: int | None) -> None:
        said = (f"Jev said {ROUTE_LABEL.get(decision.route or '', decision.route)} at {round((decision.route_confidence or 0) * 100)}%"
                if decision.used and decision.route else f"Jev {decision.status.replace('_', ' ')}")
        lat = f" in {decision.latency_ms} ms" if decision.latency_ms is not None else ""
        self._marker(t, lap, "jev", f"{KIND_TITLE.get(kind, kind.replace('_', ' '))} → {ROUTE_LABEL.get(decision.chosen_route, decision.chosen_route)}",
                     f"{said}{lat}; code kept {ROUTE_LABEL.get(decision.chosen_route, decision.chosen_route)}", car=car, tone="neutral", ref=ref)

    def on_incident(self, t: str, lap: int | None, car: int | None, label: str, detail: str, ours: bool, ref: str) -> None:
        if any(m.ref == ref and m.kind == "incident" for m in self.tl.markers):
            return
        self._marker(t, lap, "incident", label, detail, car=car, tone="alert" if ours else "hold", ref=ref)

    def snapshot(self) -> RaceTimeline:
        self.tl.version += 1
        self.dirty = False
        return self.tl.model_copy(deep=True)


# ---------------------------------------------------------------- workflows


def new_workflow(replay_id: str, race_id: str, kind: str, event_time: str, lap: int | None, car: int | None, scope: str, message: str,
                 decision: JevDecision, jev_started: str | None, jev_finished: str | None, observed: str) -> AgentWorkflow:
    wid = f"{kind}:{event_time}"
    jev_status = "done" if decision.used and decision.status in ("ok", "low_confidence", "overridden") else "skipped"
    if decision.used and decision.route:
        jev_detail = (f"routed to {ROUTE_LABEL.get(decision.route, decision.route)} at {round((decision.route_confidence or 0) * 100)}% route confidence"
                      + (f"; code kept {ROUTE_LABEL.get(decision.chosen_route, decision.chosen_route)}: {decision.reason}" if decision.route != decision.chosen_route else ""))
    else:
        jev_detail = f"Jev {decision.status.replace('_', ' ')}: the deterministic route {ROUTE_LABEL.get(decision.chosen_route, decision.chosen_route)} was used"
    return AgentWorkflow(
        workflow_id=wid, replay_id=replay_id, race_id=race_id, kind=kind, title=KIND_TITLE.get(kind, kind.replace("_", " ").capitalize()), lap=lap,
        event_time_utc=event_time, car=car, scope=scope, route=decision.chosen_route,  # type: ignore[arg-type]
        steps=[
            WorkflowStep(key="detected", label="Event detected", actor="OpenF1 adapter", status="done", at_utc=observed, race_clock_utc=event_time, detail=message[:240]),
            WorkflowStep(key="jev", label=f"Jev routed: {ROUTE_LABEL.get(decision.chosen_route, decision.chosen_route)}", actor="Jev", status=jev_status,
                         at_utc=jev_finished or observed, race_clock_utc=event_time, latency_ms=decision.latency_ms, detail=jev_detail),
        ])


def finish_without_case(wf: AgentWorkflow, *, analyst_detail: str, analyst_at: str, analyst_ms: int | None, race_clock: str | None, published_to: list[str]) -> AgentWorkflow:
    wf.steps = [s for s in wf.steps if s.key in ("detected", "jev")] + [
        WorkflowStep(key="analyst", label="Financial analyst calculated", actor="Live finance agent", status="done", at_utc=analyst_at, race_clock_utc=race_clock,
                     latency_ms=analyst_ms, detail=analyst_detail),
        WorkflowStep(key="cost_cap", label="Cost cap review", actor="Cost cap agent", status="not_required", race_clock_utc=race_clock,
                     detail="no expenditure is proposed: a strategy or forecast change moves projected revenue, not costs"),
        WorkflowStep(key="action", label="Autonomous action", actor="Live finance agent", status="done", at_utc=analyst_at, race_clock_utc=race_clock,
                     detail="provisional payout and decision options republished; within the agent's authority (nothing booked, nothing spent)"),
        WorkflowStep(key="outcome", label="Outcome recorded", actor="Publisher", status="done", at_utc=analyst_at, race_clock_utc=race_clock,
                     detail=f"written to {', '.join(published_to)}"),
    ]
    wf.needs_person = False
    wf.outcome = "forecast updated automatically"
    wf.version += 1
    return wf


def apply_case(wf: AgentWorkflow, case: FinanceCase, analyst_detail: str | None = None, analyst_at: str | None = None) -> AgentWorkflow:
    """Steps 3-6 for an event that opened a financial case, read from the case's own audit trail."""
    wf.case_id = case.case_id
    wf.scope = case.scope
    steps = {s.key: s for s in wf.steps}
    analyst = steps.get("analyst")
    if analyst_detail is not None:
        analyst = WorkflowStep(key="analyst", label="Financial analyst calculated", actor="Live finance agent", status="done", at_utc=analyst_at,
                               race_clock_utc=case.race_clock_utc, detail=analyst_detail)
    if analyst is None:
        fa = [s for s in case.steps if s.actor == "financial_analyst"]
        analyst = WorkflowStep(key="analyst", label="Financial analyst calculated", actor="Live finance agent", status="done" if fa else "waiting",
                               at_utc=fa[-1].at_utc if fa else None, race_clock_utc=fa[-1].race_clock_utc if fa else None,
                               detail=fa[-1].action if fa else "waiting for the outcome plan")
    cc = [s for s in case.steps if s.actor == "cost_cap_agent"]
    if case.scope == "competitor":
        cost = WorkflowStep(key="cost_cap", label="Cost cap review", actor="Cost cap agent", status="not_required",
                            detail="a competitor's incident: their garage and costs are not ours; only our projections move")
    elif cc:
        last = cc[-1]
        cost = WorkflowStep(key="cost_cap", label="Cost cap agent reviewed", actor="Cost cap agent",
                            status="refused" if last.status == "refused" else "escalated" if last.status == "escalated" else "done",
                            at_utc=last.at_utc, race_clock_utc=last.race_clock_utc, detail=f"{last.action}{': ' + last.detail if last.detail else ''}"[:260])
    else:
        cost = WorkflowStep(key="cost_cap", label="Cost cap review", actor="Cost cap agent", status="waiting",
                            detail="waiting for the garage report: no exposure is valued without evidence" if case.state in ("awaiting_evidence", "investigating", "detected")
                            else "pending")
    people = [s for s in case.steps if not s.automatic and s.actor in ("engineering", "controller", "person")]
    if case.scope == "competitor":
        action = WorkflowStep(key="action", label="Autonomous action", actor="Live finance agent", status="done",
                              detail="projection updated within the agent's authority; no spend, no hand-off")
    elif case.state == "awaiting_approval":
        action = WorkflowStep(key="action", label="Human review requested", actor="Engineering + Controller", status="escalated",
                              at_utc=case.updated_at_utc, race_clock_utc=case.race_clock_utc, detail=case.escalation_reason or case.next_action)
    elif people:
        p = people[-1]
        action = WorkflowStep(key="action", label="A person decided", actor=p.actor.capitalize(), status="refused" if "reject" in p.action.lower() else "done",
                              at_utc=p.at_utc, race_clock_utc=p.race_clock_utc, detail=f"{p.action}{' by ' + p.by if p.by else ''}")
    else:
        action = WorkflowStep(key="action", label="Action", actor="Live finance agent", status="waiting", detail=case.next_action or "waiting for evidence")
    if case.state == "closed":
        outcome = WorkflowStep(key="outcome", label="Case closed", actor="Reconciliation", status="done", at_utc=case.updated_at_utc,
                               race_clock_utc=case.race_clock_utc, detail=case.closed_reason or "closed")
    elif case.state == "rejected":
        outcome = WorkflowStep(key="outcome", label="Case rejected", actor="Controller", status="refused", at_utc=case.updated_at_utc, detail=case.closed_reason or "rejected")
    else:
        outcome = WorkflowStep(key="outcome", label="Outcome", actor="Case book", status="waiting",
                               detail="open until the financial evidence, the authorization and the reconciliation are in")
    wf.steps = [s for s in wf.steps if s.key in ("detected", "jev")] + [analyst, cost, action, outcome]
    wf.needs_person = case.state == "awaiting_approval"
    wf.outcome = {"closed": "case closed", "rejected": "case rejected", "awaiting_approval": "waiting for a person"}.get(case.state, case.state.replace("_", " "))
    wf.version += 1
    return wf
