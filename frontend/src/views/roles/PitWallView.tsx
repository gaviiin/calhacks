import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { Callout, ExplodeIcon, Legend, assessing, tonesFor, type StageCar } from '../../blueprint/CarBlueprint';
import { COST_LABELS, groupOf, type CostId } from '../../blueprint/catalog';
import { HEALTH_WORDS, LIKELY, POSSIBLE, healthOf, partsFor, type CarCondition } from '../../blueprint/condition';
import type { BlueprintEngine } from '../../blueprint/engine/engine';
import { hasWebGL2 } from '../../blueprint/load';
import { IconRestart } from '../../components/icons';
import { pct, usdShort } from '../../lib/format';
import { useRace } from '../../lib/race';
import { TEAM, TRACK_LABEL, sortTime } from '../../lib/raceModel';
import type { RaceActions, RaceBeliefs, RaceIncidents } from '../../module_bindings/types';
import { QuestionCard } from '../raceday/AskPanel';
import { ActButton, clock, parse, roleLabel } from '../raceday/shared';
import { SEVERITIES, incidentCondition, readBelief, repairedCondition, sparesFor, topSeverity, type Belief, type IncidentInput, type SpareReading } from './incidentCondition';
import { DRAW, GRID_2024, WORDS, readCar, readTape, type CarRead, type Tape } from './carRead';
import { Axis, Figure, Meter, Panel, Pill, Stack, type Tone } from './kit';
import { NextSteps } from './NextSteps';
import { PartLifePanel } from './PartLife';
import './pitwall.css';

// The pit wall: for the pit crew and the race engineers. Three questions, per Williams car: what is its condition now
// (the blueprint lit by the incident belief, version by version), which parts are likely broken and is there a spare,
// and will it run (the garage check, the damage question, the start-or-withdraw options). Beside them, the track and
// the order. Explanations live in hover titles; nothing here is about another team's money.

const Sheet = lazy(() => import('../../blueprint/Sheet'));


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
        <NextSteps />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ track and order

function TrackPanel({ tape, cars }: { tape: Tape; cars: CarRead[] }) {
  const ours = new Map(cars.map((c) => [c.number, c]));
  const order = useMemo(() => {
    const rows = [...tape.cars.entries()]
      .filter(([, t]) => t.position)
      .map(([n, t]) => {
        const w = ours.get(n)?.words;
        const dns = !!t.retired?.dns || w === 'dns';
        return { n, pos: t.position!, team: t.team, dns, out: dns || !!t.retired || w === 'out' || w === 'stopped' };
      });
    rows.sort((a, b) => Number(a.out) - Number(b.out) || a.pos - b.pos || a.n - b.n);
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tape, cars]);
  return (
    <aside className="pw-rail" aria-label="Track and running order">
      <Panel title="Track" aside={tape.last ? `${clock(tape.last)} UTC` : undefined} className="pw-trackp">
        <div className={`pw-flag pw-flag--${tape.track}`} role="status">
          <i className="pw-flagmark" aria-hidden />
          <b>{TRACK_LABEL[tape.track]}</b>
        </div>
        <div className="pw-track-figs">
          <Figure size="sm" label="Session" value={tape.sessionName} />
          <Figure size="sm" label="Lap" value={tape.fieldLap ?? '—'} />
        </div>
      </Panel>
      <Panel title="Running order" aside={order.length ? `${order.filter((r) => !r.out).length} running` : undefined} className="pw-orderp">
        {order.length ? (
          <ol className="pw-order">
            {order.map((r, i) => {
              const mine = r.team === TEAM;
              return (
                <li key={r.n} className={`${mine ? 'pw-order--ours' : ''} ${r.out ? 'pw-order--out' : ''}`} title={r.team}>
                  <span className="pw-order-pos">{r.out ? (r.dns ? 'DNS' : 'OUT') : i + 1}</span>
                  <span className="pw-order-num">{r.n}</span>
                  <span className="pw-order-code">{tape.codes.get(r.n) ?? GRID_2024[r.n] ?? ''}</span>
                  <span className="pw-order-team">{mine ? 'Williams' : r.team}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="pw-empty">Positions appear with the first lap.</p>
        )}
      </Panel>
    </aside>
  );
}

// ------------------------------------------------------------------------------------------ one car card

const COMPOUND: Record<string, string> = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };

function TimingStrip({ c }: { c: CarRead }) {
  const source = c.timing === 'tape' ? 'From the timing tape (positions, laps, stints)' : c.timing === 'car_state' ? 'From car_state' : 'No timing yet';
  if (c.words === 'dns')
    return (
      <dl className="pw-timing" title={source}>
        <div>
          <dt>Grid</dt>
          <dd>No slot</dd>
        </div>
      </dl>
    );
  return (
    <dl className="pw-timing" title={source}>
      <div>
        <dt>Pos</dt>
        <dd>{c.position ? `P${c.position}` : '—'}</dd>
      </div>
      <div>
        <dt>Lap</dt>
        <dd>{c.lap ?? '—'}</dd>
      </div>
      {c.tyre ? (
        <div title={`${c.tyre.compound.toLowerCase()}, ${c.tyre.age} lap${c.tyre.age === 1 ? '' : 's'} old`}>
          <dt>Tyre</dt>
          <dd>
            <i className={`pw-tyre pw-tyre--${COMPOUND[c.tyre.compound] ?? 'X'}`} aria-hidden>
              {COMPOUND[c.tyre.compound] ?? c.tyre.compound.slice(0, 1)}
            </i>
            {c.tyre.age}
            <span className="pw-sr"> laps on {c.tyre.compound.toLowerCase()}</span>
          </dd>
        </div>
      ) : null}
      {c.gap ? (
        <div>
          <dt>Gap</dt>
          <dd>{c.gap}</dd>
        </div>
      ) : null}
      {c.lastPit ? (
        <div>
          <dt>Pit</dt>
          <dd>L{c.lastPit}</dd>
        </div>
      ) : null}
    </dl>
  );
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
  const hasQuestion = !!inc && race.questions.some((q) => q.incidentKey === inc.incidentKey && q.kind === 'damage');
  const hasDecision = actions.some((x) => x.kind === 'withdraw_car' && (x.status === 'awaiting_approval' || x.status === 'approved'));

  return (
    <article className="k-panel pw-car" aria-labelledby={`pw-car-${car.number}`}>
      <header className="pw-car-head">
        <span className="pw-car-num" aria-hidden>
          {car.number}
        </span>
        <div className="pw-car-id">
          <h2 id={`pw-car-${car.number}`}>
            <span className="pw-sr">Car {car.number} </span>
            {car.code}
            {car.name ? <span className="pw-car-name">{car.name}</span> : null}
          </h2>
          <TimingStrip c={car} />
        </div>
        <div className="pw-car-state" role="status" title={car.note || undefined}>
          <Pill tone={w.tone}>{w.word}</Pill>
          {car.note ? <span className="pw-car-note">{car.note}</span> : null}
        </div>
      </header>

      <div className="pw-car-body">
        <div className="pw-car-sheet">
          <PitSheet car={stageCar} highlightCost={hoverPart} />
          {inc ? <BeliefHistory history={history} live={inc.version} picked={pickedRow ? picked : null} onPick={setPicked} /> : null}
        </div>

        <div className="pw-car-side">
          {car.repairedSince ? (
            <p className="pw-quiet" title={`Repaired after the ${car.repairedSince}; every part reads nominal.`}>
              <Pill tone="info">All parts nominal</Pill>
              <span>Repaired after the {car.repairedSince}</span>
            </p>
          ) : !inc ? (
            <p className="pw-quiet" title={condition.source !== 'none' ? condition.label : 'Every part reads nominal.'}>
              <Pill tone="info">No incident</Pill>
              <span>{condition.source !== 'none' ? condition.label : 'Every part reads nominal'}</span>
            </p>
          ) : (
            <>
              <BeliefNow key={`${inc.incidentKey}:${input!.version}`} inc={inc} belief={belief!} version={input!.version} status={input!.status} at={input!.at} live={!pickedRow} />
              <PartsTable condition={condition} spares={sparesFor(race.actions, inc.incidentKey)} onHover={setHoverPart} />
              <GarageCheck actions={actions} />
            </>
          )}
          <PartLifePanel car={car.number} />
        </div>
      </div>

      {inc && (hasQuestion || hasDecision) ? (
        <div className={`pw-car-foot ${hasQuestion && hasDecision ? 'pw-car-foot--two' : ''}`}>
          <DamageQuestions incidentKey={inc.incidentKey} />
          <WithdrawDecision actions={actions} />
        </div>
      ) : null}
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
    return (
      <p className="pw-nogl" title={failed ?? 'This browser has no WebGL 2; the parts table reads the same belief.'}>
        {failed ? 'The 3D drawing could not start.' : 'No WebGL 2 here: the drawing is off; the parts table reads the same belief.'}
      </p>
    );
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

const SEV_TONE: Record<string, 'bad' | 'wait' | 'neutral' | 'gray'> = { heavy: 'bad', moderate: 'wait', light: 'neutral', none: 'gray' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function sevParts(b: Belief) {
  const sev = b.severity ?? {};
  return SEVERITIES.filter((k) => (sev[k] ?? 0) > 0).map((k) => ({ label: cap(k), value: sev[k]!, tone: SEV_TONE[k] }));
}

function BeliefNow({ inc, belief, version, status, at, live }: { inc: RaceIncidents; belief: Belief; version: number; status: string; at: string; live: boolean }) {
  const top = topSeverity(belief);
  const parts = sevParts(belief);
  const lap = belief.where?.startsWith('L') ? belief.where.slice(1) : belief.lap ? String(belief.lap) : null;
  const place = belief.where && !belief.where.startsWith('L') ? belief.where : null;
  return (
    <section className={`pw-now ${live ? 'pw-now--live' : ''}`} title={inc.cause && live ? `Last change: ${inc.cause}` : undefined}>
      <h3 className="pw-h">
        Damage belief
        {live ? <Pill tone="info">Live</Pill> : <Pill tone="wait">Replay</Pill>}
        <span className="pw-h-aside">
          v{version} · {status} · {clock(at)}
        </span>
      </h3>
      <div className="pw-now-figs">
        <Figure
          size="sm"
          label="Impact"
          value={belief.impact_kph ? `${belief.impact_kph} km/h` : '—'}
          sub={belief.impact_kph ? (belief.decel_g ? `${belief.decel_g} g` : undefined) : 'race control'}
        />
        <Figure size="sm" label={lap ? 'Lap' : 'Where'} value={lap ?? place ?? '—'} sub={belief.session_type ? cap(belief.session_type.toLowerCase()) : undefined} />
        <Figure
          size="sm"
          label={belief.assessed_as ? 'Assessed' : 'Likeliest'}
          value={belief.assessed_as ? cap(belief.assessed_as) : top ? cap(top.name) : '—'}
          sub={!belief.assessed_as && top ? pct(top.p, 0) : belief.assessed_by ? `by ${belief.assessed_by}` : undefined}
        />
      </div>
      {parts.length ? <Stack parts={parts} height={8} /> : <p className="pw-empty">Severity appears once the desk reads the stop.</p>}
    </section>
  );
}

// ------------------------------------------------------------------------------------------ parts and spares

const HEALTH_TONE: Record<string, Tone> = { damaged: 'bad', watch: 'wait', ok: 'neutral' };

function sparePill(s: SpareReading | undefined, p: number): { text: string; tone: Tone; title: string } {
  if (!s)
    return p >= LIKELY
      ? { text: 'Not reserved', tone: 'wait', title: 'Likely damaged and no spare reserved yet' }
      : { text: 'Not reserved', tone: 'neutral', title: `Not reserved: P under ${pct(LIKELY, 0)}` };
  if (s.released) return { text: 'Released', tone: 'neutral', title: 'Reservation released: the belief dropped below the line' };
  if (s.source === 'at_track')
    return { text: s.atTrackAfter !== null ? `At track · ${s.atTrackAfter} left` : 'At track', tone: 'info', title: `Spare at the track${s.atTrackAfter !== null ? `; ${s.atTrackAfter} left after this one` : ''}` };
  if (s.source === 'factory') return { text: 'Grove', tone: 'wait', title: `From the factory (Grove)${s.factoryAfter !== null ? `; ${s.factoryAfter} left there after this` : ''}` };
  return { text: 'To be made', tone: 'bad', title: 'No spare: the part has to be made' };
}

function PartsTable({ condition, spares, onHover }: { condition: CarCondition; spares: Partial<Record<CostId, SpareReading>>; onHover: (c: CostId | null) => void }) {
  const rows = (Object.entries(condition.parts) as [CostId, { p: number; repair?: boolean }][])
    .filter(([k, r]) => r.p >= POSSIBLE || spares[k])
    .sort((a, b) => b[1].p - a[1].p);
  const likely = rows.filter(([, r]) => r.p >= LIKELY).length;
  return (
    <section className="pw-parts-wrap">
      <h3 className="pw-h" title={`Parts at or above ${pct(POSSIBLE, 0)} P(damaged), or with a spare reservation. Hover a row to find it on the car.`}>
        Parts
        <span className="pw-h-aside">{rows.length ? `${likely} likely · ${rows.length - likely} possible` : ''}</span>
      </h3>
      {rows.length ? (
        <ul className="pw-parts" onMouseLeave={() => onHover(null)}>
          <li className="pw-parts-head" aria-hidden>
            <span>Part</span>
            <span>P(damaged)</span>
            <span>Spare</span>
          </li>
          {rows.map(([k, r]) => {
            const h = healthOf(r.p);
            const s = sparePill(spares[k], r.p);
            return (
              <li key={k} className={`pw-part pw-part--${h}`} onMouseEnter={() => onHover(k)} onFocus={() => onHover(k)} tabIndex={0}>
                <span className="pw-part-name" title={COST_LABELS[k]}>
                  {COST_LABELS[k]}
                  {r.repair ? <span className="pw-part-tag">repair</span> : null}
                  <span className="pw-sr"> {HEALTH_WORDS[h]}</span>
                </span>
                <span className="pw-part-p" title={`${HEALTH_WORDS[h]}: P ${pct(r.p, 0)} (ticks at ${pct(POSSIBLE, 0)} and ${pct(LIKELY, 0)})`}>
                  <Meter value={r.p} max={1} tone={HEALTH_TONE[h]} ticks={[{ at: POSSIBLE, label: `possible ${pct(POSSIBLE, 0)}` }, { at: LIKELY, label: `likely ${pct(LIKELY, 0)}` }]} />
                  <b>{pct(r.p, 0)}</b>
                </span>
                <span className="pw-part-spare">
                  <Pill tone={s.tone} title={s.title}>
                    {s.text}
                  </Pill>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="pw-empty">No part above {pct(POSSIBLE, 0)} in this belief.</p>
      )}
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
  const by = a.decidedBy.startsWith('person:') ? a.decidedBy.slice(7) : null;
  return (
    <section className="pw-garage" title={d.why ?? a.title}>
      <h3 className="pw-h">
        Garage check
        <span className="pw-h-aside">{roleLabel(a.ownerRole)}</span>
      </h3>
      <div className="pw-garage-row">
        {done ? (
          <>
            <Pill tone="ok">Checked</Pill>
            <span className="pw-mono-sm">
              {by ? `${by} · ` : ''}
              {clock(a.updatedAt)}
            </span>
          </>
        ) : off ? (
          <Pill tone="neutral">Cancelled</Pill>
        ) : (
          <>
            <Pill tone="wait">Not checked</Pill>
            <ActButton label="Mark the car checked" run={(by2, at) => race.decideAction({ actionKey: a.actionKey, status: 'done', by: by2, at })} />
          </>
        )}
      </div>
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
    <section className="pw-block pw-q">
      <h3 className="pw-h">
        Damage question
        {open.length ? <Pill tone="wait">Open</Pill> : null}
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
        const full = ans.defaulted ? `Nobody answered by ${clock(q.deadlineAt)}; the desk took the default: ${label}.` : `Answered by ${q.answeredBy}: ${label}.`;
        return (
          <p key={q.questionKey} className="pw-answer" title={`${q.prompt}\n${full}`}>
            {ans.defaulted ? <Pill tone="neutral">Default {clock(q.deadlineAt)}</Pill> : <Pill tone="ok">{q.answeredBy}</Pill>}
            <span>{label}</span>
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
  const opts = d.options ?? [];
  const avail = d.hours_available;
  const max = Math.max(avail ?? 0, ...opts.map((o) => o.hours_needed[2] ?? 0), 1) * 1.05;
  return (
    <section className="pw-block pw-wd" title={d.summary}>
      <h3 className="pw-h">
        Start or withdraw
        {waiting ? <Pill tone="wait">Waiting</Pill> : null}
        <span className="pw-h-aside">
          {roleLabel(a.ownerRole)}
          {a.dueAt ? ` · by ${clock(a.dueAt)}` : ''}
        </span>
      </h3>
      <div className="pw-wd-facts">
        {avail !== undefined ? <Figure size="sm" label="Hours to start" value={`${avail.toFixed(1)} h`} /> : null}
        {d.grid ? (
          <span title={d.grid_basis}>
            <Figure size="sm" label="Grid" value={`P${d.grid}`} />
          </span>
        ) : null}
        {d.p_tub !== undefined ? <Figure size="sm" label="P(tub damaged)" value={pct(d.p_tub, 0)} /> : null}
      </div>
      <ol className="pw-options">
        {opts.map((o) => {
          const [lo, mid, hi] = o.hours_needed;
          const chosen = d.chosen === o.id;
          return (
            <li key={o.id} className={`pw-option ${o.feasible ? '' : 'pw-option--no'} ${chosen ? 'pw-option--chosen' : ''}`} title={o.risk}>
              <p className="pw-option-label">{o.label}</p>
              <div className="pw-option-pills">
                <Pill tone={o.feasible ? 'info' : 'bad'}>{o.feasible ? 'Fits' : 'Does not fit'}</Pill>
                {chosen ? <Pill tone="ok">Chosen · {d.chosen_by ?? 'Team Principal'}</Pill> : null}
              </div>
              <Meter
                value={mid}
                max={max}
                limit={avail}
                tone={o.feasible ? 'info' : 'bad'}
                ticks={mid ? [{ at: lo, label: `low ${lo.toFixed(1)} h` }, { at: hi, label: `high ${hi.toFixed(1)} h` }] : undefined}
                label={mid ? `${mid.toFixed(1)} h (${lo.toFixed(1)}–${hi.toFixed(1)})${avail !== undefined ? ` / ${avail.toFixed(1)}` : ''}` : 'No garage time'}
              />
              <p className="pw-option-nums">
                <span>{o.expected_points.toFixed(1)} pts</span>
                {o.cost_cents[1] ? <span>{usdShort(o.cost_cents[1])}</span> : null}
              </p>
            </li>
          );
        })}
      </ol>
      <p className="pw-wd-foot" title="The desk priced the options and recommends none.">
        <Pill tone="neutral">No recommendation</Pill>
        {d.outcome ? <span>{cap(d.outcome)}</span> : null}
      </p>
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

function readLine(b: Belief): string {
  const top = topSeverity(b);
  return `${top ? (b.assessed_as ? `assessed ${b.assessed_as}` : `${top.name} ${pct(top.p, 0)}`) : 'no severity'}${b.parts && Object.keys(b.parts).length ? ` · ${topParts(b)}` : ''}`;
}

function BeliefHistory({ history, live, picked, onPick }: { history: RaceBeliefs[]; live: number; picked: number | null; onPick: (v: number | null) => void }) {
  if (!history.length) return null;
  const shown = picked ?? live;
  const row = history.find((h) => h.version === shown) ?? history[history.length - 1]!;
  const t0 = sortTime(history[0]!.at);
  const t1 = sortTime(history[history.length - 1]!.at);
  return (
    <section className="pw-hist" aria-label="What we believed when">
      <h3 className="pw-h">
        Belief versions
        <span className="pw-h-aside">
          {clock(history[0]!.at)} → {clock(history[history.length - 1]!.at)}
        </span>
      </h3>
      {history.length > 1 ? (
        <Axis
          from={t0}
          to={t1}
          height={16}
          marks={history.map((h) => ({ t: sortTime(h.at), label: `v${h.version} · ${clock(h.at)} · ${h.status}`, tone: h.version === shown ? 'navy' : 'gray', big: h.version === shown }))}
        />
      ) : null}
      <ol className="pw-steps">
        {history.map((h) => {
          const b = readBelief(h.beliefJson);
          const on = h.version === shown;
          const sev = sevParts(b);
          return (
            <li key={h.beliefKey}>
              <button
                type="button"
                className={on ? 'is-on' : ''}
                onClick={() => onPick(h.version === live ? null : h.version)}
                aria-pressed={on}
                title={`v${h.version} · ${clock(h.at)} · ${h.status}\n${h.cause}\n${readLine(b)}\nLight the car with this belief`}
              >
                <span className="pw-step-v">v{h.version}</span>
                {sev.length ? <Stack parts={sev} height={4} legend={false} /> : <span className="pw-step-none" />}
              </button>
            </li>
          );
        })}
      </ol>
      <p className={`pw-hist-now ${picked !== null ? 'pw-hist-now--replay' : ''}`} role="status" title={`${row.cause}\n${readLine(readBelief(row.beliefJson))}`}>
        <span className="pw-mono-sm">
          v{row.version} · {clock(row.at)}
        </span>
        <span className="pw-hist-cause">{row.cause}</span>
        {picked !== null ? (
          <button type="button" className="pw-linkbtn" onClick={() => onPick(null)}>
            <IconRestart size={11} /> Back to live
          </button>
        ) : null}
      </p>
    </section>
  );
}
