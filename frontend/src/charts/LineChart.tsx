import { useMemo, useState, type ReactNode } from 'react';
import { useWidth } from '../lib/motion';

// One hand-drawn line chart for the dashboard: thin 2px lines, a recessive grid, a crosshair with a
// tooltip, direct labels at the end of each line and a legend when there is more than one series.
// Series colours are the design system's neutrals (ink, steel) plus the status colours only where
// the series is a status (a penalty is a loss, so it is coral).

export interface Series {
  key: string;
  label: string;
  /** y per x index; null leaves a gap */
  values: (number | null)[];
  /** css colour var */
  color: string;
  dashed?: boolean;
  /** fill under the line, 0..1 */
  area?: number;
}

export interface Marker {
  x: number;
  label: string;
  tone?: 'ink' | 'alert' | 'hold' | 'muted';
}

export interface Band {
  from: number;
  to: number;
  label?: string;
}

interface Props {
  xs: number[];
  series: Series[];
  xLabel: (x: number) => string;
  yLabel: (y: number) => string;
  /** fixed y range, else from the data */
  yMin?: number;
  yMax?: number;
  height?: number;
  markers?: Marker[];
  bands?: Band[];
  /** a horizontal reference line */
  zero?: boolean;
  tooltip?: (i: number) => ReactNode;
  ariaLabel: string;
}

function nice(max: number, min: number, n = 4): number[] {
  const span = max - min || 1;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export function LineChart({ xs, series, xLabel, yLabel, yMin, yMax, height = 220, markers = [], bands = [], zero, tooltip, ariaLabel }: Props) {
  const [wrap, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const PAD = { l: 56, r: 118, t: 14, b: 26 };
  const H = height;
  const pw = w - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;
  const { lo, hi, ticks } = useMemo(() => {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    let lo = yMin ?? Math.min(0, ...all);
    let hi = yMax ?? Math.max(0, ...all);
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.06;
    if (yMin === undefined) lo -= all.some((v) => v < 0) ? pad : 0;
    if (yMax === undefined) hi += pad;
    return { lo, hi, ticks: nice(hi, lo) };
  }, [series, yMin, yMax]);
  const x0 = xs[0];
  const x1 = xs[xs.length - 1];
  const X = (x: number) => PAD.l + ((x - x0) / Math.max(1e-9, x1 - x0)) * pw;
  const Y = (y: number) => PAD.t + (1 - (y - lo) / (hi - lo)) * ph;
  const path = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${X(xs[i]).toFixed(1)} ${Y(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const areaPath = (vals: (number | null)[]) => {
    const pts = vals.map((v, i) => (v === null ? null : [X(xs[i]), Y(v)] as const)).filter((p): p is readonly [number, number] => p !== null);
    if (!pts.length) return '';
    const base = Y(Math.max(lo, Math.min(0, hi)));
    return `M${pts[0][0]} ${base} ` + pts.map((p) => `L${p[0]} ${p[1]}`).join(' ') + ` L${pts[pts.length - 1][0]} ${base} Z`;
  };
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const xv = x0 + fx * (x1 - x0);
    let best = 0;
    xs.forEach((x, i) => {
      if (Math.abs(x - xv) < Math.abs(xs[best] - xv)) best = i;
    });
    setHover(best);
  };

  return (
    <div className="chart" ref={wrap}>
      <svg width={w} height={H} role="img" aria-label={ariaLabel}>
        {bands.map((b, i) => (
          <g key={i}>
            <rect x={X(b.from)} y={PAD.t} width={Math.max(0, X(b.to) - X(b.from))} height={ph} className="chart-band" />
            {b.label && (
              <text x={X(b.from) + 6} y={PAD.t + 12} className="chart-band-label">
                {b.label}
              </text>
            )}
          </g>
        ))}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={PAD.l + pw} y1={Y(t)} y2={Y(t)} className={zero && t === 0 ? 'chart-zero' : 'gridline'} />
            <text x={PAD.l - 8} y={Y(t) + 4} textAnchor="end" className="axis-label">
              {yLabel(t)}
            </text>
          </g>
        ))}
        {xs.filter((_, i) => i % Math.max(1, Math.round(xs.length / 6)) === 0 || i === xs.length - 1).map((x) => (
          <text key={x} x={X(x)} y={H - 6} textAnchor="middle" className="axis-label">
            {xLabel(x)}
          </text>
        ))}
        {series.map((s) =>
          s.area ? <path key={`a${s.key}`} d={areaPath(s.values)} fill={`var(${s.color})`} opacity={s.area} /> : null
        )}
        {series.map((s) => (
          <path key={s.key} d={path(s.values)} fill="none" stroke={`var(${s.color})`} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" className="chart-line" />
        ))}
        {series.map((s) => {
          const last = [...s.values].reverse().findIndex((v) => v !== null);
          if (last < 0) return null;
          const i = s.values.length - 1 - last;
          const v = s.values[i] as number;
          return (
            <text key={`l${s.key}`} x={X(xs[i]) + 8} y={Y(v) + 4} className="chart-direct" fill={`var(${s.color})`}>
              {s.label}
            </text>
          );
        })}
        {markers.map((m, i) => (
          <g key={m.label} transform={`translate(${X(m.x)} 0)`} className={`chart-marker chart-marker--${m.tone ?? 'ink'}`}>
            <line y1={PAD.t} y2={PAD.t + ph} />
            <text y={PAD.t + 12 + (i % 3) * 13} x={4} textAnchor="start">
              {m.label}
            </text>
          </g>
        ))}
        {hover !== null && (
          <g>
            <line x1={X(xs[hover])} x2={X(xs[hover])} y1={PAD.t} y2={PAD.t + ph} className="crosshair" />
            {series.map((s) =>
              s.values[hover] === null ? null : <circle key={s.key} cx={X(xs[hover])} cy={Y(s.values[hover] as number)} r={4} fill={`var(${s.color})`} stroke="var(--panel)" strokeWidth={2} />
            )}
          </g>
        )}
        <rect x={PAD.l} y={PAD.t} width={pw} height={ph} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: Math.min(w - 270, X(xs[hover]) + 12), top: PAD.t }}>
          <p className="tooltip-time">{xLabel(xs[hover])}</p>
          {tooltip
            ? tooltip(hover)
            : series.map((s) => (
                <div key={s.key} className="tooltip-row">
                  <span className="tooltip-line" style={{ background: `var(${s.color})` }} />
                  <span>
                    <b className="mono">{s.values[hover] === null ? '—' : yLabel(s.values[hover] as number)}</b> <span className="muted">{s.label}</span>
                  </span>
                </div>
              ))}
        </div>
      )}
      {series.length > 1 && (
        <ul className="legend">
          {series.map((s) => (
            <li key={s.key}>
              <span className="swatch" style={{ background: `var(${s.color})` }} /> {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
