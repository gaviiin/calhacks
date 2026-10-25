import { lazy, Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Callout, ExplodeIcon, Legend, assessing, tonesFor, type StageCar } from '../../blueprint/CarBlueprint';
import { COST_LABELS, groupOf, type CostId } from '../../blueprint/catalog';
import { HEALTH_WORDS, LIKELY, POSSIBLE, healthOf, partsFor, type CarCondition, type CarStatus } from '../../blueprint/condition';
import type { BlueprintEngine } from '../../blueprint/engine/engine';
import { hasWebGL2 } from '../../blueprint/load';
import { IconApproved, IconDenied, IconFlag, IconLive, IconQuestion, IconRestart, IconWaiting } from '../../components/icons';
import { pct, usdShort } from '../../lib/format';
import { useRace, type RaceData } from '../../lib/race';
import { DRIVERS, TEAM, TRACK_LABEL, payloadOf, sortTime, trackStatus, type TrackStatus } from '../../lib/raceModel';
import type { CarState, RaceActions, RaceBeliefs, RaceEvents, RaceIncidents } from '../../module_bindings/types';
import { QuestionCard } from '../raceday/AskPanel';
import { ActButton, clock, parse, roleLabel } from '../raceday/shared';
import { SEVERITIES, incidentCondition, readBelief, repairedCondition, sparesFor, topSeverity, type Belief, type IncidentInput, type SpareReading } from './incidentCondition';
import './pitwall.css';

// The pit wall: for the pit crew and the race engineers. One card per Williams car, the blueprint lit by what the desk
// believes about the car right now (the incident belief, version by version), the car's state in words, its timing
// line, the parts likely damaged with where each replacement comes from, the garage check, the chief mechanic's damage
// question and any start-or-withdraw decision waiting for the Team Principal. Beside them, the track and the order.
// Nothing here is about another team's money.

const Sheet = lazy(() => import('../../blueprint/Sheet'));

const SESSION_NAMES: Record<number, string> = { 9627: 'Qualifying', 9636: 'Race', 11291: 'Race', 9693: 'Race' };
const NAMES: Record<number, string> = { 23: 'Alexander Albon', 43: 'Franco Colapinto', 55: 'Carlos Sainz' };

// ------------------------------------------------------------------------------------------ the tape, read per car

interface CarTape {
  lap: number | null;
  lapStarts: string[];
  position: number | null;
  stint: { compound: string; lapStart: number; ageAtStart: number } | null;
  lastPit: number | null;
  retiredSuspectedAt: string | null;
  retired: { dns: boolean; dnf: boolean; dsq: boolean; laps: number | null } | null;
  team: string;
}

interface Tape {
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

type Words = 'running' | 'pit' | 'garage' | 'stopped' | 'out' | 'dns' | 'dsq' | 'finished' | 'waiting';

const WORDS: Record<Words, { word: string; tone: string; icon: ReactNode }> = {
  running: { word: 'Running', tone: 'ok', icon: <IconLive size={13} /> },
  finished: { word: 'Finished', tone: 'ok', icon: <IconApproved size={13} /> },
  pit: { word: 'In the pit', tone: 'hold', icon: <IconWaiting size={13} /> },
  garage: { word: 'In the garage', tone: 'hold', icon: <IconWaiting size={13} /> },
  stopped: { word: 'Stopped', tone: 'alert', icon: <IconWaiting size={13} /> },
  out: { word: 'Out', tone: 'alert', icon: <IconDenied size={13} /> },
  dsq: { word: 'Disqualified', tone: 'alert', icon: <IconDenied size={13} /> },
  dns: { word: 'Did not start', tone: 'alert', icon: <IconDenied size={13} /> },
  waiting: { word: 'Not on track yet', tone: 'muted', icon: <IconWaiting size={13} /> },
};

const DRAW: Record<Words, CarStatus> = { running: 'running', finished: 'running', pit: 'pit', garage: 'pit', stopped: 'stopped', out: 'out', dsq: 'dsq', dns: 'out', waiting: 'running' };
const CAR_STATE: Record<CarStatus, string> = { running: 'running', pit: 'pit', stopped: 'retired_suspected', out: 'retired', dsq: 'retired' };

interface CarRead {
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

// ------------------------------------------------------------------------------------------ the view

export function PitWallView() {
  const race = useRace();
  const tape = useMemo(() => readTape(race.events), [race.events]);
  const numbers = useMemo(() => {
    const s = new Set<number>(tape.teamCars);
    for (const i of race.incidents) if (i.teamName === TEAM) s.add(i.driverNumber);
    if (!s.size) for (const n of [23, 43]) s.add(n);
    return [...s].sort((a, b) => a - b);
  }, [tape.teamCars, race.incidents]);
  const cars = useMemo(() => numbers.map((n) => readCar(n, race, tape)), [numbers, race, tape]);

  return (
    <div className="pw">
      <TrackPanel tape={tape} cars={cars} />
      <div className="pw-cars">
        {cars.map((c) => (
          <CarCard key={c.number} car={c} />
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ track and order

const TRACK_TONE: Record<TrackStatus, string> = { GREEN: 'ok', SC: 'hold', VSC: 'hold', RED: 'alert', CHEQUERED: 'muted', UNKNOWN: 'muted' };

function TrackPanel({ tape, cars }: { tape: Tape; cars: CarRead[] }) {
  const ours = new Map(cars.map((c) => [c.number, c]));
  const order = useMemo(() => {
    const rows = [...tape.cars.entries()]
      .filter(([, t]) => t.position)
      .map(([n, t]) => ({ n, pos: t.position!, team: t.team, out: !!t.retired || ours.get(n)?.words === 'out' || ours.get(n)?.words === 'stopped' || ours.get(n)?.words === 'dns' }));
    rows.sort((a, b) => Number(a.out) - Number(b.out) || a.pos - b.pos || a.n - b.n);
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tape, cars]);
  const tone = TRACK_TONE[tape.track];
  return (
    <aside className="pw-track" aria-label="Track and running order">
      <div className={`pw-flag pw-flag--${tone}`} role="status">
        <IconFlag size={16} />
        <span className="pw-flag-word">{TRACK_LABEL[tape.track]}</span>
      </div>
      <p className="pw-track-meta mono">
        {tape.sessionName}
        {tape.fieldLap ? ` · lap ${tape.fieldLap}` : ''}
        {tape.last ? ` · ${clock(tape.last)} UTC` : ''}
      </p>
      <h3 className="pw-h">Running order</h3>
      {order.length ? (
        <ol className="pw-order">
          {order.map((r, i) => {
            const mine = r.team === TEAM;
            return (
              <li key={r.n} className={`${mine ? 'pw-order--ours' : ''} ${r.out ? 'pw-order--out' : ''}`}>
                <span className="pw-order-pos mono">{r.out ? 'OUT' : i + 1}</span>
                <span className="pw-order-car mono">
                  {r.n} {tape.codes.get(r.n) ?? ''}
                </span>
                <span className="pw-order-team">{mine ? 'Williams' : r.team}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted small">No positions on the tape yet.</p>
      )}
      {cars.some((c) => c.words === 'dns') && (
        <p className="muted small pw-dns">
          {cars
            .filter((c) => c.words === 'dns')
            .map((c) => `${c.number} ${c.code}`)
            .join(', ')}{' '}
          did not start.
        </p>
      )}
    </aside>
  );
}

// ------------------------------------------------------------------------------------------ one car card

function timingLine(c: CarRead): string {
  const bits: string[] = [];
  if (c.words === 'dns') bits.push('no grid slot');
  else bits.push(c.position ? `P${c.position}` : 'P—');
  if (c.lap) bits.push(`lap ${c.lap}`);
  if (c.tyre && c.words !== 'dns') bits.push(`${c.tyre.compound} ${c.tyre.age} lap${c.tyre.age === 1 ? '' : 's'}`);
  if (c.gap) bits.push(c.gap);
  if (c.lastPit) bits.push(`pit L${c.lastPit}`);
  return bits.join(' · ');
}

/** Keep a condition by value, so a new event that changes nothing about the car does not re-tone the drawing. */
function useStable<T>(value: T): T {
  const ref = useRef<{ key: string; v: T } | null>(null);
  const key = JSON.stringify(value);
  if (!ref.current || ref.current.key !== key) ref.current = { key, v: value };
  return ref.current.v;
}

function CarCard({ car }: { car: CarRead }) {
  const race = useRace();
  const inc = car.incident;
  const history = useMemo(
    () => (inc ? race.beliefs.filter((b) => b.incidentKey === inc.incidentKey).sort((a, b) => a.version - b.version) : []),
    [race.beliefs, inc],
  );
  const [picked, setPicked] = useState<number | null>(null);
  const pickedRow = picked !== null ? history.find((h) => h.version === picked) ?? null : null;
  const input: IncidentInput | null = inc
    ? pickedRow
      ? { incident: inc, beliefJson: pickedRow.beliefJson, version: pickedRow.version, status: pickedRow.status, at: pickedRow.at }
      : { incident: inc, beliefJson: inc.beliefJson, version: inc.version, status: inc.status, at: inc.updatedAt }
    : null;
  const status = DRAW[car.words];
  const fresh = car.repairedSince
    ? repairedCondition(car.carState, status, race.effects, race.forecasts, car.repairedSince)
    : incidentCondition(car.carState, status, input, race.effects, race.forecasts, race.actions);
  const condition = useStable(fresh);
  const belief = input ? readBelief(input.beliefJson) : null;
  const [hoverPart, setHoverPart] = useState<CostId | null>(null);

  const stageCar = useMemo<StageCar>(
    () => ({ number: car.number, code: car.code, team: TEAM, position: car.position, lap: car.lap, gap: car.gap, lastPit: car.lastPit, condition }),
    [car.number, car.code, car.position, car.lap, car.gap, car.lastPit, condition],
  );
  const w = WORDS[car.words];
  const actions = inc ? race.actions.filter((a) => a.incidentKey === inc.incidentKey) : [];

  return (
    <article className={`pw-car pw-car--${w.tone}`} aria-labelledby={`pw-car-${car.number}`}>
      <header className="pw-car-head">
        <div className="pw-car-id">
          <span className="pw-car-num mono">{car.number}</span>
          <div>
            <h2 id={`pw-car-${car.number}`}>
              {car.code}
              {car.name ? <span className="pw-car-name"> {car.name}</span> : null}
            </h2>
            <p className="pw-timing mono" title={car.timing === 'tape' ? 'From the timing tape (positions, laps, stints)' : car.timing === 'car_state' ? 'From car_state' : 'No timing yet'}>
              {timingLine(car)}
            </p>
          </div>
        </div>
        <div className={`pw-status pw-status--${w.tone}`} role="status">
          {w.icon}
          <b>{w.word}</b>
          {car.note ? <span className="pw-status-note">{car.note}</span> : null}
        </div>
      </header>

      <div className="pw-car-body">
        <div className="pw-car-sheet">
          <PitSheet car={stageCar} highlightCost={hoverPart} />
          {pickedRow ? (
            <p className="pw-replaying" role="status">
              <IconRestart size={12} /> Showing belief v{pickedRow.version} as at {clock(pickedRow.at)}.{' '}
              <button type="button" className="pw-linkbtn" onClick={() => setPicked(null)}>
                Back to live
              </button>
            </p>
          ) : null}
          {inc ? <BeliefHistory history={history} live={inc.version} picked={picked} onPick={setPicked} /> : null}
        </div>

        <div className="pw-car-side">
          {car.repairedSince ? (
            <p className="pw-quiet">
              <IconApproved size={13} /> Repaired after the {car.repairedSince}; every part reads nominal.
            </p>
          ) : !inc ? (
            <p className="pw-quiet">
              <IconApproved size={13} /> No incident this weekend. {condition.source !== 'none' ? `${condition.label}.` : 'Every part reads nominal.'}
            </p>
          ) : (
            <>
              <BeliefNow key={`${inc.incidentKey}:${input!.version}`} inc={inc} belief={belief!} version={input!.version} status={input!.status} at={input!.at} live={!pickedRow} />
              <PartsList condition={condition} spares={sparesFor(race.actions, inc.incidentKey)} onHover={setHoverPart} />
              <GarageCheck actions={actions} />
              <DamageQuestions incidentKey={inc.incidentKey} />
              <WithdrawDecision actions={actions} />
            </>
          )}
        </div>
      </div>
    </article>
  );
}

// ------------------------------------------------------------------------------------------ the drawing

function PitSheet({ car, highlightCost }: { car: StageCar; highlightCost: CostId | null }) {
  const [exploded, setExploded] = useState(false);
  const [pointer, setPointer] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [webgl] = useState(hasWebGL2);
  const engineRef = useRef<BlueprintEngine | null>(null);
  const c = car.condition;
  const tones = useMemo(() => tonesFor('condition', c), [c]);
  const highlight = useMemo(() => (highlightCost ? partsFor(highlightCost) : []), [highlightCost]);
  const pinned = useMemo(() => (pin ? groupOf(pin) : []), [pin]);
  const active = pointer ?? (highlight[0] || null) ?? pin;
  const onPick = useCallback((id: string | null) => setPin((cur) => (!id || (cur && groupOf(cur).includes(id)) ? null : id)), []);

  if (!webgl || failed) {
    return <p className="muted small pw-nogl">{failed ? `The 3D drawing could not start: ${failed}` : 'This browser has no WebGL 2, so the 3D drawing is off; the parts list beside it reads the same belief.'}</p>;
  }
  return (
    <div className="bp-stage bp-stage--replay pw-stage" onKeyDown={(e) => (e.key === 'Escape' ? setPin(null) : e.key === 'e' || e.key === 'E' ? setExploded((x) => !x) : null)}>
      <Suspense fallback={<div className="bp-sheet bp-sheet--compact bp-sheet--wait" />}>
        <Sheet
          variant="compact"
          tones={tones}
          highlight={highlight}
          highlightPull={false}
          pinned={pinned}
          exploded={exploded}
          active={active}
          onHover={setPointer}
          onPick={onPick}
          engineRef={engineRef}
          onError={(e) => setFailed(e.message)}
          callout={(id) => <Callout id={id} car={car} />}
          heroTitle={
            <>
              <span className="bp-iso">Iso view · {c.label}</span>
              <span className="bp-iso-car">
                Car {car.number} · {car.code}
              </span>
              <Legend lens="condition" unknown={assessing(c)} />
            </>
          }
          heroCorner={
            <div className="bp-replay-tools">
              <button type="button" className={`btn pillbtn bp-explode${exploded ? ' is-on' : ''}`} aria-pressed={exploded} onClick={() => setExploded((x) => !x)} title="E">
                <ExplodeIcon open={exploded} />
                {exploded ? 'Assemble' : 'Explode'}
              </button>
              <button type="button" className="bp-reset" onClick={() => engineRef.current?.resetView()} aria-label="Reset the view">
                <IconRestart size={12} />
              </button>
            </div>
          }
        />
      </Suspense>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ what we believe now

const SEV_TONE: Record<string, string> = { heavy: 'alert', moderate: 'hold', light: 'steel', none: 'line' };

function SeverityBar({ belief }: { belief: Belief }) {
  const sev = belief.severity ?? {};
  const total = SEVERITIES.reduce((s, k) => s + (sev[k] ?? 0), 0);
  if (!total) return null;
  return (
    <div className="pw-sev" aria-label="P(severity)">
      <div className="pw-sev-bar" aria-hidden>
        {SEVERITIES.map((k) => (sev[k] ? <i key={k} className={`pw-sev--${SEV_TONE[k]}`} style={{ flexGrow: sev[k] }} /> : null))}
      </div>
      <p className="pw-sev-keys mono">
        {SEVERITIES.filter((k) => sev[k]).map((k) => (
          <span key={k}>
            {k} {pct(sev[k]!, 0)}
          </span>
        ))}
      </p>
    </div>
  );
}

function BeliefNow({ inc, belief, version, status, at, live }: { inc: RaceIncidents; belief: Belief; version: number; status: string; at: string; live: boolean }) {
  const top = topSeverity(belief);
  const what: string[] = [];
  if (belief.impact_kph) what.push(`stopped from ${belief.impact_kph} km/h${belief.decel_g ? `, ${belief.decel_g} g` : ''}`);
  else what.push('race-control incident');
  if (belief.where) what.push(belief.where.startsWith('L') ? `lap ${belief.where.slice(1)}` : belief.where);
  if (belief.session_type) what.push(belief.session_type.toLowerCase());
  return (
    <section className={`pw-now ${live ? 'pw-now--live' : ''}`}>
      <p className="pw-now-top">
        <span className="pw-chip mono">
          v{version} · {status}
        </span>
        <span className="muted mono">{clock(at)} UTC</span>
        {live ? <span className="pw-livechip">live</span> : null}
      </p>
      <p className="pw-now-what">
        {what.join(' · ')}
        {top ? (
          <>
            {' · '}
            <b>
              {belief.assessed_as ? `assessed ${belief.assessed_as}` : `${top.name} ${pct(top.p, 0)}`}
            </b>
          </>
        ) : null}
      </p>
      <SeverityBar belief={belief} />
      {inc.cause && live ? <p className="muted small pw-cause">Last change: {inc.cause}</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------------------------------ parts and spares

const HEALTH_MARK: Record<string, string> = { damaged: '✕', watch: '△', ok: '○' };

function spareWords(s: SpareReading | undefined, p: number): { text: string; tone: string } {
  if (!s) return p >= LIKELY ? { text: 'not reserved yet', tone: 'hold' } : { text: 'not reserved (P under 50%)', tone: 'muted' };
  if (s.released) return { text: 'reservation released', tone: 'muted' };
  if (s.source === 'at_track') return { text: `at track${s.atTrackAfter !== null ? `, ${s.atTrackAfter} left after this` : ''}`, tone: 'ok' };
  if (s.source === 'factory') return { text: 'from the factory (Grove)', tone: 'hold' };
  return { text: 'to be made', tone: 'alert' };
}

function PartsList({ condition, spares, onHover }: { condition: CarCondition; spares: Partial<Record<CostId, SpareReading>>; onHover: (c: CostId | null) => void }) {
  const rows = (Object.entries(condition.parts) as [CostId, { p: number; repair?: boolean }][])
    .filter(([k, r]) => r.p >= POSSIBLE || spares[k])
    .sort((a, b) => b[1].p - a[1].p);
  if (!rows.length) return <p className="muted small">No part above {pct(POSSIBLE, 0)} in this belief.</p>;
  return (
    <section>
      <h3 className="pw-h">Parts likely damaged</h3>
      <ul className="pw-parts" onMouseLeave={() => onHover(null)}>
        {rows.map(([k, r]) => {
          const h = healthOf(r.p);
          const s = spareWords(spares[k], r.p);
          return (
            <li key={k} className={`pw-part pw-part--${h}`} onMouseEnter={() => onHover(k)} onFocus={() => onHover(k)} tabIndex={0}>
              <span className="pw-part-mark" aria-hidden>
                {HEALTH_MARK[h]}
              </span>
              <span className="pw-part-name">
                {COST_LABELS[k]}
                {r.repair ? <span className="muted"> (repair)</span> : null}
                <span className="pw-sr"> {HEALTH_WORDS[h]}</span>
              </span>
              <span className="pw-part-p mono">P {pct(r.p, 0)}</span>
              <span className={`pw-part-spare pw-tone--${s.tone}`}>{s.text}</span>
              <i className="pw-part-bar" style={{ width: `${Math.round(r.p * 100)}%` }} aria-hidden />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------------------------------ garage, question, decision

function GarageCheck({ actions }: { actions: RaceActions[] }) {
  const race = useRace();
  const a = actions.find((x) => x.kind === 'garage_check');
  if (!a) return null;
  const d = parse<{ why?: string }>(a.detailJson, {});
  const done = a.status === 'done' || a.status === 'approved';
  const off = a.status === 'cancelled' || a.status === 'rejected';
  return (
    <section className={`pw-box ${done ? 'pw-box--ok' : off ? '' : 'pw-box--hold'}`}>
      <h3 className="pw-h">
        Garage check <span className="pw-owner">for the {roleLabel(a.ownerRole)}</span>
      </h3>
      <p className="small">{d.why ?? a.title}</p>
      {done ? (
        <p className="small pw-tone--ok">
          <IconApproved size={12} /> Checked{a.decidedBy.startsWith('person:') ? ` by ${a.decidedBy.slice(7)}` : ''} at {clock(a.updatedAt)}
        </p>
      ) : off ? (
        <p className="small muted">Cancelled.</p>
      ) : (
        <ActButton label="Mark the car checked" run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'done', by, at })} />
      )}
    </section>
  );
}

function DamageQuestions({ incidentKey }: { incidentKey: string }) {
  const race = useRace();
  const qs = race.questions.filter((q) => q.incidentKey === incidentKey && q.kind === 'damage');
  if (!qs.length) return null;
  const open = qs.filter((q) => q.status === 'open');
  const shut = qs.filter((q) => q.status !== 'open');
  return (
    <section>
      <h3 className="pw-h">
        <IconQuestion size={13} /> Damage question
      </h3>
      {open.length ? (
        <ul className="questions pw-questions">
          {open.map((q) => (
            <QuestionCard key={q.questionKey} q={q} />
          ))}
        </ul>
      ) : null}
      {shut.map((q) => {
        const opts = parse<{ id: string; label: string }[]>(q.optionsJson, []);
        const ans = parse<{ option?: string; defaulted?: boolean }>(q.answerJson, {});
        const label = opts.find((o) => o.id === ans.option)?.label ?? ans.option ?? 'answered';
        return (
          <p key={q.questionKey} className="small muted">
            {ans.defaulted ? `Nobody answered by ${clock(q.deadlineAt)}; the desk took the default: ${label}.` : `Answered by ${q.answeredBy}: ${label}.`}
          </p>
        );
      })}
    </section>
  );
}

interface WithdrawOption {
  id: string;
  label: string;
  hours_needed: [number, number, number];
  feasible: boolean;
  cost_cents: [number, number, number];
  expected_points: number;
  risk: string;
}

interface WithdrawDetail {
  car?: number;
  grid?: number | null;
  grid_basis?: string;
  race_start?: string;
  hours_available?: number;
  p_heavy?: number;
  p_tub?: number;
  options?: WithdrawOption[];
  summary?: string;
  outcome?: string;
  chosen?: string;
  chosen_by?: string;
}

function WithdrawDecision({ actions }: { actions: RaceActions[] }) {
  const a = actions.find((x) => x.kind === 'withdraw_car' && (x.status === 'awaiting_approval' || x.status === 'approved'));
  if (!a) return null;
  const d = parse<WithdrawDetail>(a.detailJson, {});
  const waiting = a.status === 'awaiting_approval' && !d.chosen;
  return (
    <section className={`pw-box ${waiting ? 'pw-box--hold' : 'pw-box--ok'}`}>
      <h3 className="pw-h">
        Start or withdraw <span className="pw-owner">the {roleLabel(a.ownerRole)} decides{a.dueAt ? ` by ${clock(a.dueAt)}` : ''}</span>
      </h3>
      <p className="small">
        {d.hours_available !== undefined ? `${d.hours_available.toFixed(1)} h from the crash to the start` : ''}
        {d.grid ? ` · grid P${d.grid} (${d.grid_basis})` : ''}
        {d.p_tub !== undefined ? ` · P(tub damaged) ${pct(d.p_tub, 0)}` : ''}
      </p>
      <ol className="pw-options">
        {(d.options ?? []).map((o) => (
          <li key={o.id} className={`pw-option ${o.feasible ? '' : 'pw-option--no'} ${d.chosen === o.id ? 'pw-option--chosen' : ''}`}>
            <p className="pw-option-top">
              <b>{o.label}</b>
              <span className={`pw-chip ${o.feasible ? 'pw-tone--ok' : 'pw-tone--alert'}`}>{o.feasible ? 'fits the time' : 'does not fit'}</span>
              {d.chosen === o.id ? <span className="pw-chip pw-tone--ok">chosen by {d.chosen_by ?? 'the Team Principal'}</span> : null}
            </p>
            <p className="mono small">
              {o.hours_needed[1] ? `${o.hours_needed[1].toFixed(1)} h (${o.hours_needed[0].toFixed(1)}–${o.hours_needed[2].toFixed(1)})` : 'no garage time'} · {o.expected_points.toFixed(1)} pts expected
              {o.cost_cents[1] ? ` · ${usdShort(o.cost_cents[1])}` : ''}
            </p>
            <p className="small muted">{o.risk}</p>
          </li>
        ))}
      </ol>
      <p className="small muted">The desk priced three options and recommends none.{d.outcome ? ` Outcome: ${d.outcome}.` : ''}</p>
    </section>
  );
}

// ------------------------------------------------------------------------------------------ what we believed when

const SHORT: Record<string, string> = {
  front_wing: 'front wing', rear_wing: 'rear wing', floor: 'floor', bodywork: 'bodywork', front_suspension: 'front susp.', rear_suspension: 'rear susp.',
  chassis: 'tub', gearbox: 'gearbox', power_unit: 'PU', electronics: 'loom', brakes: 'brakes', steering_rack: 'steering',
};

function topParts(b: Belief, n = 3): string {
  const parts = Object.entries(b.parts ?? {})
    .filter(([k]) => k !== 'chassis_repair')
    .sort((x, y) => y[1] - x[1])
    .slice(0, n);
  return parts.map(([k, p]) => `${SHORT[k] ?? k.replace(/_/g, ' ')} ${pct(p, 0)}`).join(', ');
}

function BeliefHistory({ history, live, picked, onPick }: { history: RaceBeliefs[]; live: number; picked: number | null; onPick: (v: number | null) => void }) {
  if (!history.length) return null;
  return (
    <section>
      <h3 className="pw-h">What we believed when</h3>
      <ol className="pw-history">
        {history.map((h) => {
          const b = readBelief(h.beliefJson);
          const top = topSeverity(b);
          const on = picked === h.version || (picked === null && h.version === live);
          return (
            <li key={h.beliefKey} className={on ? 'pw-history--on' : ''}>
              <button type="button" onClick={() => onPick(h.version === live ? null : h.version)} aria-pressed={on} title="Light the car with this belief">
                <span className="pw-history-v mono">v{h.version}</span>
                <span className="pw-history-at mono">{clock(h.at)}</span>
                <span className="pw-history-status">{h.status}</span>
                <span className="pw-history-cause">{h.cause}</span>
                <span className="pw-history-read mono muted">
                  {top ? `${b.assessed_as ? `assessed ${b.assessed_as}` : `${top.name} ${pct(top.p, 0)}`}` : 'no severity'}
                  {b.parts && Object.keys(b.parts).length ? ` · ${topParts(b)}` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
