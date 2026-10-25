import { useMemo } from 'react';
import type { StageCar } from '../../blueprint/CarBlueprint';
import { COST_LABELS, PARTS, priceCents, type CostId } from '../../blueprint/catalog';
import { healthOf, type CarCondition, type Health } from '../../blueprint/condition';
import type { PartTone } from '../../blueprint/engine/engine';
import { PALETTE, type RGB } from '../../blueprint/palette';
import { useRace, type RaceData } from '../../lib/race';
import { TEAM, carLabel, costByLap, ledger, payloadOf, readJev, sortTime, tierOf, type CostByLap } from '../../lib/raceModel';
import type { RaceActions, RaceAudit, RaceIncidents, RacePartLife, RacePostings } from '../../module_bindings/types';
import { signedCents } from '../raceday/AccountPanel';
import { latestSim } from '../raceday/ReplanPanel';
import { clock, parse, roleLabel } from '../raceday/shared';
import { DRAW, readCar, readTape, type CarRead, type Tape } from '../roles/carRead';
import { incidentCondition, readBelief, repairedCondition, sparesFor, type SpareReading } from '../roles/incidentCondition';

// The desk's reading of the weekend, for the home screen: every part on each of our cars with its condition, its
// life, its spare and when its replacement counts against the cap; the alerts that follow from those; the money;
// the agent's own trail. Everything here is derived from the live rows, in one memo, so the panels only draw.

// ------------------------------------------------------------------------------------------ parts

export type LifeStatus = 'damaged' | 'due' | 'watch' | 'ok' | 'replaced' | 'none';
export type CapYear = 'booked' | 'this' | 'next' | null;

export interface Stress {
  at: string;
  lap?: number;
  kind: string;
  note: string;
  severity?: string;
  p?: number;
  taken: number;
  by?: string;
}

export interface DeskPart {
  key: string;
  car: number;
  cost: CostId;
  label: string;
  short: string;
  life: RacePartLife | null;
  lifeStatus: LifeStatus;
  /** 0..120 */
  usedPct: number;
  remainingKm: number;
  lifeKm: number;
  dueEvent: string;
  /** "Qatar", "Abu Dhabi", "2025" */
  dueShort: string;
  lastsSeason: boolean;
  /** a gearbox or power unit replacement past the season's allocation */
  penalty: boolean;
  /** the replacement's price-book mid, USD cents */
  replacementCents: number;
  broughtForwardCents: number;
  capYear: CapYear;
  capNote: string;
  stress: Stress[];
  /** P(damaged) from the incident belief, when the desk has read this car */
  p: number | null;
  health: Health | 'unknown';
  spare: SpareReading | null;
  /** lower sorts first */
  urgency: number;
}

export const SHORT_PART: Record<CostId, string> = {
  chassis: 'Chassis',
  gearbox: 'Gearbox',
  floor: 'Floor',
  front_wing: 'Front wing',
  rear_wing: 'Rear wing',
  front_suspension: 'Front susp.',
  rear_suspension: 'Rear susp.',
  steering_rack: 'Steering',
  bodywork: 'Bodywork',
  brakes: 'Brakes',
  rear_brakes: 'Rear brakes',
  electronics: 'Electronics',
  wheel_speed_sensor: 'Wheel sensor',
  power_unit: 'Power unit',
  tyre: 'Tyres',
};

/** The price-book lines the life model follows (race/life.py), in the order the desk lists a car. */
export const LIFE_PARTS: CostId[] = ['power_unit', 'gearbox', 'chassis', 'floor', 'front_wing', 'rear_wing', 'front_suspension', 'rear_suspension', 'brakes', 'bodywork', 'electronics'];

export const shortEvent = (e: string) => e.replace(/ Grand Prix$/, '');
const penaltyOf = (r: RacePartLife | null) => !!r && /grid penalty/.test(r.capNote);

const RANK: Record<LifeStatus, number> = { damaged: 0, due: 1, watch: 2, ok: 3, replaced: 4, none: 5 };

function readPart(car: number, cost: CostId, life: RacePartLife | null, condition: CarCondition, spares: Partial<Record<CostId, SpareReading>>): DeskPart {
  const lifeStatus: LifeStatus = life ? ((life.status in RANK ? life.status : 'ok') as LifeStatus) : 'none';
  // a part replaced after the crash is new: the belief's damage reading belonged to the part that came off
  const reading = lifeStatus === 'replaced' ? undefined : condition.parts[cost];
  const p = reading ? reading.p : null;
  const assessing = lifeStatus !== 'replaced' && condition.source === 'none' && (condition.status === 'stopped' || condition.status === 'out');
  const health: Health | 'unknown' = assessing ? 'unknown' : healthOf(p ?? undefined);
  const dueEvent = life?.dueEvent ?? '';
  const lastsSeason = !life || dueEvent === '2025' || dueEvent === '';
  const penalty = penaltyOf(life);
  const capYear: CapYear = !life ? null : lifeStatus === 'replaced' || lifeStatus === 'damaged' ? 'booked' : lastsSeason ? 'next' : 'this';
  const price = priceCents(cost);
  const replacementCents = life && Number(life.costCents) > 0 ? Number(life.costCents) : price.mid;
  const spare = spares[cost] ?? null;
  const usedPct = life ? Math.max(0, Math.min(120, life.usedPct)) : 0;
  // damaged without a spare first, then grid penalties, then due, by life used
  let urgency = RANK[lifeStatus] * 1000 - usedPct;
  if (health === 'damaged') urgency -= 5000;
  if (spare && spare.source === 'make' && !spare.released) urgency -= 500;
  if (penalty) urgency -= 300;
  return {
    key: `${car}:${cost}`,
    car,
    cost,
    label: COST_LABELS[cost],
    short: SHORT_PART[cost],
    life,
    lifeStatus,
    usedPct,
    remainingKm: life?.remainingKm ?? 0,
    lifeKm: life?.lifeKm ?? 0,
    dueEvent,
    dueShort: lastsSeason ? '2025' : shortEvent(dueEvent),
    lastsSeason,
    penalty,
    replacementCents,
    broughtForwardCents: Number(life?.broughtForwardCents ?? 0),
    capYear,
    capNote: life?.capNote ?? '',
    stress: life ? parse<Stress[]>(life.stressJson, []).filter((s) => s.kind !== 'replaced') : [],
    p,
    health,
    spare,
    urgency,
  };
}

// ------------------------------------------------------------------------------------------ cars

export interface DeskCar {
  read: CarRead;
  number: number;
  code: string;
  name: string | null;
  incident: RaceIncidents | null;
  condition: CarCondition;
  stage: StageCar;
  parts: DeskPart[];
  impactKph: number | null;
  /** parts likely damaged in the current belief */
  damaged: number;
  replaced: number;
  due: number;
  penalties: number;
  /** spares reserved for this car's incident: at the track, at the factory, to be made */
  spares: { track: number; factory: number; make: number };
  /** the car's parts: life used, averaged over the parts the life model follows */
  lifeUsed: number;
  expectedCents: number | null;
}

function readDeskCar(n: number, race: RaceData, tape: Tape): DeskCar {
  const read = readCar(n, race, tape);
  const inc = read.incident;
  const status = DRAW[read.words];
  const input = inc ? { incident: inc, beliefJson: inc.beliefJson, version: inc.version, status: inc.status, at: inc.updatedAt } : null;
  const condition = read.repairedSince
    ? repairedCondition(read.carState, status, race.effects, race.forecasts, read.repairedSince)
    : incidentCondition(read.carState, status, input, race.effects, race.forecasts, race.actions);
  const spares = inc ? sparesFor(race.actions, inc.incidentKey) : {};
  const lifeRows = new Map(race.partLife.filter((r) => r.driverNumber === n).map((r) => [r.part, r]));
  const parts = LIFE_PARTS.map((cost) => readPart(n, cost, lifeRows.get(cost) ?? null, condition, spares)).sort((a, b) => a.urgency - b.urgency);
  const live = Object.values(spares).filter((s) => !s.released);
  const followed = parts.filter((p) => p.life);
  return {
    read,
    number: n,
    code: read.code,
    name: read.name,
    incident: inc,
    condition,
    stage: { number: n, code: read.code, team: TEAM, position: read.position, lap: read.lap, gap: read.gap, lastPit: read.lastPit, condition },
    parts,
    impactKph: inc ? readBelief(inc.beliefJson).impact_kph ?? null : null,
    damaged: parts.filter((p) => p.health === 'damaged').length,
    replaced: parts.filter((p) => p.lifeStatus === 'replaced').length,
    due: parts.filter((p) => p.lifeStatus === 'due' || (p.lifeStatus === 'watch' && !p.lastsSeason)).length,
    penalties: parts.filter((p) => p.penalty).length,
    spares: { track: live.filter((s) => s.source === 'at_track').length, factory: live.filter((s) => s.source === 'factory').length, make: live.filter((s) => s.source === 'make').length },
    lifeUsed: followed.length ? followed.reduce((t, p) => t + Math.min(p.usedPct, 100), 0) / followed.length : 0,
    expectedCents: condition.expected?.mid ?? null,
  };
}

// ------------------------------------------------------------------------------------------ lenses

export type DeskLens = 'condition' | 'life' | 'cap';

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const FRESH: RGB = [0.42, 0.86, 1.0];
const WHITE: RGB = [1, 1, 1];

/** Life used, 0..1, as a lamp colour: cyan when fresh, amber past three quarters, coral at the limit. */
export function lifeColor(used: number): RGB {
  const t = Math.max(0, Math.min(1.2, used / 100));
  if (t < 0.75) return mix(FRESH, PALETTE.hold, t / 0.75);
  return mix(PALETTE.hold, PALETTE.alert, Math.min(1, (t - 0.75) / 0.25));
}

export function lifeCss(used: number): string {
  const c = lifeColor(used);
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

/** Tones for the blueprint under the life or cap lens; the condition lens stays the blueprint's own. */
export function lensTones(lens: DeskLens, car: DeskCar): PartTone[] | null {
  if (lens === 'condition') return null;
  const byCost = new Map(car.parts.map((p) => [p.cost, p]));
  return PARTS.map((def) => {
    const p = byCost.get(def.cost);
    if (!p || !p.life) return { color: PALETTE.unknown, level: 0.5, ink: null, pulse: false };
    if (lens === 'life') {
      if (p.lifeStatus === 'replaced') return { color: mix(WHITE, FRESH, 0.35), level: 1.25, ink: mix(WHITE, FRESH, 0.5), pulse: false };
      if (p.lifeStatus === 'damaged') return { color: PALETTE.alert, level: 1.3, ink: mix(PALETTE.alert, WHITE, 0.08), pulse: true };
      const c = lifeColor(p.usedPct);
      return { color: c, level: 0.8 + 0.5 * Math.min(1, p.usedPct / 100), ink: p.usedPct >= 75 ? mix(c, WHITE, 0.1) : null, pulse: p.lifeStatus === 'due' };
    }
    // cap: what this weekend's running brings into this year's cap
    if (p.capYear === 'booked') return { color: PALETTE.alert, level: 1.25, ink: mix(PALETTE.alert, WHITE, 0.08), pulse: false };
    if (p.capYear === 'this') return { color: PALETTE.hold, level: 1.15, ink: mix(PALETTE.hold, WHITE, 0.08), pulse: p.penalty };
    return { color: PALETTE.line, level: 0.7, ink: null, pulse: false };
  });
}

// ------------------------------------------------------------------------------------------ alerts

export type AlertKind = 'penalty' | 'damaged' | 'nospare' | 'held' | 'question' | 'decision' | 'due' | 'close' | 'refused' | 'unsure';

export interface Alert {
  key: string;
  kind: AlertKind;
  tone: 'bad' | 'wait' | 'info';
  /** a person must act (not just read) */
  action: boolean;
  title: string;
  detail: string;
  car: number | null;
  who: string | null;
  amountCents: number | null;
  at: string;
  /** the role view that owns it, and an anchor on it */
  go: { tab: 'garage' | 'strategy' | 'accounting' | 'cfo'; anchor?: string };
}

export interface HeldGroup {
  key: string;
  rows: RacePostings[];
  net: number;
  label: string;
  who: string[];
  reasons: string[];
  at: string;
}

const n = (c: bigint | number | undefined | null) => Number(c ?? 0);

function reasonTag(reason: string): string {
  if (/unsure/i.test(reason)) return 'Jev unsure';
  if (/materiality/i.test(reason)) return 'over materiality';
  if (/threshold/i.test(reason)) return 'over CFO threshold';
  return reason.split(/[:;(]/)[0]!.trim();
}

/** The held postings grouped by incident: one approval per crash, as the CFO view does it. */
export function heldGroups(race: RaceData): HeldGroup[] {
  const held = race.postings.filter((x) => x.status === 'held');
  const entryOf = new Map(race.entries.map((e) => [e.entryKey, e]));
  const lines = new Map<string, RaceData['entryLines'][number][]>();
  for (const l of race.entryLines) lines.set(l.entryKey, [...(lines.get(l.entryKey) ?? []), l]);
  const groups = new Map<string, RacePostings[]>();
  for (const h of held) groups.set(h.incidentKey, [...(groups.get(h.incidentKey) ?? []), h]);
  return [...groups.entries()]
    .map(([key, rows]) => {
      const inc = race.incidents.find((i) => i.incidentKey === key);
      const net = rows.reduce((t, h) => {
        const e = entryOf.get(h.entryKey);
        return t + (e ? n(signedCents(e, lines.get(h.entryKey))) : n(h.amountCents));
      }, 0);
      const lap = inc ? parse<{ lap?: number }>(inc.beliefJson, {}).lap : undefined;
      const what = inc?.evidenceJson.includes('car_stopped') ? 'crash' : 'contact';
      const label = inc ? `${carLabel(inc.driverNumber)} · ${inc.sessionKey === 9627 ? 'qualifying' : `race L${lap ?? '?'}`} ${what}` : 'FIA fines';
      return { key, rows, net, label, who: [...new Set(rows.map((h) => roleLabel(h.reviewRole)))], reasons: [...new Set(rows.map((h) => reasonTag(h.reason)).filter(Boolean))], at: inc?.firstSeenAt ?? '' };
    })
    .sort((a, b) => sortTime(b.at || '1970-01-01T00:00:00Z') - sortTime(a.at || '1970-01-01T00:00:00Z'));
}

function alertsOf(race: RaceData, cars: DeskCar[], held: HeldGroup[]): Alert[] {
  const out: Alert[] = [];
  for (const c of cars) {
    for (const p of c.parts) {
      if (p.penalty)
        out.push({
          key: `pen:${p.key}`, kind: 'penalty', tone: 'bad', action: false, car: c.number, who: null, amountCents: null, at: p.life?.updatedAt ?? '',
          title: `Grid penalty · car ${c.number}`, detail: `${p.short} runs out by ${p.dueShort}, past the allocation`, go: { tab: 'garage' },
        });
      if (p.health === 'damaged' && p.lifeStatus !== 'replaced' && p.spare && p.spare.source === 'make' && !p.spare.released)
        out.push({
          key: `make:${p.key}`, kind: 'nospare', tone: 'bad', action: false, car: c.number, who: 'Head of Logistics', amountCents: p.replacementCents, at: p.life?.updatedAt ?? '',
          title: `No spare · ${p.short}`, detail: `car ${c.number} · to be made at Grove`, go: { tab: 'garage', anchor: 'next-steps' },
        });
    }
    if (c.damaged && c.read.words !== 'dns' && !c.replaced)
      out.push({
        key: `dmg:${c.number}`, kind: 'damaged', tone: 'bad', action: false, car: c.number, who: null, amountCents: c.expectedCents, at: c.incident?.updatedAt ?? '',
        title: `${c.damaged} parts likely damaged · car ${c.number}`, detail: c.condition.label, go: { tab: 'garage' },
      });
  }
  for (const g of held)
    out.push({
      key: `held:${g.key}`, kind: 'held', tone: 'wait', action: true, car: null, who: g.who.join(', '), amountCents: g.net, at: g.at,
      title: `${g.rows.length} ${g.rows.length === 1 ? 'entry' : 'entries'} held · ${g.label}`, detail: g.reasons.join(' · '), go: { tab: 'cfo' },
    });
  for (const q of race.questions.filter((x) => x.status === 'open'))
    out.push({
      key: `q:${q.questionKey}`, kind: 'question', tone: 'wait', action: true, car: race.incidents.find((i) => i.incidentKey === q.incidentKey)?.driverNumber ?? null, who: roleLabel(q.routeRole),
      amountCents: q.expectedLossCents > 0n ? Number(q.expectedLossCents) : null, at: q.createdAt, title: q.prompt, detail: q.deadlineAt ? `default at ${clock(q.deadlineAt)}` : '', go: { tab: 'garage' },
    });
  for (const a of race.actions.filter((x) => x.status === 'awaiting_approval' && (x.kind === 'withdraw_car' || x.outward)))
    out.push({
      key: `act:${a.actionKey}`, kind: 'decision', tone: 'wait', action: true, car: race.incidents.find((i) => i.incidentKey === a.incidentKey)?.driverNumber ?? null, who: roleLabel(a.ownerRole),
      amountCents: null, at: a.updatedAt, title: a.title, detail: a.dueAt ? `by ${clock(a.dueAt).slice(0, 5)}` : '', go: { tab: 'garage', anchor: a.kind === 'withdraw_car' ? undefined : 'next-steps' },
    });
  for (const e of race.effects.filter((x) => x.status === 'needs_person'))
    out.push({
      key: `unsure:${e.effectKey}`, kind: 'unsure', tone: 'wait', action: true, car: e.driverNumber, who: 'Chief Mechanic', amountCents: n(e.midCents), at: e.at,
      title: `Jev unsure · ${carLabel(e.driverNumber)}`, detail: e.memo.split(/ - counts| - retirement|\. /)[0]!.trim(), go: { tab: 'cfo' },
    });
  const close = race.closes.reduce<RaceData['closes'][number] | null>((b, c) => (!b || c.closedAt > b.closedAt ? c : b), null);
  if (close?.status === 'draft')
    out.push({
      key: `close:${close.closeKey}`, kind: 'close', tone: 'wait', action: true, car: null, who: 'CFO', amountCents: parse<{ race_cost?: { mid_cents?: number } }>(close.totalsJson, {}).race_cost?.mid_cents ?? null, at: close.closedAt,
      title: 'Weekend close and briefs', detail: `${close.leaves} rows sealed`, go: { tab: 'cfo' },
    });
  const refusedAgent = race.audit.filter((a) => !a.allowed && (a.role === 'race' || a.role === 'owner' || a.name.startsWith('agent:')));
  if (refusedAgent.length) {
    const last = refusedAgent.reduce((m, a) => (a.auditId > m.auditId ? a : m));
    out.push({
      key: 'refused', kind: 'refused', tone: 'info', action: false, car: null, who: null, amountCents: null, at: last.at,
      title: `${refusedAgent.length} agent ${refusedAgent.length === 1 ? 'attempt' : 'attempts'} refused`, detail: last.reason, go: { tab: 'accounting' },
    });
  }
  const order: Record<AlertKind, number> = { held: 0, question: 1, decision: 2, unsure: 3, close: 4, penalty: 5, nospare: 6, damaged: 7, due: 8, refused: 9 };
  return out.sort((a, b) => Number(b.action) - Number(a.action) || order[a.kind] - order[b.kind] || sortTime(b.at) - sortTime(a.at));
}

// ------------------------------------------------------------------------------------------ money

export interface DeskFinance {
  cost: { low: number; mid: number; high: number; n: number };
  books: { posted: { c: number; k: number }; held: { c: number; k: number }; unrouted: { c: number; k: number }; rejected: { c: number; k: number } };
  cap: { year: string; capCents: number; p10: number; p50: number; p90: number; pOver: number; pMat: number; basis: string; over: { label: string; p: number }[] } | null;
  prize: { expected: number; delta: number; pTarget: number; target: number; baseline: number | null; history: number[]; ours: number; rivals: number } | null;
  sim: { at: string; runtimeMs: number; seasons: number } | null;
  hardware: { replaced: number; dueParts: number; dueCents: number; forward: number; penalties: number; stress: number };
  erp: { id: string; memo: string; cents: number; at: string }[];
}

function financeOf(race: RaceData, cars: DeskCar[]): DeskFinance {
  const led = ledger(race.effects);
  const postingOf = new Map(race.postings.map((x) => [x.entryKey, x]));
  const entryOf = new Map(race.entries.map((e) => [e.entryKey, e]));
  const lines = new Map<string, RaceData['entryLines'][number][]>();
  for (const l of race.entryLines) lines.set(l.entryKey, [...(lines.get(l.entryKey) ?? []), l]);
  const books = { posted: { c: 0, k: 0 }, held: { c: 0, k: 0 }, unrouted: { c: 0, k: 0 }, rejected: { c: 0, k: 0 } };
  for (const e of race.entries) {
    const s = postingOf.get(e.entryKey)?.status;
    const slot = s === 'posted' || s === 'approved' ? books.posted : s === 'held' ? books.held : s === 'rejected' ? books.rejected : books.unrouted;
    slot.c += n(signedCents(e, lines.get(e.entryKey)));
    slot.k += 1;
  }
  const seasonRuns = race.sims.filter((s) => !s.trigger.startsWith('trueup:'));
  const sim = latestSim({ sims: seasonRuns });
  const p = sim ? parse<Record<string, any>>(sim.payloadJson, {}) : {};
  const capP = (p.cap ?? {}) as Record<string, any>;
  const ye = capP.year_end as { p10_cents: number; p50_cents: number; p90_cents: number } | undefined;
  const facets = (p.facets ?? []) as { facet: string; outcomes: { label: string; p: number }[] }[];
  const capFacet = facets.find((f) => /cost cap/i.test(f.facet));
  const over = (capFacet?.outcomes ?? []).filter((o) => /over by more than/i.test(o.label)).map((o) => ({ label: o.label.replace(/^over by more than /i, '> '), p: o.p }));
  const history = sim
    ? seasonRuns
        .filter((s) => s.meetingKey === sim.meetingKey)
        .map((s) => ({ s, v: parse<Record<string, any>>(s.payloadJson, {}).p_target }))
        .filter((r): r is { s: (typeof seasonRuns)[number]; v: number } => typeof r.v === 'number')
        .sort((a, b) => sortTime(a.s.at) - sortTime(b.s.at) || a.s.simKey.localeCompare(b.s.simKey))
        .map((r) => r.v)
    : [];
  const parts = cars.flatMap((c) => c.parts).filter((x) => x.life);
  const due = parts.filter((x) => x.lifeStatus !== 'replaced' && x.lifeStatus !== 'damaged' && !x.lastsSeason);
  const erp = race.postings
    .filter((x) => x.status === 'posted')
    .sort((a, b) => sortTime(b.at) - sortTime(a.at))
    .slice(0, 12)
    .map((x) => ({ id: x.erpEntryId, memo: entryOf.get(x.entryKey)?.memo ?? x.entryKey, cents: n(x.amountCents), at: x.at }));
  return {
    cost: { low: n(led.cost.low), mid: n(led.cost.mid), high: n(led.cost.high), n: led.cost.n },
    books,
    cap: ye
      ? { year: String(capP.year ?? ''), capCents: n(capP.cap_cents), p10: ye.p10_cents, p50: ye.p50_cents, p90: ye.p90_cents, pOver: capP.p_overspend ?? 0, pMat: capP.p_material ?? 0, basis: capP.cap_basis ?? '', over }
      : null,
    prize: p.prize
      ? {
          expected: n(p.prize.expected_cents), delta: n(p.prize.delta_cents), pTarget: p.p_target ?? 0, target: p.target_position ?? 8, baseline: p.p_target_baseline ?? null, history,
          ours: n(p.attribution?.ours_cents), rivals: n(p.attribution?.rivals_cents),
        }
      : null,
    sim: sim ? { at: sim.at, runtimeMs: sim.runtimeMs, seasons: p.n ?? 10_000 } : null,
    hardware: {
      replaced: parts.filter((x) => x.lifeStatus === 'replaced' || x.lifeStatus === 'damaged').length,
      dueParts: due.length,
      dueCents: due.reduce((t, x) => t + x.replacementCents, 0),
      forward: parts.reduce((t, x) => t + x.broughtForwardCents, 0),
      penalties: parts.filter((x) => x.penalty).length,
      stress: new Set(parts.flatMap((x) => x.stress.map((s) => `${x.car}|${s.at}|${s.kind}`))).size,
    },
    erp,
  };
}

// ------------------------------------------------------------------------------------------ the agent's trail

export type Actor = 'agent' | 'jev' | 'claude' | 'policy' | 'person' | 'system';
export type Outcome = 'allowed' | 'refused' | 'held' | 'posted' | 'asked' | 'auto' | 'decided';

export interface TrailItem {
  key: string;
  /** wall time, ms */
  t: number;
  /** race time, when the item has one */
  raceAt: string;
  actor: Actor;
  who: string;
  action: string;
  detail: string;
  outcome: Outcome;
  amountCents: number | null;
  ms: number | null;
  car: number | null;
}

const AUDIT_WORDS: Record<string, string> = {
  request_posting: 'asked to post', record_posted: 'posted to the ERP', record_failed: 'send failed', record_held: 'held an entry',
  posting_approved: 'approved a posting', posting_rejected: 'rejected a posting', confirm_effect: 'signed off an estimate',
  correct_effect: 'corrected an estimate', apply_answer: 'applied an answer', answer_question: 'answered a question',
  question_default: 'took the deadline default', approve_close: 'approved the close', choose_option: 'chose an option',
  set_policy_autonomy: 'set a policy’s autonomy', set_rules: 'changed the money rules', grant_seat: 'seated a person',
  action_approved: 'approved an action', action_rejected: 'rejected an action', action_done: 'marked an action done', action_cancelled: 'cancelled an action',
  record_event: 'recorded an event', record_effects: 'booked an effect', record_part_life: 'updated part life', record_sim: 'ran the season', record_close: 'sealed the weekend',
};

function actorOfAudit(a: RaceAudit): Actor {
  if (a.role === 'race' || a.role === 'owner' || a.name.startsWith('agent:')) return 'agent';
  if (a.role === 'scheduler') return 'system';
  return 'person';
}

const DESK_ACTION: Record<string, string> = {
  spares_reserve: 'reserved a spare', work_order: 'raised a Grove work order', td017_move: 'moved inventory', evidence_pack: 'built the evidence pack',
  parc_ferme_list: 'drafted the parc fermé list', pu_check: 'checked PU and gearbox', hand_carry: 'booked a hand-carry', freight: 'booked freight', fia_notice: 'drafted the FIA notice',
};

function trailOf(race: RaceData): TrailItem[] {
  const out: TrailItem[] = [];
  const incCar = new Map(race.incidents.map((i) => [i.incidentKey, i.driverNumber]));
  // chatter the audit records thousands of times (every event's commit) is folded out: one line per decision
  const QUIET = new Set(['record_event', 'record_part_life']);
  for (const a of race.audit) {
    if (QUIET.has(a.action) && a.allowed) continue;
    out.push({
      key: `au:${a.auditId}`, t: sortTime(a.at), raceAt: '', actor: actorOfAudit(a), who: a.name, action: AUDIT_WORDS[a.action] ?? a.action.replace(/_/g, ' '),
      detail: a.reason, outcome: a.allowed ? (a.action.startsWith('record_') ? 'auto' : 'allowed') : 'refused', amountCents: null, ms: null, car: incCar.get(a.targetKey) ?? null,
    });
  }
  for (const e of race.effects) {
    if (e.kind !== 'cost' && e.kind !== 'bonus') continue;
    const tier = tierOf(e.decidedBy);
    const j = readJev(e.jevJson);
    out.push({
      key: `ef:${e.effectKey}`, t: sortTime(e.at), raceAt: e.at, actor: tier === 'jev' ? 'jev' : tier === 'claude' ? 'claude' : tier === 'policy' ? 'policy' : 'agent',
      who: tier === 'jev' ? 'Jev' : tier === 'claude' ? 'Claude' : tier === 'policy' ? e.decidedBy.replace(/^(policy|precedent):?/, '$1 ') : 'desk',
      action: e.status === 'needs_person' ? 'priced, asks a person' : e.status === 'corrected' ? 'priced, later corrected' : 'priced',
      detail: e.memo.split(/ - counts| - retirement|\. /)[0]!.trim(), outcome: e.status === 'needs_person' ? 'asked' : 'auto', amountCents: n(e.midCents), ms: j?.ms ?? null, car: e.driverNumber || null,
    });
  }
  for (const a of race.actions) {
    if (a.status === 'auto')
      out.push({ key: `ac:${a.actionKey}`, t: sortTime(a.updatedAt), raceAt: '', actor: 'agent', who: 'desk', action: DESK_ACTION[a.kind] ?? a.kind.replace(/_/g, ' '), detail: a.title, outcome: 'auto', amountCents: null, ms: null, car: incCar.get(a.incidentKey) ?? null });
    else if (a.decidedBy.startsWith('person:'))
      out.push({ key: `ac:${a.actionKey}`, t: sortTime(a.updatedAt), raceAt: '', actor: 'person', who: a.decidedBy.slice(7), action: `${a.status.replace(/_/g, ' ')}: ${a.title}`, detail: parse<{ chosen?: string }>(a.detailJson, {}).chosen ?? '', outcome: 'decided', amountCents: null, ms: null, car: incCar.get(a.incidentKey) ?? null });
  }
  for (const q of race.questions) {
    out.push({ key: `q:${q.questionKey}`, t: sortTime(q.createdAt), raceAt: q.createdAt, actor: 'agent', who: 'desk', action: `asked the ${roleLabel(q.routeRole)}`, detail: q.prompt, outcome: 'asked', amountCents: q.expectedLossCents > 0n ? n(q.expectedLossCents) : null, ms: null, car: incCar.get(q.incidentKey) ?? null });
  }
  for (const p of race.postings) {
    if (p.status === 'held') out.push({ key: `po:${p.entryKey}`, t: sortTime(p.at), raceAt: '', actor: 'agent', who: 'desk', action: `held for the ${roleLabel(p.reviewRole)}`, detail: p.reason, outcome: 'held', amountCents: n(p.amountCents), ms: null, car: incCar.get(p.incidentKey) ?? null });
    else if (p.status === 'posted') out.push({ key: `po:${p.entryKey}`, t: sortTime(p.at), raceAt: '', actor: 'agent', who: 'ERP gateway', action: `posted ${p.erpEntryId}`, detail: p.reason, outcome: 'posted', amountCents: n(p.amountCents), ms: null, car: incCar.get(p.incidentKey) ?? null });
  }
  return out.sort((a, b) => b.t - a.t || a.key.localeCompare(b.key));
}

// ------------------------------------------------------------------------------------------ the session on one axis

export interface Mark {
  lap: number;
  at: string;
  kind: 'crash' | 'contact' | 'sc' | 'vsc' | 'red' | 'pit' | 'penalty';
  car: number | null;
  label: string;
}

export interface Timeline {
  session: number | null;
  laps: number;
  cost: CostByLap;
  marks: Mark[];
}

function timelineOf(race: RaceData, tape: Tape): Timeline {
  const inSession = race.events.filter((e) => e.sessionKey === tape.session);
  const marks: Mark[] = [];
  for (const e of inSession) {
    const p = payloadOf(e);
    const ours = e.teamName === TEAM;
    switch (e.kind) {
      case 'red_flag':
        marks.push({ lap: e.lap, at: e.at, kind: 'red', car: null, label: `Red flag L${e.lap}` });
        break;
      case 'safety_car':
        if (p.deployed !== false) marks.push({ lap: e.lap, at: e.at, kind: /VIRTUAL/i.test(String(p.message ?? '')) ? 'vsc' : 'sc', car: null, label: `Safety car L${e.lap}` });
        break;
      case 'vsc':
        if (p.deployed !== false) marks.push({ lap: e.lap, at: e.at, kind: 'vsc', car: null, label: `VSC L${e.lap}` });
        break;
      case 'car_stopped':
        if (ours) marks.push({ lap: e.lap, at: e.at, kind: 'crash', car: e.driverNumber, label: `${carLabel(e.driverNumber)} stopped L${e.lap}` });
        break;
      case 'incident':
        if (ours) marks.push({ lap: e.lap, at: e.at, kind: 'contact', car: e.driverNumber, label: `${carLabel(e.driverNumber)} ${String(p.message ?? 'incident').slice(0, 60)}` });
        break;
      case 'pit_stop':
        if (ours) marks.push({ lap: e.lap, at: e.at, kind: 'pit', car: e.driverNumber, label: `${carLabel(e.driverNumber)} pit L${e.lap}` });
        break;
      case 'penalty':
        if (ours) marks.push({ lap: e.lap, at: e.at, kind: 'penalty', car: e.driverNumber, label: `${carLabel(e.driverNumber)} penalty L${e.lap}` });
        break;
    }
  }
  const laps = tape.fieldLap ?? 0;
  return { session: tape.session, laps, cost: costByLap(race.effects.filter((e) => inSession.some((x) => x.eventKey === e.eventKey)), inSession, laps), marks: marks.sort((a, b) => a.lap - b.lap || sortTime(a.at) - sortTime(b.at)) };
}

// ------------------------------------------------------------------------------------------ the desk

export interface Desk {
  race: RaceData;
  tape: Tape;
  cars: DeskCar[];
  parts: DeskPart[];
  alerts: Alert[];
  held: HeldGroup[];
  finance: DeskFinance;
  trail: TrailItem[];
  timeline: Timeline;
  /** the field by position, our cars marked */
  order: { n: number; pos: number; code: string; team: string; ours: boolean; out: boolean; dns: boolean }[];
  /** who is watching, latency, decisions on the record */
  proof: { online: number; names: string[]; meanMs: number | null; lastMs: number | null; maxMs: number | null; events: number; decisions: number; refused: number; agentRefused: number };
  spares: { track: number; factory: number; make: number };
  actions: { waiting: RaceActions[]; desk: RaceActions[]; done: RaceActions[] };
}

export function readDesk(race: RaceData): Desk {
  const tape = readTape(race.events);
  const numbers = new Set<number>(tape.teamCars);
  for (const i of race.incidents) if (i.teamName === TEAM) numbers.add(i.driverNumber);
  if (!numbers.size) for (const x of [23, 43]) numbers.add(x);
  const cars = [...numbers].sort((a, b) => a - b).map((x) => readDeskCar(x, race, tape));
  const held = heldGroups(race);
  const ours = new Map(cars.map((c) => [c.number, c]));
  const order = [...tape.cars.entries()]
    .filter(([, t]) => t.position)
    .map(([x, t]) => {
      const w = ours.get(x)?.read.words;
      const dns = !!t.retired?.dns || w === 'dns';
      return { n: x, pos: t.position!, code: tape.codes.get(x) ?? '', team: t.team, ours: t.team === TEAM, dns, out: dns || !!t.retired || w === 'out' || w === 'stopped' };
    })
    .sort((a, b) => Number(a.out) - Number(b.out) || a.pos - b.pos || a.n - b.n);
  const refused = race.audit.filter((a) => !a.allowed);
  const agentRefused = refused.filter((a) => actorOfAudit(a) === 'agent');
  const lat = race.latency;
  const SKIP = new Set(['garage_check', 'withdraw_car']);
  const acts = race.actions.filter((a) => !SKIP.has(a.kind));
  return {
    race,
    tape,
    cars,
    parts: cars.flatMap((c) => c.parts).sort((a, b) => a.urgency - b.urgency),
    alerts: alertsOf(race, cars, held),
    held,
    finance: financeOf(race, cars),
    trail: trailOf(race),
    timeline: timelineOf(race, tape),
    order,
    proof: {
      online: race.online.length, names: race.online.map((o) => o.name), meanMs: lat ? lat.meanMs : null, lastMs: lat ? lat.lastMs : null, maxMs: lat ? lat.maxMs : null, events: lat ? Number(lat.events) : race.events.length,
      decisions: race.audit.length, refused: refused.length, agentRefused: agentRefused.length,
    },
    spares: cars.reduce((t, c) => ({ track: t.track + c.spares.track, factory: t.factory + c.spares.factory, make: t.make + c.spares.make }), { track: 0, factory: 0, make: 0 }),
    actions: {
      waiting: acts.filter((a) => a.status === 'awaiting_approval').sort((a, b) => sortTime(a.dueAt || '9999') - sortTime(b.dueAt || '9999')),
      desk: acts.filter((a) => a.status === 'auto'),
      done: acts.filter((a) => a.status === 'approved' || a.status === 'done' || a.status === 'rejected'),
    },
  };
}

export function useDesk(): Desk {
  const race = useRace();
  return useMemo(() => readDesk(race), [race]);
}
