import { useEffect, useMemo, useRef, useState } from 'react';
import { useCostCap } from '../lib/costcap';
import { useEvidence } from '../lib/evidence';
import { clock, plural } from '../lib/format';

// The shift on one clock. Every actor that touched the system of work has a lane; activity is
// binned on a shared time axis. People's decisions are lime, everything agents and systems did is
// steel, and an attempt the module refused is a coral mark on the lane that tried it. The audit
// view is this chart's table.

interface Lane {
  key: string;
  label: string;
  kind: 'evidence' | 'agent' | 'person' | 'system';
  note: string;
}

const LANES: Lane[] = [
  { key: 'fia', label: 'FIA feed', kind: 'evidence', note: 'Apify captures of fia.com' },
  { key: 'sync', label: 'Sync job', kind: 'system', note: 'systems of record → work' },
  { key: 'ai_policy_learner', label: 'Policy Learner', kind: 'agent', note: 'Claude · drafts policies' },
  { key: 'ai_cap_analyst', label: 'Cap Analyst', kind: 'agent', note: 'Claude · proposes, asks' },
  { key: 'auto_approver', label: 'Standing approvals', kind: 'system', note: 'what an approved rule decided' },
  { key: 'human_head_of_cost_cap', label: 'Head of Cost Cap', kind: 'person', note: 'new scenarios, policies' },
  { key: 'human_controller', label: 'Controller', kind: 'person', note: 'new scenarios below materiality' },
  { key: 'gateway', label: 'ERP gateway', kind: 'system', note: 'the only poster' },
  { key: 'red_team', label: 'Red team', kind: 'system', note: 'forbidden calls on purpose' },
];

interface Ev {
  t: number;
  lane: string;
  allowed: boolean;
  action: string;
}

const LANE_H = 30;
const AXIS_H = 26;
const BIN_PX = 7;

function niceStep(spanMs: number, bins: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240].map((m) => m * 60_000);
  const target = spanMs / Math.max(4, bins / 22);
  return steps.find((s) => s >= target) ?? steps[steps.length - 1];
}

export function Spine({ onWindow }: { onWindow?: (from: number, to: number) => void }) {
  const cc = useCostCap();
  const ev = useEvidence();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(el);
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      ro.disconnect();
      window.clearInterval(t);
    };
  }, []);

  const events = useMemo<Ev[]>(() => {
    const out: Ev[] = cc.audit.map((a) => ({
      t: a.at.toDate().getTime(),
      lane: a.actorRole,
      allowed: a.allowed,
      action: a.action,
    }));
    for (const d of ev.documents) {
      const t = Date.parse(d.ingestedAt);
      if (!Number.isNaN(t)) out.push({ t, lane: 'fia', allowed: true, action: 'ingest_document' });
    }
    return out;
  }, [cc.audit, ev.documents]);

  const compact = width < 560;
  const LABEL_W = compact ? 116 : 188;
  const plotW = Math.max(120, width - LABEL_W - 16);
  const bins = Math.max(24, Math.floor(plotW / BIN_PX));

  const model = useMemo(() => {
    const lanes = LANES.filter((l) => events.some((e) => e.lane === l.key));
    if (!events.length) return null;
    const t0 = Math.min(...events.map((e) => e.t));
    const t1 = Math.max(now, ...events.map((e) => e.t));
    const span = Math.max(60_000, t1 - t0) * 1.02;
    const binMs = span / bins;
    const grid = new Map<string, { ok: number[]; denied: number[]; actions: Map<string, number>[] }>();
    for (const l of lanes) {
      grid.set(l.key, {
        ok: new Array(bins).fill(0),
        denied: new Array(bins).fill(0),
        actions: Array.from({ length: bins }, () => new Map()),
      });
    }
    const totals = new Map<string, { ok: number; denied: number }>();
    for (const e of events) {
      const g = grid.get(e.lane);
      if (!g) continue;
      const i = Math.min(bins - 1, Math.floor((e.t - t0) / binMs));
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
    const step = niceStep(span, bins);
    const ticks: number[] = [];
    for (let t = Math.ceil(t0 / step) * step; t <= t0 + span; t += step) ticks.push(t);
    return { lanes, grid, totals, t0, span, binMs, maxOk, ticks };
  }, [events, bins, now]);

  if (!model) {
    return (
      <section className="spine spine--empty" ref={wrap}>
        <h2>The shift</h2>
        <p className="muted">
          Nothing has touched the system of work yet. Run <code>make cost-cap-run</code>, and every actor's lane fills in here as
          it works.
        </p>
      </section>
    );
  }

  const { lanes, grid, totals, t0, span, binMs, maxOk, ticks } = model;
  const bx = (i: number) => (i / bins) * plotW;
  const tx = (t: number) => ((t - t0) / span) * plotW;
  const height = lanes.length * LANE_H + AXIS_H;
  const bw = Math.max(2, plotW / bins - 2);
  const totalDenied = [...totals.values()].reduce((s, t) => s + t.denied, 0);

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
    <section className="spine" aria-labelledby="spine-h" ref={wrap}>
      <div className="spine-head">
        <h2 id="spine-h">The shift</h2>
        <p className="muted">
          {plural(events.length, 'recorded action')} since {clock(new Date(t0))}. Agents propose, people decide, only the gateway
          posts. {totalDenied > 0 && <span className="tone-alert">{plural(totalDenied, 'attempt')} refused by the module.</span>}
        </p>
      </div>
      <div className="spine-plot">
        <svg width={width} height={height} role="img" aria-label="Activity by actor over time; the audit view lists every action">
          {lanes.map((l, li) => {
            const y = li * LANE_H;
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
                    return (
                      <path key={`d${i}`} d={`M${cx - 3.5} 4.5 l7 7 m0 -7 l-7 7`} className="denied" />
                    );
                  })}
                </g>
              </g>
            );
          })}
          <g transform={`translate(${LABEL_W} ${lanes.length * LANE_H})`} className="axis">
            {ticks.filter((t) => Math.abs(tx(t) - tx(now)) > 40).map((t) => (
              <g key={t} transform={`translate(${tx(t)} 0)`}>
                <line y1={-lanes.length * LANE_H} y2={4} className="gridline" />
                <text y={18} textAnchor="middle">
                  {clock(new Date(t)).slice(0, 5)}
                </text>
              </g>
            ))}
            <g transform={`translate(${tx(now)} 0)`} className="now">
              <line y1={-lanes.length * LANE_H} y2={4} />
              <text y={18} textAnchor="end" dx={-4}>
                now
              </text>
            </g>
          </g>
          {hover !== null && (
            <line
              x1={LABEL_W + bx(hover) + bw / 2 + 1}
              x2={LABEL_W + bx(hover) + bw / 2 + 1}
              y1={0}
              y2={lanes.length * LANE_H}
              className="crosshair"
            />
          )}
          <rect
            x={LABEL_W}
            y={0}
            width={plotW}
            height={lanes.length * LANE_H}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            onClick={() => hover !== null && onWindow?.(t0 + hover * binMs, t0 + (hover + 1) * binMs)}
            style={{ cursor: onWindow ? 'pointer' : 'default' }}
          />
        </svg>
        {hover !== null && hoverRows.length > 0 && (
          <div
            className="tooltip"
            style={{ left: Math.min(width - 260, LABEL_W + bx(hover) + 14), top: 8 }}
            role="status"
          >
            <p className="tooltip-time">
              {clock(new Date(t0 + hover * binMs))} – {clock(new Date(t0 + (hover + 1) * binMs))}
            </p>
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
            {onWindow && <p className="tooltip-hint">Click to open these rows in the audit log</p>}
          </div>
        )}
      </div>
    </section>
  );
}
