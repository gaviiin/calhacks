import type { CSSProperties, ReactNode } from 'react';

// The desk's chart forms, each an SVG with no library: a quantity is drawn, not described. Colours come from CSS
// classes (tokens), so the same chart reads on the light page and on the dark stage.

const fmtPct = (x: number) => `${Math.round(x * 100)}%`;

/** A line over equally spaced points, with the first value as a dashed baseline and a dot on the last. */
export function Spark({ values, width = 160, height = 40, baseline = true, area = true, min, max, className = '', label }: { values: number[]; width?: number; height?: number; baseline?: boolean; area?: boolean; min?: number; max?: number; className?: string; label?: string }) {
  if (values.length < 2) return <svg className={`ch-spark ${className}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? 'no series yet'} />;
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * (width - 6) + 3;
  const y = (v: number) => 3 + (1 - (v - lo) / span) * (height - 6);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const last = values[values.length - 1]!;
  return (
    <svg className={`ch-spark ${className}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label ?? `from ${values[0]} to ${last} over ${values.length} points`}>
      {area && <polygon className="ch-spark-area" points={`${x(0)},${height} ${pts.join(' ')} ${x(values.length - 1)},${height}`} />}
      {baseline && <line className="ch-spark-base" x1={0} x2={width} y1={y(values[0]!)} y2={y(values[0]!)} />}
      <polyline className="ch-spark-line" points={pts.join(' ')} vectorEffect="non-scaling-stroke" />
      <circle className="ch-spark-dot" cx={x(values.length - 1)} cy={y(last)} r={2.8} />
    </svg>
  );
}

/** A ring: one share of a whole, with the figure in the middle. */
export function Ring({ value, size = 64, stroke = 6, tone = 'navy', children, label, track = true }: { value: number; size?: number; stroke?: number; tone?: string; children?: ReactNode; label?: string; track?: boolean }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className={`ch-ring ch-ring--${tone}`} style={{ width: size, height: size }} role="img" aria-label={label ?? fmtPct(v)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {track && <circle className="ch-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />}
        <circle className="ch-ring-fill" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" strokeDasharray={`${c * v} ${c * (1 - v)}`} strokeDashoffset={c / 4} strokeLinecap={v > 0 && v < 1 ? 'round' : 'butt'} />
      </svg>
      <span className="ch-ring-label">{children}</span>
    </span>
  );
}

/** A bullet: a value against a limit, with an uncertainty band behind it (P10 to P90) and tick marks. */
export function Bullet({ value, limit, band, min = 0, max, ticks = [], tone = 'navy', height = 10, label }: { value: number; limit?: number; band?: [number, number]; min?: number; max: number; ticks?: { at: number; label: string }[]; tone?: string; height?: number; label?: string }) {
  const span = max - min || 1;
  const pct = (v: number) => `${Math.max(0, Math.min(100, ((v - min) / span) * 100))}%`;
  return (
    <span className={`ch-bullet ch-bullet--${tone}`} style={{ height }} role="img" aria-label={label}>
      {band && <span className="ch-bullet-band" style={{ left: pct(band[0]), width: `calc(${pct(band[1])} - ${pct(band[0])})` }} />}
      <span className="ch-bullet-fill" style={{ width: pct(value) }} />
      {ticks.map((t) => (
        <span key={t.label} className="ch-bullet-tick" style={{ left: pct(t.at) }} title={t.label} />
      ))}
      {limit !== undefined && <span className="ch-bullet-limit" style={{ left: pct(limit) }} />}
    </span>
  );
}

/** A life bar: used share on a 0..120% track with the 100% tick; the fill is a clip of the life ramp, so the colour at
 *  its end is the condition (glass.css .life-bar). */
export function LifeBar({ used, size, label }: { used: number; size?: 'sm' | 'lg'; label?: string }) {
  const u = Math.max(0, Math.min(120, used));
  return (
    <span className={`life-bar ${size ? `life-bar--${size}` : ''}`} style={{ '--used': `${(u / 1.2).toFixed(2)}%` } as CSSProperties} data-over={u > 100 ? '1' : '0'} role="img" aria-label={label ?? `${Math.round(used)}% of life used`}>
      <i />
    </span>
  );
}

/** A strip of dots, one per event, toned by class. */
export function Dots({ items, max = 8 }: { items: { tone: string; title: string }[]; max?: number }) {
  const shown = items.slice(-max);
  return (
    <span className="ch-dots" title={items.map((i) => i.title).join('\n')}>
      {items.length > max && <span className="ch-dots-more">+{items.length - max}</span>}
      {shown.map((i, k) => (
        <i key={k} className={`ch-dot ch-dot--${i.tone}`} aria-hidden />
      ))}
    </span>
  );
}

/** Shares of one whole as one bar. */
export function Shares({ parts, height = 8 }: { parts: { tone: string; value: number; label: string }[]; height?: number }) {
  const total = parts.reduce((s, p) => s + Math.max(p.value, 0), 0) || 1;
  return (
    <span className="ch-shares" style={{ height }} role="img" aria-label={parts.map((p) => `${p.label} ${fmtPct(p.value / total)}`).join(', ')}>
      {parts.map((p) => (p.value > 0 ? <span key={p.label} className={`ch-share ch-share--${p.tone}`} style={{ width: `${(p.value / total) * 100}%` }} title={`${p.label} ${fmtPct(p.value / total)}`} /> : null))}
    </span>
  );
}

export interface AxisMark {
  x: number;
  tone: string;
  label: string;
  big?: boolean;
  glyph?: string;
}

/**
 * The session on one axis: a step line of a cumulative quantity (cost by lap) and marks for what happened, on a
 * shared x scale. Lanes stack the marks by tone so a crash and a safety car on the same lap both show.
 */
export function LapAxis({ xs, line, marks, width = 600, height = 72, xLabel, format, now }: { xs: number[]; line: number[]; marks: AxisMark[]; width?: number; height?: number; xLabel?: (x: number) => string; format: (v: number) => string; now?: number }) {
  const padL = 4;
  const padR = 8;
  const top = 14;
  const bottom = 18;
  const maxX = Math.max(xs[xs.length - 1] ?? 1, 1);
  const maxY = Math.max(...line, 1);
  const X = (x: number) => padL + (x / maxX) * (width - padL - padR);
  const Y = (v: number) => top + (1 - v / maxY) * (height - top - bottom);
  let d = '';
  xs.forEach((x, i) => {
    const px = X(x).toFixed(1);
    const py = Y(line[i] ?? 0).toFixed(1);
    d += i === 0 ? `M${px} ${py}` : ` H${px} V${py}`;
  });
  const last = line[line.length - 1] ?? 0;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * maxX));
  return (
    <svg className="ch-axis" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${format(last)} by lap ${maxX}, with ${marks.length} marks`}>
      <line className="ch-axis-floor" x1={padL} x2={width - padR} y1={height - bottom + 0.5} y2={height - bottom + 0.5} />
      {ticks.map((t) => (
        <g key={t}>
          <line className="ch-axis-tick" x1={X(t)} x2={X(t)} y1={height - bottom} y2={height - bottom + 4} />
          <text className="ch-axis-text" x={X(t)} y={height - 4} textAnchor={t === 0 ? 'start' : t === maxX ? 'end' : 'middle'}>
            {xLabel ? xLabel(t) : t}
          </text>
        </g>
      ))}
      {d && <path className="ch-axis-area" d={`${d} V${Y(0)} H${X(xs[0] ?? 0)} Z`} />}
      {d && <path className="ch-axis-line" d={d} vectorEffect="non-scaling-stroke" />}
      {now !== undefined && <line className="ch-axis-now" x1={X(now)} x2={X(now)} y1={top - 6} y2={height - bottom} />}
      {marks.map((m, i) => (
        <g key={i} className={`ch-mark ch-mark--${m.tone}`} transform={`translate(${X(m.x).toFixed(1)} ${top - 7})`}>
          <title>{m.label}</title>
          {m.big ? <path d="M0 -5 L5 3 L-5 3 Z" /> : <circle r={2.6} />}
          <line x1={0} x2={0} y1={m.big ? 3 : 2.6} y2={height - bottom - top + 7} className="ch-mark-drop" />
        </g>
      ))}
      {last > 0 && (
        <text className="ch-axis-value" x={width - padR} y={Y(last) - 4} textAnchor="end">
          {format(last)}
        </text>
      )}
    </svg>
  );
}
