import { useEffect, useMemo, useRef, useState } from 'react';
import { IconApproved, IconDenied, IconExternal, IconShield, IconWaiting } from '../components/icons';
import { dayTime, usdShort } from '../lib/format';
import { DEMO_STOP_BEFORE, useRevenue, type Round, type Weekend } from '../lib/revenue';

// The revenue desk in race time: real 2024 results and real FIA documents drive the books.

const MERIDIAN_CARS = [44, 63]; // Meridian's results mirror Mercedes, cars 44 and 63
const SERIES = [
  { key: 'base', label: 'Base fees', cls: 's1' },
  { key: 'bonus', label: 'Performance bonuses', cls: 's2' },
  { key: 'prize', label: 'Prize money accrual', cls: 's3' },
] as const;

function SeasonColumns({ rounds }: { rounds: Round[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(760);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 180;
  const AX = 22;
  const GUT = 48; // tick labels
  const max = Math.max(1, ...rounds.map((r) => r.revenue.base + r.revenue.bonus + r.revenue.prize));
  const band = (w - GUT) / Math.max(1, rounds.length);
  const bw = Math.min(24, band - 6);
  const y = (v: number) => (v / max) * (H - 12);
  const ticks = [0.25, 0.5, 0.75, 1].map((f) => f * max);
  const r = hover === null ? null : rounds[hover];
  return (
    <div className="season" ref={wrap}>
      <svg width={w} height={H + AX} role="img" aria-label="Revenue recognised per round, by kind; the table below lists every sponsor">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={GUT} x2={w} y1={H - y(t)} y2={H - y(t)} className="gridline" />
            <text x={GUT - 8} y={H - y(t) + 4} textAnchor="end" className="axis-label">
              {usdShort(t)}
            </text>
          </g>
        ))}
        {rounds.map((rd, i) => {
          let acc = 0;
          const x = GUT + i * band + (band - bw) / 2;
          return (
            <g key={rd.round} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} className={rd.final ? '' : 'col--pending'}>
              <rect x={GUT + i * band} y={0} width={band} height={H} fill="transparent" />
              {SERIES.map((s, si) => {
                const v = rd.revenue[s.key];
                const h = y(v);
                const top = H - acc - h;
                acc += h + (h > 0 ? 2 : 0);
                return v > 0 ? <rect key={s.key} x={x} y={top} width={bw} height={Math.max(0, h)} rx={si === 2 ? 2 : 0} className={`col ${s.cls}`} /> : null;
              })}
              {(i % 3 === 0 || i === rounds.length - 1) && (
                <text x={GUT + i * band + band / 2} y={H + 16} textAnchor="middle" className="axis-label">
                  R{rd.round}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <ul className="legend">
        {SERIES.map((s) => (
          <li key={s.key}>
            <span className={`swatch ${s.cls}`} /> {s.label}
          </li>
        ))}
      </ul>
      {r && (
        <div className="tooltip" style={{ left: Math.min(w - 260, GUT + hover! * band + band), top: 0 }}>
          <p className="tooltip-time">
            R{r.round} {r.name} · {r.final ? 'final' : 'not final yet'}
          </p>
          {SERIES.map((s) => (
            <div key={s.key} className="tooltip-row">
              <span className={`tooltip-line ${s.cls}`} />
              <b className="mono">{usdShort(r.revenue[s.key])}</b>
              <span className="muted">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Mark {
  t: number;
  lane: number;
  label: string;
  tone: 'steel' | 'hold' | 'alert' | 'ink';
  url?: string;
}

function WeekendSpine({ weekend }: { weekend: Weekend }) {
  const marks = useMemo<Mark[]>(() => {
    const out: Mark[] = [];
    for (const d of weekend.fia_documents) {
      const ours = d.cars?.some((c) => MERIDIAN_CARS.includes(c));
      out.push({ t: Date.parse(d.at), lane: 0, label: d.title, tone: ours ? (/(infringement|decision)/i.test(d.kind) ? 'alert' : 'hold') : 'steel', url: d.url });
    }
    for (const a of (weekend.actions ?? []) as { at: string; event: string; payload: Record<string, unknown>; results: { status?: string; type?: string; reason?: string }[] }[]) {
      const t = Date.parse(a.at);
      if (a.event === 'race_provisional' || a.event === 'race_final' || a.event === 'fia_document') {
        if (a.event !== 'fia_document') out.push({ t, lane: 1, label: a.event === 'race_final' ? 'Final classification: results become bookable' : 'Provisional classification: memos only', tone: 'ink' });
      } else if (a.event === 'billing_request') {
        const st = a.results?.[0]?.status ?? '';
        out.push({ t, lane: 2, label: `Billing request ${a.payload.request_id}: ${st}${a.results?.[0]?.reason ? ` (${a.results[0].reason})` : ''}`, tone: st === 'hold' ? 'hold' : st === 'rejected' ? 'alert' : 'steel' });
      }
      for (const r of a.results ?? []) {
        if (r.status === 'posted') out.push({ t, lane: 3, label: `Entry posted after ${a.event.replace(/_/g, ' ')}`, tone: 'steel' });
        if (r.status === 'parked') out.push({ t, lane: 3, label: `Entry parked for approval: ${r.reason ?? ''}`, tone: 'hold' });
        if (r.status === 'refused') out.push({ t, lane: 3, label: `Entry refused by the kernel: ${r.reason ?? ''}`, tone: 'alert' });
      }
    }
    return out.filter((m) => !Number.isNaN(m.t)).sort((a, b) => a.t - b.t);
  }, [weekend]);
  const [hover, setHover] = useState<Mark | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(360, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!marks.length) return null;
  const LANES = ['FIA documents', 'Results', 'Billing requests', 'Revenue desk'];
  const LW = 140;
  const LH = 34;
  const t0 = marks[0].t;
  const t1 = marks[marks.length - 1].t;
  const pw = w - LW - 12;
  const x = (t: number) => LW + ((t - t0) / Math.max(1, t1 - t0)) * pw;
  const days: number[] = [];
  for (let d = new Date(t0); d.getTime() <= t1; d.setUTCDate(d.getUTCDate() + 1)) days.push(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const key = marks.filter((m) => m.tone === 'alert' || m.tone === 'ink' || (m.tone === 'hold' && m.lane === 0));

  return (
    <section className="weekend" aria-labelledby="wk-h">
      <div className="sec-head">
        <h2 id="wk-h">{weekend.name}, on one clock</h2>
        <p className="muted">Every FIA document and what the revenue desk did about it. Amber and coral marks name a Meridian car.</p>
      </div>
      <div className="weekend-plot" ref={wrap}>
        <svg width={w} height={LANES.length * LH + 24} role="img" aria-label="Race weekend timeline; the list below names every key moment">
          {LANES.map((l, i) => (
            <g key={l} transform={`translate(0 ${i * LH})`}>
              <text x={0} y={LH / 2 + 4} className="lane-label">
                {l}
              </text>
              <line x1={LW} x2={w} y1={LH / 2} y2={LH / 2} className="lane-base" />
            </g>
          ))}
          {days.filter((d) => x(d) >= LW).map((d) => (
            <g key={d}>
              <line x1={x(d)} x2={x(d)} y1={0} y2={LANES.length * LH} className="gridline" />
              <text x={x(d) + 4} y={LANES.length * LH + 16} className="axis-label">
                {new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' })}
              </text>
            </g>
          ))}
          {marks.map((m, i) => (
            <g key={i} onPointerEnter={() => setHover(m)} onPointerLeave={() => setHover(null)}>
              <circle cx={x(m.t)} cy={m.lane * LH + LH / 2} r={12} fill="transparent" />
              <circle cx={x(m.t)} cy={m.lane * LH + LH / 2} r={4.5} className={`dot dot--${m.tone}`} />
            </g>
          ))}
        </svg>
        {hover && (
          <div className="tooltip" style={{ left: Math.min(w - 280, x(hover.t) + 10), top: hover.lane * LH }}>
            <p className="tooltip-time">{dayTime(new Date(hover.t))} UTC</p>
            <p>{hover.label}</p>
          </div>
        )}
      </div>
      <ol className="moments">
        {key.map((m, i) => (
          <li key={i} className={`moment moment--${m.tone}`}>
            <span className="mono">{dayTime(new Date(m.t))}</span>
            <span>
              {m.label}{' '}
              {m.url && (
                <a href={m.url} target="_blank" rel="noreferrer" className="link">
                  FIA PDF <IconExternal size={11} />
                </a>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RevenueView() {
  const rev = useRevenue();
  const [weekend, setWeekend] = useState<Weekend | null>(null);
  const clockRound = rev.timeline.filter((r) => r.final).at(-1)?.round ?? 0;
  useEffect(() => {
    let live = true;
    if (rev.run) void rev.weekend(DEMO_STOP_BEFORE).then((w) => live && setWeekend(w));
    return () => {
      live = false;
    };
  }, [rev.run?.run_id, rev.run?.events_done, rev]);

  if (!rev.online) {
    return (
      <div className="empty-state">
        <h1>Revenue desk</h1>
        <p className="muted">
          The revenue API isn't reachable. Start it with <code>make revenue-api</code> (port 8000) and this page fills in.
        </p>
      </div>
    );
  }
  if (!rev.run) {
    return (
      <div className="empty-state">
        <h1>Revenue desk</h1>
        <p>
          Replay Meridian Racing's 2024 season from the real results, stopping before the Belgian Grand Prix, where George Russell finished first on the
          road and was disqualified for an underweight car.
        </p>
        <button className="btn btn--primary" onClick={() => void rev.startRun()} disabled={rev.busy !== null}>
          {rev.busy ?? 'Replay 2024 to Spa'}
        </button>
        {rev.error && <p className="tone-alert">{rev.error}</p>}
      </div>
    );
  }
  const s = rev.scorecard;
  const spaDone = rev.timeline.some((r) => r.round === DEMO_STOP_BEFORE && r.final);

  return (
    <div className="revenue">
      <section className="run-bar" aria-label="Season replay">
        <div>
          <h1>Revenue desk</h1>
          <p className="muted mono">
            run {rev.run.run_id} · race clock {dayTime(new Date(rev.run.clock))} · {rev.run.events_done} of {rev.run.events_total} events · through round {clockRound}
          </p>
        </div>
        <div className="run-actions">
          {!spaDone && (
            <button className="btn btn--primary" onClick={() => void rev.advance(DEMO_STOP_BEFORE)} disabled={rev.busy !== null}>
              {rev.busy ?? 'Run the Belgian Grand Prix weekend'}
            </button>
          )}
          {spaDone && rev.run.events_done < rev.run.events_total && (
            <button className="btn" onClick={() => void rev.advance(99)} disabled={rev.busy !== null}>
              {rev.busy ?? 'Run the rest of the season'}
            </button>
          )}
          <button className="btn" onClick={() => void rev.runAudit()} disabled={rev.busy !== null}>
            <IconShield size={14} /> Run the independent audit
          </button>
        </div>
      </section>

      {s && (
        <dl className="figures figures--wide">
          <div>
            <dt>Sponsor bonuses booked right</dt>
            <dd>
              {s.bonuses.correct}/{s.bonuses.truth}
            </dd>
          </div>
          <div>
            <dt>Kept off invoices</dt>
            <dd>{usdShort(s.dollars_protected_cents)}</dd>
          </div>
          <div>
            <dt>Routed to code · to Claude</dt>
            <dd>
              {s.router.code} · {s.router.agent}
            </dd>
          </div>
          <div>
            <dt>Claude calls this season, and their cost</dt>
            <dd>
              {s.model.model_calls} · {s.model.cost_cents < 1 ? 'under 1¢' : `${s.model.cost_cents.toFixed(1)}¢`}
            </dd>
          </div>
          <div>
            <dt>Independent auditor</dt>
            <dd>{rev.audit ? rev.audit.opinion : 'not run'}</dd>
          </div>
        </dl>
      )}

      {weekend && <WeekendSpine weekend={weekend} />}

      {rev.queue && rev.queue.alerts.length > 0 && (
        <section className="alerts" aria-labelledby="alerts-h">
          <h2 id="alerts-h">Alerts sent to the Controller</h2>
          <ul>
            {rev.queue.alerts.slice(-4).map((a) => (
              <li key={a.key}>
                <span className="mono muted">
                  {dayTime(new Date(a.at))} · drafted by {a.backend === 'claude' ? 'Claude' : 'template'}
                </span>
                <p>{a.text.replace(/\*\*/g, '').split('\n').filter(Boolean).slice(0, 3).join(' ')}</p>
                {a.fia_url && (
                  <a className="link" href={a.fia_url} target="_blank" rel="noreferrer">
                    The FIA document <IconExternal size={11} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="season-h">
        <div className="sec-head">
          <h2 id="season-h">Revenue recognised by round</h2>
          <p className="muted">Bonuses are booked only once the FIA's final classification is out; a later stewards' decision reverses them.</p>
        </div>
        <SeasonColumns rounds={rev.timeline} />
      </section>

      <section aria-labelledby="sp-h">
        <h2 id="sp-h">Sponsors</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Sponsor</th>
                <th>Currency</th>
                <th className="num">Bonuses earned</th>
                <th className="num">Reversed</th>
                <th className="num">Billed</th>
                <th className="num">Held or rejected</th>
                <th className="num">Waiting for approval</th>
              </tr>
            </thead>
            <tbody>
              {rev.sponsors.map((sp) => (
                <tr key={sp.sponsor_id}>
                  <td>{sp.name}</td>
                  <td className="mono">{sp.currency}</td>
                  <td className="num mono">{sp.bonuses_earned}</td>
                  <td className="num mono">{sp.bonuses_reversed}</td>
                  <td className="num mono">{sp.billing.billed ?? 0}</td>
                  <td className="num mono">{(sp.billing.hold ?? 0) + (sp.billing.rejected ?? 0)}</td>
                  <td className="num mono">
                    {sp.billing.pending_approval ? (
                      <span className="tone-hold">
                        <IconWaiting size={12} /> {sp.billing.pending_approval}
                      </span>
                    ) : (
                      0
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {s && (
          <p className="muted proof-line">
            {s.books_tie ? <IconApproved size={13} /> : <IconDenied size={13} />} Trial balance {s.books_tie ? 'ties' : 'does not tie'} · rules learned from 2023
            controller rulings: {s.rules_approved.join(', ') || 'none'}
          </p>
        )}
      </section>
      {rev.error && <p className="tone-alert">{rev.error}</p>}
    </div>
  );
}
