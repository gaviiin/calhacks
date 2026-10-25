import type { ReactNode } from 'react';
import { IconApproved, IconDenied, IconWaiting } from '../../components/icons';
import './kit.css';

// The race-day views' small visual vocabulary. Each piece shows a quantity instead of describing it; the words
// that remain are labels. Blue is a person or the primary action, amber waiting, red refused or off; data is navy/sky.

export type Tone = 'ok' | 'wait' | 'bad' | 'info' | 'neutral';

const ICON = { ok: IconApproved, wait: IconWaiting, bad: IconDenied } as const;

/** A status that never relies on colour alone: icon plus one or two words. */
export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  const Icon = tone === 'ok' || tone === 'wait' || tone === 'bad' ? ICON[tone] : null;
  return (
    <span className={`k-pill k-pill--${tone}`} title={title}>
      {Icon && <Icon size={12} />}
      {children}
    </span>
  );
}

/** One figure with its label; an optional change sits beside it with a direction arrow and its own words. */
export function Figure({ label, value, delta, deltaTone, sub, size = 'md' }: { label: string; value: ReactNode; delta?: string; deltaTone?: Tone; sub?: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <div className={`k-fig k-fig--${size}`}>
      <span className="k-fig-label">{label}</span>
      <span className="k-fig-value">{value}</span>
      {(delta || sub) && (
        <span className="k-fig-foot">
          {delta && <span className={`k-delta k-delta--${deltaTone ?? 'neutral'}`}>{delta}</span>}
          {sub && <span className="k-fig-sub">{sub}</span>}
        </span>
      )}
    </div>
  );
}

/** Shares of one whole as a single bar (outcome probabilities, posted vs held). Labels inline when a segment is wide. */
export function Stack({ parts, height = 10, legend = true }: { parts: { label: string; value: number; tone?: Tone | 'navy' | 'sky' | 'gray' }[]; height?: number; legend?: boolean }) {
  const total = parts.reduce((s, p) => s + Math.max(p.value, 0), 0) || 1;
  return (
    <div className="k-stack">
      <div className="k-stack-bar" style={{ height }} role="img" aria-label={parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}>
        {parts.map((p) =>
          p.value > 0 ? <span key={p.label} className={`k-seg k-seg--${p.tone ?? 'navy'}`} style={{ width: `${(p.value / total) * 100}%` }} title={`${p.label}: ${Math.round((p.value / total) * 100)}%`} /> : null
        )}
      </div>
      {legend && (
        <div className="k-legend">
          {parts.map((p) => (
            <span key={p.label}>
              <i className={`k-dot k-seg--${p.tone ?? 'navy'}`} aria-hidden />
              {p.label} <b>{Math.round((p.value / total) * 100)}%</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A quantity against a limit: hours needed against hours available, spend against the cap. */
export function Meter({ value, limit, max, label, tone, ticks }: { value: number; limit?: number; max: number; label?: ReactNode; tone?: Tone; ticks?: { at: number; label: string }[] }) {
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / (max || 1)) * 100))}%`;
  return (
    <div className="k-meter">
      <div className="k-meter-track">
        <span className={`k-meter-fill k-meter-fill--${tone ?? 'info'}`} style={{ width: pct(value) }} />
        {limit !== undefined && <span className="k-meter-limit" style={{ left: pct(limit) }} />}
        {ticks?.map((t) => (
          <span key={t.label} className="k-meter-tick" style={{ left: pct(t.at) }} title={t.label} />
        ))}
      </div>
      {label && <span className="k-meter-label">{label}</span>}
    </div>
  );
}

/** Things that happened on one race-time axis: a dot per event, coloured by kind, labelled on hover. */
export function Axis({ from, to, marks, height = 28 }: { from: number; to: number; marks: { t: number; label: string; tone?: Tone | 'navy' | 'sky' | 'gray'; big?: boolean }[]; height?: number }) {
  const span = Math.max(to - from, 1);
  return (
    <div className="k-axis" style={{ height }}>
      <span className="k-axis-line" />
      {marks.map((m, i) => (
        <span
          key={`${m.t}-${i}`}
          className={`k-axis-mark k-seg--${m.tone ?? 'navy'} ${m.big ? 'k-axis-mark--big' : ''}`}
          style={{ left: `${((m.t - from) / span) * 100}%` }}
          title={m.label}
          aria-label={m.label}
        />
      ))}
    </div>
  );
}

/** A titled region of a view. No eyebrow, no number: the title carries it; `aside` holds one small figure or control. */
export function Panel({ title, aside, children, className = '' }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`k-panel ${className}`}>
      <header className="k-panel-head">
        <h2>{title}</h2>
        {aside && <span className="k-panel-aside">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

/** Small multiples of probability: one row per outcome, a bar and its share. */
export function Odds({ rows, highlight }: { rows: { label: string; p: number }[]; highlight?: string }) {
  return (
    <ul className="k-odds">
      {rows.map((r) => (
        <li key={r.label} className={r.label === highlight ? 'k-odds--on' : ''}>
          <span className="k-odds-label">{r.label}</span>
          <span className="k-odds-bar" aria-hidden>
            <span style={{ width: `${Math.max(r.p * 100, r.p > 0 ? 1.5 : 0)}%` }} />
          </span>
          <span className="k-odds-p">{r.p > 0 && r.p < 0.1 ? `${(r.p * 100).toFixed(1)}%` : `${Math.round(r.p * 100)}%`}</span>
        </li>
      ))}
    </ul>
  );
}
