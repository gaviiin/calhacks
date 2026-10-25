import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// The live racing feed (live_racing/api.py on :8020, proxied at /live). The snapshot comes from
// polling /live/state; every published record, in order and with every version, comes from the
// server-sent events at /live/stream. The contracts are frozen in live_racing/schemas.py; the
// types here mirror them. Nothing on this feed is booked: the forecast is an indicative exposure.

export type Route = 'crash_finance' | 'revenue_change' | 'race_forecast' | 'human_review' | 'no_action';
export type Urgency = 'routine' | 'watch' | 'urgent' | 'critical';
export type Mode = 'replay' | 'live';

export interface SourceRef {
  system: string;
  endpoint: string;
  url: string;
  event_time_utc: string | null;
  record_id: string | null;
  note: string | null;
}

export interface Timestamps {
  source_event: string | null;
  adapter_received: string | null;
  jev_started: string | null;
  jev_finished: string | null;
  state_published: string | null;
  finance_recomputed: string | null;
}

export interface Weather {
  observed_at_utc: string | null;
  rainfall: number | null;
  track_temperature_c: number | null;
  air_temperature_c: number | null;
  humidity: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
}

export interface DriverState {
  driver_number: number;
  name_acronym: string | null;
  team: string | null;
  position: number | null;
  lap: number | null;
  compound: string | null;
  tyre_age_laps: number | null;
  last_pit_lap: number | null;
  status: 'running' | 'in_pit' | 'stopped_candidate' | 'unknown';
}

export interface ForecastLine {
  sponsor_id: string;
  sponsor_name: string;
  contract_ref: string;
  clause_id: string;
  clause_type: string;
  car: number;
  driver_id: string;
  position: number | null;
  amount_orig_cents: number;
  currency: string;
  fx_rate: string;
  amount_usd_cents: number;
  quote: string;
}

export interface Forecast {
  type: 'if_finished_now' | 'provisional_classification' | 'final_classification';
  status: 'indicative' | 'awaiting_official_classification' | 'verified_final';
  financial_source: 'synthetic';
  currency: 'USD';
  amount_cents: number | null;
  lines: ForecastLine[];
  prize: { constructors_position: number; points: number; prize_table_cents: number; note: string } | null;
  basis: string;
  as_of_utc: string | null;
}

export interface ForecastChange {
  before_cents: number | null;
  after_cents: number | null;
  delta_cents: number | null;
  gained: string[];
  lost: string[];
  text: string;
}

export interface RaceStateUpdate {
  schema_version: number;
  event_id: string;
  source_system: string;
  source_url: string;
  event_time_utc: string;
  observed_at_utc: string;
  session_key: number;
  race_id: string;
  mode: Mode;
  lap: number | null;
  flag_status: string | null;
  weather: Weather;
  driver_states: DriverState[];
  forecast: Forecast;
  forecast_change: ForecastChange | null;
  team_cars: number[];
  timestamps: Timestamps;
  note: string | null;
  truncated?: boolean;
}

export interface JevDecision {
  used: boolean;
  status: 'ok' | 'low_confidence' | 'overridden' | 'unavailable' | 'disabled' | 'invalid_response' | 'budget_exhausted' | 'cached';
  model: string | null;
  route: Route | null;
  route_confidence: number | null;
  route_probabilities: Record<string, number> | null;
  urgency: Urgency | null;
  urgency_score: number | null;
  urgency_confidence: number | null;
  urgency_probabilities: Record<string, number> | null;
  needs_evidence: number | null;
  latency_ms: number | null;
  input_hash: string | null;
  masked_input: Record<string, unknown> | null;
  deterministic_route: Route;
  chosen_route: Route;
  reason: string;
  error: string | null;
}

export interface FinancialImpact {
  status: 'unknown' | 'synthetic_projected_not_booked' | 'pending';
  amount_cents: number | null;
  currency: 'USD';
}

export interface Handoff {
  target: 'cost_cap_agent' | 'revenue_desk' | 'human_review' | 'none';
  status: 'not_requested' | 'requested' | 'acknowledged' | 'assessed' | 'pending';
  requested_at_utc: string | null;
  acknowledged_at_utc: string | null;
  finance_impact_ref: string | null;
}

export interface IncidentSignal {
  schema_version: number;
  incident_id: string;
  version: number;
  type: 'potential_crash' | 'red_flag_unattributed' | 'incident_noted';
  sporting_source_date: string;
  race_id: string;
  lap: number | null;
  driver_number: number | null;
  driver_name: string | null;
  historical_team: string | null;
  driver_attribution: 'none' | 'provisionally_correlated' | 'named_by_race_control' | 'confirmed';
  source_evidence: SourceRef[];
  corroborating_source_url: string | null;
  corroboration_note: string | null;
  sporting_confirmation: 'incident_candidate' | 'needs_confirmation' | 'retired_per_timing' | 'verified_historical_incident';
  scope?: 'own_team' | 'competitor' | 'unknown';
  post_race_reference?: { url: string; publisher: string; claim: string; read_on: string; available: string } | null;
  damage_confirmation: 'none' | 'awaiting_synthetic_garage_report' | 'synthetic_garage_report_received';
  jev: JevDecision;
  urgency: Urgency | null;
  financial_impact: FinancialImpact;
  handoff: Handoff;
  synthetic_financial_world: string;
  event_time_utc: string;
  observed_at_utc: string;
  mode: Mode;
  timestamps: Timestamps;
  message: string;
}

export interface FinanceImpactUpdate {
  schema_version: number;
  incident_id: string;
  financial_status: 'pending' | 'synthetic_projected_not_booked';
  initial_exposure_cents: number | null;
  selected_recovery_cost_cents: number | null;
  forecast_headroom_after_cents: number | null;
  currency: 'USD';
  requires_engineering_approval: boolean | null;
  requires_finance_approval: boolean | null;
  accounting_rule_version: string | null;
  evidence_refs: string[];
  note: string | null;
  received_at_utc: string | null;
}

export interface OfficialDocument {
  title: string;
  url: string | null;
  document_number: string | null;
  kind: string;
  cars: number[];
  likely_outcome: string | null;
  published_at_utc: string;
  actor_run_id: string | null;
}

export interface ResultChangeSignal {
  schema_version: number;
  signal_id: string;
  version: number;
  type: 'provisional' | 'result_at_risk' | 'result_change' | 'result_final';
  race_id: string;
  season: number;
  round: number;
  session: string;
  document: OfficialDocument | null;
  before: Forecast;
  after: Forecast;
  change: ForecastChange;
  jev: JevDecision;
  status: 'provisional' | 'at_risk' | 'provisional_expected_bonus_corrected_awaiting_recognized_revenue_policy_gate' | 'final';
  message: string;
  handoff: Handoff;
  event_time_utc: string;
  observed_at_utc: string;
  mode: Mode;
  timestamps: Timestamps;
}

/** What one place up or down is worth to the team right now, from the contracts (strategy.py). */
export interface PlaceValue {
  car: number;
  driver_id: string;
  position: number | null;
  value_now_cents: number;
  up_one_cents: number;
  down_one_cents: number;
  up_one_text: string;
  down_one_text: string;
}

export interface PitScenario {
  car: number;
  position: number | null;
  pit_loss_s: number;
  pit_loss_basis: string;
  under: string | null;
  cars_passed: number[];
  cars_maybe: number[];
  positions_lost: number;
  rejoin_position: number | null;
  delta_cents: number;
  /** the same stop under a green flag (full pit loss), so the Safety Car discount is visible */
  green_pit_loss_s?: number | null;
  green_positions_lost?: number | null;
  green_delta_cents?: number | null;
  text: string;
}

export interface TyreContext {
  car: number;
  compound: string | null;
  age_laps: number | null;
  stint_lap_start: number | null;
  field_median_age_laps: number | null;
  note: string;
}

/** The money on every strategic lever, as of now. Arithmetic on the timing feed and the contracts; no pace model. */
export interface StrategyAdvice {
  schema_version: number;
  race_id: string;
  version: number;
  as_of_utc: string;
  observed_at_utc: string;
  lap: number | null;
  flag_status: string | null;
  exposure_now_cents: number;
  exposure_at_join_cents: number | null;
  exposure_peak_cents: number | null;
  lost_from_peak_cents: number | null;
  places: PlaceValue[];
  pit: PitScenario[];
  tyres: TyreContext[];
  weather_note: string;
  /** plain-English lines: what a place, a stop, the tyres and the weather are worth right now */
  levers?: string[];
  status: 'indicative';
  financial_source: 'synthetic';
  basis: string;
  timestamps: Timestamps;
}

export type ScenarioKey = 'continue' | 'pit_now' | 'retire' | 'repair_and_rejoin' | 'penalty_5s' | 'penalty_10s' | 'drive_through' | 'disqualified';

export interface IncidentScenario {
  key: ScenarioKey;
  label: string;
  assumption: string;
  feasible?: boolean;
  requires?: string[];
  why?: string;
  position_after: number | null;
  exposure_after_cents: number;
  delta_cents: number;
  lines_lost: string[];
  lines_gained: string[];
  constructors_position_after: number | null;
  prize_delta_cents: number;
}

/** The live finance agent's draft on an incident: a pick among the scenarios code priced, never a booking. */
export interface AdvisorNote {
  used: boolean;
  status: 'pending' | 'ok' | 'disabled' | 'unavailable' | 'refused' | 'error' | 'invalid';
  model: string | null;
  latency_ms: number | null;
  recommended_scenario: string | null;
  headline: string | null;
  rationale: string | null;
  what_we_need: string[];
  confidence: 'low' | 'medium' | 'high' | null;
  error: string | null;
  drafted_at_utc: string | null;
}

/** Accident outcomes priced for one car; the cost-cap side waits for the garage report. */
export interface IncidentPlan {
  schema_version: number;
  incident_id: string;
  version: number;
  race_id: string;
  car: number;
  driver_id: string;
  team_car: boolean;
  scope?: 'own_team' | 'competitor';
  car_status?: string;
  feasibility_note?: string;
  as_of_utc: string;
  observed_at_utc: string;
  lap: number | null;
  flag_status: string | null;
  position_now: number | null;
  exposure_now_cents: number;
  scenarios: IncidentScenario[];
  damage_estimate_cents: number | null;
  cost_cap_note: string;
  advisor: AdvisorNote;
  status: 'indicative';
  financial_source: 'synthetic';
  basis: string;
  timestamps: Timestamps;
}

export interface SinkHealth {
  name: string;
  ok: boolean;
  written: number;
  errors: number;
  last_write_utc: string | null;
  detail: string | null;
}

/** How alive the feed is, measured on the wall clock (health.py, every 5 s while running). */
export interface FeedHealth {
  replay_id: string | null;
  state: string | null;
  mode: Mode;
  now_utc: string;
  race_clock_utc: string | null;
  lap: number | null;
  last_publish_utc: string | null;
  seconds_since_last_publish: number | null;
  publishes_total: number;
  publishes_last_60s: number;
  publishes_per_second_10s: number;
  state_updates: number;
  publish_p95_ms: number | null;
  sinks: SinkHealth[];
  jev: { requests?: number; errors?: number; p50_ms?: number | null; p95_ms?: number | null; mode?: string };
  advisor: string;
  exposure_now_cents: number | null;
  exposure_at_join_cents: number | null;
  exposure_peak_cents: number | null;
  lost_from_peak_cents: number | null;
  incidents: number;
  incident_plans: number;
}

export type CaseState = 'detected' | 'investigating' | 'awaiting_evidence' | 'evaluated' | 'awaiting_approval' | 'authorized' | 'reconciling' | 'closed' | 'rejected';
export type Actor = 'system' | 'jev' | 'financial_analyst' | 'cost_cap_agent' | 'engineering' | 'controller' | 'procurement' | 'reconciliation' | 'person';

export interface CaseStep {
  at_utc: string;
  race_clock_utc: string | null;
  actor: Actor;
  by: string | null;
  action: string;
  detail: string;
  evidence: string[];
  automatic: boolean;
  status: 'done' | 'pending' | 'refused' | 'escalated';
  state_after: CaseState | null;
}

export interface GarageOption {
  key: 'replace' | 'repair';
  label: string;
  cost_cents: number;
  lead_time: string;
  feasible_if: string | null;
}

export interface GarageReport {
  synthetic: boolean;
  source: string;
  reported_at_utc: string;
  car: number;
  parts: { part: string; condition: string }[];
  options: GarageOption[];
  engineer_note: string;
}

export interface CostCapEvaluation {
  treatment: string;
  basis: string;
  headroom_before_cents: number | null;
  headroom_source: string;
  options: { key: string; label: string; cost_cents: number; treatment: string; cap_effect_cents: number; headroom_after_cents: number | null; feasible_if: string | null }[];
  recommended: 'replace' | 'repair' | null;
  avoided_cents: number | null;
  conditions: string[];
  evaluated_at_utc: string;
}

export interface CaseApproval {
  role: 'engineering' | 'controller';
  by: string;
  decision: 'cleared' | 'not_cleared' | 'authorized' | 'rejected';
  reason: string;
  at_utc: string;
}

export interface ProcurementOrder {
  order_id: string;
  option: 'replace' | 'repair';
  amount_cents: number;
  vendor: string;
  authorized_by: string;
  created_at_utc: string;
  status: 'prepared' | 'sent' | 'invoiced' | 'matched' | 'disputed';
  mock: boolean;
}

export interface CaseInvoice {
  invoice_id: string;
  order_id: string | null;
  amount_cents: number;
  received_at_utc: string;
  synthetic: boolean;
  variance_cents: number | null;
  matched: boolean | null;
  note: string;
}

/** A unit of finance work opened by a material racing event (live_racing/cases.py). */
export interface FinanceCase {
  schema_version: number;
  case_id: string;
  version: number;
  incident_id: string;
  race_id: string;
  replay_id: string;
  team: string;
  scope: 'own_team' | 'competitor';
  car: number;
  driver_id: string;
  title: string;
  summary: string;
  state: CaseState;
  owner: string;
  opened_at_utc: string;
  updated_at_utc: string;
  race_clock_utc: string | null;
  exposure_status: 'unknown_until_evidence' | 'projection_only' | 'estimated_from_garage_report' | 'authorized' | 'reconciled' | 'none';
  exposure_cents: number | null;
  exposure_label: string;
  projection_delta_cents: number | null;
  evidence: string[];
  missing_evidence: string[];
  next_action: string;
  permissions: Record<string, boolean>;
  garage_report: GarageReport | null;
  evaluation: CostCapEvaluation | null;
  approvals: CaseApproval[];
  procurement: ProcurementOrder | null;
  invoice: CaseInvoice | null;
  escalation_reason: string | null;
  closed_reason: string | null;
  steps: CaseStep[];
  stages: { key: string; label: string; status: 'done' | 'active' | 'pending' }[];
}

export interface Scorecard {
  generated_at_utc: string;
  how: string;
  headline: Record<string, string | number>;
  jev_routing: { mode: string; cases: number; agree: number | null; accuracy?: number; p50_ms?: number | null; p95_ms?: number | null; rows?: unknown[] };
  contract_calculator: { passed: number; total: number; checks: { check: string; ok: boolean }[] };
  workflow: Record<string, unknown>;
}

export interface ReplayStatus {
  replay_id: string;
  race_id: string;
  mode: Mode;
  state: 'idle' | 'fast_forward' | 'running' | 'paused' | 'finished' | 'stopped' | 'error';
  speed: number | null; // JSON cannot carry Infinity; the API sends null for `inf`
  events_total: number;
  events_done: number;
  clock_utc: string | null;
  lap: number | null;
  jev_mode: string;
  jev_requests: number;
  jev_errors: number;
  incidents: number;
  duplicates_suppressed: number;
  sinks: string[];
  error: string | null;
}

/** One routing decision (`jev_decision` records): the candidate and what Jev, or the fallback, decided. */
export interface JevDecisionRecord {
  at: string;
  lap?: number | null;
  kind: string;
  material: boolean;
  drivers?: number[] | null;
  message: string;
  decision: JevDecision;
  timestamps?: Timestamps;
  incident_id?: string | null;
}

/** `Replay.metrics()` / `ResultReplay.metrics()`: measured on this machine, absent means not measured. */
export interface Metrics {
  replay_id: string;
  state: string;
  events_done: number;
  events_total: number;
  state_updates?: number;
  incidents?: number;
  signals?: number;
  duplicates_suppressed?: number;
  jev: {
    requests: number;
    errors: number;
    cache_hits: number;
    p50_ms: number | null;
    p95_ms: number | null;
    statuses: Record<string, number>;
    mode: string;
    calls_by_candidate_kind: Record<string, number>;
    calls_on_telemetry_ticks?: number;
  };
  publish: { count: number; adapter_received_to_published_p50_ms?: number | null; adapter_received_to_published_p95_ms?: number | null };
  sinks: string[];
}

/** A record as the publisher wrote it to every sink: the envelope around a payload. */
export interface Published<T> {
  kind: string;
  id: string;
  version: number;
  status: string | null;
  published_at_utc: string;
  payload: T;
  seq: number;
}

interface Snapshot {
  replay: ReplayStatus | null;
  race_state: RaceStateUpdate | null;
  incidents: IncidentSignal[];
  result_changes: ResultChangeSignal[];
  jev_decisions: JevDecisionRecord[];
  finance_impacts: FinanceImpactUpdate[];
  metrics: Metrics | null;
  log: string[];
  seq: number;
  strategy?: StrategyAdvice | null;
  incident_plans?: IncidentPlan[];
  feed?: FeedHealth | null;
  cases?: FinanceCase[];
  team?: { id: string; label: string | null } | null;
}

export interface LiveState {
  /** /live/state answered. */
  online: boolean;
  /** the SSE stream is open */
  streaming: boolean;
  replay: ReplayStatus | null;
  /** when the current replay's first status was published; '' until the stream has said */
  replayStartedAt: string;
  race: RaceStateUpdate | null;
  /** every race-state publication of this replay, oldest first */
  states: Published<RaceStateUpdate>[];
  /** state updates of the current replay that carried a forecast change, in order */
  moves: Published<RaceStateUpdate>[];
  /** every IncidentSignal version, in publish order */
  incidents: Published<IncidentSignal>[];
  resultChanges: Published<ResultChangeSignal>[];
  jevDecisions: Published<JevDecisionRecord>[];
  financeImpacts: Published<FinanceImpactUpdate>[];
  /** the latest strategy advice of this replay (null on a document replay or before the first publish) */
  strategy: StrategyAdvice | null;
  /** the strategy versions of this replay at which the money given up since the peak changed, in order */
  strategyMoves: Published<StrategyAdvice>[];
  /** the latest incident plan per incident, in first-publish order */
  plans: Published<IncidentPlan>[];
  /** the latest feed health, and the browser's clock when it arrived (so the age can tick between polls) */
  feed: FeedHealth | null;
  feedAt: number;
  /** every finance case of this replay, latest version each, oldest first */
  cases: Published<FinanceCase>[];
  /** which constructor the customer mirrors on the current replay */
  team: { id: string; label: string | null } | null;
  /** the measured scorecard (scripts/live_scorecard.py), when it exists */
  scorecard: Scorecard | null;
  metrics: Metrics | null;
  log: string[];
  busy: string | null;
  error: string | null;
  /** start any replay: the API's StartReplay body */
  start: (body: Record<string, unknown>) => Promise<void>;
  /** a person's decision on a case; the API refuses agents and self-approval */
  approve: (caseId: string, role: 'engineering' | 'controller', by: string, decision: string, reason?: string) => Promise<string | null>;
  garageReport: (caseId: string) => Promise<string | null>;
  sendInvoice: (caseId: string, amountCents?: number) => Promise<string | null>;
  startBrazil: (pauseAtLap: number | null) => Promise<void>;
  startSpa: () => Promise<void>;
  /** Stop whatever is on the feed, then start this race. Switching is allowed mid-replay. */
  playRace: (raceId: string) => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
}

export const BRAZIL = '2024_sao_paulo_gp';
export const SPA = '2024_belgian_gp';
export const BRAZIL_WINDOW = { from_lap: 28, to_lap: 34, speed: 20 };
export const SPA_SPEED = 120;

const KINDS = ['race_state', 'incident_signal', 'jev_decision', 'finance_impact', 'result_change', 'replay_status', 'strategy_advice', 'incident_plan', 'feed_health', 'finance_case'] as const;

interface Store {
  replay: ReplayStatus | null;
  race: RaceStateUpdate | null;
  /** race-state publications of this replay, in arrival order, so the race desk can scrub the feed */
  states: Published<RaceStateUpdate>[];
  moves: Published<RaceStateUpdate>[];
  incidents: Map<string, Published<IncidentSignal>>;
  results: Map<string, Published<ResultChangeSignal>>;
  jev: Map<string, Published<JevDecisionRecord>>;
  impacts: Map<string, Published<FinanceImpactUpdate>>;
  strategy: Published<StrategyAdvice> | null;
  strategyMoves: Published<StrategyAdvice>[];
  plans: Map<string, Published<IncidentPlan>>;
  cases: Map<string, Published<FinanceCase>>;
  feed: Published<FeedHealth> | null;
  feedAt: number;
  lastSeq: number;
  /** when the current replay's first status was published; state updates from before it are another story */
  replayStartedAt: string;
}

/** The stream and the snapshot name the same decision differently; key both by what it is. */
const jevKey = (p: JevDecisionRecord) => `${p.kind}:${p.at}:${p.incident_id ?? ''}`;
const impactKey = (p: FinanceImpactUpdate) => `${p.incident_id}:${p.received_at_utc ?? ''}:${p.financial_status}`;

const empty = (): Store => ({
  replay: null, race: null, states: [], moves: [], incidents: new Map(), results: new Map(), jev: new Map(), impacts: new Map(),
  strategy: null, strategyMoves: [], plans: new Map(), cases: new Map(), feed: null, feedAt: 0, lastSeq: 0, replayStartedAt: '',
});

/** A new replay: the exposure story starts again and the previous race's state is not this one's. */
function newReplay(s: Store, p: ReplayStatus, startedAt: string): void {
  if (s.replay && s.replay.replay_id === p.replay_id) {
    // first seen through the snapshot (no publish time); the stream's status record brings it
    if (!s.replayStartedAt && startedAt) s.replayStartedAt = startedAt;
    return;
  }
  s.moves = [];
  s.race = null;
  s.states = [];
  s.strategy = null;
  s.strategyMoves = [];
  s.replayStartedAt = startedAt;
}

/** The advice is versioned per race; a later publish always wins (a new run starts its versions again). */
function takeStrategy(s: Store, r: Published<StrategyAdvice>): void {
  if (s.strategy && r.published_at_utc < s.strategy.published_at_utc) return;
  s.strategy = r;
  const last = s.strategyMoves[s.strategyMoves.length - 1];
  if (!last || (last.payload.lost_from_peak_cents ?? 0) !== (r.payload.lost_from_peak_cents ?? 0)) s.strategyMoves = [...s.strategyMoves, r];
}

function takePlan(s: Store, r: Published<IncidentPlan>): void {
  const cur = s.plans.get(r.id);
  if (cur && r.published_at_utc < cur.published_at_utc) return;
  s.plans = new Map(s.plans).set(r.id, r);
}

function takeFeed(s: Store, r: Published<FeedHealth>): void {
  if (s.feed && r.payload.now_utc < s.feed.payload.now_utc) return;
  s.feed = r;
  s.feedAt = Date.now();
}

function rememberState(s: Store, rec: Published<RaceStateUpdate>): void {
  if (s.states.some((x) => x.payload.event_id === rec.payload.event_id)) return;
  const states = [...s.states, rec];
  s.states = states.length > 800 ? states.slice(-800) : states;
}

const publishedAt = (r: RaceStateUpdate | null) => r?.timestamps?.state_published ?? r?.observed_at_utc ?? '';

const newerReplay = (cur: ReplayStatus | null, next: ReplayStatus) =>
  !cur || cur.replay_id !== next.replay_id || next.events_done > cur.events_done || next.state !== cur.state;

/** Folds one published record into the store, in place (the caller copies first). */
function fold(s: Store, r: Published<unknown>): void {
  s.lastSeq = Math.max(s.lastSeq, r.seq ?? 0);
  switch (r.kind) {
    case 'replay_status': {
      const p = r.payload as ReplayStatus;
      // The replay we just replaced still publishes one last "stopped" record. Its id differs and
      // its sequence is newer, so without this it would wipe the race that just started.
      if (s.replay && s.replay.replay_id !== p.replay_id && (p.state === 'stopped' || p.state === 'error')) break;
      newReplay(s, p, r.published_at_utc);
      if (newerReplay(s.replay, p)) s.replay = p;
      break;
    }
    case 'race_state': {
      const p = r.payload as RaceStateUpdate;
      if (r.published_at_utc < s.replayStartedAt) break; // an earlier replay's state, still in the stream's buffer
      if (!s.race || publishedAt(p) >= publishedAt(s.race)) s.race = p;
      rememberState(s, r as Published<RaceStateUpdate>);
      const ch = p.forecast_change;
      if (ch && ch.text && !s.moves.some((m) => m.payload.forecast_change?.text === ch.text && m.payload.forecast.as_of_utc === p.forecast.as_of_utc)) {
        s.moves = [...s.moves, r as Published<RaceStateUpdate>];
      }
      break;
    }
    case 'incident_signal':
      s.incidents = new Map(s.incidents).set(`${r.id}#${r.version}`, r as Published<IncidentSignal>);
      break;
    case 'result_change':
      s.results = new Map(s.results).set(`${r.id}#${r.version}`, r as Published<ResultChangeSignal>);
      break;
    case 'jev_decision':
      s.jev = new Map(s.jev).set(jevKey(r.payload as JevDecisionRecord), r as Published<JevDecisionRecord>);
      break;
    case 'finance_impact':
      s.impacts = new Map(s.impacts).set(impactKey(r.payload as FinanceImpactUpdate), r as Published<FinanceImpactUpdate>);
      break;
    case 'strategy_advice':
      if (r.published_at_utc < s.replayStartedAt) break;
      takeStrategy(s, r as Published<StrategyAdvice>);
      break;
    case 'incident_plan':
      takePlan(s, r as Published<IncidentPlan>);
      break;
    case 'finance_case': {
      const cur = s.cases.get(r.id);
      if (!cur || r.version >= cur.version) s.cases = new Map(s.cases).set(r.id, r as Published<FinanceCase>);
      break;
    }
    case 'feed_health':
      takeFeed(s, r as Published<FeedHealth>);
      break;
  }
}

/** The snapshot has only the latest version of each record; it fills whatever the stream has not sent. */
function seed(s: Store, snap: Snapshot): void {
  const seedSeq = -1; // unknown position in the stream; stream records always win
  if (snap.replay) {
    newReplay(s, snap.replay, s.replayStartedAt); // the snapshot carries no publish time; the stream's status record sets it
    if (newerReplay(s.replay, snap.replay)) s.replay = snap.replay;
  }
  if (snap.race_state && (!s.race || publishedAt(snap.race_state) >= publishedAt(s.race))) {
    s.race = snap.race_state;
    rememberState(s, {
      kind: 'race_state',
      id: snap.race_state.race_id,
      version: 1,
      status: snap.race_state.flag_status,
      published_at_utc: publishedAt(snap.race_state),
      payload: snap.race_state,
      seq: seedSeq,
    });
  }
  for (const p of snap.incidents) {
    const k = `${p.incident_id}#${p.version}`;
    if (!s.incidents.has(k)) {
      s.incidents = new Map(s.incidents).set(k, { kind: 'incident_signal', id: p.incident_id, version: p.version, status: p.sporting_confirmation, published_at_utc: p.timestamps?.state_published ?? p.observed_at_utc, payload: p, seq: seedSeq });
    }
  }
  for (const p of snap.result_changes) {
    const k = `${p.signal_id}#${p.version}`;
    if (!s.results.has(k)) {
      s.results = new Map(s.results).set(k, { kind: 'result_change', id: p.signal_id, version: p.version, status: p.status, published_at_utc: p.timestamps?.state_published ?? p.observed_at_utc, payload: p, seq: seedSeq });
    }
  }
  for (const p of snap.jev_decisions) {
    const k = jevKey(p);
    if (!s.jev.has(k)) s.jev = new Map(s.jev).set(k, { kind: 'jev_decision', id: k, version: 1, status: p.decision.status, published_at_utc: p.timestamps?.state_published ?? p.at, payload: p, seq: seedSeq });
  }
  for (const p of snap.finance_impacts) {
    const k = impactKey(p);
    if (!s.impacts.has(k)) s.impacts = new Map(s.impacts).set(k, { kind: 'finance_impact', id: k, version: 1, status: p.financial_status, published_at_utc: p.received_at_utc ?? '', payload: p, seq: seedSeq });
  }
  const at = (t: Timestamps | undefined, fallback: string) => t?.state_published ?? fallback;
  if (snap.strategy && (!s.strategy || snap.strategy.version > s.strategy.payload.version || at(snap.strategy.timestamps, '') > s.strategy.published_at_utc)) {
    takeStrategy(s, { kind: 'strategy_advice', id: snap.strategy.race_id, version: snap.strategy.version, status: snap.strategy.flag_status, published_at_utc: at(snap.strategy.timestamps, snap.strategy.observed_at_utc), payload: snap.strategy, seq: seedSeq });
  }
  for (const p of snap.incident_plans ?? []) {
    const cur = s.plans.get(p.incident_id);
    if (!cur || p.version > cur.payload.version) {
      takePlan(s, { kind: 'incident_plan', id: p.incident_id, version: p.version, status: p.advisor.status, published_at_utc: at(p.timestamps, p.observed_at_utc), payload: p, seq: seedSeq });
    }
  }
  if (snap.feed) takeFeed(s, { kind: 'feed_health', id: snap.feed.replay_id ?? '', version: 1, status: snap.feed.state, published_at_utc: snap.feed.now_utc, payload: snap.feed, seq: seedSeq });
  for (const c of snap.cases ?? []) {
    const cur = s.cases.get(c.case_id);
    if (!cur || c.version >= cur.version) s.cases = new Map(s.cases).set(c.case_id, { kind: 'finance_case', id: c.case_id, version: c.version, status: c.state, published_at_utc: c.updated_at_utc, payload: c, seq: seedSeq });
  }
}

const bySeq = <T,>(a: Published<T>, b: Published<T>) => (a.seq < 0 || b.seq < 0 ? a.published_at_utc.localeCompare(b.published_at_utc) : a.seq - b.seq);

/** Python's json writes `Infinity` for a replay at `--speed inf`; JSON.parse refuses it. */
function parseLoose<T>(text: string): T {
  return JSON.parse(text.replace(/:\s*-?Infinity\b/g, ':null').replace(/:\s*NaN\b/g, ':null')) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { detail?: string }).detail ?? `HTTP ${r.status}`);
  return data as T;
}

const Ctx = createContext<LiveState | null>(null);

// The event stream holds a connection open for as long as the page lives. Browsers allow six per
// origin over HTTP/1.1, and every dashboard tab proxied through the dev server was spending one of
// the dev server's six, so page loads queued behind the streams. The stream therefore goes to the
// live API's own origin (CORS is open there); the short polls stay proxied. A hidden tab closes its
// stream and reopens it when shown, so background tabs cost nothing.
const LIVE_API_ORIGIN: string = (import.meta.env.VITE_LIVE_API as string | undefined) ?? 'http://localhost:8020';

export function LiveProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [store, setStore] = useState<Store>(empty);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [team, setTeam] = useState<{ id: string; label: string | null } | null>(null);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0); // bumped to reconnect the stream from seq 0
  const pending = useRef<Published<unknown>[]>([]);
  const seqRef = useRef(0);
  const busyRef = useRef(false);

  // ---------------------------------------------------------------- the snapshot, polled
  const poll = useCallback(async () => {
    try {
      const r = await fetch('/live/state', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const snap = parseLoose<Snapshot>(await r.text());
      setOnline(true);
      setMetrics(snap.metrics);
      setTeam(snap.team ?? null);
      setLog(snap.log ?? []);
      if (snap.seq < seqRef.current) {
        // the API restarted: its sequence began again, so ours does too
        seqRef.current = 0;
        pending.current = [];
        setStore(empty());
        setGeneration((g) => g + 1);
        return;
      }
      setStore((prev) => {
        const next = { ...prev };
        seed(next, snap);
        return next;
      });
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    void poll();
    const t = window.setInterval(() => void poll(), 1500);
    return () => window.clearInterval(t);
  }, [poll]);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch('/live/scorecard', { cache: 'no-store' });
        if (r.ok) setScorecard((await r.json()) as Scorecard);
      } catch {
        /* no scorecard yet */
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 60000);
    return () => window.clearInterval(t);
  }, []);

  // ---------------------------------------------------------------- every record, streamed
  useEffect(() => {
    let es: EventSource | null = null;
    let timer = 0;
    let live = true;
    const connect = () => {
      if (!live || document.visibilityState === 'hidden') return;
      es = new EventSource(`${LIVE_API_ORIGIN}/live/stream?since=${seqRef.current}`);
      const on = (e: Event) => {
        try {
          pending.current.push(parseLoose<Published<unknown>>((e as MessageEvent<string>).data));
        } catch {
          /* a malformed frame is dropped; the poll fills the gap */
        }
      };
      for (const k of KINDS) es.addEventListener(k, on);
      es.onopen = () => setStreaming(true);
      es.onerror = () => {
        setStreaming(false);
        es?.close();
        timer = window.setTimeout(connect, 2500);
      };
    };
    connect();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        es?.close();
        es = null;
        setStreaming(false);
      } else if (!es) {
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    // the stream can carry ten state updates a second at 20x; fold them in batches
    const flush = window.setInterval(() => {
      if (!pending.current.length) return;
      const batch = pending.current;
      pending.current = [];
      setStore((prev) => {
        const next = { ...prev, moves: prev.moves };
        for (const r of batch) fold(next, r);
        seqRef.current = Math.max(seqRef.current, next.lastSeq);
        return next;
      });
    }, 200);
    return () => {
      live = false;
      es?.close();
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearTimeout(timer);
      window.clearInterval(flush);
    };
  }, [generation]);

  // ---------------------------------------------------------------- controls
  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(label);
      setError(null);
      try {
        await fn();
        await poll();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [poll]
  );

  const value = useMemo<LiveState>(() => {
    const incidents = [...store.incidents.values()].sort(bySeq);
    const resultChanges = [...store.results.values()].sort(bySeq);
    const jevDecisions = [...store.jev.values()].sort(bySeq);
    const financeImpacts = [...store.impacts.values()].sort(bySeq);
    const states = [...store.states].sort((a, b) => a.payload.event_time_utc.localeCompare(b.payload.event_time_utc) || a.seq - b.seq);
    const plans = [...store.plans.values()].sort((a, b) => a.payload.as_of_utc.localeCompare(b.payload.as_of_utc) || a.published_at_utc.localeCompare(b.published_at_utc));
    const cases = [...store.cases.values()].sort((a, b) => a.payload.opened_at_utc.localeCompare(b.payload.opened_at_utc));
    const decide = async (path: string, body: unknown): Promise<string | null> => {
      try {
        await post(path, body);
        await poll();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    return {
      online, streaming, replay: store.replay, replayStartedAt: store.replayStartedAt, race: store.race, states, moves: store.moves, incidents, resultChanges, jevDecisions, financeImpacts,
      strategy: store.strategy?.payload ?? null, strategyMoves: store.strategyMoves, plans, cases, team, scorecard, feed: store.feed?.payload ?? null, feedAt: store.feedAt, metrics, log, busy, error,
      start: (body) => act('Starting the replay', () => post('/live/replay', body)),
      approve: (caseId, role, by, decision, reason = '') => decide(`/live/cases/${encodeURIComponent(caseId)}/approve`, { role, by, decision, reason }),
      garageReport: (caseId) => decide(`/live/cases/${encodeURIComponent(caseId)}/garage-report`, null),
      sendInvoice: (caseId, amountCents) => decide(`/live/cases/${encodeURIComponent(caseId)}/invoice`, amountCents === undefined ? null : { amount_cents: amountCents }),
      startBrazil: (pauseAtLap) =>
        act('Starting the São Paulo replay', () => post('/live/replay', { race_id: BRAZIL, ...BRAZIL_WINDOW, pause_at_lap: pauseAtLap })),
      startSpa: () => act('Starting the Spa replay', () => post('/live/replay', { race_id: SPA, speed: SPA_SPEED })),
      playRace: (raceId) =>
        act(raceId === SPA ? 'Starting the Spa replay' : 'Starting the São Paulo replay', async () => {
          await post('/live/replay/stop', {}).catch(() => undefined);
          const body = raceId === SPA ? { race_id: SPA, speed: SPA_SPEED } : { race_id: BRAZIL, ...BRAZIL_WINDOW, pause_at_lap: null };
          await post('/live/replay', body);
        }),
      resume: () => act('Resuming', () => post('/live/replay/resume', {})),
      stop: () => act('Stopping', () => post('/live/replay/stop', {})),
    };
  }, [online, streaming, store, metrics, team, scorecard, log, busy, error, act, poll]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLive outside LiveProvider');
  return v;
}
