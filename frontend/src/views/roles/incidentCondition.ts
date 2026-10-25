import { PRICES, SEVERITY_TEMPLATES, USD_PER_GBP, type CostId } from '../../blueprint/catalog';
import { LIKELY, POSSIBLE, liveCondition, type CarCondition, type CarStatus, type PartReading } from '../../blueprint/condition';
import type { CarState, RaceActions, RaceEffects, RaceForecasts, RaceIncidents } from '../../module_bindings/types';
import { parse } from '../raceday/shared';

// The blueprint's CarCondition read from the incident belief (race_incidents.belief_json, and each version of it in
// race_beliefs), so the car lights up the moment telemetry sees the stop and moves as the belief changes. In order:
//   1. the belief's own per-part P(damaged) (Jev's, pooled with the impact speed);
//   2. no parts yet but a severity distribution: the price book's severity templates, weighted by P(severity);
//   3. no belief yet: the blueprint's own reading (forecast, Jev on the booking, booked severity), via liveCondition.
// A forecast's prices are kept on the parts it priced; whether each part is in spares comes from the incident's
// spares_reserve actions (at track or at Grove: in stock; to be made: not).

export interface Belief {
  severity?: Record<string, number>;
  parts?: Record<string, number>;
  severity_by?: string;
  impact_kph?: number;
  signature?: 'stop' | 'freeze' | string;
  decel_g?: number;
  lap?: number;
  where?: string;
  turn?: string;
  session_type?: string;
  out_of_session?: boolean;
  dns?: boolean;
  laps_after?: number;
  corroborated_after_s?: number;
  assessed_as?: string;
  assessed_by?: string;
  missed_session?: number;
}

export const readBelief = (json: string): Belief => parse<Belief>(json, {});

export const SEVERITIES = ['heavy', 'moderate', 'light', 'none'] as const;

/** The likeliest severity and its probability, or null when the belief has none. */
export function topSeverity(b: Belief): { name: string; p: number } | null {
  const sev = b.severity ?? {};
  let best: { name: string; p: number } | null = null;
  for (const [name, p] of Object.entries(sev)) if (typeof p === 'number' && (!best || p > best.p)) best = { name, p };
  return best && best.p > 0 ? best : null;
}

/** part -> P(damaged), raw keys as the desk writes them (chassis and chassis_repair apart). */
export function beliefParts(b: Belief): { raw: Record<string, number>; from: 'parts' | 'severity' | null } {
  const parts = Object.fromEntries(Object.entries(b.parts ?? {}).filter(([, p]) => typeof p === 'number' && p > 0));
  if (Object.keys(parts).length) return { raw: parts, from: 'parts' };
  const sev = b.severity ?? {};
  const raw: Record<string, number> = {};
  for (const [name, ps] of Object.entries(sev)) {
    for (const [k, p] of SEVERITY_TEMPLATES[name] ?? []) raw[k] = (raw[k] ?? 0) + ps * p;
  }
  return Object.keys(raw).length ? { raw, from: 'severity' } : { raw: {}, from: null };
}

const gbpCents = (g: number) => Math.round(g * USD_PER_GBP * 100);

/** condition.ts's fold: price-book lines only; the tub is replaced or repaired, keep the likelier and say which. */
function fold(raw: Record<string, number>): Partial<Record<CostId, PartReading>> {
  const out: Partial<Record<CostId, PartReading>> = {};
  for (const [k, p] of Object.entries(raw)) {
    if (k === 'chassis_repair') continue;
    if (k in PRICES) out[k as CostId] = { p: Math.min(1, p) };
  }
  const rep = raw.chassis_repair ?? 0;
  const rpl = raw.chassis ?? 0;
  if (rep > 0 || rpl > 0) out.chassis = { p: Math.min(1, Math.max(rep, rpl)), repair: rep > rpl };
  return out;
}

/** condition.ts's expected repair: P times the price-book mid, summed; low counts the likely parts, high the possible. */
function expectedOf(parts: Partial<Record<CostId, PartReading>>): CarCondition['expected'] {
  let low = 0;
  let mid = 0;
  let high = 0;
  let any = false;
  for (const [k, r] of Object.entries(parts) as [CostId, PartReading][]) {
    if (!r || r.p <= 0.02) continue;
    any = true;
    const price = r.repair ? PRICES.chassis_repair : PRICES[k];
    const l = r.low ?? gbpCents(price.low);
    const m = r.mid ?? gbpCents(price.mid);
    const h = r.high ?? gbpCents(price.high);
    mid += r.p * m;
    if (r.p >= LIKELY) low += l;
    if (r.p >= POSSIBLE) high += h;
  }
  return any ? { low: Math.round(low), mid: Math.round(mid), high: Math.round(high) } : null;
}

export type SpareSource = 'at_track' | 'factory' | 'make';

export interface SpareReading {
  source: SpareSource;
  /** the reservation was released (the belief dropped below the line) */
  released: boolean;
  atTrackAfter: number | null;
  factoryAfter: number | null;
  status: string;
}

/** part -> where its replacement comes from, from the incident's spares_reserve actions. */
export function sparesFor(actions: readonly RaceActions[], incidentKey: string): Partial<Record<CostId, SpareReading>> {
  const out: Partial<Record<CostId, SpareReading>> = {};
  for (const a of actions) {
    if (a.incidentKey !== incidentKey || a.kind !== 'spares_reserve') continue;
    const d = parse<{ part?: string; source?: SpareSource; at_track_after?: number; factory_after?: number }>(a.detailJson, {});
    const part = (d.part === 'chassis_repair' ? 'chassis' : d.part) as CostId | undefined;
    if (!part || !(part in PRICES)) continue;
    const reading: SpareReading = {
      source: d.source ?? 'at_track',
      released: a.status === 'cancelled' || a.status === 'rejected',
      atTrackAfter: typeof d.at_track_after === 'number' ? d.at_track_after : null,
      factoryAfter: typeof d.factory_after === 'number' ? d.factory_after : null,
      status: a.status,
    };
    // a live reservation wins over a released one for the same part
    if (!out[part] || (out[part]!.released && !reading.released)) out[part] = reading;
  }
  return out;
}

export interface IncidentInput {
  incident: RaceIncidents;
  /** the version to draw: the incident row's own (live) unless a history row was picked */
  beliefJson: string;
  version: number;
  status: string;
  at: string;
}

/**
 * The car's condition for the pit wall: from the incident belief when there is one, else the blueprint's own sources.
 * `car` is the car as the pit wall reads it now (car_state when it belongs to this session, else the tape).
 */
export function incidentCondition(
  car: CarState,
  status: CarStatus,
  input: IncidentInput | null,
  effects: readonly RaceEffects[],
  forecasts: readonly RaceForecasts[],
  actions: readonly RaceActions[],
): CarCondition {
  const fallback = liveCondition(car, effects, forecasts);
  fallback.status = status;
  if (!input) return fallback;

  const b = readBelief(input.beliefJson);
  const { raw, from } = beliefParts(b);
  if (!from) {
    // the stop is seen but nothing is read yet: the blueprint's sources, else "assessing" (every part drawn unknown)
    if (fallback.source !== 'none') return fallback;
    return { ...fallback, source: 'none', label: `Belief v${input.version}, ${input.status}: parts not read yet`, at: input.at, severity: null, parts: {}, expected: null };
  }

  const parts = fold(raw);
  // a forecast that priced a part keeps its price; spares from the incident's reservations
  if (fallback.source === 'forecast') {
    for (const [k, r] of Object.entries(fallback.parts) as [CostId, PartReading][]) {
      const mine = parts[k];
      if (mine && r.mid !== undefined && !!mine.repair === !!r.repair) Object.assign(mine, { low: r.low, mid: r.mid, high: r.high });
    }
  }
  const spares = sparesFor(actions, input.incident.incidentKey);
  for (const [k, s] of Object.entries(spares) as [CostId, SpareReading][]) {
    const r = parts[k];
    if (r && !s.released) r.inSpares = s.source !== 'make';
  }

  const top = topSeverity(b);
  const label = `Belief v${input.version}, ${input.status}${from === 'severity' ? ' (severity template)' : ''}`;
  return {
    ...fallback,
    source: from === 'parts' ? 'jev' : 'template',
    label,
    at: input.at,
    severity: b.assessed_as ?? top?.name ?? null,
    parts,
    expected: expectedOf(parts),
    status,
  };
}

/** A car repaired since its last incident: every part nominal, and the drawing says why. */
export function repairedCondition(car: CarState, status: CarStatus, effects: readonly RaceEffects[], forecasts: readonly RaceForecasts[], since: string): CarCondition {
  const c = liveCondition(car, effects, forecasts);
  return { ...c, source: 'none', label: `Repaired: running again since ${since}`, at: null, severity: null, parts: {}, expected: null, status };
}
