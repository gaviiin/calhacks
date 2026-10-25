import type {
  DriverState,
  FeedHealth,
  IncidentPlan,
  IncidentSignal,
  JevDecisionRecord,
  LiveState,
  PitScenario,
  Published,
  RaceStateUpdate,
  ResultChangeSignal,
  StrategyAdvice,
} from './live';

// Derivations for the live dashboard: the exposure curve, the conditions (flags, rain, track
// temperature, tyre stints) and the one story of the race in race-time order. Everything here is
// read from the feed's own records; nothing is estimated or invented on the client.

/** The feed's compact money form: $2.74M, $260k, $4,352, −$1.00M. */
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const d = cents / 100;
  const a = Math.abs(d);
  const sign = d < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}

export const signed = (cents: number | null | undefined): string => (cents === null || cents === undefined ? '—' : cents > 0 ? `+${money(cents)}` : cents < 0 ? money(cents) : '$0');
export const clock = (iso: string | null | undefined): string => (iso && iso.length >= 19 ? iso.slice(11, 19) : '—');
export const words = (s: string | null | undefined): string => (s ?? '—').replace(/_/g, ' ');
export const sentence = (s: string): string => s.replace(/^./, (c) => c.toUpperCase());

export const FLAG_WORDS: Record<string, string> = {
  GREEN: 'Green flag',
  VSC: 'Virtual Safety Car',
  VSC_ENDING: 'VSC ending',
  SAFETY_CAR: 'Safety Car',
  SAFETY_CAR_ENDING: 'Safety Car in this lap',
  RED_FLAG: 'Red flag',
  FINISHED: 'Chequered flag',
};
export const flagWord = (f: string | null | undefined): string => (f ? FLAG_WORDS[f] ?? sentence(words(f).toLowerCase()) : 'No flag yet');
export const flagTone = (f: string | null | undefined): 'neutral' | 'ok' | 'hold' | 'alert' =>
  f === 'RED_FLAG' ? 'alert' : f && f !== 'GREEN' && f !== 'FINISHED' ? 'hold' : f ? 'ok' : 'neutral';

export const COMPOUND: Record<string, string> = { SOFT: 'Soft', MEDIUM: 'Medium', HARD: 'Hard', INTERMEDIATE: 'Inter', WET: 'Wet' };
export const compoundWord = (c: string | null | undefined): string => (c ? COMPOUND[c] ?? sentence(words(c).toLowerCase()) : '?');

export const DRIVER_NAMES: Record<number, string> = { 63: 'Russell', 44: 'Hamilton', 43: 'Colapinto', 30: 'Lawson' };
export const driverName = (car: number, d?: DriverState | null): string => DRIVER_NAMES[car] ?? d?.name_acronym ?? `Car ${car}`;

export const ROUTE_WORDS: Record<string, string> = {
  crash_finance: 'Crash finance',
  revenue_change: 'Revenue change',
  race_forecast: 'Forecast refresh',
  human_review: 'A person decides',
  no_action: 'No action',
};
export const KIND_WORDS: Record<string, string> = {
  financial_threshold_crossed: 'Exposure moved',
  race_control_red_flag: 'Red flag',
  driver_stopped: 'Car stopped',
  race_control_incident_noted: 'Incident noted',
  incident_corroborated: 'Crash corroborated',
  weather_change: 'Weather changed',
  race_control_safety_car: 'Safety Car',
  result_document: 'FIA document',
};
export const URGENCY_TONE: Record<string, 'neutral' | 'ok' | 'hold' | 'alert'> = { routine: 'neutral', watch: 'hold', urgent: 'alert', critical: 'alert' };

// ---------------------------------------------------------------- series

export interface Point {
  t: string;
  lap: number | null;
  v: number;
}

export function exposureSeries(states: Published<RaceStateUpdate>[]): Point[] {
  const out: Point[] = [];
  for (const s of states) {
    const v = s.payload.forecast?.amount_cents;
    if (v === null || v === undefined) continue;
    const last = out[out.length - 1];
    if (last && last.v === v && last.lap === s.payload.lap) {
      last.t = s.payload.event_time_utc; // extend the flat stretch
      continue;
    }
    out.push({ t: s.payload.event_time_utc, lap: s.payload.lap, v });
  }
  return out;
}

export function trackTempSeries(states: Published<RaceStateUpdate>[]): Point[] {
  const out: Point[] = [];
  for (const s of states) {
    const w = s.payload.weather;
    if (w?.track_temperature_c === null || w?.track_temperature_c === undefined) continue;
    const last = out[out.length - 1];
    if (last && last.t === w.observed_at_utc) continue;
    out.push({ t: w.observed_at_utc ?? s.payload.event_time_utc, lap: s.payload.lap, v: w.track_temperature_c });
  }
  return out;
}

export interface Segment {
  from: string;
  to: string;
  fromLap: number | null;
  toLap: number | null;
  label: string;
}

export function flagSegments(states: Published<RaceStateUpdate>[]): Segment[] {
  const out: Segment[] = [];
  for (const s of states) {
    const f = s.payload.flag_status ?? 'GREEN';
    const last = out[out.length - 1];
    if (last && last.label === f) {
      last.to = s.payload.event_time_utc;
      last.toLap = s.payload.lap;
    } else {
      out.push({ from: s.payload.event_time_utc, to: s.payload.event_time_utc, fromLap: s.payload.lap, toLap: s.payload.lap, label: f });
    }
  }
  return out;
}

export function rainSegments(states: Published<RaceStateUpdate>[]): Segment[] {
  const out: Segment[] = [];
  for (const s of states) {
    const r = s.payload.weather?.rainfall ? 'rain' : 'dry';
    const last = out[out.length - 1];
    if (last && last.label === r) {
      last.to = s.payload.event_time_utc;
      last.toLap = s.payload.lap;
    } else out.push({ from: s.payload.event_time_utc, to: s.payload.event_time_utc, fromLap: s.payload.lap, toLap: s.payload.lap, label: r });
  }
  return out;
}

export interface Stint {
  car: number;
  compound: string | null;
  fromLap: number | null;
  toLap: number | null;
  ageAtEnd: number | null;
  pitLap: number | null;
}

/** Tyre stints per car, read from the running states: a new stint when the compound or the last pit lap changes. */
export function stints(states: Published<RaceStateUpdate>[], car: number): Stint[] {
  const out: Stint[] = [];
  for (const s of states) {
    const d = s.payload.driver_states.find((x) => x.driver_number === car);
    if (!d) continue;
    const last = out[out.length - 1];
    if (last && last.compound === d.compound && last.pitLap === d.last_pit_lap) {
      last.toLap = d.lap;
      last.ageAtEnd = d.tyre_age_laps;
    } else {
      out.push({ car, compound: d.compound, fromLap: d.lap, toLap: d.lap, ageAtEnd: d.tyre_age_laps, pitLap: d.last_pit_lap });
    }
  }
  return out;
}

/** 0..1 position of a time within [from, to]; clamps. */
export function frac(t: string, from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  const x = Date.parse(t);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.min(1, Math.max(0, (x - a) / (b - a)));
}

// ---------------------------------------------------------------- the story

export type StoryKind = 'money' | 'flag' | 'weather' | 'pit' | 'incident' | 'jev' | 'advisor' | 'result' | 'handoff' | 'strategy';
export type Tone = 'neutral' | 'ok' | 'hold' | 'alert';

export interface StoryItem {
  key: string;
  t: string;
  lap: number | null;
  kind: StoryKind;
  title: string;
  detail?: string;
  delta?: number | null;
  tone: Tone;
  meta?: string;
}

const teamCar = (race: RaceStateUpdate | null, car: number) => (race?.team_cars ?? [63, 44]).includes(car);

export function buildStory(live: Pick<LiveState, 'states' | 'moves' | 'incidents' | 'jevDecisions' | 'plans' | 'resultChanges' | 'strategyMoves' | 'race'>): StoryItem[] {
  const items: StoryItem[] = [];
  const race = live.race;

  for (const m of live.moves) {
    const ch = m.payload.forecast_change;
    if (!ch) continue;
    const parts: string[] = [];
    if (ch.lost.length) parts.push(`Lost ${ch.lost.join('; ')}`);
    if (ch.gained.length) parts.push(`Gained ${ch.gained.join('; ')}`);
    items.push({
      key: `money:${m.payload.event_id}`,
      t: m.payload.event_time_utc,
      lap: m.payload.lap,
      kind: 'money',
      title: `Exposure ${money(ch.before_cents)} → ${money(ch.after_cents)}`,
      detail: parts.join('. '),
      delta: ch.delta_cents,
      tone: (ch.delta_cents ?? 0) < 0 ? 'alert' : (ch.delta_cents ?? 0) > 0 ? 'ok' : 'neutral',
    });
  }

  // conditions, from consecutive states
  let flag: string | null | undefined;
  let rain: number | null | undefined;
  const pits = new Map<number, number | null>();
  for (const s of live.states) {
    const p = s.payload;
    if (flag !== undefined && p.flag_status !== flag) {
      items.push({ key: `flag:${p.event_id}`, t: p.event_time_utc, lap: p.lap, kind: 'flag', title: flagWord(p.flag_status), tone: flagTone(p.flag_status),
        detail: p.flag_status === 'RED_FLAG' ? 'Race suspended: repairs and tyre changes are free of track position.' : p.flag_status === 'SAFETY_CAR' ? 'Field bunched: a stop costs about half the track position.' : undefined });
    }
    flag = p.flag_status;
    const r = p.weather?.rainfall;
    if (rain !== undefined && r !== undefined && r !== null && r !== rain) {
      items.push({ key: `rain:${p.event_id}`, t: p.weather.observed_at_utc ?? p.event_time_utc, lap: p.lap, kind: 'weather', title: r ? 'Rain started' : 'Rain stopped',
        detail: `Track ${p.weather.track_temperature_c ?? '?'}°C. A measurement at the sensor, not a forecast.`, tone: 'hold' });
    }
    if (r !== undefined && r !== null) rain = r;
    for (const d of p.driver_states) {
      if (!teamCar(race, d.driver_number)) continue;
      const prev = pits.get(d.driver_number);
      if (prev !== undefined && d.last_pit_lap !== prev && d.last_pit_lap !== null) {
        items.push({ key: `pit:${d.driver_number}:${d.last_pit_lap}`, t: p.event_time_utc, lap: p.lap, kind: 'pit', title: `${driverName(d.driver_number, d)} pits (lap ${d.last_pit_lap})`,
          detail: `${compoundWord(d.compound)} tyres on; rejoins P${d.position ?? '?'}.`, tone: 'neutral' });
      }
      pits.set(d.driver_number, d.last_pit_lap);
    }
  }

  for (const j of live.jevDecisions) {
    const d = j.payload.decision;
    const said = d.route ? `${ROUTE_WORDS[d.route] ?? words(d.route)}${d.route_confidence !== null ? ` at ${(d.route_confidence * 100).toFixed(0)}%` : ''}` : null;
    const how = d.used ? `Jev said ${said}${d.latency_ms !== null ? ` in ${d.latency_ms} ms` : ''}${d.chosen_route !== d.route ? `; code kept ${ROUTE_WORDS[d.chosen_route] ?? d.chosen_route} (${words(d.status)})` : ''}` : `Jev ${words(d.status)}; deterministic route`;
    items.push({ key: `jev:${j.id}:${j.version}`, t: j.payload.at, lap: j.payload.lap ?? null, kind: 'jev', title: `${KIND_WORDS[j.payload.kind] ?? sentence(words(j.payload.kind))} → ${ROUTE_WORDS[d.chosen_route] ?? d.chosen_route}`,
      detail: how, tone: d.urgency ? URGENCY_TONE[d.urgency] : 'neutral', meta: d.urgency ? `urgency ${d.urgency}` : undefined });
  }

  for (const i of live.incidents) {
    const p = i.payload;
    const who = p.driver_number ? `${driverName(p.driver_number)} (car ${p.driver_number})` : 'no driver named';
    const title = p.version === 1 ? `Incident candidate: ${who}` : p.sporting_confirmation === 'verified_historical_incident' && p.handoff.status === 'requested' && p.version >= 3 ? `Crash confirmed: ${who}` : `Incident update v${p.version}: ${who}`;
    items.push({ key: `inc:${p.incident_id}:${p.version}`, t: p.event_time_utc, lap: p.lap, kind: 'incident', title, detail: p.message, tone: p.type === 'potential_crash' ? 'alert' : 'hold',
      meta: `${words(p.driver_attribution)} · ${words(p.sporting_confirmation)}` });
    if (p.handoff.status === 'requested' && p.handoff.target === 'cost_cap_agent' && p.handoff.requested_at_utc) {
      items.push({ key: `handoff:${p.incident_id}:${p.version}`, t: p.event_time_utc, lap: p.lap, kind: 'handoff', title: 'Handed to the cost cap agent', detail: 'Damage and parts cost unknown until the garage report; nothing booked.', tone: 'hold' });
    }
    if (p.handoff.status === 'assessed') {
      items.push({ key: `assessed:${p.incident_id}:${p.version}`, t: p.observed_at_utc, lap: p.lap, kind: 'handoff', title: 'Cost cap desk answered', detail: p.message.split(' Cost cap desk: ')[1] ?? p.message, tone: 'ok', delta: p.financial_impact.amount_cents ? -p.financial_impact.amount_cents : null });
    }
  }

  for (const pl of live.plans) {
    const a = pl.payload.advisor;
    if (a.used && a.headline) {
      items.push({ key: `adv:${pl.id}:${pl.version}`, t: pl.payload.as_of_utc, lap: pl.payload.lap, kind: 'advisor', title: `Advisor: ${a.headline}`, detail: a.rationale ?? undefined,
        tone: a.confidence === 'high' ? 'ok' : 'hold', meta: `${a.recommended_scenario ? words(a.recommended_scenario) : ''} · ${a.confidence ?? ''} confidence · ${a.latency_ms ?? '?'} ms` });
    }
  }

  for (const r of live.resultChanges) {
    const p = r.payload;
    items.push({ key: `res:${p.signal_id}:${p.version}`, t: p.event_time_utc, lap: null, kind: 'result', title: p.document?.title ?? words(p.type), detail: p.message,
      delta: p.change.delta_cents, tone: p.type === 'result_change' ? 'alert' : p.type === 'result_at_risk' ? 'hold' : 'neutral' });
  }

  for (const s of live.strategyMoves.slice(1)) {
    const p = s.payload;
    items.push({ key: `str:${p.version}`, t: p.as_of_utc, lap: p.lap, kind: 'strategy', title: `Given up since the peak: ${money(p.lost_from_peak_cents)}`, detail: (p as Advice).levers?.[0], tone: 'neutral' });
  }

  items.sort((a, b) => b.t.localeCompare(a.t) || b.key.localeCompare(a.key));
  return items;
}

// ---------------------------------------------------------------- feed health

export function feedAge(feed: FeedHealth | null, feedAt: number, now: number): number | null {
  if (!feed) return null;
  const base = feed.seconds_since_last_publish ?? 0;
  return base + Math.max(0, now - feedAt) / 1000;
}

export const sinkByName = (feed: FeedHealth | null, name: string) => feed?.sinks.find((s) => s.name === name) ?? null;

export type Plan = Published<IncidentPlan>;
export type Signal = Published<IncidentSignal>;
export type Decision = Published<JevDecisionRecord>;
export type Result = Published<ResultChangeSignal>;
export type PitPlan = PitScenario & { green_pit_loss_s?: number | null; green_positions_lost?: number | null; green_delta_cents?: number | null };
export type Advice = Omit<StrategyAdvice, 'pit'> & { levers?: string[]; pit: PitPlan[] };
