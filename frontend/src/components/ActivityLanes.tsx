import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { plural } from '../lib/format';

// Activity on one clock, one lane per actor. A bar is how many rows the lane wrote in that slot; a
// red cross is an attempt the module refused. The caller says which clock: the books chart puts each
// row on the ledger date of the line it acted on, the race chart on the race time of the crash,
// question, entry or plan it acted on. Rows with no date on that clock are left out and counted.

export interface Lane {
  key: string;
  label: string;
  kind: 'evidence' | 'agent' | 'person' | 'system';
  note: string;
}

export interface LaneEvent {
  t: number;
  lane: string;
  allowed: boolean;
  action: string;
}

export interface Marker {
  t: number;
  label: string;
}

const LANE_H = 30;
const AXIS_H = 26;
const MARK_H = 18;
const BIN_PX = 7;
const DAY = 86_400_000;

function niceStep(spanMs: number, bins: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240].map((m) => m * 60_000);
  const target = spanMs / Math.max(4, bins / 22);
  return steps.find((s) => s >= target) ?? steps[steps.length - 1];
}

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
const dayWord = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function ActivityLanes({
  id,
  title,
  blurb,
  lanes: laneDefs,
  events,
  unit,
  markers = [],
  undated = 0,
  undatedWord = 'row',
  empty,
  onWindow,
}: {
  id: string;
  title: string;
  blurb: ReactNode;
  lanes: Lane[];
  events: LaneEvent[];
  /** 'minute': a race clock in UTC; 'day': ledger dates, one bar per day */
  unit: 'minute' | 'day';
  markers?: Marker[];
  /** rows left out because they have no time on this clock */
  undated?: number;
  undatedWord?: string;
  empty: ReactNode;
  onWindow?: (from: number, to: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const compact = width < 560;
  const LABEL_W = compact ? 116 : 200;
  const plotW = Math.max(120, width - LABEL_W - 16);

  const model = useMemo(() => {
    if (!events.length) return null;
    const lanes = laneDefs.filter((l) => events.some((e) => e.lane === l.key));
    const ts = [...events.map((e) => e.t), ...markers.map((m) => m.t)];
    let t0 = Math.min(...ts);
    let t1 = Math.max(...ts);
    let bins: number;
    let binMs: number;
    let span: number;
    let ticks: number[] = [];
    if (unit === 'day') {
      t0 = Math.floor(t0 / DAY) * DAY;
      t1 = Math.floor(t1 / DAY) * DAY + DAY;
      bins = Math.max(1, Math.round((t1 - t0) / DAY));
      binMs = DAY;
      span = t1 - t0;
      const every = bins > 45 ? 14 : bins > 16 ? 7 : 1;
      // weekly ticks fall on Mondays, so the weekends read as the gaps they are
      let mondays = 0;
      for (let i = 0; i < bins; i += 1) {
        const t = t0 + i * DAY;
        if (every === 1) ticks.push(t);
        else if (new Date(t).getUTCDay() === 1 && mondays++ % (every / 7) === 0) ticks.push(t);
      }
    } else {
      bins = Math.max(24, Math.floor(plotW / BIN_PX));
      // a little air either side, so the first crash isn't on the axis
      const pad = Math.max(5 * 60_000, (t1 - t0) * 0.02);
      t0 -= pad;
      t1 += pad;
      span = Math.max(60_000, t1 - t0);
      binMs = span / bins;
      const step = niceStep(span, bins);
      for (let t = Math.ceil(t0 / step) * step; t <= t0 + span; t += step) ticks.push(t);
    }
    const grid = new Map<string, { ok: number[]; denied: number[]; actions: Map<string, number>[] }>();
    for (const l of lanes) {
      grid.set(l.key, { ok: new Array(bins).fill(0), denied: new Array(bins).fill(0), actions: Array.from({ length: bins }, () => new Map()) });
    }
    const totals = new Map<string, { ok: number; denied: number }>();
    for (const e of events) {
      const g = grid.get(e.lane);
      if (!g) continue;
      const i = Math.max(0, Math.min(bins - 1, Math.floor((e.t - t0) / binMs)));
      (e.allowed ? g.ok : g.denied)[i] += 1;
      const key = e.allowed ? e.action : `${e.action} (denied)`;
      g.actions[i].set(key, (g.actions[i].get(key) ?? 0) + 1);
      const tot = totals.get(e.lane) ?? { ok: 0, denied: 0 };
      if (e.allowed) tot.ok += 1;
      else tot.denied += 1;
      totals.set(e.lane, tot);
    }
    let maxOk = 1;
    for (const g of grid.values()) for (const c of g.ok) maxOk = Math.max(maxOk, c);
    return { lanes, grid, totals, t0, span, bins, binMs, maxOk, ticks };
  }, [events, markers, laneDefs, unit, plotW]);

  if (!model) {
    return (
      <section className="spine spine--empty" ref={wrap}>
        <h2>{title}</h2>
        <p className="muted">{empty}</p>
      </section>
    );
  }

  const { lanes, grid, totals, t0, span, bins, binMs, maxOk, ticks } = model;
  const top = markers.length ? MARK_H : 0;
  const bx = (i: number) => (i / bins) * plotW;
  const tx = (t: number) => ((t - t0) / span) * plotW;
  const lanesH = lanes.length * LANE_H;
  const height = top + lanesH + AXIS_H;
  const bw = Math.max(2, plotW / bins - 2);
  const totalDenied = [...totals.values()].reduce((s, t) => s + t.denied, 0);
  const slot = (i: number) =>
    unit === 'day' ? dayWord(t0 + i * binMs) : `${hhmm(t0 + i * binMs)} – ${hhmm(t0 + (i + 1) * binMs)} UTC`;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(bins - 1, Math.floor(((e.clientX - r.left) / r.width) * bins))));
  };
  const hoverRows =
    hover === null
      ? []
      : lanes
          .map((l) => ({ lane: l, actions: [...grid.get(l.key)!.actions[hover].entries()].sort((a, b) => b[1] - a[1]) }))
          .filter((r) => r.actions.length);

  return (
    <section className="spine" aria-labelledby={`${id}-h`} ref={wrap}>
      <div className="spine-head">
        <h2 id={`${id}-h`}>{title}</h2>
        <p className="muted">
          {blurb} {plural(events.length, 'row')} on this clock
          {undated ? `; ${plural(undated, undatedWord)} with no ${unit === 'day' ? 'ledger date' : 'race time'} are in the table only` : ''}.{' '}
          {totalDenied > 0 && <span className="tone-alert">{plural(totalDenied, 'attempt')} refused.</span>}{' '}
          {onWindow && 'Click a column to see those rows below.'}
        </p>
      </div>
      <div className="spine-plot">
        <svg width={width} height={height} role="img" aria-label={`${title}; the table below lists every row`}>
          {markers.length > 0 && (
            <g transform={`translate(${LABEL_W} 0)`} className="marks">
              {markers.map((m) => (
                <g key={`${m.t}-${m.label}`} transform={`translate(${tx(m.t)} 0)`}>
                  <line y1={MARK_H - 4} y2={MARK_H + lanesH} className="mark-line" />
                  <text y={MARK_H - 7} dx={3} className="mark-label">
                    {m.label}
                  </text>
                </g>
              ))}
            </g>
          )}
          {lanes.map((l, li) => {
            const y = top + li * LANE_H;
            const g = grid.get(l.key)!;
            const tot = totals.get(l.key) ?? { ok: 0, denied: 0 };
            return (
              <g key={l.key} transform={`translate(0 ${y})`} className={`lane lane--${l.kind}`}>
                <text x={0} y={13} className="lane-label">
                  {l.label}
                </text>
                <text x={0} y={25} className="lane-note">
                  {tot.ok.toLocaleString()}
                  {tot.denied ? ` · ${tot.denied} refused` : ''}
                  {compact ? '' : ` · ${l.note}`}
                </text>
                <g transform={`translate(${LABEL_W} 0)`}>
                  <line x1={0} x2={plotW} y1={LANE_H - 2} y2={LANE_H - 2} className="lane-base" />
                  {g.ok.map((c, i) => {
                    if (!c) return null;
                    const h = 3 + (LANE_H - 9) * Math.sqrt(c / maxOk);
                    return <rect key={i} x={bx(i) + 1} y={LANE_H - 2 - h} width={bw} height={h} rx={1} className="bin" />;
                  })}
                  {g.denied.map((c, i) => {
                    if (!c) return null;
                    const cx = bx(i) + bw / 2 + 1;
                    return <path key={`d${i}`} d={`M${cx - 3.5} 4.5 l7 7 m0 -7 l-7 7`} className="denied" />;
                  })}
                </g>
              </g>
            );
          })}
          <g transform={`translate(${LABEL_W} ${top + lanesH})`} className="axis">
            {ticks.map((t) => (
              <g key={t} transform={`translate(${unit === 'day' ? tx(t) + (plotW / bins) / 2 : tx(t)} 0)`}>
                <line y1={-lanesH} y2={4} className="gridline" />
                <text y={18} textAnchor="middle">
                  {unit === 'day' ? dayWord(t) : hhmm(t)}
                </text>
              </g>
            ))}
            <text x={-LABEL_W} y={18} className="axis-unit">
              {unit === 'day' ? 'ledger date' : 'race clock, UTC'}
            </text>
          </g>
          {hover !== null && (
            <line x1={LABEL_W + bx(hover) + bw / 2 + 1} x2={LABEL_W + bx(hover) + bw / 2 + 1} y1={top} y2={top + lanesH} className="crosshair" />
          )}
          <rect
            x={LABEL_W}
            y={top}
            width={plotW}
            height={lanesH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            onClick={() => hover !== null && onWindow?.(t0 + hover * binMs, t0 + (hover + 1) * binMs)}
            style={{ cursor: onWindow ? 'pointer' : 'default' }}
          />
        </svg>
        {hover !== null && hoverRows.length > 0 && (
          <div className="tooltip" style={{ left: Math.min(width - 260, LABEL_W + bx(hover) + 14), top: top + 8 }} role="status">
            <p className="tooltip-time">{slot(hover)}</p>
            {hoverRows.map((r) => (
              <div key={r.lane.key} className="tooltip-row">
                <span className={`tooltip-key tooltip-key--${r.lane.kind}`} />
                <span className="tooltip-lane">{r.lane.label}</span>
                <span className="tooltip-acts">
                  {r.actions.slice(0, 3).map(([a, n]) => (
                    <span key={a} className={a.endsWith('(denied)') ? 'tone-alert' : undefined}>
                      <b>{n}</b> {a.replace(/_/g, ' ')}
                    </span>
                  ))}
                </span>
              </div>
            ))}
            {onWindow && <p className="tooltip-hint">Click to open these rows below</p>}
          </div>
        )}
      </div>
    </section>
  );
}
