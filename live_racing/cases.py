"""Financial cases: the unit of work an autonomous finance employee opens, advances, escalates and closes.

A material racing event opens a case. Agents do what evidence and authority allow, automatically:
route it (Jev), gather sporting evidence, price the supported scenarios, request the garage report
(own team only), evaluate the garage's options under the cost cap, recommend, prepare the mock
procurement order once a person has authorized it, reconcile the invoice, close. Everything else is
an explicit escalation that says what is missing or who must decide. Every step, taken or refused,
is appended to the case and published; the case is also written append-only to JSONL.

Guards that are not negotiable: an agent never approves a restricted action; the person who cleared
feasibility cannot also authorize the spend; a competitor's incident never reaches our garage or cost
cap desk; no loss is estimated before evidence; a retired car is not recommended to continue.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

import httpx

from .finance_projections import usd
from .schemas import (Approval, CaseState, CaseStep, CostCapEvaluation, FinanceCase, GarageOption, GarageReport, IncidentPlan, IncidentSignal, Invoice,
                      JevDecision, ProcurementOrder)

CAP_USD_MINOR = 21_500_000_000  # the 2026 cap the cost cap desk is bootstrapped with (agents/config.py)
MATERIALITY_CENTS = 25_000_000  # $250k: the desk's materiality (finance/config.py)
INVOICE_TOLERANCE = 0.02  # a 2% variance is matched; more is escalated to the controller

STAGES_OWN = [
    ("detected", "Sporting incident detected"),
    ("routed", "Jev routed to finance investigation"),
    ("evidence", "Garage damage assessment"),
    ("evaluated", "Cost-cap evaluation"),
    ("approved", "Engineering clearance and financial authorization"),
    ("procured", "Procurement order prepared"),
    ("reconciled", "Invoice reconciled and case closed"),
]
STAGES_COMPETITOR = [
    ("detected", "Sporting incident detected"),
    ("routed", "Jev routed"),
    ("evaluated", "Our projections updated"),
    ("closed", "Case closed (competitor event)"),
]


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Refused(RuntimeError):
    """An action the guards do not allow. Logged on the case as a refused step; counted by the scorecard."""


def cap_headroom(stdb_url: str | None = None, token: str | None = None) -> tuple[int | None, str]:
    """Headroom under the cap from the cost cap desk's own cap_position table, when the local
    SpacetimeDB is up; otherwise None and an honest note. Never guessed."""
    from finance.spacetime_mirror import cli_token

    base = (stdb_url or os.environ.get("STDB_URL", os.environ.get("SPACETIME_URL", "http://127.0.0.1:3000"))).rstrip("/")
    token = token or os.environ.get("SPACETIME_TOKEN", "") or cli_token()
    try:
        r = httpx.post(f"{base}/v1/database/cost-cap-desk/sql", content="SELECT relevant_usd_minor FROM cap_position",
                       headers={"Authorization": f"Bearer {token}"} if token else {}, timeout=4)
    except httpx.HTTPError as exc:
        return None, f"cost cap desk not reachable ({exc.__class__.__name__}); headroom unknown"
    if r.status_code != 200:
        return None, f"cost cap desk answered {r.status_code}; headroom unknown"
    try:
        rows = r.json()[0]["rows"]
        relevant = sum(int(x[0]) for x in rows)
    except (KeyError, IndexError, ValueError, TypeError):
        return None, "cost cap desk returned an unexpected shape; headroom unknown"
    return CAP_USD_MINOR - relevant, f"cap {usd(CAP_USD_MINOR)} less {usd(relevant)} relevant costs posted in cost-cap-desk ({len(rows)} period rows)"


class CaseBook:
    def __init__(self, replay_id: str, race_id: str, team: str, publish: Callable[[str, Any, str, int, str | None], Any], *, jsonl_path: Path | None = None,
                 now: Callable[[], str] = _now, log: Callable[[str], None] = print, headroom: Callable[[], tuple[int | None, str]] | None = None):
        self.replay_id, self.race_id, self.team = replay_id, race_id, team
        self._publish = publish
        self.now, self.log = now, log
        self.headroom_fn = headroom or cap_headroom
        self.cases: dict[str, FinanceCase] = {}
        self.by_incident: dict[str, str] = {}
        self.refused: list[dict] = []
        self.jsonl_path = jsonl_path
        self._lock = threading.RLock()
        self._timers: list[threading.Timer] = []
        if jsonl_path:
            jsonl_path.parent.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ plumbing

    def _emit(self, case: FinanceCase) -> None:
        case.version += 1
        case.updated_at_utc = self.now()
        case.stages = self._stages(case)
        if self.jsonl_path:
            with open(self.jsonl_path, "a") as f:
                f.write(json.dumps({"kind": "finance_case", "at": case.updated_at_utc, "case": case.model_dump(mode="json")}, default=str) + "\n")
        self._publish("finance_case", case, case.case_id, case.version, case.state)

    def _step(self, case: FinanceCase, actor: str, action: str, detail: str = "", *, evidence: list[str] | None = None, automatic: bool = True,
              status: str = "done", by: str | None = None, state: CaseState | None = None, race_clock: str | None = None) -> None:
        if state:
            case.state = state
        case.steps.append(CaseStep(at_utc=self.now(), race_clock_utc=race_clock or case.race_clock_utc, actor=actor, by=by, action=action, detail=detail,
                                   evidence=evidence or [], automatic=automatic, status=status, state_after=case.state))
        self.log(f"         case {case.case_id.split(':')[-1]} [{case.state}] {actor}{' (' + by + ')' if by else ''}: {action}{' — ' + detail if detail else ''}")

    def _refuse(self, case: FinanceCase | None, actor: str, action: str, why: str, by: str | None = None) -> Refused:
        self.refused.append({"at": self.now(), "case_id": case.case_id if case else None, "actor": actor, "by": by, "action": action, "why": why})
        if case is not None:
            self._step(case, actor, action, why, status="refused", automatic=actor != "person", by=by)
            self._emit(case)
        return Refused(why)

    def _stages(self, case: FinanceCase) -> list[dict[str, str]]:
        done: set[str] = {"detected"}
        if any(s.actor == "jev" for s in case.steps):
            done.add("routed")
        if case.scope == "competitor":
            if case.projection_delta_cents is not None:
                done.add("evaluated")
            if case.state == "closed":
                done.add("closed")
            return [{"key": k, "label": l, "status": "done" if k in done else "pending"} for k, l in STAGES_COMPETITOR]
        if case.garage_report:
            done.add("evidence")
        if case.evaluation:
            done.add("evaluated")
        if any(a.role == "controller" and a.decision == "authorized" for a in case.approvals):
            done.add("approved")
        if case.procurement:
            done.add("procured")
        if case.state == "closed" and case.invoice and case.invoice.matched:
            done.add("reconciled")
        current = next((k for k, _ in STAGES_OWN if k not in done), None)
        out = []
        for k, l in STAGES_OWN:
            status = "done" if k in done else "active" if k == current and case.state not in ("closed", "rejected") else "pending"
            out.append({"key": k, "label": l, "status": status})
        return out

    # ------------------------------------------------------------------ opening and investigating

    def open(self, sig: IncidentSignal, scope: str, car_status: str, race_clock: str | None) -> FinanceCase:
        with self._lock:
            if sig.incident_id in self.by_incident:
                return self.cases[self.by_incident[sig.incident_id]]
            case_id = f"case:{self.race_id}:{sig.incident_id.split(':', 2)[-1]}"  # stable: one case per incident, replays reproduce it
            own = scope == "own_team"
            case = FinanceCase(
                case_id=case_id, incident_id=sig.incident_id, race_id=self.race_id, replay_id=self.replay_id, team=self.team, scope=scope, car=sig.driver_number or 0,
                driver_id=(sig.driver_name or f"car {sig.driver_number}"), title=("Race incident: our car" if own else "Race incident: competitor car") + f" {sig.driver_number}",
                summary=sig.message, opened_at_utc=self.now(), updated_at_utc=self.now(), race_clock_utc=race_clock,
                exposure_status="unknown_until_evidence" if own else "projection_only",
                exposure_label="Unconfirmed incident exposure until garage evidence arrives" if own else "No exposure of ours; our projections may move",
                evidence=[f"{e.endpoint} {e.event_time_utc}: {e.note or ''}".strip() for e in sig.source_evidence],
                permissions={"may_request_garage_report": own, "may_call_cost_cap_agent": own, "may_read_inventory": own, "may_prepare_procurement": own,
                             "may_approve_spend": False, "may_access_competitor_books": False},
            )
            self._step(case, "system", "Incident detected", f"{sig.type.replace('_', ' ')}; attribution {sig.driver_attribution}; car status {car_status}",
                       evidence=case.evidence, race_clock=race_clock)
            if not own:
                case.next_action = "Reprice our sponsor and championship scenarios on the new running order; nothing of theirs is ours to inspect"
                case.missing_evidence = []
            else:
                case.next_action = "Confirm the car's state from the timing feed; request the signed garage damage report. Do not estimate loss until evidence arrives."
                case.missing_evidence = ["garage damage report", "engineering feasibility of a repair"]
            self.cases[case_id] = case
            self.by_incident[sig.incident_id] = case_id
            self._emit(case)
            return case

    def on_jev(self, incident_id: str, d: JevDecision, race_clock: str | None) -> None:
        with self._lock:
            case = self._for(incident_id)
            if case is None:
                return
            how = (f"{d.chosen_route} (Jev said {d.route} at {d.route_confidence:.2f}, {d.latency_ms} ms)" if d.used else f"{d.chosen_route} (deterministic; Jev {d.status})")
            self._step(case, "jev", "Routed", how + "; routing is not permission to spend", state="investigating" if case.state == "detected" else None, race_clock=race_clock)
            self._emit(case)

    def on_plan(self, plan: IncidentPlan, race_clock: str | None) -> None:
        with self._lock:
            case = self._for(plan.incident_id)
            if case is None:
                return
            feasible = [s for s in plan.scenarios if s.feasible]
            worst = min(plan.scenarios, key=lambda s: s.delta_cents) if plan.scenarios else None
            self._step(case, "financial_analyst", "Priced the supported outcomes",
                       f"{len(feasible)} of {len(plan.scenarios)} outcomes feasible for a car that is {plan.car_status}; " +
                       (f"largest projection change {usd(worst.delta_cents)} ({worst.label.lower()})" if worst else ""), race_clock=race_clock)
            if case.scope == "competitor":
                delta = next((s.delta_cents for s in plan.scenarios if s.key == "retire"), 0)
                case.projection_delta_cents = delta
                case.exposure_status = "projection_only"
                case.exposure_label = "Change to our provisional sponsor scenario if they retire"
                closed = case.state in ("closed", "rejected")
                self._step(case, "financial_analyst", "Updated our projections", f"if car {plan.car} retires our provisional sponsor scenario moves {usd(delta) if delta else '$0'}; "
                           "competitor's books not accessed", state=None if closed else "evaluated", race_clock=race_clock)
                if not closed:
                    case.next_action = "Watch the running order; close when the car's status is final"
            self._emit(case)

    def on_retired(self, incident_id: str, race_clock: str | None, evidence: str) -> None:
        """The timing feed says the car is out. Own team: request the garage report. Competitor: close."""
        with self._lock:
            case = self._for(incident_id)
            if case is None:
                return
            case.evidence.append(evidence)
            if case.scope == "competitor":
                self._step(case, "financial_analyst", "Retirement confirmed from timing", evidence, evidence=[evidence], race_clock=race_clock)
                self.close(case, "competitor retired; our projections updated; no expense, no access to their records", race_clock)
                return
            self._step(case, "financial_analyst", "Retirement confirmed from timing", evidence, evidence=[evidence], race_clock=race_clock)
            if case.state in ("detected", "investigating"):
                self._step(case, "financial_analyst", "Requested the signed garage damage report and the component inventory",
                           "automatic: within the analyst's permissions; no loss estimated yet", state="awaiting_evidence", race_clock=race_clock)
                case.next_action = "Wait for the garage report; then evaluate repair against replacement under the cost cap"
            self._emit(case)

    def on_no_damage(self, incident_id: str, race_clock: str | None, evidence: str) -> None:
        """A collision was noted but the car is racing and the stewards took no further action: close
        without an expense. Knowing when not to act."""
        with self._lock:
            case = self._for(incident_id)
            if case is None or case.state in ("closed", "rejected"):
                return
            case.evidence.append(evidence)
            self._step(case, "financial_analyst", "No damage confirmed", evidence, evidence=[evidence], race_clock=race_clock)
            self.close(case, "car racing at full speed and stewards took no further action; no repair bill invented", race_clock)

    # ------------------------------------------------------------------ evidence and evaluation

    def receive_garage_report(self, case_id: str, report: GarageReport, race_clock: str | None = None) -> FinanceCase:
        with self._lock:
            case = self.cases[case_id]
            if case.scope != "own_team":
                raise self._refuse(case, "system", "Garage report for a competitor's car", "a competitor's garage records are not ours to receive")
            case.garage_report = report
            case.missing_evidence = [m for m in case.missing_evidence if m != "garage damage report"]
            self._step(case, "engineering", "Garage damage report received", f"{len(report.parts)} parts; options {', '.join(f'{o.key} {usd(o.cost_cents)}' for o in report.options)}"
                       + ("; SYNTHETIC demo input" if report.synthetic else ""), evidence=[report.source], automatic=False, race_clock=race_clock)
            self._evaluate(case, race_clock)
            return case

    def _evaluate(self, case: FinanceCase, race_clock: str | None) -> None:
        r = case.garage_report
        assert r is not None
        headroom, source = self.headroom_fn()
        opts = []
        for o in r.options:
            opts.append({"key": o.key, "label": o.label, "cost_cents": o.cost_cents, "treatment": "RELEVANT", "cap_effect_cents": o.cost_cents,
                         "headroom_after_cents": (headroom - o.cost_cents) if headroom is not None else None, "feasible_if": o.feasible_if})
        repair = next((o for o in r.options if o.key == "repair"), None)
        replace = next((o for o in r.options if o.key == "replace"), None)
        rec = None
        avoided = None
        conditions = []
        if repair and replace and repair.cost_cents < replace.cost_cents:
            rec, avoided = "repair", replace.cost_cents - repair.cost_cents
            conditions.append(repair.feasible_if or "engineering confirms the repair is safe and available before the next required event")
        elif replace:
            rec = "replace"
        ev = CostCapEvaluation(basis="Parts replaced after accident damage are Relevant Costs under the FIA Financial Regulations (no exclusion for crash damage); "
                               "both options count against the cap in full", headroom_before_cents=headroom, headroom_source=source, options=opts, recommended=rec,
                               avoided_cents=avoided, conditions=conditions + ["controller authorizes the spend; the agent cannot"], evaluated_at_utc=self.now())
        case.evaluation = ev
        case.exposure_status = "estimated_from_garage_report"
        case.exposure_cents = (repair or replace).cost_cents if (repair or replace) else None
        case.exposure_label = "Estimated incident cost from the garage report, not booked"
        self._step(case, "cost_cap_agent", "Evaluated the options under the cost cap",
                   f"both RELEVANT; headroom {usd(headroom) if headroom is not None else 'unknown'} ({source}); " +
                   (f"recommends {rec}, avoiding {usd(avoided)} against replacement, if {conditions[0]}" if rec == "repair" else f"recommends {rec}"),
                   state="evaluated", race_clock=race_clock)
        case.missing_evidence = ["engineering clearance of the repair", "controller authorization of the spend"]
        case.next_action = ("Engineering: confirm the repair is safe and available. Controller: authorize the spend. Then procurement is prepared automatically.")
        self._step(case, "financial_analyst", "Escalated for approval", "a spend commitment needs engineering clearance and the controller; beyond the agent's authority",
                   status="escalated", state="awaiting_approval", race_clock=race_clock)
        case.escalation_reason = "spend commitment requires engineering clearance and controller authorization"
        self._emit(case)

    # ------------------------------------------------------------------ approvals, procurement, reconciliation

    def approve(self, case_id: str, role: str, by: str, decision: str, reason: str = "") -> FinanceCase:
        with self._lock:
            case = self.cases[case_id]
            actor = "engineering" if role == "engineering" else "controller"
            if by.startswith("agent:") or by in ("jev", "advisor", "financial_analyst", "cost_cap_agent"):
                raise self._refuse(case, actor, f"{role} {decision}", f"{by} is an agent; agents do not approve restricted actions", by=by)
            if case.state != "awaiting_approval":
                raise self._refuse(case, actor, f"{role} {decision}", f"the case is {case.state}, not awaiting approval", by=by)
            if role not in ("engineering", "controller") or decision not in ("cleared", "not_cleared", "authorized", "rejected"):
                raise self._refuse(case, actor, f"{role} {decision}", "unknown role or decision", by=by)
            if role == "controller":
                eng = next((a for a in case.approvals if a.role == "engineering"), None)
                if eng is None:
                    raise self._refuse(case, actor, f"controller {decision}", "engineering has not cleared the repair yet", by=by)
                if eng.by == by:
                    raise self._refuse(case, actor, f"controller {decision}", f"{by} cleared feasibility; the same person cannot also authorize the spend", by=by)
            ap = Approval(role=role, by=by, decision=decision, reason=reason, at_utc=self.now())  # type: ignore[arg-type]
            case.approvals.append(ap)
            if role == "engineering":
                if decision == "cleared":
                    case.missing_evidence = [m for m in case.missing_evidence if not m.startswith("engineering")]
                    self._step(case, "engineering", "Repair cleared", reason or "repair is safe and the parts are available", automatic=False, by=by)
                    case.next_action = "Controller: authorize the repair spend"
                else:
                    if case.evaluation:
                        case.evaluation.recommended = "replace"
                        case.evaluation.avoided_cents = None
                        case.exposure_cents = next((o["cost_cents"] for o in case.evaluation.options if o["key"] == "replace"), case.exposure_cents)
                    self._step(case, "engineering", "Repair not cleared", reason or "replacement required", automatic=False, by=by)
                    case.next_action = "Controller: authorize the replacement spend"
                self._emit(case)
                return case
            # controller
            if decision == "rejected":
                self._step(case, "controller", "Spend rejected", reason, automatic=False, by=by, state="rejected")
                case.closed_reason = f"controller rejected the spend: {reason}"
                case.next_action = "None; the case is closed as rejected"
                self._emit(case)
                return case
            option = case.evaluation.recommended if case.evaluation else None
            amount = next((o["cost_cents"] for o in (case.evaluation.options if case.evaluation else []) if o["key"] == option), None)
            if option is None or amount is None:
                raise self._refuse(case, actor, "controller authorized", "nothing to authorize: no evaluated option", by=by)
            case.missing_evidence = []
            self._step(case, "controller", "Spend authorized", f"{option} at {usd(amount)}{' (material: above $250k)' if amount >= MATERIALITY_CENTS else ''}; {reason}".rstrip("; "),
                       automatic=False, by=by, state="authorized")
            case.exposure_status = "authorized"
            case.exposure_cents = amount
            case.exposure_label = "Authorized commitment, not yet invoiced"
            self._prepare_procurement(case, option, amount, by)
            return case

    def _prepare_procurement(self, case: FinanceCase, option: str, amount: int, authorized_by: str) -> None:
        order = ProcurementOrder(order_id=f"PO-{uuid.uuid4().hex[:8].upper()}", option=option, amount_cents=amount,  # type: ignore[arg-type]
                                 vendor="Meridian composites supplier (synthetic)", authorized_by=authorized_by, created_at_utc=self.now(), status="sent")
        case.procurement = order
        self._step(case, "procurement", "Mock procurement order prepared and sent", f"{order.order_id} {option} {usd(amount)} to {order.vendor}; within the authorization",
                   state="reconciling")
        case.next_action = "Wait for the supplier's invoice; match it to the order within 2% or escalate"
        self._emit(case)

    def receive_invoice(self, case_id: str, inv: Invoice) -> FinanceCase:
        with self._lock:
            case = self.cases[case_id]
            if case.state != "reconciling" or case.procurement is None:
                raise self._refuse(case, "reconciliation", "Invoice received", f"no authorized order to match (case is {case.state})")
            order = case.procurement
            variance = inv.amount_cents - order.amount_cents
            inv.order_id = order.order_id
            inv.variance_cents = variance
            inv.matched = abs(variance) <= INVOICE_TOLERANCE * order.amount_cents
            case.invoice = inv
            if inv.matched:
                order.status = "matched"
                self._step(case, "reconciliation", "Invoice matched to the order", f"{inv.invoice_id} {usd(inv.amount_cents)} vs {order.order_id} {usd(order.amount_cents)}; variance {usd(variance)} within 2%"
                           + ("; SYNTHETIC demo invoice" if inv.synthetic else ""), evidence=[inv.invoice_id, order.order_id])
                case.exposure_status = "reconciled"
                case.exposure_label = "Reconciled against the authorized order (synthetic demo)"
                self.close(case, f"invoice matched the authorized {order.option} at {usd(inv.amount_cents)}; audit trail complete", None)
            else:
                order.status = "disputed"
                case.escalation_reason = f"invoice {usd(inv.amount_cents)} differs from the authorization {usd(order.amount_cents)} by {usd(variance)} (over 2%)"
                case.missing_evidence = ["controller decision on the invoice variance"]
                case.next_action = "Controller: accept the variance or dispute the invoice; the agent does not pay outside the authorization"
                self._step(case, "reconciliation", "Invoice outside tolerance", case.escalation_reason, evidence=[inv.invoice_id, order.order_id], status="escalated",
                           state="awaiting_approval")
                self._emit(case)
            return case

    def close(self, case: FinanceCase, reason: str, race_clock: str | None) -> None:
        with self._lock:
            case.closed_reason = reason
            case.next_action = "None; the case is closed"
            case.missing_evidence = []
            self._step(case, "system", "Case closed", reason, state="closed", race_clock=race_clock)
            self._emit(case)

    # ------------------------------------------------------------------ demo input (labelled synthetic)

    def demo_garage_report(self, case_id: str, race_clock: str | None = None) -> FinanceCase:
        """The synthetic garage report the plan's section 6C illustrates: replace $400k or repair $130k."""
        case = self.cases[case_id]
        report = GarageReport(reported_at_utc=self.now(), car=case.car,
                              parts=[{"part": "front wing assembly", "condition": "destroyed"}, {"part": "floor, left edge", "condition": "cracked"},
                                     {"part": "front suspension, left", "condition": "to be crack-tested"}],
                              options=[GarageOption(key="replace", label="New front wing, floor section and suspension arm", cost_cents=40_000_000, lead_time="available from stock"),
                                       GarageOption(key="repair", label="Repair the floor, replace the wing, reuse the arm if it passes NDT", cost_cents=13_000_000, lead_time="48 hours",
                                                    feasible_if="engineering confirms the arm passes crack testing and the repaired floor is safe for the next event")],
                              engineer_note="Synthetic demo report. Real inspection would come from the garage's signed damage assessment.")
        return self.receive_garage_report(case_id, report, race_clock)

    def demo_invoice(self, case_id: str, amount_cents: int | None = None) -> FinanceCase:
        case = self.cases[case_id]
        amt = amount_cents if amount_cents is not None else (case.procurement.amount_cents if case.procurement else 0)
        return self.receive_invoice(case_id, Invoice(invoice_id=f"INV-{uuid.uuid4().hex[:6].upper()}", order_id=None, amount_cents=amt, received_at_utc=self.now(), synthetic=True,
                                                     note="synthetic demo invoice"))

    def schedule(self, seconds: float, fn: Callable[[], None]) -> None:
        t = threading.Timer(seconds, fn)
        t.daemon = True
        self._timers.append(t)
        t.start()

    # ------------------------------------------------------------------ views

    def _for(self, incident_id: str) -> FinanceCase | None:
        cid = self.by_incident.get(incident_id)
        return self.cases.get(cid) if cid else None

    def all(self) -> list[FinanceCase]:
        return sorted(self.cases.values(), key=lambda c: c.opened_at_utc)

    def summary(self) -> dict:
        cs = self.all()
        return {"cases": len(cs), "by_state": {s: sum(1 for c in cs if c.state == s) for s in sorted({c.state for c in cs})}, "refused_actions": len(self.refused),
                "closed_autonomously": sum(1 for c in cs if c.state == "closed" and not any(not s.automatic for s in c.steps)),
                "closed_with_approvals": sum(1 for c in cs if c.state == "closed" and any(not s.automatic for s in c.steps))}
