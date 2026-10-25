import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { IconArrow, IconFlag } from '../../components/icons';
import { usdShort } from '../../lib/format';
import { useRace, type RaceData } from '../../lib/race';
import { carLabel } from '../../lib/raceModel';
import { latestSim } from '../raceday/ReplanPanel';
import { clock, parse } from '../raceday/shared';
import { Axis, Figure, Meter, Odds, Panel, Pill, type Tone } from './kit';
import './strategy.css';

// The head of strategy's view. At a decision point: what each option does to position, time, points, money and the
// cap, side by side (race/cockpit/comparator.py, after Varun Sanjeev's decision cockpit); the race's decision points on
// one lap axis, with what was actually done at each; the season as probabilities; the start-or-withdraw decision.
// The desk prices the options and never picks one: nothing here marks a best or recommended option.

type OptionRow = RaceData['options'][number];
type Action = RaceData['actions'][number];
type RaceEvent = RaceData['events'][number];

interface Loss {
  condition: string;
  seconds: number | null;
  low: number;
  high: number;
  method: string;
  samples: number;
  basis?: string;
}

interface Pace {
  compound: string;
  own_s: number | null;
  field_fresh_s: number | null;
  gain_per_lap_s: number | null;
  laps_compared: number;
  laps_to_recover: number | null;
  note: string;
}

interface Opt {
  id: string;
  label: string;
  available: boolean;
  why_not?: string;
  compound_after?: string;
  position_now: number | null;
  positions: (number | null)[];
  time_lost_s: Loss;
  cars_passed: number[];
  cars_maybe: number[];
  points: number[];
  points_delta: number[];
  constructors_place: number[];
  prize_delta_cents: number[];
  prize_note?: string;
  sponsor_delta_cents: number[];
  sponsor_label?: string;
  clauses?: string[];
  cost_cap: { cents: number; line: string };
  pace?: Pace | string | null;
  race_end_value?: string;
  evidence?: string[];
}

interface Context {
  driver?: string;
  condition?: string;
  condition_label?: string;
  trigger?: string;
  field_lap?: number;
  car_lap?: number;
  laps_left?: number | null;
  laps_left_basis?: string;
  position?: number;
  running?: number;
  car_ahead?: number | null;
  gap_ahead_s?: number | null;
  car_behind?: number | null;
  gap_behind_s?: number | null;
  compound?: string;
  tyre_age?: number | null;
  field_compounds?: Record<string, number>;
  constructors_place?: number;
  stop_cost?: Record<string, Loss>;
  stops_measured?: number;
  cap_headroom_cents?: number;
  prize_basis?: string;
  sponsor_basis?: string;
  race_end_value?: string;
  range?: string;
  as_of?: string;
  credit?: string;
}

interface Facet {
  facet: string;
  owner: string;
  basis?: string;
  outcomes: { label: string; p: number }[];
}

interface WithdrawOption {
  id: string;
  label: string;
  hours_needed: number[];
  feasible: boolean;
  cost_cents: number[];
  expected_points: number;
  risk: string;
}

interface Withdraw {
  car?: number;
  grid?: number | null;
  grid_basis?: string;
  race_start?: string;
  hours_available?: number;
  p_tub?: number;
  options?: WithdrawOption[];
  summary?: string;
  chosen?: string;
  chosen_by?: string;
  outcome?: string;
}

/** What the car actually did after a decision point, read from the event tape. */
interface Taken {
  option: string;
  stop?: { lap: number; at: string; seconds: number | null; under: string; compound?: string };
}

/** optionsJson is {"context", "options"}; an older row may carry the options alone. */
function readSet(row: OptionRow): { ctx: Context; opts: Opt[] } {
  const v = parse<unknown>(row.optionsJson, []);
  if (Array.isArray(v)) return { ctx: {}, opts: v as Opt[] };
  const o = v as { context?: Context; options?: Opt[] };
  return { ctx: o.context ?? {}, opts: o.options ?? [] };
}

const COND: Record<string, { label: string; short: string; tone: Tone }> = {
  green: { label: 'Green flag', short: 'Green', tone: 'neutral' },
  vsc: { label: 'Virtual Safety Car', short: 'VSC', tone: 'wait' },
  sc: { label: 'Safety Car', short: 'SC', tone: 'wait' },
  red: { label: 'Red flag', short: 'Red', tone: 'bad' },
};
const TRIGGER: Record<string, string> = { lap: 'lap completed', safety_car: 'Safety Car deployed', vsc: 'VSC deployed', red_flag: 'red flag' };
const TYRE: Record<string, { name: string; letter: string }> = {
  SOFT: { name: 'Soft', letter: 'S' },
  MEDIUM: { name: 'Medium', letter: 'M' },
  HARD: { name: 'Hard', letter: 'H' },
  INTERMEDIATE: { name: 'Intermediate', letter: 'I' },
  WET: { name: 'Wet', letter: 'W' },
};
const METHOD: Record<string, string> = { measured: 'measured', derived: 'derived', prior: 'prior', unmeasured: 'range', range: 'range', suspension: 'suspension', none: 'no stop' };

const same = <T,>(xs: T[]) => xs.every((x) => x === xs[0]);
const signedUsd = (c: number) => (Math.abs(c) < 50 ? '$0' : `${c > 0 ? '+' : '−'}${usdShort(Math.abs(c))}`);
const signedN = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0');
const secs = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
const solid = (l: Loss) => l.seconds != null && (l.method === 'measured' || l.method === 'derived');

// ---------------------------------------------------------------------- what was done, from the event tape

function payload(e: RaceEvent): Record<string, unknown> {
  return parse<Record<string, unknown>>(e.payloadJson, {});
}

/** A decision point's taken option: a stop on the lap after it is a pit (the other compound when the next stint's
 *  compound differs); otherwise staying out, once the tape shows the car past that lap or stopped. Unknown while live. */
function takenAt(row: OptionRow, ctx: Context, opts: Opt[], events: RaceEvent[]): Taken | null {
  // a lap point is "lap N completed"; a flag point falls mid-lap, on the car's own lap
  const carLap = row.trigger === 'lap' ? row.lap : (ctx.car_lap ?? row.lap);
  const mine = events.filter((e) => e.sessionKey === row.sessionKey && e.driverNumber === row.driverNumber);
  const stopEv = mine.find((e) => e.kind === 'pit_stop' && Number(payload(e).lap_number ?? e.lap) === carLap + 1);
  if (stopEv) {
    const p = payload(stopEv);
    const lap = Number(p.lap_number ?? stopEv.lap);
    const stint = mine
      .filter((e) => e.kind === 'stint')
      .map(payload)
      .filter((s) => Number(s.lap_start) > lap)
      .sort((a, b) => Number(a.lap_start) - Number(b.lap_start))[0];
    const compound = stint ? String(stint.compound ?? '') : undefined;
    const changed = compound && ctx.compound && compound !== ctx.compound;
    const alt = changed ? opts.find((o) => o.id !== 'stay_out' && o.available && o.compound_after === compound) : undefined;
    return {
      option: alt?.id ?? (changed ? 'other_compound' : 'pit_now'),
      stop: { lap, at: stopEv.at, seconds: typeof p.stop_duration === 'number' ? p.stop_duration : null, under: String(p.under ?? ''), compound },
    };
  }
  const past = mine.some(
    (e) => e.at > row.at && (e.lap >= carLap + 2 || e.kind === 'car_stopped' || e.kind.startsWith('retirement')) && e.kind !== 'stint'
  );
  return past ? { option: 'stay_out' } : null;
}

// ---------------------------------------------------------------------- small glyphs

function Tyre({ c, age }: { c?: string; age?: number | null }) {
  if (!c) return <span className="muted">—</span>;
  const t = TYRE[c] ?? { name: c, letter: c.slice(0, 1) };
  return (
    <span className={`sv-tyre sv-tyre--${c.toLowerCase()}`} title={`${t.name}${age != null ? `, ${age} laps old` : ''}`} aria-label={t.name}>
      {t.letter}
    </span>
  );
}

/** [best, likely, worst] as one figure when they agree, else likely with the spread beside it. */
function Val({ v, fmt, signed }: { v: (number | null)[]; fmt: (x: number) => string; signed?: boolean }) {
  if (v.length < 3 || v.some((x) => x == null)) return <span className="muted">—</span>;
  const [b, l, w] = v as number[];
  const tone = signed ? (l! > 0 ? 'sv-v--up' : l! < 0 ? 'sv-v--down' : 'sv-v--zero') : '';
  return (
    <span className="sv-val">
      <span className={`sv-v ${tone}`}>{fmt(l!)}</span>
      {!same([b, l, w]) && <span className="sv-rng" title="best to worst">{`${fmt(b!)} to ${fmt(w!)}`}</span>}
    </span>
  );
}

/** Positions on a small slot scale: now outlined, best-to-worst shaded, likely filled. */
function PosGlyph({ o, lo, hi }: { o: Opt; lo: number; hi: number }) {
  const [b, l, w] = o.positions;
  if (b == null || l == null || w == null) return <span className="muted">—</span>;
  const slots = [];
  for (let p = lo; p <= hi; p++) {
    const cls = ['sv-slot', p >= b && p <= w ? 'sv-slot--range' : '', p === l ? 'sv-slot--likely' : '', p === o.position_now ? 'sv-slot--now' : ''].join(' ');
    slots.push(
      <span key={p} className={cls}>
        {p}
      </span>
    );
  }
  return (
    <div className="sv-pos">
      <span className="sv-val">
        <span className="sv-v">P{l}</span>
        {b !== w && <span className="sv-rng">{`P${b} to P${w}`}</span>}
      </span>
      <span className="sv-slots" role="img" aria-label={`now P${o.position_now ?? '?'}, likely P${l}, best P${b}, worst P${w}`}>
        {slots}
      </span>
    </div>
  );
}

/** Time lost on a shared seconds scale: a measured figure is a solid bar with its range as a whisker; a range that
 *  was never measured is hatched from low to high. */
function TimeBar({ l, max, compact }: { l: Loss; max: number; compact?: boolean }) {
  const at = (x: number) => `${Math.max(0, Math.min(100, (x / max) * 100))}%`;
  const none = l.method === 'none' || l.method === 'suspension';
  const fig = none ? (l.method === 'none' ? '0 s' : '0 s') : l.seconds != null ? secs(l.seconds) : `${Math.round(l.low)}–${Math.round(l.high)} s`;
  const how = METHOD[l.method] ?? l.method;
  return (
    <div className={`sv-time ${compact ? 'sv-time--compact' : ''}`} title={l.basis}>
      <span className="sv-val">
        <span className="sv-v">{fig}</span>
        <span className="sv-rng">
          {how}
          {(l.method === 'measured' || l.method === 'derived') && l.samples ? ` ×${l.samples}` : ''}
        </span>
      </span>
      <span className="sv-tbar" aria-hidden>
        {!none && solid(l) && (
          <>
            <span className="sv-tbar-whisker" style={{ left: at(l.low), width: `calc(${at(l.high)} - ${at(l.low)})` }} />
            <span className="sv-tbar-solid" style={{ width: at(l.seconds!) }} />
          </>
        )}
        {!none && !solid(l) && <span className="sv-tbar-hatch" style={{ left: at(l.low), width: `calc(${at(l.high)} - ${at(l.low)})` }} />}
      </span>
    </div>
  );
}

function CarChips({ o }: { o: Opt }) {
  if (o.id === 'stay_out') return <span className="muted">—</span>;
  if (!o.cars_passed.length && !o.cars_maybe.length) return <span className="muted">none</span>;
  return (
    <span className="sv-cars">
      {o.cars_passed.map((c) => (
        <span key={c} className="sv-car" title={`${carLabel(c)} gets past`}>
          {c}
        </span>
      ))}
      {o.cars_maybe.map((c) => (
        <span key={c} className="sv-car sv-car--maybe" title={`${carLabel(c)}: too close to call (lapped, or no gap in the feed)`}>
          {c}
        </span>
      ))}
    </span>
  );
}

function PaceCell({ o, lapsLeft }: { o: Opt; lapsLeft: number | null | undefined }) {
  const p = o.pace;
  if (!p) return <span className="muted">—</span>;
  if (typeof p === 'string') return <span className="muted" title={p}>see basis</span>;
  if (p.gain_per_lap_s == null) {
    return (
      <span className="muted" title={p.note}>
        no figure
      </span>
    );
  }
  const g = p.gain_per_lap_s;
  return (
    <div className="sv-pace" title={p.note}>
      <span className="sv-val">
        <span className="sv-v">{`${g > 0 ? '−' : '+'}${Math.abs(g).toFixed(2)} s/lap`}</span>
        <span className="sv-rng">{`${p.laps_compared} laps compared`}</span>
      </span>
      {p.laps_to_recover != null && lapsLeft ? (
        <Meter
          value={p.laps_to_recover}
          max={Math.max(lapsLeft, p.laps_to_recover)}
          limit={lapsLeft}
          tone={p.laps_to_recover <= lapsLeft ? 'info' : 'wait'}
          label={`time back in ${p.laps_to_recover} of ${lapsLeft} laps`}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------- the comparator

interface Scale {
  lo: number;
  hi: number;
  tmax: number;
  lapsLeft: number | null | undefined;
}

const ROWS: { key: string; label: string; legend?: ReactNode; title?: string; cell: (o: Opt, s: Scale) => ReactNode }[] = [
  {
    key: 'pos',
    label: 'Position',
    legend: (
      <span className="sv-key">
        <i className="sv-key-now" />
        now <i className="sv-key-likely" />
        likely <i className="sv-key-range" />
        range
      </span>
    ),
    cell: (o, s) => <PosGlyph o={o} lo={s.lo} hi={s.hi} />,
  },
  {
    key: 'time',
    label: 'Time lost',
    legend: (
      <span className="sv-key">
        <i className="sv-key-solid" />
        measured <i className="sv-key-hatch" />
        range
      </span>
    ),
    cell: (o, s) => <TimeBar l={o.time_lost_s} max={s.tmax} />,
  },
  { key: 'cars', label: 'Cars past', legend: <span className="sv-key"><i className="sv-key-car" />certain <i className="sv-key-car sv-key-car--maybe" />too close</span>, cell: (o) => <CarChips o={o} /> },
  {
    key: 'pts',
    label: 'Points',
    title: 'Points if the position holds to the flag; the change is against staying out',
    cell: (o) => (
      <span className="sv-val" title={(o.clauses ?? []).join('; ') || undefined}>
        <Val v={o.points} fmt={String} />
        <Val v={o.points_delta} fmt={signedN} signed />
      </span>
    ),
  },
  { key: 'place', label: "Constructors'", cell: (o) => <span title={o.prize_note}><Val v={o.constructors_place} fmt={(x) => `P${x}`} /></span> },
  { key: 'prize', label: 'Prize', title: '2024 prize ladder', cell: (o) => <span title={o.prize_note}><Val v={o.prize_delta_cents} fmt={signedUsd} signed /></span> },
  {
    key: 'sponsor',
    label: 'Sponsor',
    legend: <span className="sv-assume">assumed</span>,
    title: '$100k a point and $500k a constructors’ place above 10th: an assumption',
    cell: (o) => <Val v={o.sponsor_delta_cents} fmt={signedUsd} signed />,
  },
  { key: 'cap', label: 'Cost cap', cell: (o) => <span className="sv-v sv-v--zero" title={o.cost_cap.line}>{usdShort(o.cost_cap.cents)}</span> },
  { key: 'pace', label: 'Pace after', cell: (o, s) => <PaceCell o={o} lapsLeft={s.lapsLeft} /> },
];

function Comparator({ opts, ctx, taken }: { opts: Opt[]; ctx: Context; taken: Taken | null }) {
  const scale = useMemo<Scale>(() => {
    const ps = opts.flatMap((o) => [...o.positions, o.position_now]).filter((x): x is number => x != null);
    const running = ctx.running ?? Math.max(...ps, 1);
    let lo = Math.max(1, Math.min(...ps) - 1);
    let hi = Math.min(running, Math.max(...ps) + 1);
    while (hi - lo < 4 && (lo > 1 || hi < running)) {
      if (hi < running) hi++;
      if (hi - lo < 4 && lo > 1) lo--;
    }
    const highs = [...opts.map((o) => o.time_lost_s.high), ...Object.values(ctx.stop_cost ?? {}).map((l) => l.high)];
    const tmax = Math.max(10, Math.ceil(Math.max(...highs, 0) / 10) * 10);
    return { lo: ps.length ? lo : 1, hi: ps.length ? hi : 1, tmax, lapsLeft: ctx.laps_left };
  }, [opts, ctx]);

  const style = { '--n': opts.length, '--r': ROWS.length + 1 } as CSSProperties;
  return (
    <div className="sv-cmp" style={style}>
      <div className="sv-labels" aria-hidden>
        <span className="sv-lh" />
        {ROWS.map((r) => (
          <span key={r.key} className="sv-lc" title={r.title}>
            {r.label}
            {r.legend}
          </span>
        ))}
      </div>
      {opts.map((o) => {
        const isTaken = taken?.option === o.id;
        return (
          <div key={o.id} className={`sv-col ${o.available ? '' : 'sv-col--cmp'} ${isTaken ? 'sv-col--taken' : ''}`}>
            <div className="sv-ch">
              <Tyre c={o.compound_after} age={o.id === 'stay_out' ? ctx.tyre_age : 0} />
              <span className="sv-optlabel">{o.label}</span>
              <span className="sv-chpills">
                {!o.available && (
                  <Pill tone="neutral" title={o.why_not}>
                    Comparison
                  </Pill>
                )}
                {isTaken && (
                  <span className="sv-taken" title={taken?.stop ? `Pitted on lap ${taken.stop.lap}${taken.stop.seconds != null ? `, ${taken.stop.seconds.toFixed(1)} s stationary` : ''}${taken.stop.under ? `, under ${COND[taken.stop.under]?.short ?? taken.stop.under}` : ''} (${clock(taken.stop.at)} UTC)` : 'No stop on the lap after this point'}>
                    <IconFlag size={12} /> Taken
                  </span>
                )}
              </span>
            </div>
            {ROWS.map((r) => (
              <div key={r.key} className={`sv-cell sv-cell--${r.key}`}>
                <span className="sv-cl">{r.label}</span>
                <div className="sv-cv">{r.cell(o, scale)}</div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ContextStrip({ ctx, tmax }: { ctx: Context; tmax: number }) {
  const stops = Object.entries(ctx.stop_cost ?? {});
  const field = Object.entries(ctx.field_compounds ?? {});
  const gap = (s: number | null | undefined) => (s != null ? secs(s) : '—');
  return (
    <div className="sv-ctx">
      <Figure size="sm" label="Position" value={ctx.position ? `P${ctx.position}` : '—'} sub={ctx.running ? `of ${ctx.running}` : undefined} />
      <div title={ctx.laps_left_basis}>
        <Figure size="sm" label="Laps left" value={ctx.laps_left ?? '—'} sub={ctx.field_lap ? `lap ${ctx.field_lap}` : undefined} />
      </div>
      <Figure size="sm" label="Ahead" value={gap(ctx.gap_ahead_s)} sub={ctx.car_ahead ? `#${ctx.car_ahead}` : undefined} />
      <div title={ctx.car_behind && ctx.gap_behind_s == null ? 'lapped, or no gap in the feed' : undefined}>
        <Figure size="sm" label="Behind" value={gap(ctx.gap_behind_s)} sub={ctx.car_behind ? `#${ctx.car_behind}` : undefined} />
      </div>
      <Figure
        size="sm"
        label="Tyres"
        value={
          <span className="sv-tyrefig">
            <Tyre c={ctx.compound} age={ctx.tyre_age} />
            {ctx.tyre_age != null ? `${ctx.tyre_age} laps` : '—'}
          </span>
        }
        sub={
          field.length ? (
            <span className="sv-field" title="what the running field is on">
              field{' '}
              {field.map(([c, n]) => (
                <span key={c}>
                  <Tyre c={c} />
                  {n}
                </span>
              ))}
            </span>
          ) : undefined
        }
      />
      <div className="sv-ctx-stops">
        <span className="k-fig-label">A stop costs</span>
        {stops.length ? (
          stops.map(([c, l]) => (
            <div key={c} className={`sv-stopcost ${c === ctx.condition ? 'sv-stopcost--now' : ''}`}>
              <b>{COND[c]?.short ?? c}</b>
              <TimeBar l={l} max={tmax} compact />
            </div>
          ))
        ) : (
          <span className="muted">—</span>
        )}
      </div>
      <Figure size="sm" label="Cap headroom" value={ctx.cap_headroom_cents != null ? usdShort(ctx.cap_headroom_cents) : '—'} />
    </div>
  );
}

// ---------------------------------------------------------------------- the race's decision points on one lap axis

interface Point {
  row: OptionRow;
  taken: Taken | null;
}

function DecisionTrack({ points, sel, onSel, total, stops }: { points: Point[]; sel: string; onSel: (k: string) => void; total: number; stops: NonNullable<Taken['stop']>[] }) {
  const span = Math.max(total - 1, 1);
  const x = (lap: number) => `${Math.max(0, Math.min(100, ((lap - 1) / span) * 100))}%`;
  const bands = useMemo(() => {
    const neutral = new Map<number, string>();
    for (const p of points) if (p.row.condition !== 'green') neutral.set(p.row.lap, p.row.condition);
    const out: { from: number; to: number; cond: string }[] = [];
    for (const lap of [...neutral.keys()].sort((a, b) => a - b)) {
      const c = neutral.get(lap)!;
      const last = out[out.length - 1];
      if (last && last.cond === c && last.to === lap - 1) last.to = lap;
      else out.push({ from: lap, to: lap, cond: c });
    }
    return out;
  }, [points]);
  const flagMarks = points
    .filter((p) => p.row.trigger !== 'lap')
    .map((p) => ({ t: p.row.lap, label: `${COND[p.row.condition]?.label ?? p.row.condition}, lap ${p.row.lap}`, tone: (p.row.condition === 'red' ? 'bad' : 'wait') as Tone }));
  const stopMarks = stops.map((s) => ({
    t: s.lap,
    label: `Pitted lap ${s.lap}${s.seconds != null ? `, ${s.seconds.toFixed(1)} s` : ''}${s.under ? ` under ${COND[s.under]?.short ?? s.under}` : ''}`,
    tone: 'navy' as const,
    big: true,
  }));
  const step = total > 40 ? 10 : 5;
  const scale = [1];
  for (let l = step; l < total - step / 2; l += step) scale.push(l);
  scale.push(total);
  const idx = points.findIndex((p) => p.row.optionKey === sel);
  const cur = points[idx];
  return (
    <div className="sv-track-wrap">
      <div className="sv-track-bar">
        <button type="button" className="sv-step" aria-label="Earlier decision point" disabled={idx <= 0} onClick={() => onSel(points[idx - 1]!.row.optionKey)}>
          <IconArrow size={14} />
        </button>
        <span className="sv-readout">
          <b>L{cur?.row.lap}</b> {TRIGGER[cur?.row.trigger ?? ''] ?? cur?.row.trigger} · {cur ? clock(cur.row.at) : ''} UTC
        </span>
        <button
          type="button"
          className="sv-step sv-step--next"
          aria-label="Later decision point"
          disabled={idx >= points.length - 1}
          onClick={() => onSel(points[idx + 1]!.row.optionKey)}
        >
          <IconArrow size={14} />
        </button>
      </div>
      <div className="sv-track" role="group" aria-label="Decision points this race, by lap">
        {bands.map((b) => (
          <span key={`${b.cond}-${b.from}`} className={`sv-band sv-band--${b.cond}`} style={{ left: x(b.from - 0.5), width: `calc(${x(b.to + 0.5)} - ${x(b.from - 0.5)})` }}>
            <span>{COND[b.cond]?.short ?? b.cond}</span>
          </span>
        ))}
        <div className="sv-track-axis">
          <Axis from={1} to={total} marks={[...flagMarks, ...stopMarks]} height={14} />
        </div>
        {points.map((p) => {
          const on = p.row.optionKey === sel;
          const flag = p.row.trigger !== 'lap';
          const pit = p.taken && p.taken.option !== 'stay_out';
          return (
            <button
              key={p.row.optionKey}
              type="button"
              className={`sv-pt ${flag ? 'sv-pt--flag' : ''} sv-pt--${p.row.condition} ${on ? 'sv-pt--on' : ''} ${pit ? 'sv-pt--pit' : ''}`}
              style={{ left: x(p.row.lap) }}
              aria-pressed={on}
              aria-label={`Lap ${p.row.lap}, ${TRIGGER[p.row.trigger] ?? p.row.trigger}${pit ? ', pitted after' : ''}`}
              title={`Lap ${p.row.lap} · ${TRIGGER[p.row.trigger] ?? p.row.trigger} · ${COND[p.row.condition]?.label ?? p.row.condition}${p.taken ? ` · taken: ${p.taken.option.replace(/_/g, ' ')}` : ''}`}
              onClick={() => onSel(p.row.optionKey)}
            >
              <i />
            </button>
          );
        })}
        <div className="sv-scale" aria-hidden>
          {scale.map((l) => (
            <span key={l} style={{ left: x(l) }}>
              {l}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Basis({ ctx, opts }: { ctx: Context; opts: Opt[] }) {
  return (
    <details className="sv-basis">
      <summary>Basis</summary>
      <ul>
        {ctx.range && <li>{ctx.range}.</li>}
        {ctx.laps_left_basis && <li>Laps left: {ctx.laps_left_basis}.</li>}
        {opts.map((o) => (
          <li key={o.id}>
            <b>{o.label}.</b> {[o.time_lost_s.basis, ...(o.evidence ?? []), o.prize_note, o.cost_cap.line, typeof o.pace === 'object' && o.pace ? o.pace.note : o.pace, o.why_not, ...(o.clauses ?? [])].filter(Boolean).join('; ')}.
          </li>
        ))}
        {ctx.race_end_value && <li>Expected race-end value: {ctx.race_end_value}.</li>}
        {ctx.prize_basis && <li>Prize: {ctx.prize_basis}.</li>}
        {ctx.sponsor_basis && <li>Sponsor: {ctx.sponsor_basis}.</li>}
        {ctx.as_of && <li>{ctx.as_of}.</li>}
        {ctx.credit && <li>{ctx.credit}.</li>}
      </ul>
    </details>
  );
}

function CarDesk({ car, rows, events }: { car: number; rows: OptionRow[]; events: RaceEvent[] }) {
  const ordered = useMemo(() => [...rows].sort((a, b) => a.at.localeCompare(b.at) || a.optionKey.localeCompare(b.optionKey)), [rows]);
  const [picked, setPicked] = useState<string | null>(null);
  const points = useMemo<Point[]>(
    () =>
      ordered.map((r) => {
        const { ctx, opts } = readSet(r);
        return { row: r, taken: takenAt(r, ctx, opts, events) };
      }),
    [ordered, events]
  );
  const latest = ordered[ordered.length - 1]!;
  const row = ordered.find((r) => r.optionKey === picked) ?? latest;
  const { ctx, opts } = useMemo(() => readSet(row), [row]);
  const latestCtx = useMemo(() => readSet(latest).ctx, [latest]);
  const live = row.optionKey === latest.optionKey;
  const total = Math.max(latestCtx.field_lap != null && latestCtx.laps_left != null ? latestCtx.field_lap + latestCtx.laps_left : 0, ...ordered.map((r) => r.lap), 2);
  const taken = points.find((p) => p.row.optionKey === row.optionKey)?.taken ?? null;
  const stops = useMemo(() => {
    const seen = new Map<number, NonNullable<Taken['stop']>>();
    for (const p of points) if (p.taken?.stop) seen.set(p.taken.stop.lap, p.taken.stop);
    return [...seen.values()];
  }, [points]);
  const cond = COND[row.condition] ?? { label: row.condition, short: row.condition, tone: 'wait' as Tone };
  const tmax = Math.max(10, Math.ceil(Math.max(...opts.map((o) => o.time_lost_s.high), ...Object.values(ctx.stop_cost ?? {}).map((l) => l.high), 0) / 10) * 10);

  return (
    <Panel
      className="sv-desk"
      title={`${carLabel(car)}${ctx.driver ? ` · ${ctx.driver}` : ''}`}
      aside={
        <span className="sv-head-aside">
          <Pill tone={cond.tone} title={cond.label}>
            {cond.tone === 'neutral' && <IconFlag size={12} />}
            {cond.short === 'Green' ? 'Green flag' : cond.short}
          </Pill>
          {live ? (
            <Pill tone="info">Latest</Pill>
          ) : (
            <button type="button" className="btn btn--small" onClick={() => setPicked(null)}>
              Back to latest
            </button>
          )}
        </span>
      }
    >
      <DecisionTrack points={points} sel={row.optionKey} onSel={setPicked} total={total} stops={stops} />
      <ContextStrip ctx={ctx} tmax={tmax} />
      <Comparator opts={opts} ctx={ctx} taken={taken} />
      <Basis ctx={ctx} opts={opts} />
    </Panel>
  );
}

// ---------------------------------------------------------------------- the season and the withdraw decision

function Season({ race }: { race: RaceData }) {
  const sim = latestSim(race);
  const facets = sim ? parse<{ facets?: Facet[]; phase?: string }>(sim.payloadJson, {}) : {};
  const list = facets.facets ?? [];
  return (
    <section className="sv-season" aria-labelledby="sv-season-h">
      <header className="sv-sec-head">
        <h2 id="sv-season-h">Season chances</h2>
        {sim && <span className="sv-sec-aside" title={`${sim.trigger} · ${facets.phase ?? ''}`}>re-run {clock(sim.at)} UTC</span>}
      </header>
      {list.length === 0 ? (
        <p className="muted sv-empty">Season probabilities appear after the first re-run of the season.</p>
      ) : (
        <div className="sv-facets">
          {list.map((f) => (
            <div key={f.facet} title={f.basis}>
              <Panel title={f.facet} aside={f.owner}>
                <Odds rows={[...f.outcomes].sort((a, b) => b.p - a.p).slice(0, 5)} />
              </Panel>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function WithdrawDecision({ a }: { a: Action }) {
  const d = parse<Withdraw>(a.detailJson, {});
  const opts = d.options ?? [];
  const avail = d.hours_available ?? 0;
  const max = Math.max(avail, ...opts.map((o) => o.hours_needed[1] ?? 0)) || 1;
  const status =
    a.status === 'awaiting_approval' ? (
      <Pill tone="wait">Team Principal decides</Pill>
    ) : a.status === 'rejected' || a.status === 'cancelled' ? (
      <Pill tone="bad">{a.status}</Pill>
    ) : (
      <Pill tone="ok" title={d.chosen_by ? `by ${d.chosen_by}` : undefined}>
        {d.chosen ? `Chosen: ${d.chosen.replace(/_/g, ' ')}` : a.status}
      </Pill>
    );
  return (
    <Panel title={`${carLabel(d.car ?? 0)} · start or withdraw`} aside={status} className="sv-wd">
      <div className="sv-wd-head" title={d.summary}>
        <Figure size="sm" label="Hours to the start" value={`${avail.toFixed(1)} h`} sub={d.race_start ? `start ${clock(d.race_start)} UTC` : undefined} />
        <Figure size="sm" label="Grid" value={d.grid ? `P${d.grid}` : '—'} />
      </div>
      <ul className="sv-wd-list">
        {opts.map((o) => (
          <li key={o.id} title={o.risk} className={d.chosen === o.id ? 'sv-wd--chosen' : ''}>
            <span className="sv-wd-label">
              {o.label}
              {o.feasible ? <Pill tone="neutral">Fits</Pill> : <Pill tone="bad">Does not fit</Pill>}
            </span>
            <Meter
              value={o.hours_needed[1] ?? 0}
              limit={avail}
              max={max}
              tone={o.feasible ? 'info' : 'bad'}
              label={`${(o.hours_needed[1] ?? 0).toFixed(1)} h of ${avail.toFixed(1)} h`}
            />
            <span className="sv-wd-figs">
              <Val v={o.cost_cents} fmt={(x) => usdShort(x)} />
              <span className="sv-val">
                <span className="sv-v">{o.expected_points.toFixed(1)}</span>
                <span className="sv-rng">exp. pts</span>
              </span>
            </span>
          </li>
        ))}
      </ul>
      {d.outcome && <p className="sv-wd-outcome">Outcome: {d.outcome}</p>}
    </Panel>
  );
}

// ---------------------------------------------------------------------- the view

export function StrategyView() {
  const race = useRace();
  const byCar = useMemo(() => {
    const m = new Map<number, OptionRow[]>();
    for (const o of race.options) m.set(o.driverNumber, [...(m.get(o.driverNumber) ?? []), o]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [race.options]);
  const tape = useMemo(() => race.events.filter((e) => e.kind === 'pit_stop' || e.kind === 'stint' || e.kind === 'lap' || e.kind === 'car_stopped' || e.kind.startsWith('retirement')), [race.events]);
  const withdraws = race.actions.filter((a) => a.kind === 'withdraw_car');

  return (
    <div className="sv">
      <p className="sv-strap">Priced options; the desk does not recommend. The decision is yours.</p>
      {byCar.length === 0 ? (
        !race.connected ? (
          <div className="sv-skel" aria-label="Loading">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <p className="muted sv-empty">Priced options appear at each completed lap of our cars, and at every Safety Car, VSC and red flag.</p>
        )
      ) : (
        byCar.map(([car, rows]) => <CarDesk key={car} car={car} rows={rows} events={tape} />)
      )}
      <Season race={race} />
      {withdraws.length > 0 && (
        <section className="sv-season" aria-labelledby="sv-wd-h">
          <header className="sv-sec-head">
            <h2 id="sv-wd-h">Start or withdraw</h2>
          </header>
          <div className="sv-wds">
            {withdraws.map((a) => (
              <WithdrawDecision key={a.actionKey} a={a} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
