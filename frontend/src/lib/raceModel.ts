import type { CarState, RaceEffects, RaceEvents, RaceForecasts } from '../module_bindings/types';
import { parseJson, usdShort } from './format';

// Pure readings of the race desk's rows: what an event says in one line, where the track stands,
// what the ledger adds up to. Every payload is JSON written by the replayer; none of it is trusted
// to be well formed.

export const TEAM = 'Williams';
export const DRIVERS: Record<number, string> = { 23: 'ALB', 55: 'SAI' };

type Payload = Record<string, unknown>;

export function payloadOf(e: { payloadJson: string }): Payload {
  const p = parseJson<unknown>(e.payloadJson, null);
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Payload) : {};
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null);
const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** "#23 ALB", "#44", or "field" for a whole-field event. */
export function carLabel(n: number): string {
  if (!n) return 'field';
  const code = DRIVERS[n];
  return code ? `#${n} ${code}` : `#${n}`;
}

export function isTeamCar(n: number): boolean {
  return n in DRIVERS;
}

/** HH:MM:SS UTC from an ISO timestamp, or the raw string when it does not parse. */
export function utcClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(11, 19);
}

export function sortTime(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** 92.456 -> "1:32.456". */
export function lapTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m ? `${m}:${s.toFixed(3).padStart(6, '0')}` : `${s.toFixed(3)}s`;
}

// ---------------------------------------------------------------- track status

export type TrackStatus = 'GREEN' | 'SC' | 'VSC' | 'RED' | 'CHEQUERED' | 'UNKNOWN';

export const TRACK_LABEL: Record<TrackStatus, string> = {
  GREEN: 'Green',
  SC: 'Safety car',
  VSC: 'Virtual safety car',
  RED: 'Red flag',
  CHEQUERED: 'Chequered',
  UNKNOWN: 'No session',
};

/** Reads the newest track-wide control message; sector yellows do not change the track status. */
export function trackStatus(newestFirst: readonly RaceEvents[]): TrackStatus {
  for (const e of newestFirst) {
    const p = payloadOf(e);
    const msg = (str(p.message) ?? '').toUpperCase();
    const flag = (str(p.flag) ?? '').toUpperCase();
    switch (e.kind) {
      case 'red_flag':
        return 'RED';
      case 'safety_car':
        if (p.deployed === false || /ENDING|IN THIS LAP|WITHDRAWN/.test(msg)) return 'GREEN';
        return /VIRTUAL/.test(msg) ? 'VSC' : 'SC';
      case 'vsc':
        return p.deployed === false || /ENDING|WITHDRAWN/.test(msg) ? 'GREEN' : 'VSC';
      case 'flag':
        if (flag === 'CHEQUERED' || /CHEQUERED/.test(msg)) return 'CHEQUERED';
        if (flag === 'RED') return 'RED';
        if (flag === 'GREEN' || flag === 'CLEAR') return 'GREEN';
        break;
      case 'session_status': {
        const s = (str(p.status) ?? msg).toUpperCase();
        if (/FINISHED|ENDS|FINALISED/.test(s)) return 'CHEQUERED';
        if (/STARTED|GREEN/.test(s)) return 'GREEN';
        break;
      }
    }
  }
  return newestFirst.length ? 'GREEN' : 'UNKNOWN';
}

// ---------------------------------------------------------------- event kinds

export interface KindMeta {
  label: string;
  glyph: string;
  /** stronger highlight: money moves or a car is at risk */
  loud?: boolean;
}

export const KINDS: Record<string, KindMeta> = {
  session_status: { label: 'Session', glyph: '◷' },
  flag: { label: 'Flag', glyph: '⚑' },
  safety_car: { label: 'Safety car', glyph: 'SC' },
  vsc: { label: 'VSC', glyph: 'VSC' },
  red_flag: { label: 'Red flag', glyph: '⚑', loud: true },
  position: { label: 'Position', glyph: '⇅' },
  overtake: { label: 'Overtake', glyph: '⇄' },
  pit_stop: { label: 'Pit stop', glyph: 'PIT' },
  stint: { label: 'Stint', glyph: '◍' },
  lap: { label: 'Lap', glyph: '↻' },
  incident: { label: 'Incident', glyph: '!', loud: true },
  penalty: { label: 'Penalty', glyph: '§', loud: true },
  retirement_suspected: { label: 'Stopped?', glyph: '?', loud: true },
  retirement_confirmed: { label: 'Retired', glyph: '✕', loud: true },
  standings: { label: 'Standings', glyph: '≡' },
};

export function kindMeta(kind: string): KindMeta {
  return KINDS[kind] ?? { label: kind.replace(/_/g, ' '), glyph: '·' };
}

const seconds = (v: unknown): string | null => {
  const n = numOf(v);
  return n === null ? null : `${n.toFixed(1)}s`;
};

/** One line that says what the event was, from its payload; never throws. */
export function eventDetail(e: RaceEvents): string {
  const p = payloadOf(e);
  switch (e.kind) {
    case 'position': {
      const from = numOf(p.from);
      const to = numOf(p.to);
      const gained = numOf(p.gained) ?? (from !== null && to !== null ? from - to : null);
      if (to === null) break;
      const delta = gained === null ? '' : ` (${gained > 0 ? '+' : ''}${gained})`;
      return from === null ? `P${to}${delta}` : `P${from} → P${to}${delta}`;
    }
    case 'pit_stop': {
      const parts = [];
      const stop = seconds(p.stop_duration);
      const lane = seconds(p.lane_duration);
      if (stop) parts.push(`stop ${stop}`);
      if (lane) parts.push(`lane ${lane}`);
      const under = str(p.under);
      if (under && !/green|none|false/i.test(under)) parts.push(`under ${under.toUpperCase()}`);
      if (parts.length) return parts.join(', ');
      break;
    }
    case 'stint': {
      const compound = str(p.compound);
      const age = numOf(p.tyre_age_at_start);
      const n = numOf(p.stint_number);
      if (compound) return `${compound.toUpperCase()}${age !== null ? `, age ${age}` : ''}${n !== null ? ` · stint ${n}` : ''}`;
      break;
    }
    case 'lap': {
      const d = numOf(p.lap_duration);
      const n = numOf(p.lap_number);
      if (d !== null) return `${n !== null ? `lap ${n} · ` : ''}${lapTime(d)}`;
      break;
    }
    case 'incident': {
      const msg = str(p.message) ?? str(p.summary);
      const turn = numOf(p.turn);
      if (msg) return turn !== null && !/turn/i.test(msg) ? `${msg} (turn ${turn})` : msg;
      break;
    }
    case 'penalty': {
      const what = str(p.what);
      const reason = str(p.reason);
      if (what || reason) return [what, reason].filter(Boolean).join(' — ');
      break;
    }
    case 'retirement_suspected': {
      const s = str(p.summary);
      const last = numOf(p.last_lap);
      const silent = numOf(p.silent_seconds);
      if (s) return s;
      if (last !== null) return `no lap since lap ${last}${silent !== null ? `, silent ${Math.round(silent)}s` : ''}`;
      break;
    }
    case 'retirement_confirmed': {
      const s = str(p.summary) ?? str(p.message) ?? str(p.reason);
      if (s) return s;
      if (p.dsq === true) return 'disqualified';
      if (p.dns === true) return 'did not start';
      const laps = numOf(p.number_of_laps);
      if (laps !== null) return `classified retired after ${laps} laps`;
      if (p.dnf === true) return 'did not finish';
      break;
    }
    case 'standings': {
      const ps = numOf(p.position_start);
      const pc = numOf(p.position_current);
      const pts0 = numOf(p.points_start);
      const pts1 = numOf(p.points_current);
      const bits = [];
      if (ps !== null && pc !== null) bits.push(ps === pc ? `P${pc} in the constructors'` : `P${ps} → P${pc} in the constructors'`);
      if (pts0 !== null && pts1 !== null) bits.push(pts0 === pts1 ? `${pts1} pts` : `${pts0} → ${pts1} pts`);
      if (bits.length) return bits.join(', ');
      break;
    }
    case 'overtake': {
      const b = numOf(p.overtaken_driver_number) ?? numOf(p.overtaken);
      const pos = numOf(p.position);
      if (b !== null) return `passes ${carLabel(b)}${pos !== null ? ` for P${pos}` : ''}`;
      break;
    }
    case 'session_status': {
      const s = str(p.status) ?? str(p.message);
      if (s) return s;
      break;
    }
  }
  const msg = str(p.message) ?? str(p.summary) ?? str(p.status) ?? str(p.flag);
  if (msg) return msg;
  const pairs = Object.entries(p)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${String(v)}`);
  return pairs.join(' · ') || '—';
}

/** Whether the event touches the team: its own car, or a field-wide message naming the team. */
export function involvesTeam(e: RaceEvents): boolean {
  if (e.teamName === TEAM || isTeamCar(e.driverNumber)) return true;
  const p = payloadOf(e);
  if (p.team_involved === true) return true;
  const cars = Array.isArray(p.car_numbers) ? p.car_numbers : [];
  return cars.some((c) => isTeamCar(numOf(c) ?? -1));
}

// ---------------------------------------------------------------- money

export type Tier = 'policy' | 'jev' | 'claude' | 'code';

export function tierOf(decidedBy: string): Tier {
  if (decidedBy.startsWith('policy')) return 'policy';
  if (decidedBy.startsWith('jev')) return 'jev';
  if (decidedBy.startsWith('claude')) return 'claude';
  return 'code';
}

export interface JevReading {
  ms: number | null;
  severity: string | null;
  topSeverity: { name: string; p: number } | null;
  model: string | null;
  /** part -> P(damaged), as Jev answered it */
  parts: Record<string, number>;
}

export function readJev(jevJson: string): JevReading | null {
  const j = parseJson<unknown>(jevJson, null);
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const pSev = (o.p as Record<string, unknown> | undefined)?.severity;
  let top: JevReading['topSeverity'] = null;
  if (pSev && typeof pSev === 'object') {
    for (const [name, v] of Object.entries(pSev as Record<string, unknown>)) {
      const p = numOf(v);
      if (p !== null && (!top || p > top.p)) top = { name, p };
    }
  }
  const parts: Record<string, number> = {};
  if (o.parts && typeof o.parts === 'object' && !Array.isArray(o.parts)) {
    for (const [name, v] of Object.entries(o.parts as Record<string, unknown>)) {
      const p = numOf(v);
      if (p !== null) parts[name] = p;
    }
  }
  return { ms: numOf(o.ms), severity: str(o.severity), topSeverity: top, model: str(o.model), parts };
}

/** "front wing · floor": the two parts Jev thinks most likely hit (p ≥ 0.5), or null when none. */
export function damageLabel(parts: Record<string, number>, min = 0.5, top = 2): string | null {
  const hit = Object.entries(parts)
    .filter(([, p]) => p >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([name]) => name.replace(/_/g, ' '));
  return hit.length ? hit.join(' · ') : null;
}

/** Mean Jev latency over the effects it decided, and how many decisions that was. */
export function jevStats(effects: readonly RaceEffects[]): { n: number; meanMs: number | null } {
  let n = 0;
  let total = 0;
  for (const e of effects) {
    const ms = readJev(e.jevJson)?.ms;
    if (ms !== null && ms !== undefined && ms > 0) {
      n++;
      total += ms;
    }
  }
  return { n, meanMs: n ? total / n : null };
}

/** The car's drawing state from car_state.status: a stopped car is drawn crashed until it is confirmed out. */
export type CarVisual = 'running' | 'crashed' | 'out';

export function carVisual(status: string): CarVisual {
  switch (status) {
    case 'retired_suspected':
      return 'crashed';
    case 'retired':
      return 'out';
    default:
      return 'running';
  }
}

const CAR_ORDER: Record<string, number> = { running: 0, pit: 0, retired_suspected: 1, retired: 2 };

/** The field by position; cars that have stopped go to the back, confirmed retirements last. */
export function runningOrder(cars: readonly CarState[]): CarState[] {
  return cars
    .slice()
    .sort((a, b) => (CAR_ORDER[a.status] ?? 0) - (CAR_ORDER[b.status] ?? 0) || (a.position || 99) - (b.position || 99) || a.driverNumber - b.driverNumber);
}

export const live = (e: RaceEffects) => e.status !== 'corrected';

function sumMid(effects: readonly RaceEffects[], kind: string): { low: bigint; mid: bigint; high: bigint; n: number } {
  let low = 0n;
  let mid = 0n;
  let high = 0n;
  let n = 0;
  for (const e of effects) {
    if (e.kind !== kind || !live(e)) continue;
    low += e.lowCents;
    mid += e.midCents;
    high += e.highCents;
    n++;
  }
  return { low, mid, high, n };
}

export interface Ledger {
  cost: { low: bigint; mid: bigint; high: bigint; n: number };
  prize: { low: bigint; mid: bigint; high: bigint; n: number };
  bonuses: RaceEffects[];
  headroom: RaceEffects | null;
}

export function ledger(effects: readonly RaceEffects[]): Ledger {
  const headroom = effects
    .filter((e) => e.kind === 'cap_headroom' && live(e))
    .reduce<RaceEffects | null>((best, e) => (!best || sortTime(e.at) >= sortTime(best.at) ? e : best), null);
  return {
    cost: sumMid(effects, 'cost'),
    prize: sumMid(effects, 'revenue_projection'),
    bonuses: effects.filter((e) => e.kind === 'bonus').sort((a, b) => sortTime(b.at) - sortTime(a.at)),
    headroom,
  };
}

export interface CostByLap {
  /** laps 0..fieldLap */
  xs: number[];
  /** cumulative race cost per lap, in cents as Numbers for the chart */
  low: number[];
  mid: number[];
  high: number[];
}

/**
 * Cumulative race cost lap by lap: live cost effects joined to their event's lap. Effects whose event
 * is not on the tape are left out; laps before the first booking read 0.
 */
export function costByLap(effects: readonly RaceEffects[], events: readonly RaceEvents[], fieldLap: number): CostByLap {
  const lapOf = new Map<string, number>();
  for (const e of events) lapOf.set(e.eventKey, e.lap);
  const perLap = new Map<number, { low: bigint; mid: bigint; high: bigint }>();
  let maxLap = fieldLap;
  for (const e of effects) {
    if (e.kind !== 'cost' || !live(e)) continue;
    const lap = lapOf.get(e.eventKey);
    if (lap === undefined) continue;
    maxLap = Math.max(maxLap, lap);
    const cur = perLap.get(lap) ?? { low: 0n, mid: 0n, high: 0n };
    perLap.set(lap, { low: cur.low + e.lowCents, mid: cur.mid + e.midCents, high: cur.high + e.highCents });
  }
  const xs: number[] = [];
  const low: number[] = [];
  const mid: number[] = [];
  const high: number[] = [];
  let l = 0n;
  let m = 0n;
  let h = 0n;
  for (let lap = 0; lap <= maxLap; lap++) {
    const d = perLap.get(lap);
    if (d) {
      l += d.low;
      m += d.mid;
      h += d.high;
    }
    xs.push(lap);
    low.push(Number(l));
    mid.push(Number(m));
    high.push(Number(h));
  }
  return { xs, low, mid, high };
}

/** "$340k" with an explicit plus for gains; usdShort already prints the minus. */
export function signed(cents: bigint): string {
  return cents > 0n ? `+${usdShort(cents)}` : usdShort(cents);
}

export function band(low: bigint, high: bigint): string {
  return `${usdShort(low)} – ${usdShort(high)}`;
}

// ---------------------------------------------------------------- forecasts

export interface ForecastStep {
  t: string;
  label: string;
  detail: string;
  cents_low: number;
  cents_mid: number;
  cents_high: number;
}

export interface ForecastPart {
  part: string;
  label: string;
  p: number;
  low: number;
  mid: number;
  high: number;
  basis: string;
  in_spares: boolean;
}

export interface ForecastPayload {
  steps: ForecastStep[];
  parts: ForecastPart[];
  totals: { low: number; mid: number; high: number } | null;
  prize: { before: number; after: number; delta: number; position_before: number; position_after: number } | null;
  cap: { headroom_before: number; headroom_after: number } | null;
}

const asArray = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];

export function readForecast(f: RaceForecasts): ForecastPayload {
  const p = payloadOf(f);
  const n = (o: Record<string, unknown>, k: string) => numOf(o[k]) ?? 0;
  const s = (o: Record<string, unknown>, k: string) => str(o[k]) ?? '';
  const totals = p.totals && typeof p.totals === 'object' ? (p.totals as Record<string, unknown>) : null;
  const prize = p.prize && typeof p.prize === 'object' ? (p.prize as Record<string, unknown>) : null;
  const cap = p.cap && typeof p.cap === 'object' ? (p.cap as Record<string, unknown>) : null;
  return {
    steps: asArray(p.steps).map((o) => ({ t: s(o, 't'), label: s(o, 'label'), detail: s(o, 'detail'), cents_low: n(o, 'cents_low'), cents_mid: n(o, 'cents_mid'), cents_high: n(o, 'cents_high') })),
    parts: asArray(p.parts).map((o) => ({ part: s(o, 'part'), label: s(o, 'label') || s(o, 'part'), p: n(o, 'p'), low: n(o, 'low'), mid: n(o, 'mid'), high: n(o, 'high'), basis: s(o, 'basis'), in_spares: o.in_spares === true })),
    totals: totals ? { low: n(totals, 'low'), mid: n(totals, 'mid'), high: n(totals, 'high') } : null,
    prize: prize
      ? { before: n(prize, 'before'), after: n(prize, 'after'), delta: n(prize, 'delta'), position_before: n(prize, 'position_before'), position_after: n(prize, 'position_after') }
      : null,
    cap: cap ? { headroom_before: n(cap, 'headroom_before'), headroom_after: n(cap, 'headroom_after') } : null,
  };
}

/** "May 24 20:27" for a forecast step; the full ISO string wraps over the step text. */
export function stepClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${d.getUTCDate()} ${hh}:${mm}`;
}
