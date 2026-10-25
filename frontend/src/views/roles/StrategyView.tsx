import { useMemo, useState, type ReactNode } from 'react';
import { IconApproved, IconDenied, IconFlag, IconWaiting } from '../../components/icons';
import { usdShort } from '../../lib/format';
import { useRace, type RaceData } from '../../lib/race';
import { carLabel } from '../../lib/raceModel';
import { latestSim } from '../raceday/ReplanPanel';
import { clock, parse } from '../raceday/shared';
import './strategy.css';

// The head of strategy's view: for each of our cars, what each decision the pit wall has would do now, priced side by
// side (race/strategy.py, after Varun Sanjeev's decision cockpit). One column per option, the same rows in each; a
// timeline of this race's decision points; what the season now looks like as probabilities; and the start-or-withdraw
// decision, priced the same way. The desk prices the options and never picks one.

type OptionRow = RaceData['options'][number];
type Action = RaceData['actions'][number];

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

/** optionsJson is {"context", "options"}; an older row may carry the options alone. */
function readSet(row: OptionRow): { ctx: Context; opts: Opt[] } {
  const v = parse<unknown>(row.optionsJson, []);
  if (Array.isArray(v)) return { ctx: {}, opts: v as Opt[] };
  const o = v as { context?: Context; options?: Opt[] };
  return { ctx: o.context ?? {}, opts: o.options ?? [] };
}

const COND: Record<string, { label: string; tone: 'ok' | 'hold' | 'alert'; short: string }> = {
  green: { label: 'Green flag', tone: 'ok', short: 'GRN' },
  vsc: { label: 'Virtual Safety Car', tone: 'hold', short: 'VSC' },
  sc: { label: 'Safety Car', tone: 'hold', short: 'SC' },
  red: { label: 'Red flag', tone: 'alert', short: 'RED' },
};
const TRIGGER: Record<string, string> = { lap: 'lap completed', safety_car: 'Safety Car deployed', vsc: 'VSC deployed', red_flag: 'red flag' };
const COMPOUND: Record<string, string> = { SOFT: 'Soft', MEDIUM: 'Medium', HARD: 'Hard', INTERMEDIATE: 'Intermediate', WET: 'Wet' };

const same = <T,>(xs: T[]) => xs.every((x) => x === xs[0]);
const signedUsd = (c: number) => (Math.abs(c) < 50 ? '$0' : `${c > 0 ? '+' : '−'}${usdShort(Math.abs(c))}`);
const signedN = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
const pct = (p: number) => `${(p * 100).toFixed(p > 0 && p < 0.1 ? 1 : 0)}%`;

/** [best, likely, worst] as one figure when they agree, else "likely (best to worst)". */
function Range({ v, fmt }: { v: (number | null)[]; fmt: (x: number) => string }) {
  const xs = v.map((x) => (x == null ? null : x));
  if (xs.some((x) => x == null)) return <span className="muted">—</span>;
  const [b, l, w] = xs as number[];
  if (same([b, l, w])) return <span className="mono">{fmt(l!)}</span>;
  return (
    <span className="mono">
      {fmt(l!)} <span className="muted">({fmt(b!)} to {fmt(w!)})</span>
    </span>
  );
}

function CondChip({ cond }: { cond: string }) {
  const c = COND[cond] ?? { label: cond, tone: 'hold' as const, short: cond.toUpperCase() };
  return (
    <span className={`flag flag--${c.tone}`}>
      <IconFlag size={12} />
      <span>{c.label}</span>
    </span>
  );
}

function lossText(l: Loss): string {
  if (l.method === 'none') return 'no stop';
  if (l.method === 'suspension') return '0 s (suspension)';
  const fig = l.seconds != null ? `${l.seconds.toFixed(1)} s` : `${Math.round(l.low)}–${Math.round(l.high)} s`;
  const how = l.method === 'measured' ? `measured, ${l.samples} stop${l.samples === 1 ? '' : 's'}` : l.method === 'derived' ? `derived from ${l.samples} green stop${l.samples === 1 ? '' : 's'}` : l.method === 'prior' ? 'prior, not measured' : 'range, not measured';
  return `${fig} · ${how}`;
}

// ---------------------------------------------------------------------- the comparator

const ROWS: { key: string; label: string; cell: (o: Opt) => ReactNode }[] = [
  {
    key: 'status',
    label: 'Status',
    cell: (o) =>
      o.available ? (
        <span className="sv-chip sv-chip--open">
          <IconApproved size={12} /> open now
        </span>
      ) : (
        <span className="sv-chip sv-chip--cmp" title={o.why_not}>
          <IconWaiting size={12} /> comparison only
        </span>
      ),
  },
  { key: 'pos', label: 'Position after', cell: (o) => <Range v={o.positions} fmt={(x) => `P${x}`} /> },
  {
    key: 'time',
    label: 'Time lost',
    cell: (o) => (
      <span>
        <span className="mono">{lossText(o.time_lost_s)}</span>
        {o.time_lost_s.basis && o.time_lost_s.method !== 'none' && <span className="sv-sub muted">{o.time_lost_s.basis}</span>}
      </span>
    ),
  },
  {
    key: 'cars',
    label: 'Cars that get past',
    cell: (o) => (
      <span className="mono">
        {o.cars_passed.length ? o.cars_passed.map((c) => `#${c}`).join(' ') : o.id === 'stay_out' ? '—' : 'none'}
        {o.cars_maybe.length > 0 && <span className="sv-sub muted">too close to call: {o.cars_maybe.map((c) => `#${c}`).join(' ')}</span>}
      </span>
    ),
  },
  {
    key: 'pts',
    label: 'Points if it holds',
    cell: (o) => (
      <span>
        <Range v={o.points} fmt={String} />
        {o.points_delta.some((d) => d !== 0) && <span className="sv-sub muted">vs staying out: <Range v={o.points_delta} fmt={signedN} /></span>}
        {(o.clauses ?? []).map((c) => (
          <span key={c} className="sv-sub muted">
            {c}
          </span>
        ))}
      </span>
    ),
  },
  { key: 'place', label: "Constructors' place", cell: (o) => <Range v={o.constructors_place} fmt={(x) => `P${x}`} /> },
  {
    key: 'prize',
    label: 'Prize change (2024 ladder)',
    cell: (o) => (
      <span>
        <Range v={o.prize_delta_cents} fmt={signedUsd} />
        {o.prize_note && <span className="sv-sub muted">{o.prize_note}</span>}
      </span>
    ),
  },
  {
    key: 'sponsor',
    label: 'Sponsor clause change',
    cell: (o) => (
      <span>
        <Range v={o.sponsor_delta_cents} fmt={signedUsd} /> <span className="sv-assume">ASSUMPTION</span>
      </span>
    ),
  },
  {
    key: 'cap',
    label: 'Cost cap',
    cell: (o) => (
      <span>
        <span className="mono">{usdShort(o.cost_cap.cents)}</span>
        <span className="sv-sub muted">{o.cost_cap.line}</span>
      </span>
    ),
  },
  {
    key: 'pace',
    label: 'Pace evidence',
    cell: (o) => {
      const p = o.pace;
      if (!p) return <span className="muted">—</span>;
      if (typeof p === 'string') return <span className="sv-sub">{p}</span>;
      return (
        <span>
          {p.gain_per_lap_s != null && (
            <span className="mono">
              {p.gain_per_lap_s > 0 ? '−' : '+'}
              {Math.abs(p.gain_per_lap_s).toFixed(2)} s/lap on fresh {COMPOUND[p.compound]?.toLowerCase() ?? p.compound.toLowerCase()}s
            </span>
          )}
          <span className="sv-sub muted">{p.note}</span>
        </span>
      );
    },
  },
  { key: 'end', label: 'Expected race-end value', cell: (o) => <span className="muted">{o.race_end_value ?? 'unavailable'}</span> },
];

function Comparator({ opts }: { opts: Opt[] }) {
  return (
    <div className="sv-table-wrap">
      <table className="sv-table">
        <thead>
          <tr>
            <th scope="col" className="sv-rowhead">
              <span className="sv-sr">Row</span>
            </th>
            {opts.map((o) => (
              <th scope="col" key={o.id} className={o.available ? '' : 'sv-col--cmp'}>
                <span className="sv-optid mono">{o.id.replace(/_/g, ' ')}</span>
                <span className="sv-optlabel">{o.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="sv-rowhead">
                {r.label}
              </th>
              {opts.map((o) => (
                <td key={o.id} className={o.available ? '' : 'sv-col--cmp'}>
                  {r.cell(o)}
                </td>
              ))}
            </tr>
          ))}
          <tr>
            <th scope="row" className="sv-rowhead">
              Evidence
            </th>
            {opts.map((o) => (
              <td key={o.id} className={o.available ? '' : 'sv-col--cmp'}>
                <ul className="sv-evidence">
                  {(o.evidence ?? []).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                  {!o.available && o.why_not && <li>{o.why_not}</li>}
                </ul>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ContextStrip({ ctx }: { ctx: Context }) {
  const gap = (car: number | null | undefined, s: number | null | undefined) => (car ? `#${car} ${s != null ? `${s.toFixed(1)} s` : 'lapped or no gap'}` : '—');
  const stops = Object.entries(ctx.stop_cost ?? {});
  return (
    <dl className="sv-context">
      <div>
        <dt>Position</dt>
        <dd className="mono">
          P{ctx.position ?? '—'} <span className="muted">of {ctx.running ?? '—'} running</span>
        </dd>
      </div>
      <div>
        <dt>Laps left</dt>
        <dd className="mono" title={ctx.laps_left_basis}>
          {ctx.laps_left ?? '—'} <span className="muted">race lap {ctx.field_lap ?? '—'}</span>
        </dd>
      </div>
      <div>
        <dt>Gap ahead</dt>
        <dd className="mono">{gap(ctx.car_ahead, ctx.gap_ahead_s)}</dd>
      </div>
      <div>
        <dt>Gap behind</dt>
        <dd className="mono">{gap(ctx.car_behind, ctx.gap_behind_s)}</dd>
      </div>
      <div>
        <dt>Tyres</dt>
        <dd className="mono">
          {COMPOUND[ctx.compound ?? ''] ?? ctx.compound ?? '—'} <span className="muted">{ctx.tyre_age != null ? `${ctx.tyre_age} laps` : 'age unknown'}</span>
        </dd>
      </div>
      <div>
        <dt>Field on</dt>
        <dd className="mono">
          {Object.entries(ctx.field_compounds ?? {})
            .map(([k, v]) => `${v} ${(COMPOUND[k] ?? k).toLowerCase()}`)
            .join(', ') || '—'}
        </dd>
      </div>
      <div className="sv-context-wide">
        <dt>A stop costs, this race</dt>
        <dd className="mono">
          {stops.length
            ? stops.map(([c, l]) => (
                <span key={c} className="sv-stopcost">
                  <b>{COND[c]?.short ?? c}</b> {lossText(l)}
                </span>
              ))
            : '—'}
        </dd>
      </div>
      <div>
        <dt>Cap headroom</dt>
        <dd className="mono">{ctx.cap_headroom_cents != null ? usdShort(ctx.cap_headroom_cents) : '—'}</dd>
      </div>
    </dl>
  );
}

// ---------------------------------------------------------------------- the timeline of decision points

function Timeline({ rows, sel, onSel }: { rows: OptionRow[]; sel: string; onSel: (k: string) => void }) {
  return (
    <ol className="sv-timeline" aria-label="Decision points this race">
      {rows.map((r) => {
        const neutral = r.trigger !== 'lap';
        const c = COND[r.condition];
        const on = r.optionKey === sel;
        return (
          <li key={r.optionKey}>
            <button
              type="button"
              className={`sv-tick ${neutral ? 'sv-tick--flag' : ''} ${on ? 'sv-tick--on' : ''} sv-tick--${c?.tone ?? 'hold'}`}
              aria-pressed={on}
              onClick={() => onSel(r.optionKey)}
              title={`Lap ${r.lap} · ${TRIGGER[r.trigger] ?? r.trigger} · ${c?.label ?? r.condition} · ${clock(r.at)} UTC`}
            >
              {neutral ? `${c?.short ?? r.trigger} L${r.lap}` : `L${r.lap}`}
              {!neutral && r.condition !== 'green' && <span className="sv-tick-cond">{c?.short}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function CarDesk({ car, rows }: { car: number; rows: OptionRow[] }) {
  const ordered = useMemo(() => [...rows].sort((a, b) => a.at.localeCompare(b.at) || a.optionKey.localeCompare(b.optionKey)), [rows]);
  const [picked, setPicked] = useState<string | null>(null);
  const latest = ordered[ordered.length - 1]!;
  const row = ordered.find((r) => r.optionKey === picked) ?? latest;
  const { ctx, opts } = useMemo(() => readSet(row), [row]);
  const live = row.optionKey === latest.optionKey;
  return (
    <section className="sv-car panel" aria-labelledby={`sv-car-${car}`}>
      <header className="sv-car-head">
        <h3 id={`sv-car-${car}`}>
          <span className="mono">{carLabel(car)}</span> {ctx.driver ?? ''}
        </h3>
        <CondChip cond={row.condition} />
        <span className="sv-trigger mono">
          {TRIGGER[row.trigger] ?? row.trigger} · lap {row.lap} · {clock(row.at)} UTC
        </span>
        {live ? (
          <span className="sv-chip sv-chip--open">
            <IconApproved size={12} /> latest
          </span>
        ) : (
          <button type="button" className="btn btn--small" onClick={() => setPicked(null)}>
            Back to the latest
          </button>
        )}
      </header>
      <Timeline rows={ordered} sel={row.optionKey} onSel={setPicked} />
      <ContextStrip ctx={ctx} />
      <Comparator opts={opts} />
      <p className="sv-foot muted">
        {ctx.race_end_value ? `Expected race-end value: ${ctx.race_end_value}. ` : ''}
        {ctx.sponsor_basis ?? ''} {ctx.prize_basis ? `Prize: ${ctx.prize_basis}.` : ''}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------- the season and the withdraw decision

function Facets({ race }: { race: RaceData }) {
  const sim = latestSim(race);
  const facets = sim ? parse<{ facets?: Facet[]; phase?: string }>(sim.payloadJson, {}) : {};
  const list = facets.facets ?? [];
  if (!list.length) return <p className="muted">The season has not been simulated yet.</p>;
  return (
    <>
      <p className="muted sv-sub-head">
        Latest re-run of the season · {sim!.trigger.split('@')[0]} · {facets.phase ?? ''} · {clock(sim!.at)} UTC
      </p>
      <div className="sv-facets">
        {list.map((f) => {
          const top = [...f.outcomes].sort((a, b) => b.p - a.p).slice(0, 5);
          return (
            <article key={f.facet} className="sv-facet">
              <h4>{f.facet}</h4>
              <p className="muted sv-owner">{f.owner}</p>
              <ul>
                {top.map((o) => (
                  <li key={o.label}>
                    <span className="sv-facet-label">{o.label}</span>
                    <span className="sv-bar" aria-hidden>
                      <span style={{ width: `${Math.min(100, o.p * 100)}%` }} />
                    </span>
                    <span className="mono">{pct(o.p)}</span>
                  </li>
                ))}
              </ul>
              {f.basis && <p className="muted sv-sub">{f.basis}</p>}
            </article>
          );
        })}
      </div>
    </>
  );
}

function WithdrawDecision({ a }: { a: Action }) {
  const d = parse<Withdraw>(a.detailJson, {});
  const opts = d.options ?? [];
  const avail = d.hours_available ?? 0;
  const status =
    a.status === 'awaiting_approval' ? (
      <span className="sv-chip sv-chip--wait">
        <IconWaiting size={12} /> waiting for the Team Principal
      </span>
    ) : a.status === 'rejected' || a.status === 'cancelled' ? (
      <span className="sv-chip sv-chip--no">
        <IconDenied size={12} /> {a.status}
      </span>
    ) : (
      <span className="sv-chip sv-chip--open">
        <IconApproved size={12} /> {d.chosen ? `chosen: ${d.chosen.replace(/_/g, ' ')}` : a.status}
        {d.chosen_by ? ` by ${d.chosen_by}` : ''}
      </span>
    );
  return (
    <section className="sv-car panel" aria-labelledby={`sv-wd-${a.actionKey}`}>
      <header className="sv-car-head">
        <h3 id={`sv-wd-${a.actionKey}`}>
          <span className="mono">{carLabel(d.car ?? 0)}</span> start or withdraw
        </h3>
        {status}
        <span className="sv-trigger mono">
          {avail.toFixed(1)} h from the crash to the start{d.race_start ? ` (${clock(d.race_start)} UTC)` : ''} · grid {d.grid ? `P${d.grid}` : '?'}
        </span>
      </header>
      <div className="sv-table-wrap">
        <table className="sv-table">
          <thead>
            <tr>
              <th scope="col" className="sv-rowhead">
                <span className="sv-sr">Row</span>
              </th>
              {opts.map((o) => (
                <th scope="col" key={o.id}>
                  <span className="sv-optid mono">{o.id.replace(/_/g, ' ')}</span>
                  <span className="sv-optlabel">{o.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className="sv-rowhead">
                Fits the time
              </th>
              {opts.map((o) => (
                <td key={o.id}>
                  {o.feasible ? (
                    <span className="sv-chip sv-chip--open">
                      <IconApproved size={12} /> fits
                    </span>
                  ) : (
                    <span className="sv-chip sv-chip--no">
                      <IconDenied size={12} /> does not fit
                    </span>
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className="sv-rowhead">
                Hours needed
              </th>
              {opts.map((o) => (
                <td key={o.id}>
                  <Range v={o.hours_needed} fmt={(x) => `${x.toFixed(1)} h`} /> <span className="muted">of {avail.toFixed(1)} h</span>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className="sv-rowhead">
                Cost
              </th>
              {opts.map((o) => (
                <td key={o.id}>
                  <Range v={o.cost_cents} fmt={(x) => usdShort(x)} />
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className="sv-rowhead">
                Expected points
              </th>
              {opts.map((o) => (
                <td key={o.id} className="mono">
                  {o.expected_points.toFixed(1)}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className="sv-rowhead">
                Risk
              </th>
              {opts.map((o) => (
                <td key={o.id} className="sv-sub">
                  {o.risk}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {d.summary && <p className="sv-foot muted">{d.summary}</p>}
      {d.outcome && <p className="sv-foot">What happened: {d.outcome}</p>}
    </section>
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
  const withdraws = race.actions.filter((a) => a.kind === 'withdraw_car');

  return (
    <div className="sv">
      <p className="sv-strap">
        <IconFlag size={14} /> Priced options; the desk does not recommend. The decision is yours.
      </p>
      {byCar.length === 0 ? (
        <p className="muted">No decision points priced yet: options appear at each completed lap of our cars, and at every Safety Car, VSC and red flag of the race.</p>
      ) : (
        byCar.map(([car, rows]) => <CarDesk key={car} car={car} rows={rows} />)
      )}
      {withdraws.length > 0 && (
        <>
          <h2 className="sv-h">Start or withdraw</h2>
          {withdraws.map((a) => (
            <WithdrawDecision key={a.actionKey} a={a} />
          ))}
        </>
      )}
      <h2 className="sv-h">The season, as probabilities</h2>
      <Facets race={race} />
    </div>
  );
}
