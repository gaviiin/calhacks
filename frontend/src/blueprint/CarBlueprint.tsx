import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { IconDenied, IconLive, IconRestart, IconWaiting } from '../components/icons';
import { pct, usdShort } from '../lib/format';
import { utcClock } from '../lib/raceModel';
import { COST_LABELS, LEAD_DAYS, PARTS, PART_INDEX, PRICES, SYSTEM_LABELS, UNITS, carValueCents, groupOf, priceCents, type CostId } from './catalog';
import { HEALTH_WORDS, healthOf, partsFor, type CarCondition, type CarStatus, type Health } from './condition';
import type { BlueprintEngine, PartTone } from './engine/engine';
import { hasWebGL2 } from './load';
import { PALETTE, css, type RGB } from './palette';
import './blueprint.css';

// The car as a blueprint: an angled 3D drawing that comes apart under the pointer, four rigid drawings
// (side, front, rear, underside) and the parts list beside them, every part priced from the race
// desk's price book and read for damage from what Jev or the forecast said about this car. The 3D
// drawing and the list point at each other: hover either, and both light the same parts.

const Sheet = lazy(() => import('./Sheet'));

export type Lens = 'condition' | 'cost';

/** One car on the stage, already read: who it is, where it is, and what the desk thinks of its parts. */
export interface StageCar {
  number: number;
  code: string;
  team: string;
  position: number | null;
  lap: number | null;
  gap: string | null;
  lastPit: number | null;
  condition: CarCondition;
}

// ------------------------------------------------------------------------------------------ parts and tones

/** The drawn part a price-book line points at when it is named: the callout's anchor. */
const PRIMARY: Record<CostId, string> = {
  chassis: 'chassis',
  gearbox: 'gearbox',
  floor: 'floor',
  front_wing: 'front_wing',
  rear_wing: 'rear_wing',
  front_suspension: 'fsusp_r',
  rear_suspension: 'rsusp_r',
  steering_rack: 'steering',
  bodywork: 'engine_cover',
  brakes: 'fbrake_r',
  rear_brakes: 'rbrake_r',
  electronics: 'electronics',
  wheel_speed_sensor: 'wss_f_r',
  power_unit: 'power_unit',
  tyre: 'wheel_f_r',
};

const LINES = Object.keys(UNITS) as CostId[];

/** Typical stint length per compound, for the tyre wear reading. An estimate; the drawing says so. */
const STINT: Record<string, number> = { SOFT: 20, MEDIUM: 30, HARD: 40, INTERMEDIATE: 25, WET: 30 };

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function assessing(c: CarCondition): boolean {
  return c.source === 'none' && (c.status === 'stopped' || c.status === 'out');
}

export function tonesFor(lens: Lens, c: CarCondition): PartTone[] {
  if (lens === 'cost') {
    const max = Math.max(...PARTS.map((p) => PRICES[p.cost].mid));
    return PARTS.map((p) => {
      const t = Math.sqrt(PRICES[p.cost].mid / max);
      return { color: mix(PALETTE.costLo, PALETTE.costHi, t), level: 0.42 + 0.85 * t, ink: null, pulse: false };
    });
  }
  const unknown = assessing(c);
  return PARTS.map((p) => {
    if (unknown) return { color: PALETTE.unknown, level: 0.72, ink: null, pulse: false };
    const h = healthOf(c.parts[p.cost]?.p);
    if (h === 'damaged') return { color: PALETTE.alert, level: 1.3, ink: mix(PALETTE.alert, [1, 1, 1], 0.08), pulse: true };
    if (h === 'watch') return { color: PALETTE.hold, level: 1.1, ink: mix(PALETTE.hold, [1, 1, 1], 0.08), pulse: false };
    return { color: PALETTE.line, level: 0.86, ink: null, pulse: false };
  });
}

// ------------------------------------------------------------------------------------------ small pieces

function HealthGlyph({ h, size = 12 }: { h: Health | 'unknown'; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true } as const;
  if (h === 'damaged')
    return (
      <svg {...common}>
        <path d="M4 1.5h4L10.5 4v4L8 10.5H4L1.5 8V4z" />
        <path d="M4.3 4.3l3.4 3.4M7.7 4.3L4.3 7.7" />
      </svg>
    );
  if (h === 'watch')
    return (
      <svg {...common}>
        <path d="M6 1.6l4.6 8.6H1.4z" />
        <path d="M6 5v2.4M6 8.6v.1" />
      </svg>
    );
  if (h === 'unknown')
    return (
      <svg {...common}>
        <circle cx="6" cy="6" r="4.4" strokeDasharray="2 1.6" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="6" cy="6" r="4.4" />
      <path d="M4 6.1l1.5 1.4L8.2 4.7" />
    </svg>
  );
}

const STATUS: Record<CarStatus, { word: string; cls: string; icon: ReactNode }> = {
  running: { word: 'Running', cls: 'bp-flag--ok', icon: <IconLive size={12} /> },
  pit: { word: 'In the pit', cls: 'bp-flag--hold', icon: <IconWaiting size={12} /> },
  stopped: { word: 'Stopped?', cls: 'bp-flag--hold', icon: <IconWaiting size={12} /> },
  out: { word: 'Out', cls: 'bp-flag--alert', icon: <IconDenied size={12} /> },
  dsq: { word: 'Disqualified', cls: 'bp-flag--alert', icon: <IconDenied size={12} /> },
};

function lead(cost: CostId): string {
  const [lo, mid, hi] = LEAD_DAYS[cost];
  if (!hi) return 'no lead time';
  return lo === hi ? `${mid} day${mid === 1 ? '' : 's'}` : `${mid} days (${lo}–${hi})`;
}

function partHealth(c: CarCondition, cost: CostId): Health | 'unknown' {
  if (assessing(c)) return 'unknown';
  return healthOf(c.parts[cost]?.p);
}

/** The callout in the 3D view: the part, its price-book line, its band and what the desk believes. */
export function Callout({ id, car }: { id: string; car: StageCar }) {
  const p = PARTS[PART_INDEX[id]];
  const c = car.condition;
  const r = c.parts[p.cost];
  const h = partHealth(c, p.cost);
  const price = r?.mid !== undefined ? { low: r.low ?? 0, mid: r.mid, high: r.high ?? 0 } : priceCents(r?.repair ? 'chassis_repair' : p.cost);
  const basis = PRICES[p.cost].basis;
  const tyre = p.cost === 'tyre' && c.tyre;
  return (
    <div className={`bp-co bp-co--${h}`}>
      <div className="bp-co-top">
        <span>{SYSTEM_LABELS[p.system]}</span>
        <span className={`bp-basis bp-basis--${basis}`}>{basis === 'press' ? 'Press figure' : 'Assumption'}</span>
      </div>
      <h4>{p.label}</h4>
      <p className="bp-co-line">
        {COST_LABELS[p.cost]}
        {p.share ? <span> · {p.share}</span> : null}
      </p>
      {p.cost === 'tyre' ? (
        <p className="bp-co-price">
          <b className="mono">$0</b> <span className="muted">supplied by the tyre maker</span>
        </p>
      ) : (
        <p className="bp-co-price">
          <b className="mono">{usdShort(price.mid)}</b>
          <span className="mono muted">
            {usdShort(price.low)} – {usdShort(price.high)}
          </span>
          {r?.repair && <span className="muted">repair, not replace</span>}
        </p>
      )}
      <div className="bp-co-cond">
        <span className={`bp-health bp-health--${h}`}>
          <HealthGlyph h={h} />
          {h === 'unknown' ? 'Not read yet' : HEALTH_WORDS[h]}
          {r && h !== 'unknown' ? <span className="mono">{pct(r.p, 0)}</span> : null}
        </span>
        {r && <span className="muted">{c.label}</span>}
      </div>
      <dl className="bp-co-kv">
        {tyre ? (
          <div>
            <dt>Set</dt>
            <dd className="mono">
              {tyre.compound} · {tyre.age} lap{tyre.age === 1 ? '' : 's'}
            </dd>
          </div>
        ) : (
          <div>
            <dt>Lead time</dt>
            <dd className="mono">{lead(p.cost)}</dd>
          </div>
        )}
        {r && r.p > 0.02 && p.cost !== 'tyre' ? (
          <div>
            <dt>Expected</dt>
            <dd className="mono">{usdShort(r.p * price.mid)}</dd>
          </div>
        ) : null}
        {r?.inSpares !== undefined ? (
          <div>
            <dt>Spares</dt>
            <dd>{r.inSpares ? 'in stock' : 'to order'}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ inspector

function ConditionSummary({ car }: { car: StageCar }) {
  const c = car.condition;
  const counts = { damaged: 0, watch: 0 };
  for (const r of Object.values(c.parts)) {
    const h = healthOf(r?.p);
    if (h === 'damaged') counts.damaged++;
    else if (h === 'watch') counts.watch++;
  }
  let headline: ReactNode;
  if (assessing(c)) headline = 'Stopped on track. No part reading yet: Jev reads the parts when the cost is booked.';
  else if (c.source === 'none') headline = 'No incident. Every part reads nominal.';
  else
    headline = (
      <>
        {counts.damaged ? (
          <b className="tone-alert">
            {counts.damaged} line{counts.damaged === 1 ? '' : 's'} likely damaged
          </b>
        ) : (
          'Nothing likely damaged'
        )}
        {counts.watch ? <>, {counts.watch} possible</> : null}
        {c.severity ? <span className="muted"> · severity {c.severity}</span> : null}
      </>
    );
  return (
    <section className="bp-sum" aria-label="Condition">
      <div className="bp-sum-head">
        <h3>Condition</h3>
        <span className="muted small">
          {c.label}
          {c.at ? ` · ${utcClock(c.at)} UTC` : ''}
        </span>
      </div>
      <p className="bp-sum-line">{headline}</p>
      <dl className="bp-sum-kv">
        <div>
          <dt>Expected repair</dt>
          <dd>
            <b className="mono">{c.expected ? usdShort(c.expected.mid) : '$0'}</b>
            {c.expected && (
              <span className="mono muted">
                {usdShort(c.expected.low)} – {usdShort(c.expected.high)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Booked to the cap</dt>
          <dd>
            <b className="mono">{c.booked ? usdShort(c.booked.mid) : '$0'}</b>
            <span className="muted small">{c.booked ? `${c.booked.n} crash line${c.booked.n === 1 ? '' : 's'}, 6050` : 'nothing booked'}</span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

interface RowProps {
  cost: CostId;
  car: StageCar;
  lens: Lens;
  maxValue: number;
  lit: boolean;
  open: boolean;
  onHover: (c: CostId | null) => void;
  onToggle: (c: CostId) => void;
  onChip: (id: string | null) => void;
}

function PartRow({ cost, car, lens, maxValue, lit, open, onHover, onToggle, onChip }: RowProps) {
  const c = car.condition;
  const r = c.parts[cost];
  const h = partHealth(c, cost);
  const unit = r?.mid !== undefined ? { low: r.low ?? 0, mid: r.mid, high: r.high ?? 0 } : priceCents(r?.repair ? 'chassis_repair' : cost);
  const units = UNITS[cost];
  const value = unit.mid * units;
  const share = lens === 'cost' ? (maxValue ? value / maxValue : 0) : (r?.p ?? 0);
  const price = PRICES[cost];
  const drawn = partsFor(cost);
  return (
    <li className={`bp-row bp-row--${h}${lit ? ' is-lit' : ''}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="bp-row-main"
        aria-expanded={open}
        onMouseEnter={() => onHover(cost)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(cost)}
        onBlur={() => onHover(null)}
        onClick={() => onToggle(cost)}
      >
        <span className={`bp-health bp-health--${h} bp-row-glyph`} title={h === 'unknown' ? 'Not read yet' : HEALTH_WORDS[h]}>
          <HealthGlyph h={h} />
        </span>
        <span className="bp-row-label">
          {COST_LABELS[cost]}
          {units > 1 && <span className="bp-row-units mono">×{units}</span>}
        </span>
        <span className="bp-row-p mono">{r && h !== 'unknown' ? pct(r.p, 0) : ''}</span>
        <span className="bp-row-value mono">{cost === 'tyre' ? 'supplied' : usdShort(value)}</span>
        <span className="bp-row-bar" aria-hidden="true">
          <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, share))})` }} />
        </span>
      </button>
      <div className="bp-row-more" aria-hidden={!open}>
        <div>
          <dl className="bp-row-kv">
            <div>
              <dt>Band, each</dt>
              <dd className="mono">
                {cost === 'tyre' ? '$0' : `${usdShort(unit.low)} – ${usdShort(unit.high)}`} <span className="muted">mid {usdShort(unit.mid)}</span>
              </dd>
            </div>
            <div>
              <dt>Basis</dt>
              <dd>
                {price.basis === 'press' ? 'Press figure' : 'Assumption'}
                {price.note ? <span className="muted">: {price.note}</span> : null}
              </dd>
            </div>
            <div>
              <dt>Lead time</dt>
              <dd className="mono">{lead(cost)}</dd>
            </div>
            <div>
              <dt>Condition</dt>
              <dd>
                {h === 'unknown' ? 'not read yet' : r ? `P(damaged) ${pct(r.p, 0)} · ${c.label}` : 'nominal, no reading'}
                {r && r.p > 0.02 && cost !== 'tyre' ? <span className="mono muted"> · expected {usdShort(r.p * unit.mid)}</span> : null}
              </dd>
            </div>
          </dl>
          <div className="bp-chips" onMouseLeave={() => onChip(null)}>
            {drawn.map((id) => (
              <button key={id} type="button" className="bp-chip" tabIndex={open ? 0 : -1} onMouseEnter={() => onChip(id)} onFocus={() => onChip(id)} onBlur={() => onChip(null)}>
                {PARTS[PART_INDEX[id]].label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------------------------------ the stage

export interface StageProps {
  cars: StageCar[];
  /** shown in the title block, e.g. "Race desk · Williams" */
  desk: string;
  /** the race's lap, the drawing's revision */
  revision?: number | null;
}

type Pin = { kind: 'part'; id: string } | { kind: 'line'; cost: CostId } | null;

export function BlueprintStage({ cars, desk, revision }: StageProps) {
  const [chosen, setChosen] = useState<number | null>(null);
  const [lensChoice, setLensChoice] = useState<Lens | null>(null);
  const [exploded, setExploded] = useState(false);
  const [pointer, setPointer] = useState<string | null>(null);
  const [rowHover, setRowHover] = useState<CostId | null>(null);
  const [chip, setChip] = useState<string | null>(null);
  const [pin, setPin] = useState<Pin>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [webgl] = useState(hasWebGL2);
  const engineRef = useRef<BlueprintEngine | null>(null);

  // the car on the drawing: the one picked, else the one in trouble, else the first
  const car = useMemo(() => {
    const picked = cars.find((c) => c.number === chosen);
    if (picked) return picked;
    return cars.find((c) => c.condition.source !== 'none' || c.condition.status !== 'running') ?? cars[0] ?? null;
  }, [cars, chosen]);

  const damaged = !!car && (car.condition.source !== 'none' || car.condition.status === 'stopped' || car.condition.status === 'out');
  const lens: Lens = lensChoice ?? (damaged ? 'condition' : 'cost');
  const tones = useMemo(() => (car ? tonesFor(lens, car.condition) : []), [lens, car]);

  const highlight = useMemo(() => (chip ? [chip] : rowHover ? partsFor(rowHover) : []), [chip, rowHover]);
  const pinned = useMemo(() => (pin?.kind === 'part' ? groupOf(pin.id) : pin?.kind === 'line' ? partsFor(pin.cost) : []), [pin]);
  const active = pointer ?? chip ?? (rowHover ? PRIMARY[rowHover] : null) ?? (pin ? (pin.kind === 'part' ? pin.id : PRIMARY[pin.cost]) : null);
  const activeLine: CostId | null = rowHover ?? (active ? PARTS[PART_INDEX[active]].cost : null);
  const openLine: CostId | null = pin ? (pin.kind === 'line' ? pin.cost : PARTS[PART_INDEX[pin.id]].cost) : null;

  const onPick = useCallback((id: string | null) => {
    setPin((cur) => {
      if (!id) return null;
      if (cur?.kind === 'part' && groupOf(cur.id).includes(id)) return null;
      return { kind: 'part', id };
    });
  }, []);
  const toggleLine = useCallback(
    (cost: CostId) => setPin((cur) => (cur && (cur.kind === 'line' ? cur.cost : PARTS[PART_INDEX[cur.id]].cost) === cost ? null : { kind: 'line', cost })),
    [],
  );

  // a new car starts unpinned
  const carNo = car?.number ?? null;
  useEffect(() => {
    setPin(null);
    setRowHover(null);
    setChip(null);
  }, [carNo]);

  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') setPin(null);
    else if (e.key === 'e' || e.key === 'E') setExploded((x) => !x);
  };

  const sorted = useMemo(() => {
    if (!car) return LINES;
    const value = (c: CostId) => priceCents(c).mid * UNITS[c];
    return LINES.slice().sort((a, b) => {
      if (lens === 'condition') {
        const pa = car.condition.parts[a]?.p ?? 0;
        const pb = car.condition.parts[b]?.p ?? 0;
        if (Math.abs(pa - pb) > 1e-6) return pb - pa;
      }
      return value(b) - value(a);
    });
  }, [car, lens]);
  const maxValue = useMemo(() => Math.max(...LINES.map((c) => priceCents(c).mid * UNITS[c])), []);
  const carValue = useMemo(() => carValueCents(), []);

  if (!car) return <p className="muted empty">No car state yet.</p>;
  const st = STATUS[car.condition.status];
  const tyre = car.condition.tyre;
  const stint = tyre ? (STINT[tyre.compound] ?? 30) : 30;

  return (
    <section className="bp-stage" aria-label={`Blueprint of car ${car.number}`} onKeyDown={onKey}>
      <header className="bp-head">
        <div className="bp-head-title">
          <h2>Car blueprint</h2>
          <p className="muted small">Reference 2026 chassis, priced from the race desk's price book</p>
        </div>
        <div className="bp-cars" role="tablist" aria-label="Car">
          {cars.map((c) => {
            const s = STATUS[c.condition.status];
            const on = c.number === car.number;
            return (
              <button key={c.number} type="button" role="tab" aria-selected={on} className={`bp-car${on ? ' is-on' : ''}`} onClick={() => setChosen(c.number)}>
                <span className="bp-car-num mono">{c.number}</span>
                <span className="bp-car-code">{c.code}</span>
                <span className="bp-car-pos mono">{c.condition.status === 'out' ? 'OUT' : c.position ? `P${c.position}` : '—'}</span>
                <span className={`bp-flag ${s.cls}`}>
                  {s.icon}
                  {s.word}
                </span>
              </button>
            );
          })}
        </div>
        <div className="bp-tools">
          <div className="seg-ctl" role="group" aria-label="Lens">
            {(['condition', 'cost'] as Lens[]).map((l) => (
              <button key={l} type="button" className={lens === l ? 'seg-btn seg-btn--on' : 'seg-btn'} aria-pressed={lens === l} onClick={() => setLensChoice(l)}>
                {l === 'condition' ? 'Condition' : 'Cost'}
              </button>
            ))}
          </div>
          <button type="button" className={`btn pillbtn bp-explode${exploded ? ' is-on' : ''}`} aria-pressed={exploded} onClick={() => setExploded((x) => !x)} title="E">
            <ExplodeIcon open={exploded} />
            {exploded ? 'Assemble' : 'Explode'}
          </button>
        </div>
      </header>

      <div className="bp-body">
        {webgl && !failed ? (
          <Suspense fallback={<div className="bp-sheet bp-sheet--wait" />}>
            <Sheet
              tones={tones}
              highlight={highlight}
              pinned={pinned}
              exploded={exploded}
              active={active}
              onHover={setPointer}
              onPick={onPick}
              engineRef={engineRef}
              callout={(id) => <Callout id={id} car={car} />}
              onError={(e) => setFailed(e.message)}
              heroTitle={
                <>
                  <span className="bp-iso">Iso view</span>
                  <span className="bp-iso-car">
                    Car {car.number} · {car.code}
                  </span>
                  <Legend lens={lens} unknown={assessing(car.condition)} />
                </>
              }
              heroCorner={
                <div className="bp-hints">
                  <span>Drag to turn</span>
                  <span>Hover to pull a part out</span>
                  <span>Click to pin</span>
                  <button type="button" className="bp-reset" onClick={() => engineRef.current?.resetView()} aria-label="Reset the view">
                    <IconRestart size={12} />
                  </button>
                </div>
              }
              titleBlock={
                <dl className="bp-tb">
                  <div>
                    <dt>Desk</dt>
                    <dd>{desk}</dd>
                  </div>
                  <div>
                    <dt>Car</dt>
                    <dd className="mono">
                      {car.number} · {car.code}
                    </dd>
                  </div>
                  <div className="bp-tb-wide">
                    <dt>Drawing</dt>
                    <dd>Reference chassis to the 2026 technical regulations, not team data</dd>
                  </div>
                  <div>
                    <dt>Units</dt>
                    <dd className="mono">mm · USD at $1.27/£</dd>
                  </div>
                  <div>
                    <dt>Dwg</dt>
                    <dd className="mono">
                      PW-26-{String(car.number).padStart(3, '0')}
                      {revision ? ` · rev L${revision}` : ''}
                    </dd>
                  </div>
                </dl>
              }
            />
          </Suspense>
        ) : (
          <div className="bp-sheet bp-sheet--none">
            <p className="muted">{failed ? `The 3D drawing could not start: ${failed}` : 'This browser has no WebGL 2, so the 3D drawing is off. The parts list still works.'}</p>
          </div>
        )}

        <aside className="bp-inspector" aria-label={`Car ${car.number} parts`}>
          <div className="bp-inspector-in">
            <section className="bp-car-card">
              <div className="bp-car-card-top">
                <h3>
                  Car {car.number} <span className="muted">· {car.code}</span>
                </h3>
                <span className={`bp-flag ${st.cls}`}>
                  {st.icon}
                  {st.word}
                </span>
              </div>
              <dl className="bp-facts">
                <div>
                  <dt>Position</dt>
                  <dd className="mono">{car.condition.status === 'out' ? 'OUT' : car.position ? `P${car.position}` : '—'}</dd>
                </div>
                <div>
                  <dt>Lap</dt>
                  <dd className="mono">{car.lap ?? '—'}</dd>
                </div>
                <div>
                  <dt>Gap</dt>
                  <dd className="mono">{car.gap || '—'}</dd>
                </div>
                <div>
                  <dt>Last pit</dt>
                  <dd className="mono">{car.lastPit ? `L${car.lastPit}` : '—'}</dd>
                </div>
              </dl>
              {tyre && (
                <div className="bp-tyre">
                  <span className="bp-tyre-label">
                    Tyres <b>{tyre.compound}</b>
                    <span className="mono muted">
                      {tyre.age} of ~{stint} laps
                    </span>
                  </span>
                  <span className="bp-tyre-bar" aria-hidden="true">
                    <i style={{ transform: `scaleX(${Math.min(1, tyre.age / stint)})` }} className={tyre.age / stint > 0.85 ? 'is-late' : ''} />
                  </span>
                </div>
              )}
            </section>
            <ConditionSummary car={car} />
            <section className="bp-parts" aria-label="Parts">
              <div className="bp-parts-head">
                <h3>Parts {lens === 'condition' ? 'by condition' : 'by price'}</h3>
                <span className="muted small">{lens === 'condition' ? 'P(damaged)' : 'price-book mid'}</span>
              </div>
              <ul className="bp-rows" onMouseLeave={() => setRowHover(null)}>
                {sorted.map((cost) => (
                  <PartRow
                    key={cost}
                    cost={cost}
                    car={car}
                    lens={lens}
                    maxValue={maxValue}
                    lit={activeLine === cost}
                    open={openLine === cost}
                    onHover={setRowHover}
                    onToggle={toggleLine}
                    onChip={setChip}
                  />
                ))}
              </ul>
              <p className="bp-total">
                <span>Car at price-book mid</span>
                <b className="mono">{usdShort(carValue.mid)}</b>
                <span className="mono muted">
                  {usdShort(carValue.low)} – {usdShort(carValue.high)}
                </span>
              </p>
            </section>
          </div>
        </aside>
      </div>
    </section>
  );
}

const UNIT_MIDS = (Object.keys(PRICES) as (keyof typeof PRICES)[])
  .filter((k) => k !== 'chassis_repair')
  .map((k) => priceCents(k).mid)
  .filter((m) => m > 0);
const CHEAPEST = Math.min(...UNIT_MIDS);
const DEAREST = Math.max(...UNIT_MIDS);

export function Legend({ lens, unknown }: { lens: Lens; unknown: boolean }) {
  if (lens === 'cost')
    return (
      <span className="bp-legend" aria-label="Brighter parts cost more">
        <span className="bp-legend-ramp" style={{ background: `linear-gradient(90deg, ${css(PALETTE.costLo, 0.55)}, ${css(PALETTE.costHi)})` }} />
        <span className="mono">{usdShort(CHEAPEST)}</span>
        <span className="muted">to</span>
        <span className="mono">{usdShort(DEAREST)}</span>
        <span className="muted">a part, brighter costs more</span>
      </span>
    );
  if (unknown)
    return (
      <span className="bp-legend">
        <span className="bp-health bp-health--unknown">
          <HealthGlyph h="unknown" />
          Parts not read yet
        </span>
      </span>
    );
  return (
    <span className="bp-legend">
      <span className="bp-health bp-health--ok">
        <HealthGlyph h="ok" />
        Nominal
      </span>
      <span className="bp-health bp-health--watch">
        <HealthGlyph h="watch" />
        Possible
      </span>
      <span className="bp-health bp-health--damaged">
        <HealthGlyph h="damaged" />
        Likely damaged
      </span>
    </span>
  );
}

export function ExplodeIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      {open ? (
        <path d="M5.5 5.5L2 2m0 0v3m0-3h3M10.5 5.5L14 2m0 0v3m0-3h-3M5.5 10.5L2 14m0 0v-3m0 3h3M10.5 10.5L14 14m0 0v-3m0 3h-3" />
      ) : (
        <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4M6 6h4v4H6z" />
      )}
    </svg>
  );
}
