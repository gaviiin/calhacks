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
  sporting_confirmation: 'incident_candidate' | 'needs_confirmation' | 'verified_historical_incident';
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
}

export interface LiveState {
  /** /live/state answered. */
  online: boolean;
  /** the SSE stream is open */
  streaming: boolean;
  replay: ReplayStatus | null;
  race: RaceStateUpdate | null;
  /** state updates of the current replay that carried a forecast change, in order */
  moves: Published<RaceStateUpdate>[];
  /** every IncidentSignal version, in publish order */
  incidents: Published<IncidentSignal>[];
  resultChanges: Published<ResultChangeSignal>[];
  jevDecisions: Published<JevDecisionRecord>[];
  financeImpacts: Published<FinanceImpactUpdate>[];
  metrics: Metrics | null;
  log: string[];
  busy: string | null;
  error: string | null;
  startBrazil: (pauseAtLap: number | null) => Promise<void>;
  startSpa: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
}

export const BRAZIL = '2024_sao_paulo_gp';
export const SPA = '2024_belgian_gp';
export const BRAZIL_WINDOW = { from_lap: 28, to_lap: 34, speed: 20 };
export const SPA_SPEED = 120;

const KINDS = ['race_state', 'incident_signal', 'jev_decision', 'finance_impact', 'result_change', 'replay_status'] as const;

interface Store {
  replay: ReplayStatus | null;
  race: RaceStateUpdate | null;
  moves: Published<RaceStateUpdate>[];
  incidents: Map<string, Published<IncidentSignal>>;
  results: Map<string, Published<ResultChangeSignal>>;
  jev: Map<string, Published<JevDecisionRecord>>;
  impacts: Map<string, Published<FinanceImpactUpdate>>;
  lastSeq: number;
}

const empty = (): Store => ({ replay: null, race: null, moves: [], incidents: new Map(), results: new Map(), jev: new Map(), impacts: new Map(), lastSeq: 0 });

const publishedAt = (r: RaceStateUpdate | null) => r?.timestamps?.state_published ?? r?.observed_at_utc ?? '';

const newerReplay = (cur: ReplayStatus | null, next: ReplayStatus) =>
  !cur || cur.replay_id !== next.replay_id || next.events_done > cur.events_done || next.state !== cur.state;

/** Folds one published record into the store, in place (the caller copies first). */
function fold(s: Store, r: Published<unknown>): void {
  s.lastSeq = Math.max(s.lastSeq, r.seq ?? 0);
  switch (r.kind) {
    case 'replay_status': {
      const p = r.payload as ReplayStatus;
      if (s.replay && s.replay.replay_id !== p.replay_id) {
        // a new replay: the exposure story starts again and the previous race's state is not this one's
        s.moves = [];
        s.race = null;
      }
      if (newerReplay(s.replay, p)) s.replay = p;
      break;
    }
    case 'race_state': {
      const p = r.payload as RaceStateUpdate;
      if (!s.race || publishedAt(p) >= publishedAt(s.race)) s.race = p;
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
      s.jev = new Map(s.jev).set(r.id, r as Published<JevDecisionRecord>);
      break;
    case 'finance_impact':
      s.impacts = new Map(s.impacts).set(r.id, r as Published<FinanceImpactUpdate>);
      break;
  }
}

/** The snapshot has only the latest version of each record; it fills whatever the stream has not sent. */
function seed(s: Store, snap: Snapshot): void {
  if (snap.replay && newerReplay(s.replay, snap.replay)) s.replay = snap.replay;
  if (snap.race_state && (!s.race || publishedAt(snap.race_state) >= publishedAt(s.race))) s.race = snap.race_state;
  const seedSeq = -1; // unknown position in the stream; stream records always win
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
    const k = `${p.kind}:${p.at}`;
    if (!s.jev.has(k)) s.jev = new Map(s.jev).set(k, { kind: 'jev_decision', id: k, version: 1, status: p.decision.status, published_at_utc: p.timestamps?.state_published ?? p.at, payload: p, seq: seedSeq });
  }
  for (const [i, p] of snap.finance_impacts.entries()) {
    const k = `${p.incident_id}:${i}`;
    if (!s.impacts.has(k)) s.impacts = new Map(s.impacts).set(k, { kind: 'finance_impact', id: k, version: 1, status: p.financial_status, published_at_utc: p.received_at_utc ?? '', payload: p, seq: seedSeq });
  }
}

const bySeq = <T,>(a: Published<T>, b: Published<T>) => a.seq - b.seq || a.published_at_utc.localeCompare(b.published_at_utc);

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

export function LiveProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [store, setStore] = useState<Store>(empty);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0); // bumped to reconnect the stream from seq 0
  const pending = useRef<Published<unknown>[]>([]);
  const seqRef = useRef(0);

  // ---------------------------------------------------------------- the snapshot, polled
  const poll = useCallback(async () => {
    try {
      const r = await fetch('/live/state', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const snap = parseLoose<Snapshot>(await r.text());
      setOnline(true);
      setMetrics(snap.metrics);
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

  // ---------------------------------------------------------------- every record, streamed
  useEffect(() => {
    let es: EventSource | null = null;
    let timer = 0;
    let live = true;
    const connect = () => {
      if (!live) return;
      es = new EventSource(`/live/stream?since=${seqRef.current}`);
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
      window.clearTimeout(timer);
      window.clearInterval(flush);
    };
  }, [generation]);

  // ---------------------------------------------------------------- controls
  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label);
      setError(null);
      try {
        await fn();
        await poll();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
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
    return {
      online, streaming, replay: store.replay, race: store.race, moves: store.moves, incidents, resultChanges, jevDecisions, financeImpacts, metrics, log, busy, error,
      startBrazil: (pauseAtLap) =>
        act('Starting the São Paulo replay', () => post('/live/replay', { race_id: BRAZIL, ...BRAZIL_WINDOW, pause_at_lap: pauseAtLap })),
      startSpa: () => act('Starting the Spa replay', () => post('/live/replay', { race_id: SPA, speed: SPA_SPEED })),
      resume: () => act('Resuming', () => post('/live/replay/resume', {})),
      stop: () => act('Stopping', () => post('/live/replay/stop', {})),
    };
  }, [online, streaming, store, metrics, log, busy, error, act]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLive outside LiveProvider');
  return v;
}
