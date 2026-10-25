"""HTTP endpoints for the cost cap strategy simulator (mounted by finance.api).

    GET  /api/capsim/rules              the 2026 rules used (article, plain English, verbatim quote), and 2025 for comparison
    GET  /api/capsim/plan               Meridian's 2026 budget, calendar, upgrades, what has happened so far
    POST /api/capsim/forecast           year-end Relevant Costs distribution and breach probabilities
    POST /api/capsim/decide             should we bring a proposed upgrade? paired with/without comparison
    POST /api/capsim/headroom           most extra spend that keeps P(breach) at or below a target
    POST /api/capsim/pu-allocation      how to split the D6.1.1.q USD 3m between 2026 and 2027 (declare by 30 Nov 2026)
    GET  /api/capsim/sources            where every number came from
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import regulations as R
from .assumptions import SOURCES, Assumptions
from .decide import Option, Standings, Team, default_standings, evaluate, headroom, pu_allocation
from .plan import CALENDAR_SOURCE, EVENTS_2026, Plan
from .sim import Scenario, forecast, histogram
from .sources import load

router = APIRouter(prefix="/api/capsim", tags=["cost cap simulator"])


class ScenarioIn(BaseModel):
    as_of_month: int = Field(9, ge=1, le=12, description="last closed month; actuals through its end")
    source: str = Field("meridian", description="meridian | cost_cap_desk")
    include: list[str] = Field(default_factory=list, description="proposed upgrades to include, e.g. ['U5']")
    pu_integration_2026: int = Field(R.PU_INTEGRATION_DEFAULT_2026, ge=0, le=3_000_000,
                                     description="share of the mandatory D6.1.1.q.i USD 3m put in 2026; 1.5m is the split if nothing is declared")
    extra_spend: dict[int, int] = Field(default_factory=dict, description="month -> extra USD (negative = cut)")
    tyre_test_days: int = Field(0, ge=0)
    tyre_day_amount: int | None = None
    assumptions: dict = Field(default_factory=dict)


def _build(body: ScenarioIn, label: str = "baseline"):
    try:
        plan, act, meta = load(body.source, body.as_of_month)
        a = Assumptions.from_dict(body.assumptions)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(400, str(exc))
    proposed = {u.key for u in plan.upgrades if u.status == "proposed"}
    bad = [k for k in body.include if k not in proposed]
    if bad:
        raise HTTPException(400, f"not proposed upgrades: {bad}; proposed: {sorted(proposed)}")
    if any(not 1 <= m <= 12 or m <= body.as_of_month for m in body.extra_spend):
        raise HTTPException(400, "extra_spend months must be after the as-of month")
    sc = Scenario(body.as_of_month, act, set(body.include), body.pu_integration_2026, body.tyre_test_days, body.tyre_day_amount,
                  dict(body.extra_spend), label=label)
    return plan, sc, a, meta


@router.get("/rules")
def rules():
    def dump(rs: R.RuleSet):
        return {"rule_set": rs.rule_set, "years": rs.years, "base_cap": rs.base_cap, "material_threshold": str(rs.material_pct),
                "provisions": {k: asdict(v) for k, v in rs.provisions.items()}}

    cap = R.cost_cap(2026, 23)
    return {"2026": {**dump(R.SECD_ISS08), "cap_for_23_rounds": cap, "material_line": R.classify(2026, cap, cap).material_line,
                     "sanctions": R.SANCTIONS},
            "2025": dump(R.ISS22),
            "what_changed": ["material threshold 5% -> 2%", "minor overspend fine 'may' (ISS22 8.11) -> 'shall' (D10.3.2)",
                             "cap no longer falls below 24 races", "sprint adjustment only beyond 6 sprints",
                             "up to USD 2m (indexed) of unused cap carried forward from FY2027", "plant and equipment depreciation now inside the cap"]}


@router.get("/plan")
def plan():
    p = Plan()
    return {**p.summary(), "upgrades": [asdict(u) for u in p.upgrades],
            "calendar": [{**asdict(r), "day": r.day.isoformat()} for r in p.calendar], "calendar_source": CALENDAR_SOURCE,
            "events_so_far": [asdict(e) for e in EVENTS_2026]}


@router.post("/forecast")
def run_forecast(body: ScenarioIn):
    plan_, sc, a, meta = _build(body)
    f = forecast(plan_, sc, a, keep_runs=True)
    hist = histogram(f.pop("_relevant"), f["cap"])
    return {**f, "histogram": hist, "data": meta, "assumptions": a.to_dict()}


class TeamIn(BaseModel):
    name: str
    points: float
    per_race: float
    sd_per_race: float = 7.0


class DecideIn(ScenarioIn):
    option: str = "U5"
    points_per_race: float = 2.0
    points_sd_per_race: float = 1.5
    extra_cost: int = 0
    max_material_risk: float = Field(0.01, ge=0, le=1)
    teams: list[TeamIn] | None = None
    teams_ahead_fixed: int = 2
    standings_team: str = Field("mercedes", description="whose championship position the decision is valued from (real 2026 table); Meridian mirrors mercedes")


@router.post("/decide")
def decide(body: DecideIn):
    plan_, sc, a, meta = _build(body)
    if body.option in sc.include:
        raise HTTPException(400, "the option under test must not also be in include")
    try:
        st = default_standings(body.as_of_month, body.standings_team)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if body.teams:
        if not any(t.name == st.us for t in body.teams):
            raise HTTPException(400, f"teams must include {st.us}")
        st = Standings(body.teams_ahead_fixed, [Team(**t.model_dump()) for t in body.teams])
    try:
        out = evaluate(plan_, sc, Option(body.option, body.points_per_race, body.points_sd_per_race, body.extra_cost), st, a,
                       body.max_material_risk)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {**out, "data": meta}


class HeadroomIn(ScenarioIn):
    target_breach: float = Field(0.10, gt=0, lt=1)
    month: int | None = None


@router.post("/headroom")
def run_headroom(body: HeadroomIn):
    plan_, sc, a, meta = _build(body)
    if body.month is not None and body.month <= body.as_of_month:
        raise HTTPException(400, "month must be after the as-of month")
    return {**headroom(plan_, sc, a, body.target_breach, body.month), "data": meta}


@router.post("/pu-allocation")
def run_pu(body: ScenarioIn):
    plan_, sc, a, meta = _build(body)
    return {"article": asdict(R.SECD_ISS08.provisions["pu_integration"]), "deadline": "declare by 30 November 2026",
            "options": pu_allocation(plan_, sc, a), "default_if_undeclared": "1.5m to 2026 and 1.5m to 2027, not amendable later",
            "note": "the adjustment is mandatory; every dollar allocated to 2026 is a dollar less in 2027", "data": meta}


@router.get("/sources")
def sources():
    return {"regulations": "FIA 2026 F1 Regulations Section D Issue 08 (1 Oct 2026); Financial Regulations Issue 22; Section A Issue 02",
            "sources": [asdict(s) for s in SOURCES], "calendar": CALENDAR_SOURCE,
            "illustrative": ["Meridian Racing's budget, spend so far and upgrade programme", "the constructors' fight around Meridian",
                             "the prize money table (world/prize_table.json)", "every number in capsim/assumptions.py"]}
