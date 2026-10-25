"""Shared event models for the live racing workstream (plan section 6; frozen contracts).

`real_sporting_event` != `synthetic_financial_fixture` != `calculated_forecast` != `posted_financial_entry`.
Every object says which of those it is. Fields that are not known at the source time are None,
never invented. These models are the JSON contracts Person 2 (cost cap) and Person 3 (dashboard)
read; change them here first.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = 1

Route = Literal["crash_finance", "revenue_change", "race_forecast", "human_review", "no_action"]
Urgency = Literal["routine", "watch", "urgent", "critical"]
Mode = Literal["replay", "live"]


class SourceRef(BaseModel):
    """Where a fact came from: the exact endpoint and record time, so a reviewer can re-fetch it."""

    system: str = "openf1"
    endpoint: str
    url: str
    event_time_utc: str | None = None
    record_id: str | None = None
    note: str | None = None


class Timestamps(BaseModel):
    """Measured times along the path (plan 6D). Absent means not measured, never forged."""

    source_event: str | None = None
    adapter_received: str | None = None
    jev_started: str | None = None
    jev_finished: str | None = None
    state_published: str | None = None
    finance_recomputed: str | None = None


class Weather(BaseModel):
    observed_at_utc: str | None = None
    rainfall: int | None = None
    track_temperature_c: float | None = None
    air_temperature_c: float | None = None
    humidity: float | None = None
    wind_speed: float | None = None
    wind_direction: int | None = None


class DriverState(BaseModel):
    driver_number: int
    name_acronym: str | None = None
    team: str | None = None
    position: int | None = None
    lap: int | None = None
    compound: str | None = None
    tyre_age_laps: int | None = None
    last_pit_lap: int | None = None
    status: Literal["running", "in_pit", "stopped_candidate", "unknown"] = "unknown"


class ForecastLine(BaseModel):
    sponsor_id: str
    sponsor_name: str
    contract_ref: str
    clause_id: str
    clause_type: str
    car: int
    driver_id: str
    position: int | None
    amount_orig_cents: int
    currency: str
    fx_rate: str
    amount_usd_cents: int
    quote: str


class PrizeIfFinishedNow(BaseModel):
    constructors_position: int
    points: float
    prize_table_cents: int
    note: str


class Forecast(BaseModel):
    """Sponsor entitlements if the classification stood as it is now. Unbooked exposure, not revenue."""

    type: Literal["if_finished_now", "provisional_classification", "final_classification"] = "if_finished_now"
    status: Literal["indicative", "awaiting_official_classification", "verified_final"] = "indicative"
    financial_source: Literal["synthetic"] = "synthetic"
    currency: Literal["USD"] = "USD"
    amount_cents: int | None = None
    lines: list[ForecastLine] = Field(default_factory=list)
    prize: PrizeIfFinishedNow | None = None
    basis: str = ""
    as_of_utc: str | None = None


class ForecastChange(BaseModel):
    before_cents: int | None
    after_cents: int | None
    delta_cents: int | None
    gained: list[str] = Field(default_factory=list)
    lost: list[str] = Field(default_factory=list)
    text: str = ""


class RaceStateUpdate(BaseModel):
    """Person 1 -> Person 3 (plan 6A)."""

    schema_version: int = SCHEMA_VERSION
    event_id: str
    source_system: str = "openf1"
    source_url: str
    event_time_utc: str
    observed_at_utc: str
    session_key: int
    race_id: str
    mode: Mode = "replay"
    lap: int | None = None
    flag_status: str | None = None
    weather: Weather = Field(default_factory=Weather)
    driver_states: list[DriverState] = Field(default_factory=list)
    forecast: Forecast = Field(default_factory=Forecast)
    forecast_change: ForecastChange | None = None
    team_cars: list[int] = Field(default_factory=list)
    timestamps: Timestamps = Field(default_factory=Timestamps)
    note: str | None = None


class JevDecision(BaseModel):
    """What Jev (TypeSafe System One) decided, or the honest record that it did not."""

    used: bool = False
    status: Literal[
        "ok", "low_confidence", "overridden", "unavailable", "disabled", "invalid_response", "budget_exhausted", "cached"
    ] = "disabled"
    model: str | None = None
    route: Route | None = None
    route_confidence: float | None = None
    route_probabilities: dict[str, float] | None = None
    urgency: Urgency | None = None
    urgency_score: float | None = None
    urgency_confidence: float | None = None
    urgency_probabilities: dict[str, float] | None = None
    needs_evidence: float | None = None
    latency_ms: int | None = None
    input_hash: str | None = None
    masked_input: dict[str, Any] | None = None
    deterministic_route: Route
    chosen_route: Route
    reason: str = ""
    error: str | None = None


class FinancialImpact(BaseModel):
    status: Literal["unknown", "synthetic_projected_not_booked", "pending"] = "unknown"
    amount_cents: int | None = None
    currency: Literal["USD"] = "USD"


class Handoff(BaseModel):
    target: Literal["cost_cap_agent", "revenue_desk", "human_review", "none"] = "none"
    status: Literal["not_requested", "requested", "acknowledged", "assessed", "pending"] = "not_requested"
    requested_at_utc: str | None = None
    acknowledged_at_utc: str | None = None
    finance_impact_ref: str | None = None


class IncidentSignal(BaseModel):
    """Person 1 -> Person 2 + Person 3 (plan 6B)."""

    schema_version: int = SCHEMA_VERSION
    incident_id: str
    version: int = 1
    type: Literal["potential_crash", "red_flag_unattributed", "incident_noted"] = "potential_crash"
    sporting_source_date: str
    race_id: str
    lap: int | None = None
    driver_number: int | None = None
    driver_name: str | None = None
    historical_team: str | None = None
    driver_attribution: Literal["none", "provisionally_correlated", "named_by_race_control", "confirmed"] = "none"
    source_evidence: list[SourceRef] = Field(default_factory=list)
    corroborating_source_url: str | None = None
    corroboration_note: str | None = None
    sporting_confirmation: Literal["incident_candidate", "needs_confirmation", "retired_per_timing", "verified_historical_incident"] = "incident_candidate"
    scope: Literal["own_team", "competitor", "unknown"] = "unknown"
    # a source published after the race, attached for the reader; never used as live evidence
    post_race_reference: dict[str, Any] | None = None
    damage_confirmation: Literal["none", "awaiting_synthetic_garage_report", "synthetic_garage_report_received"] = "none"
    jev: JevDecision
    urgency: Urgency | None = None
    financial_impact: FinancialImpact = Field(default_factory=FinancialImpact)
    handoff: Handoff = Field(default_factory=Handoff)
    synthetic_financial_world: str = "Meridian Racing"
    event_time_utc: str
    observed_at_utc: str
    mode: Mode = "replay"
    timestamps: Timestamps = Field(default_factory=Timestamps)
    message: str = ""


class FinanceImpactUpdate(BaseModel):
    """Return from Person 2 / the revenue engine (plan 6C). Strict: anything that looks like a journal
    entry, a balance or an approval is rejected at the schema (extra fields are forbidden)."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = SCHEMA_VERSION
    incident_id: str
    financial_status: Literal["pending", "synthetic_projected_not_booked"]
    initial_exposure_cents: int | None = None
    selected_recovery_cost_cents: int | None = None
    forecast_headroom_after_cents: int | None = None
    currency: Literal["USD"] = "USD"
    requires_engineering_approval: bool | None = None
    requires_finance_approval: bool | None = None
    accounting_rule_version: str | None = None
    evidence_refs: list[str] = Field(default_factory=list)
    note: str | None = None
    received_at_utc: str | None = None


class OfficialDocument(BaseModel):
    title: str
    url: str | None
    document_number: str | None
    kind: str
    cars: list[int]
    likely_outcome: str | None
    published_at_utc: str
    actor_run_id: str | None = None


class ResultChangeSignal(BaseModel):
    """Person 1 -> revenue desk + Person 3: an official document changed (or threatens) a result.
    Code did the arithmetic; nothing here is booked."""

    schema_version: int = SCHEMA_VERSION
    signal_id: str
    version: int = 1
    type: Literal["provisional", "result_at_risk", "result_change", "result_final"]
    race_id: str
    season: int
    round: int
    session: str
    document: OfficialDocument | None = None
    before: Forecast
    after: Forecast
    change: ForecastChange
    jev: JevDecision
    status: Literal[
        "provisional", "at_risk", "provisional_expected_bonus_corrected_awaiting_recognized_revenue_policy_gate", "final"
    ]
    message: str
    handoff: Handoff = Field(default_factory=Handoff)
    event_time_utc: str
    observed_at_utc: str
    mode: Mode = "replay"
    timestamps: Timestamps = Field(default_factory=Timestamps)


class ReplayStatus(BaseModel):
    replay_id: str
    race_id: str
    mode: Mode = "replay"
    state: Literal["idle", "fast_forward", "running", "paused", "finished", "stopped", "error"] = "idle"
    speed: float
    events_total: int
    events_done: int
    clock_utc: str | None = None
    lap: int | None = None
    jev_mode: str
    jev_requests: int = 0
    jev_errors: int = 0
    incidents: int = 0
    duplicates_suppressed: int = 0
    sinks: list[str] = Field(default_factory=list)
    error: str | None = None


# ---------------------------------------------------------------------- strategic finance (plan section 5, extended)


class PlaceValue(BaseModel):
    """What one place up or down is worth to the team right now, from the contracts."""

    car: int
    driver_id: str
    position: int | None
    value_now_cents: int
    up_one_cents: int = 0
    down_one_cents: int = 0
    up_one_text: str = ""
    down_one_text: str = ""


class PitScenario(BaseModel):
    car: int
    position: int | None
    pit_loss_s: float
    pit_loss_basis: str
    under: str | None = None
    cars_passed: list[int] = Field(default_factory=list)
    cars_maybe: list[int] = Field(default_factory=list)
    positions_lost: int = 0
    rejoin_position: int | None = None
    delta_cents: int = 0
    # the same stop under a green flag (full pit loss), so the Safety Car discount is visible
    green_pit_loss_s: float | None = None
    green_positions_lost: int | None = None
    green_delta_cents: int | None = None
    text: str = ""


class TyreContext(BaseModel):
    car: int
    compound: str | None
    age_laps: int | None
    stint_lap_start: int | None
    field_median_age_laps: float | None
    note: str


class StrategyAdvice(BaseModel):
    """Person 1 -> the pit wall: the money on every strategic lever, as of now. No model of tyre
    degradation or pace is pretended; gaps come from the timing feed, pit loss from this race's stops."""

    schema_version: int = SCHEMA_VERSION
    race_id: str
    version: int = 1
    as_of_utc: str
    observed_at_utc: str
    lap: int | None
    flag_status: str | None
    exposure_now_cents: int
    exposure_at_join_cents: int | None
    exposure_peak_cents: int | None
    lost_from_peak_cents: int | None
    places: list[PlaceValue] = Field(default_factory=list)
    pit: list[PitScenario] = Field(default_factory=list)
    tyres: list[TyreContext] = Field(default_factory=list)
    weather_note: str = ""
    # plain-English lines the pit wall can read out: what a place, a stop, the tyres and the weather are worth right now
    levers: list[str] = Field(default_factory=list)
    status: Literal["indicative"] = "indicative"
    financial_source: Literal["synthetic"] = "synthetic"
    basis: str = ""
    timestamps: Timestamps = Field(default_factory=Timestamps)


class IncidentScenario(BaseModel):
    key: Literal["continue", "pit_now", "retire", "repair_and_rejoin", "penalty_5s", "penalty_10s", "drive_through", "disqualified"]
    label: str
    assumption: str
    # the feasibility gate: an infeasible outcome is shown greyed and never offered to the advisor
    feasible: bool = True
    requires: list[str] = Field(default_factory=list)  # engineering_clearance | stewards_decision
    why: str = ""
    position_after: int | None
    exposure_after_cents: int
    delta_cents: int
    lines_lost: list[str] = Field(default_factory=list)
    lines_gained: list[str] = Field(default_factory=list)
    constructors_position_after: int | None = None
    prize_delta_cents: int = 0


class AdvisorNote(BaseModel):
    """The live finance agent's draft on an incident: a recommendation among the scenarios code
    priced, never a booking. `used` is false whenever the model did not answer."""

    used: bool = False
    status: Literal["pending", "ok", "disabled", "unavailable", "refused", "error", "invalid"] = "disabled"
    model: str | None = None
    latency_ms: int | None = None
    recommended_scenario: str | None = None
    headline: str | None = None
    rationale: str | None = None
    what_we_need: list[str] = Field(default_factory=list)
    confidence: Literal["low", "medium", "high"] | None = None
    error: str | None = None
    drafted_at_utc: str | None = None


class IncidentPlan(BaseModel):
    """Accident outcomes priced for one car: what each choice does to the sponsor exposure and the
    constructors' position, with the cost-cap side left to the garage report (plan 6C)."""

    schema_version: int = SCHEMA_VERSION
    incident_id: str
    version: int = 1
    race_id: str
    car: int
    driver_id: str
    team_car: bool
    scope: Literal["own_team", "competitor"] = "competitor"
    car_status: str = "unknown"
    feasibility_note: str = ""
    as_of_utc: str
    observed_at_utc: str
    lap: int | None
    flag_status: str | None
    position_now: int | None
    exposure_now_cents: int
    scenarios: list[IncidentScenario] = Field(default_factory=list)
    damage_estimate_cents: int | None = None
    cost_cap_note: str
    advisor: AdvisorNote = Field(default_factory=AdvisorNote)
    status: Literal["indicative"] = "indicative"
    financial_source: Literal["synthetic"] = "synthetic"
    basis: str = ""
    timestamps: Timestamps = Field(default_factory=Timestamps)


class SinkHealth(BaseModel):
    name: str
    ok: bool
    written: int = 0
    errors: int = 0
    last_write_utc: str | None = None
    detail: str | None = None


class FeedHealth(BaseModel):
    """How alive the feed is, measured: wall-clock cadence of publishes, the race clock, every sink's
    write counts (the SpacetimeDB rows the dashboard reads), Jev's request stats, the exposure tally."""

    replay_id: str | None
    state: str | None
    mode: Mode = "replay"
    now_utc: str
    race_clock_utc: str | None
    lap: int | None
    last_publish_utc: str | None
    seconds_since_last_publish: float | None
    publishes_total: int
    publishes_last_60s: int
    publishes_per_second_10s: float
    state_updates: int
    publish_p95_ms: int | None
    sinks: list[SinkHealth] = Field(default_factory=list)
    jev: dict[str, Any] = Field(default_factory=dict)
    advisor: str
    exposure_now_cents: int | None
    exposure_at_join_cents: int | None
    exposure_peak_cents: int | None
    lost_from_peak_cents: int | None
    incidents: int = 0
    incident_plans: int = 0


# ---------------------------------------------------------------------- financial cases (the work, not the telemetry)

CaseState = Literal["detected", "investigating", "awaiting_evidence", "evaluated", "awaiting_approval", "authorized", "reconciling", "closed", "rejected"]
Actor = Literal["system", "jev", "financial_analyst", "cost_cap_agent", "engineering", "controller", "procurement", "reconciliation", "person"]


class CaseStep(BaseModel):
    """One line of the case's audit trail: who did what, on what evidence, and whether it was automatic."""

    at_utc: str
    race_clock_utc: str | None = None
    actor: Actor
    by: str | None = None  # a person's id when a person acted
    action: str
    detail: str = ""
    evidence: list[str] = Field(default_factory=list)
    automatic: bool = True
    status: Literal["done", "pending", "refused", "escalated"] = "done"
    state_after: CaseState | None = None


class GarageOption(BaseModel):
    key: Literal["replace", "repair"]
    label: str
    cost_cents: int
    lead_time: str
    feasible_if: str | None = None


class GarageReport(BaseModel):
    """What the garage says it found. In the replay this is synthetic demo input and says so."""

    synthetic: bool = True
    source: str = "synthetic_demo_garage_report"
    reported_at_utc: str
    car: int
    parts: list[dict[str, str]] = Field(default_factory=list)
    options: list[GarageOption] = Field(default_factory=list)
    engineer_note: str = ""


class CostCapEvaluation(BaseModel):
    """The cost cap desk's view of the garage options: treatment, cap effect, headroom, recommendation."""

    treatment: str = "RELEVANT"
    basis: str
    headroom_before_cents: int | None
    headroom_source: str
    options: list[dict[str, Any]] = Field(default_factory=list)
    recommended: Literal["replace", "repair"] | None = None
    avoided_cents: int | None = None
    conditions: list[str] = Field(default_factory=list)
    evaluated_at_utc: str


class Approval(BaseModel):
    role: Literal["engineering", "controller"]
    by: str
    decision: Literal["cleared", "not_cleared", "authorized", "rejected"]
    reason: str = ""
    at_utc: str


class ProcurementOrder(BaseModel):
    order_id: str
    option: Literal["replace", "repair"]
    amount_cents: int
    vendor: str
    authorized_by: str
    created_at_utc: str
    status: Literal["prepared", "sent", "invoiced", "matched", "disputed"] = "prepared"
    mock: bool = True


class Invoice(BaseModel):
    invoice_id: str
    order_id: str | None
    amount_cents: int
    received_at_utc: str
    synthetic: bool = True
    variance_cents: int | None = None
    matched: bool | None = None
    note: str = ""


class FinanceCase(BaseModel):
    """A unit of finance work opened by a material racing event, with a state, a next action, what
    is missing, what the agents may do, and every step that was taken or refused."""

    schema_version: int = SCHEMA_VERSION
    case_id: str
    version: int = 1
    incident_id: str
    race_id: str
    replay_id: str
    team: str
    scope: Literal["own_team", "competitor"]
    car: int
    driver_id: str
    title: str
    summary: str
    state: CaseState = "detected"
    owner: str = "financial_analyst"
    opened_at_utc: str
    updated_at_utc: str
    race_clock_utc: str | None = None
    exposure_status: Literal["unknown_until_evidence", "projection_only", "estimated_from_garage_report", "authorized", "reconciled", "none"] = "unknown_until_evidence"
    exposure_cents: int | None = None
    exposure_label: str = "Unconfirmed incident exposure until garage evidence arrives"
    projection_delta_cents: int | None = None
    evidence: list[str] = Field(default_factory=list)
    missing_evidence: list[str] = Field(default_factory=list)
    next_action: str = ""
    permissions: dict[str, bool] = Field(default_factory=dict)
    garage_report: GarageReport | None = None
    evaluation: CostCapEvaluation | None = None
    approvals: list[Approval] = Field(default_factory=list)
    procurement: ProcurementOrder | None = None
    invoice: Invoice | None = None
    escalation_reason: str | None = None
    closed_reason: str | None = None
    steps: list[CaseStep] = Field(default_factory=list)
    stages: list[dict[str, str]] = Field(default_factory=list)  # the workflow checklist the page draws
