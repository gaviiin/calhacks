import { live, readForecast, readJev, sortTime } from '../lib/raceModel';
import type { CarState, RaceEffects, RaceForecasts } from '../module_bindings/types';
import { BOOK_LABELS, PARTS, PRICES, SEVERITY_TEMPLATES, USD_PER_GBP, type CostId } from './catalog';

// What the desk believes about one car's parts right now, in order of trust:
//   1. the latest incident forecast, when it gave each part a probability (it also priced them and
//      knows what is in spares);
//   2. Jev's per-part P(damaged) on the latest crash booking;
//   3. the severity a policy or precedent booked the crash at ("Severity heavy" in the booking's why),
//      read through the price book's template, with the percentages the booking's memo printed;
//   4. nothing: a running car reads nominal, a stopped one reads "not read yet".
// Whatever the source, a forecast's spares and part prices are kept when it has them.

export type Health = 'ok' | 'watch' | 'damaged';

export interface PartReading {
  /** P(damaged) */
  p: number;
  /** USD cents when a forecast priced the part */
  low?: number;
  mid?: number;
  high?: number;
  inSpares?: boolean;
  /** Jev said repair, not replace (chassis) */
  repair?: boolean;
}

export type CarStatus = 'running' | 'pit' | 'stopped' | 'out' | 'dsq';

export interface CarCondition {
  source: 'forecast' | 'jev' | 'template' | 'none';
  /** who said so, in a few words */
  label: string;
  at: string | null;
  severity: string | null;
  parts: Partial<Record<CostId, PartReading>>;
  /** expected damage: P(damaged) times the price-book mid, summed; USD cents */
  expected: { low: number; mid: number; high: number } | null;
  /** crash damage already booked against this car (bucket 6050), USD cents */
  booked: { low: number; mid: number; high: number; n: number } | null;
  status: CarStatus;
  tyre: { compound: string; age: number } | null;
}

export const LIKELY = 0.5;
export const POSSIBLE = 0.15;

export function healthOf(p: number | undefined): Health {
  if (p === undefined) return 'ok';
  if (p >= LIKELY) return 'damaged';
  if (p >= POSSIBLE) return 'watch';
  return 'ok';
}

export const HEALTH_WORDS: Record<Health, string> = { ok: 'Nominal', watch: 'Possible damage', damaged: 'Likely damaged' };

const gbpCents = (g: number) => Math.round(g * USD_PER_GBP * 100);

function fold(raw: Record<string, number>): Partial<Record<CostId, PartReading>> {
  const out: Partial<Record<CostId, PartReading>> = {};
  for (const [k, p] of Object.entries(raw)) {
    if (k === 'chassis_repair') continue;
    if (k in PRICES) out[k as CostId] = { p };
  }
  // the chassis is either replaced or repaired: keep the likelier, remember which
  const rep = raw.chassis_repair ?? 0;
  const rpl = raw.chassis ?? 0;
  if (rep > 0 || rpl > 0) out.chassis = { p: Math.max(rep, rpl), repair: rep > rpl };
  return out;
}

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

const STATUS: Record<string, CarStatus> = { running: 'running', pit: 'pit', retired_suspected: 'stopped', retired: 'out' };

/** A car on the live race desk: its car_state row, and the effects and forecasts written about it. */
export function liveCondition(car: CarState, effects: readonly RaceEffects[], forecasts: readonly RaceForecasts[]): CarCondition {
  const status = STATUS[car.status] ?? 'running';
  const tyre = car.compound ? { compound: car.compound.toUpperCase(), age: car.tyreAge } : null;
  const mine = effects.filter((e) => e.driverNumber === car.driverNumber && e.kind === 'cost' && e.bucket === '6050' && live(e));
  let booked: CarCondition['booked'] = null;
  for (const e of mine) {
    booked ??= { low: 0, mid: 0, high: 0, n: 0 };
    booked.low += Number(e.lowCents);
    booked.mid += Number(e.midCents);
    booked.high += Number(e.highCents);
    booked.n++;
  }
  const base = { status, tyre, booked };

  const fc = forecasts.filter((f) => f.driverNumber === car.driverNumber && f.status === 'ready').sort((a, b) => sortTime(b.createdAt) - sortTime(a.createdAt))[0];
  const fcParts = fc ? readForecast(fc).parts : [];
  /** a forecast's prices and spares onto whatever read the probabilities */
  const withSpares = (parts: Partial<Record<CostId, PartReading>>) => {
    for (const p of fcParts) {
      const id = (p.part === 'chassis_repair' ? 'chassis' : p.part) as CostId;
      const r = parts[id];
      if (r && (p.part !== 'chassis_repair' || r.repair) && p.mid > 0) Object.assign(r, { low: p.low, mid: p.mid, high: p.high, inSpares: p.in_spares });
      else if (r && p.part === id) r.inSpares = p.in_spares;
    }
    return parts;
  };
  if (fc && fcParts.some((p) => p.p > 0)) {
    const raw: Record<string, number> = {};
    for (const p of fcParts) raw[p.part] = Math.max(raw[p.part] ?? 0, p.p);
    const parts = withSpares(fold(raw));
    return { ...base, source: 'forecast', label: fc.model ? `Forecast, ${fc.model}` : 'Incident forecast', at: fc.createdAt, severity: null, parts, expected: expectedOf(parts) };
  }

  const latest = mine.slice().sort((a, b) => sortTime(b.at) - sortTime(a.at));
  for (const e of latest) {
    const j = readJev(e.jevJson);
    if (!j || !Object.keys(j.parts).length) continue;
    const parts = withSpares(fold(j.parts));
    const who = e.decidedBy.startsWith('jev') ? `Jev${j.ms ? `, ${Math.round(j.ms)} ms` : ''}` : e.decidedBy.startsWith('policy') ? 'Policy, Jev parts' : 'Jev parts';
    return { ...base, source: 'jev', label: who, at: e.at, severity: j.topSeverity?.name ?? j.severity, parts, expected: expectedOf(parts) };
  }
  for (const e of latest) {
    const sev = /severity (light|moderate|heavy)\b/i.exec(e.why)?.[1]?.toLowerCase();
    if (!sev) continue;
    const raw: Record<string, number> = {};
    for (const [k, p] of SEVERITY_TEMPLATES[sev] ?? []) raw[k] = p;
    // the memo prints the booking's own top parts, "floor and diffuser 90%, front wing 90%, ..."
    const tail = e.memo.split(/ - car \d+ - /)[1] ?? '';
    for (const m of tail.matchAll(/([a-z][a-z ()]*?) (\d{1,3})%/g)) {
      const id = BOOK_LABELS[m[1].trim()];
      if (id) raw[id] = Number(m[2]) / 100;
    }
    const parts = withSpares(fold(raw));
    const who = e.decidedBy.startsWith('precedent') ? 'Precedent' : e.decidedBy.startsWith('policy') ? 'Policy' : 'Booking';
    return { ...base, source: 'template', label: `${who}, severity ${sev}`, at: e.at, severity: sev, parts, expected: expectedOf(parts) };
  }

  if (status === 'stopped' || status === 'out') {
    // stopped with nothing priced yet: what a heavy stop usually breaks, until Jev or a forecast says otherwise
    return { ...base, source: 'none', label: 'Assessing', at: car.updatedAt || null, severity: null, parts: {}, expected: null };
  }
  return { ...base, source: 'none', label: 'No incident', at: null, severity: null, parts: {}, expected: null };
}

/** A replayed race's crash, read through the price book's severity template. */
export function templateCondition(severity: 'light' | 'moderate' | 'heavy', status: CarStatus, at: string | null): CarCondition {
  const raw: Record<string, number> = {};
  for (const [k, p] of SEVERITY_TEMPLATES[severity] ?? []) raw[k] = p;
  const parts = fold(raw);
  return { source: 'template', label: `Severity template: ${severity}`, at, severity, parts, expected: expectedOf(parts), booked: null, status, tyre: null };
}

/** The drawn parts a reading covers (every part priced under that line). */
export function partsFor(cost: CostId): string[] {
  return PARTS.filter((p) => p.cost === cost).map((p) => p.id);
}
