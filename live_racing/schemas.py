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
    sporting_confirmation: Literal["incident_candidate", "needs_confirmation", "verified_historical_incident"] = "incident_candidate"
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
