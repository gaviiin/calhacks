import { TEAM, DRIVERS, payloadOf, sortTime, trackStatus, type TrackStatus } from '../../lib/raceModel';
import type { RaceData } from '../../lib/race';
import type { CarState, RaceEvents, RaceIncidents } from '../../module_bindings/types';
import type { CarStatus } from '../../blueprint/condition';
import { clock } from '../raceday/shared';
import { readBelief } from './incidentCondition';
import type { Tone } from './kit';

// The tape and each of our cars, read for the pit wall and the desk: one place turns the race_events rows into
// where the session stands (readTape) and what one car is doing now (readCar). Pure functions; no React.

export const SESSION_NAMES: Record<number, string> = { 9627: 'Qualifying', 9636: 'Race', 11291: 'Race', 9693: 'Race' };
const NAMES: Record<number, string> = { 23: 'Alexander Albon', 43: 'Franco Colapinto', 55: 'Carlos Sainz' };

// ------------------------------------------------------------------------------------------ the tape, read per car

export interface CarTape {
  lap: number | null;
  lapStarts: string[];
  position: number | null;
  stint: { compound: string; lapStart: number; ageAtStart: number } | null;
  lastPit: number | null;
  retiredSuspectedAt: string | null;
  retired: { dns: boolean; dnf: boolean; dsq: boolean; laps: number | null } | null;
  team: string;
}

export interface Tape {
  session: number | null;
  sessionName: string;
  start: string | null;
  last: string | null;
  fieldLap: number | null;
  track: TrackStatus;
  cars: Map<number, CarTape>;
  /** every car seen in this meeting with a team car's name on it */
  teamCars: number[];
  codes: Map<number, string>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function readTape(events: readonly RaceEvents[]): Tape {
  const sorted = events.slice().sort((a, b) => sortTime(a.at) - sortTime(b.at));
  const last = sorted[sorted.length - 1] ?? null;
  const session = last ? last.sessionKey : null;
  const teamCars = new Set<number>();
  const codes = new Map<number, string>();
  const cars = new Map<number, CarTape>();
  const inSession: RaceEvents[] = [];
  let fieldLap = 0;
  for (const e of sorted) {
    if (e.driverNumber && e.teamName === TEAM) teamCars.add(e.driverNumber);
    const p = payloadOf(e);
    if (Array.isArray(p.cars)) for (const c of p.cars as { number?: number; acronym?: string }[]) if (c?.number && c.acronym) codes.set(c.number, c.acronym);
    if (e.sessionKey !== session) continue;
    inSession.push(e);
    if (e.lap > fieldLap) fieldLap = e.lap;
    if (!e.driverNumber) continue;
    let t = cars.get(e.driverNumber);
    if (!t) {
      t = { lap: null, lapStarts: [], position: null, stint: null, lastPit: null, retiredSuspectedAt: null, retired: null, team: e.teamName };
      cars.set(e.driverNumber, t);
    }
    if (e.teamName) t.team = e.teamName;
    switch (e.kind) {
      case 'lap': {
        const n = num(p.lap_number) ?? e.lap;
        if (n && (t.lap === null || n >= t.lap)) t.lap = n;
        t.lapStarts.push(e.at);
        break;
      }
      case 'position': {
        const to = num(p.to);
        if (to) t.position = to;
        break;
      }
      case 'stint':
        if (typeof p.compound === 'string') t.stint = { compound: p.compound.toUpperCase(), lapStart: num(p.lap_start) ?? e.lap, ageAtStart: num(p.tyre_age_at_start) ?? 0 };
        break;
      case 'pit_stop':
        t.lastPit = num(p.lap_number) ?? e.lap;
        break;
      case 'retirement_suspected':
        t.retiredSuspectedAt = e.at;
        break;
      case 'retirement_confirmed':
        t.retired = { dns: p.dns === true, dnf: p.dnf === true, dsq: p.dsq === true, laps: num(p.number_of_laps) };
        break;
    }
  }
  for (const [n, c] of Object.entries(DRIVERS)) codes.set(Number(n), c);
  const newestFirst = inSession.slice().reverse();
  return {
    session,
    sessionName: session !== null ? SESSION_NAMES[session] ?? `Session ${session}` : 'No session',
    start: inSession[0]?.at ?? null,
    last: last?.at ?? null,
    fieldLap: fieldLap || null,
    track: trackStatus(newestFirst),
    cars,
    teamCars: [...teamCars].sort((a, b) => a - b),
    codes,
  };
}

// ------------------------------------------------------------------------------------------ one car, read now

export type Words = 'running' | 'pit' | 'garage' | 'stopped' | 'out' | 'dns' | 'dsq' | 'finished' | 'waiting';

// Blue is kept for a person's action, so a healthy car reads in sky; amber waits, red is off.
export const WORDS: Record<Words, { word: string; tone: Tone }> = {
  running: { word: 'Running', tone: 'info' },
  finished: { word: 'Finished', tone: 'info' },
  pit: { word: 'In the pit', tone: 'wait' },
  garage: { word: 'In the garage', tone: 'wait' },
  stopped: { word: 'Stopped', tone: 'bad' },
  out: { word: 'Out', tone: 'bad' },
  dsq: { word: 'Disqualified', tone: 'bad' },
  dns: { word: 'Did not start', tone: 'bad' },
  waiting: { word: 'Not on track yet', tone: 'neutral' },
};

/** The 2024 entry list, only to name a car the tape never named (the tape's own acronym always wins). */
export const GRID_2024: Record<number, string> = {
  1: 'VER', 11: 'PER', 4: 'NOR', 81: 'PIA', 16: 'LEC', 55: 'SAI', 44: 'HAM', 63: 'RUS', 14: 'ALO', 18: 'STR',
  10: 'GAS', 31: 'OCO', 23: 'ALB', 43: 'COL', 22: 'TSU', 30: 'LAW', 27: 'HUL', 50: 'BEA', 20: 'MAG', 77: 'BOT', 24: 'ZHO', 2: 'SAR',
};

export const DRAW: Record<Words, CarStatus> = { running: 'running', finished: 'running', pit: 'pit', garage: 'pit', stopped: 'stopped', out: 'out', dsq: 'dsq', dns: 'out', waiting: 'running' };
const CAR_STATE: Record<CarStatus, string> = { running: 'running', pit: 'pit', stopped: 'retired_suspected', out: 'retired', dsq: 'retired' };

export interface CarRead {
  number: number;
  code: string;
  name: string | null;
  words: Words;
  note: string;
  position: number | null;
  lap: number | null;
  tyre: { compound: string; age: number } | null;
  gap: string | null;
  lastPit: number | null;
  timing: 'car_state' | 'tape' | 'none';
  /** the incident the drawing follows, if any */
  incident: RaceIncidents | null;
  repairedSince: string | null;
  carState: CarState;
}

/** car_state is one row per car number across every weekend the desk ran: trust it only inside this session. */
function freshCarState(cs: CarState | undefined, tape: Tape): CarState | null {
  if (!cs || !tape.start || !tape.last) return null;
  if (cs.teamName && cs.teamName !== TEAM) return null;
  const t = sortTime(cs.updatedAt);
  return t >= sortTime(tape.start) - 15 * 60_000 && t <= sortTime(tape.last) + 15 * 60_000 ? cs : null;
}

export function readCar(n: number, race: RaceData, tape: Tape): CarRead {
  const t = tape.cars.get(n);
  const cs = freshCarState(race.cars.find((c) => c.driverNumber === n), tape);
  const S = tape.session;
  const incs = race.incidents.filter((i) => i.driverNumber === n).sort((a, b) => sortTime(a.firstSeenAt) - sortTime(b.firstSeenAt));
  const here = incs.filter((i) => i.sessionKey === S);
  const cur = here[here.length - 1] ?? null;
  const curB = cur ? readBelief(cur.beliefJson) : null;
  const dnsInc = incs.find((i) => {
    const b = readBelief(i.beliefJson);
    return b.dns && (b.missed_session === undefined || b.missed_session === S);
  });
  const lapsAfter = (at: string) => (t?.lapStarts ?? []).filter((x) => sortTime(x) > sortTime(at) + 5_000).length;

  let words: Words = 'running';
  let note = '';
  let incident: RaceIncidents | null = cur;
  let repairedSince: string | null = null;

  if (t?.retired?.dns || dnsInc) {
    words = 'dns';
    incident = dnsInc ?? cur;
    note = dnsInc && dnsInc.sessionKey !== S ? `not repaired after the ${SESSION_NAMES[dnsInc.sessionKey] ?? 'earlier'} crash` : 'not on the grid';
  } else if (t?.retired?.dsq) {
    words = 'dsq';
  } else if (t?.retired?.dnf) {
    words = 'out';
    note = `classified DNF${t.retired.laps !== null ? ` after ${t.retired.laps} laps` : ''}`;
  } else if (cur && curB) {
    const outOfSession = curB.out_of_session && (cur.status === 'confirmed' || cur.status === 'assessed' || cur.status === 'closed');
    const stoppedNow = curB.signature === 'stop' && !curB.laps_after && lapsAfter(cur.firstSeenAt) === 0;
    if (outOfSession) {
      words = 'out';
      note = tape.sessionName === 'Race' ? 'out of the race' : `out of ${tape.sessionName.toLowerCase()}`;
    } else if (stoppedNow) {
      words = 'stopped';
      note = `${curB.impact_kph ? `from ${curB.impact_kph} km/h` : 'on track'}${curB.lap ? ` on lap ${curB.lap}` : ''}`;
    } else if (curB.laps_after) {
      note = `carried on: ${curB.laps_after} laps since the incident`;
    }
  } else if (t?.retiredSuspectedAt && lapsAfter(t.retiredSuspectedAt) === 0) {
    words = 'stopped';
    note = 'laps stopped';
  }
  if (words === 'running' && cs) {
    if (cs.status === 'retired') words = 'out';
    else if (cs.status === 'retired_suspected') words = 'stopped';
    else if (cs.status === 'pit') words = 'pit';
  }
  if (words === 'running' && !t) words = 'waiting';
  if (words === 'running' && tape.track === 'CHEQUERED') words = 'finished';

  // an incident from an earlier session: the car ran since, so it was repaired and reads nominal
  if (!incident && incs.length) {
    const prev = incs[incs.length - 1]!;
    // a lap or a set of tyres fitted this session: the car went out again
    if (t && (t.lapStarts.length || t.stint)) repairedSince = `${SESSION_NAMES[prev.sessionKey] ?? 'the earlier session'} crash at ${clock(prev.firstSeenAt)}`;
    else {
      incident = prev;
      if (words === 'running' || words === 'waiting') {
        words = 'garage';
        note = `since the ${SESSION_NAMES[prev.sessionKey] ?? 'earlier'} crash; no lap this session`;
      }
    }
  }

  const lap = cs?.lap || t?.lap || null;
  const tyre = cs?.compound
    ? { compound: cs.compound.toUpperCase(), age: cs.tyreAge }
    : t?.stint
      ? { compound: t.stint.compound, age: Math.max(0, (lap ?? t.stint.lapStart) - t.stint.lapStart) + t.stint.ageAtStart }
      : null;
  const position = cs?.position || t?.position || null;
  const gap = cs?.gapToLeader || null;
  const lastPit = cs?.lastPitLap || t?.lastPit || null;
  const status = DRAW[words];
  const carState: CarState = {
    driverNumber: n,
    teamName: TEAM,
    position: position ?? 0,
    lap: lap ?? 0,
    compound: tyre?.compound ?? '',
    tyreAge: tyre?.age ?? 0,
    gapToLeader: gap ?? '',
    lastPitLap: lastPit ?? 0,
    status: CAR_STATE[status],
    updatedAt: cs?.updatedAt ?? tape.last ?? '',
  };
  return {
    number: n,
    code: tape.codes.get(n) ?? DRIVERS[n] ?? `#${n}`,
    name: NAMES[n] ?? null,
    words,
    note,
    position,
    lap,
    tyre,
    gap,
    lastPit,
    timing: cs ? 'car_state' : t ? 'tape' : 'none',
    incident,
    repairedSince,
    carState,
  };
}
