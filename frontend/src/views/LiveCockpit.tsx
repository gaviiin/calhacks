import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconAgent, IconApproved, IconBolt, IconChart, IconDenied, IconFlag, IconLive, IconPerson, IconRadio, IconRestart, IconShield, IconWaiting } from '../components/icons';
import type {
  AgentWorkflow,
  CarComparison,
  FinanceCase,
  JevDecision,
  LiveState,
  PitLoss,
  RaceTimeline,
  StrategyOption,
  TimelineMarker,
  WorkflowStep,
} from '../lib/live';
import { clock, compoundWord, flagTone, flagWord, money, ROUTE_WORDS, sentence, signed, words, type Advice, type Tone } from '../lib/liveStory';

// The decision cockpit: the whole race's money on one time axis, the decisions the pit wall has now
// with what each is worth, and what the agents did about every material event. Every figure is read
// from the replay's own records (race_timeline, strategy_advice, agent_workflow, finance_case);
// nothing here estimates on the client. "Immediate" is the payout if the position right after a
// decision held to the flag; the expected race-end value needs a calibrated finishing model and
// is shown as unavailable until there is one.

export function Chip({ tone = 'neutral', icon, children, title, className = '' }: { tone?: Tone; icon?: ReactNode; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`ld-chip ld-chip--${tone} ${className}`} title={title}>
      {icon}
      <span>{children}</span>
    </span>
  );
}

export function Delta({ cents, strong = false }: { cents: number | null | undefined; strong?: boolean }) {
  const tone = (cents ?? 0) < 0 ? 'alert' : (cents ?? 0) > 0 ? 'ok' : 'neutral';
  return <span className={`ld-delta ld-delta--${tone} ${strong ? 'ld-delta--strong' : ''}`}>{signed(cents)}</span>;
}

const ms = (iso: string) => Date.parse(iso);

/** The element's content width, observed from the moment it mounts (a callback ref, so an element that
 * appears after the first render, like the chart after its empty state, is still measured). */
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [w, setW] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    setW(Math.round(el.getBoundingClientRect().width));
    ro.current = new ResizeObserver((e) => setW(Math.round(e[0].contentRect.width)));
    ro.current.observe(el);
  }, []);
  useEffect(() => () => ro.current?.disconnect(), []);
  return [ref, Math.max(320, w || 900)];
}

export const TEAM_WORDS: Record<string, string> = {
  alpine: 'Meridian · Alpine-mirror',
  mercedes: 'Meridian · Mercedes-mirror',
  williams: 'Meridian · Williams-mirror',
};

const CONDITION_WORDS: Record<string, string> = { green: 'green flag', vsc: 'Virtual Safety Car', safety_car: 'Safety Car', red_flag: 'red flag' };
const METHOD_WORDS: Record<PitLoss['method'], string> = {
  measured: 'measured in this race',
  derived: 'derived from measured stops',
  prior: 'prior, not measured',
  unmeasured: 'not yet measured: a range',
  suspension: 'race suspended',
};
const methodTone = (m: PitLoss['method']): Tone => (m === 'measured' ? 'ok' : m === 'derived' || m === 'suspension' ? 'neutral' : 'hold');
const lossText = (p: PitLoss | null) => (!p ? '—' : p.seconds !== null ? `${p.seconds.toFixed(1)} s` : `${p.low_s?.toFixed(0) ?? '?'}–${p.high_s?.toFixed(0) ?? '?'} s`);

// ---------------------------------------------------------------- the status strip

export function ModeBadge({ live }: { live: LiveState }) {
  const rp = live.replay;
  if (!rp) return <Chip tone="neutral">No feed</Chip>;
  if (rp.mode === 'live') {
    return (
      <Chip tone="ok" icon={<IconLive />} title="authenticated live timing feed">
        Live feed
      </Chip>
    );
  }
  return (
    <Chip tone="hold" icon={<IconRestart />} title="cached OpenF1 records replayed in race-time order; not a current session">
      Historical replay · {rp.speed ? `${rp.speed}×` : 'no waiting'}
    </Chip>
  );
}

export function StatusStrip({ live, advice, feedAgeS }: { live: LiveState; advice: Advice | null; feedAgeS: number | null }) {
  const race = live.race;
  const w = race?.weather;
  const tl = live.timeline;
  const payout = race?.forecast?.amount_cents ?? advice?.exposure_now_cents ?? null;
  const own = live.cases.filter((c) => c.payload.scope === 'own_team' && !['closed', 'rejected'].includes(c.payload.state));
  const waitingPerson = live.cases.some((c) => c.payload.state === 'awaiting_approval');
  const p50 = live.metrics?.publish?.adapter_received_to_published_p50_ms;
  return (
    <section className="lc-status" aria-label="Race, money and agents now">
      <div className="lc-status-cell">
        <span className="lc-k">Race</span>
        <b>{live.replay?.race_id === '2024_belgian_gp' ? 'Belgian GP 2024' : 'São Paulo GP 2024'}</b>
        <span className="ld-muted ld-small">{live.team ? TEAM_WORDS[live.team.id] ?? live.team.label : '—'}</span>
      </div>
      <div className="lc-status-cell">
        <span className="lc-k">Lap</span>
        <b className="mono lc-big">
          {race?.lap ?? '—'}
          <small> / {tl?.scheduled_laps ?? 69}</small>
        </b>
        <span className="ld-muted ld-small mono">{race ? `${clock(race.event_time_utc)}Z race time` : ''}</span>
      </div>
      <div className="lc-status-cell">
        <span className="lc-k">Conditions</span>
        <span className="ld-chips">
          <Chip tone={flagTone(race?.flag_status)} icon={<IconFlag />}>
            {flagWord(race?.flag_status)}
          </Chip>
          <Chip tone={w?.rainfall ? 'hold' : 'neutral'} icon={<IconRadio />}>
            {w ? `${w.rainfall ? 'Wet' : 'Dry'} · track ${w.track_temperature_c ?? '?'}°C` : 'Weather unknown'}
          </Chip>
        </span>
      </div>
      <div className="lc-status-cell lc-status-money">
        <span className="lc-k">Provisional payout if it ended now</span>
        <b className="mono lc-big">{money(payout)}</b>
        <span className="ld-muted ld-small">synthetic contracts · not booked</span>
      </div>
      <div className="lc-status-cell">
        <span className="lc-k">Agents</span>
        {waitingPerson ? (
          <Chip tone="hold" icon={<IconPerson />}>
            A person is needed
          </Chip>
        ) : own.length ? (
          <Chip tone="neutral" icon={<IconAgent />}>
            Case open · working
          </Chip>
        ) : (
          <Chip tone="ok" icon={<IconAgent />}>
            Monitoring
          </Chip>
        )}
        <span className="ld-muted ld-small">{live.workflows.length} events handled this replay</span>
      </div>
      <div className="lc-status-cell">
        <span className="lc-k">Feed</span>
        <ModeBadge live={live} />
        <span className="ld-muted ld-small mono" title="processing latency: adapter received to published (p50); freshness: wall seconds since the feed last published">
          {p50 !== undefined && p50 !== null ? `processing p50 ${p50} ms` : 'processing —'} · {feedAgeS !== null ? `fresh ${feedAgeS.toFixed(1)} s` : 'freshness —'}
        </span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the financial timeline

interface Mark extends TimelineMarker {
  caseStep?: { caseId: string; actor: string };
}

const KIND_LABEL: Record<string, string> = { flag: 'Flags', rain: 'Rain', pit: 'Our stops', money: 'Money moves', out: 'Cars out', incident: 'Incidents', jev: 'Jev decisions', case: 'Case steps' };
const LANES = ['money', 'pit', 'out', 'incident', 'jev', 'case'] as const;

function caseMarks(cases: Published<FinanceCase>[]): Mark[] {
  const out: Mark[] = [];
  for (const c of cases) {
    c.payload.steps.forEach((st, i) => {
      if (!st.race_clock_utc) return;
      out.push({
        id: `case:${c.id}:${i}`,
        t: st.race_clock_utc,
        lap: null,
        kind: 'jev',
        label: `${sentence(words(st.actor))}: ${st.action}`,
        detail: st.detail,
        car: c.payload.car,
        delta_cents: null,
        tone: st.status === 'refused' ? 'alert' : st.status === 'escalated' || !st.automatic ? 'hold' : 'neutral',
        ref: c.id,
        caseStep: { caseId: c.id, actor: st.actor },
      });
    });
  }
  return out;
}

type Published<T> = { id: string; payload: T };

function valueAt(tl: RaceTimeline, t: number): { cents: number; positions: Record<string, number | null>; flag: string | null } {
  let cur = tl.points[0];
  for (const p of tl.points) {
    if (ms(p.t) > t) break;
    cur = p;
  }
  return { cents: cur?.cents ?? 0, positions: cur?.positions ?? {}, flag: cur?.flag ?? null };
}

export function FinancialTimeline({ live, onReplayFrom, canSeek }: { live: LiveState; onReplayFrom: (lap: number) => void; canSeek: boolean }) {
  const tl = live.timeline;
  const [wrap, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [lanes, setLanes] = useState<Record<string, boolean>>({ money: true, pit: true, out: true, incident: true, jev: true, case: true });
  const marks = useMemo<Mark[]>(() => {
    if (!tl) return [];
    const base = tl.markers.filter((m) => !tl.start_utc || m.t >= tl.start_utc);
    const cs = caseMarks(live.cases).map((m) => ({ ...m, kind: 'case' as unknown as TimelineMarker['kind'] }));
    return [...base, ...cs].sort((a, b) => a.t.localeCompare(b.t));
  }, [tl, live.cases]);
  if (!tl || !tl.points.length || !tl.start_utc || !tl.now_utc) {
    return (
      <section className="ld-card lc-timeline" aria-labelledby="lc-tl-h">
        <h2 id="lc-tl-h" className="ld-h">
          The race's money, lap by lap
        </h2>
        <p className="ld-muted">Start a São Paulo replay above. The chart draws the provisional payout from lap 1 to the replay clock (the laps before you join are replayed silently, as of their own time), with every flag, stop, crash and agent decision on the same axis.</p>
      </section>
    );
  }
  const t0 = ms(tl.start_utc);
  const t1 = Math.max(ms(tl.now_utc), t0 + 60_000);
  const H = 300;
  const padL = 64;
  const padR = 16;
  const plotTop = 14;
  const plotH = 190;
  const rainY = plotTop + plotH + 8;
  const laneY0 = rainY + 18;
  const laneH = 14;
  const shownLanes = LANES.filter((l) => lanes[l]);
  const totalH = laneY0 + shownLanes.length * laneH + 22;
  const W = width;
  const x = (t: number) => padL + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (W - padL - padR);
  const inside = tl.points.filter((p) => ms(p.t) >= t0);
  const before = [...tl.points].reverse().find((p) => ms(p.t) < t0);
  const pts = before ? [{ ...before, t: tl.start_utc }, ...inside] : inside;
  const maxV = Math.max(1, ...pts.map((p) => p.cents));
  const niceMax = (() => {
    const raw = maxV * 1.12;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => raw / s <= 5) ?? mag * 10;
    return Math.ceil(raw / step) * step;
  })();
  const y = (v: number) => plotTop + plotH - (v / niceMax) * plotH;
  let d = '';
  pts.forEach((p, i) => {
    const px = x(ms(p.t));
    d += i === 0 ? `M${px.toFixed(1)},${y(p.cents).toFixed(1)}` : `H${px.toFixed(1)}V${y(p.cents).toFixed(1)}`;
  });
  d += `H${x(t1).toFixed(1)}`;
  const area = `${d}V${y(0)}H${x(t0)}Z`;
  const flagBands = tl.flags
    .map((f, i) => ({ flag: f.flag, a: ms(f.from), b: i + 1 < tl.flags.length ? ms(tl.flags[i + 1].from) : t1 }))
    .filter((s) => s.b > t0 && ['VSC', 'VSC_ENDING', 'SAFETY_CAR', 'SAFETY_CAR_ENDING', 'RED_FLAG'].includes(s.flag));
  const rainBands = tl.rain.map((r, i) => ({ rain: r.rain, a: ms(r.from), b: i + 1 < tl.rain.length ? ms(tl.rain[i + 1].from) : t1 })).filter((s) => s.b > t0 && s.rain);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => k * niceMax);
  const lapTicks = tl.laps.filter((l) => l.lap === 1 || l.lap % 5 === 0);
  const sel = marks.find((m) => m.id === picked) ?? null;
  const hv = hover !== null ? valueAt(tl, hover) : null;
  const wf = sel?.ref ? live.workflows.find((w) => w.workflow_id === sel.ref) : null;
  const atSel = sel ? valueAt(tl, ms(sel.t)) : null;
  const beforeSel = sel ? valueAt(tl, ms(sel.t) - 1) : null;
  const selLap = sel ? sel.lap ?? tl.laps.filter((l) => l.t <= sel.t).at(-1)?.lap ?? null : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px < padL || px > W - padR) return setHover(null);
    setHover(t0 + ((px - padL) / (W - padL - padR)) * (t1 - t0));
  };
  const peak = Math.max(...pts.map((p) => p.cents));
  const nowV = pts[pts.length - 1]?.cents ?? 0;
  return (
    <section className="ld-card lc-timeline" aria-labelledby="lc-tl-h">
      <div className="ld-card-head">
        <div>
          <h2 id="lc-tl-h" className="ld-h">
            The race's money, lap by lap
          </h2>
          <p className="ld-small ld-muted lc-tl-sub">
            Provisional sponsor payout if the race ended at each moment (synthetic contracts, as of that moment). Peak <b className="mono">{money(peak)}</b>, now <b className="mono">{money(nowV)}</b>. Click any marker for what caused it.
          </p>
        </div>
        <div className="ld-filters" role="group" aria-label="Marker lanes">
          {LANES.map((l) => (
            <button key={l} type="button" className={`ld-filter ${lanes[l] ? 'ld-filter--on' : ''}`} aria-pressed={lanes[l]} onClick={() => setLanes((s) => ({ ...s, [l]: !s[l] }))}>
              {KIND_LABEL[l]}
            </button>
          ))}
        </div>
      </div>
      <div ref={wrap} className="lc-tl-wrap">
        <svg className="lc-tl" viewBox={`0 0 ${W} ${Math.max(H, totalH)}`} width={W} height={Math.max(H, totalH)} role="img" aria-label={`Provisional payout from lap 1 to lap ${tl.lap}: now ${money(nowV)}, peak ${money(peak)}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {flagBands.map((b) => (
            <rect key={`f${b.a}`} x={x(b.a)} y={plotTop} width={Math.max(1.5, x(b.b) - x(b.a))} height={plotH} className={`lc-band lc-band--${b.flag.startsWith('RED') ? 'red' : 'hold'}`}>
              <title>{`${flagWord(b.flag)} from ${clock(new Date(b.a).toISOString())}Z`}</title>
            </rect>
          ))}
          {ticks.map((v) => (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="lc-grid" />
              <text x={padL - 8} y={y(v) + 4} className="lc-axis" textAnchor="end">
                {money(v)}
              </text>
            </g>
          ))}
          {lapTicks.map((l) => (
            <g key={l.lap}>
              <line x1={x(ms(l.t))} x2={x(ms(l.t))} y1={plotTop + plotH} y2={plotTop + plotH + 4} className="lc-tick" />
              <text x={x(ms(l.t))} y={totalH - 6} className="lc-axis" textAnchor="middle">
                L{l.lap}
              </text>
            </g>
          ))}
          {tl.joined_at_utc && ms(tl.joined_at_utc) > t0 ? (
            <g>
              <line x1={x(ms(tl.joined_at_utc))} x2={x(ms(tl.joined_at_utc))} y1={plotTop} y2={plotTop + plotH} className="lc-join" />
              <text x={x(ms(tl.joined_at_utc)) + 4} y={plotTop + 10} className="lc-axis">
                joined lap {tl.joined_lap}
              </text>
            </g>
          ) : null}
          <path d={area} className="lc-area" />
          <path d={d} className="lc-line" />
          <circle cx={x(t1)} cy={y(nowV)} r={4} className="lc-now" />
          <rect x={padL} y={rainY} width={W - padL - padR} height={8} className="lc-rain-track" />
          {rainBands.map((b) => (
            <rect key={`r${b.a}`} x={x(b.a)} y={rainY} width={Math.max(1.5, x(b.b) - x(b.a))} height={8} className="lc-rain" />
          ))}
          <text x={padL - 8} y={rainY + 8} className="lc-axis" textAnchor="end">
            rain
          </text>
          {shownLanes.map((lane, i) => (
            <g key={lane}>
              <text x={padL - 8} y={laneY0 + i * laneH + 10} className="lc-axis" textAnchor="end">
                {KIND_LABEL[lane].toLowerCase()}
              </text>
              <line x1={padL} x2={W - padR} y1={laneY0 + i * laneH + 6} y2={laneY0 + i * laneH + 6} className="lc-lane" />
              {marks
                .filter((m) => (m.kind as string) === lane)
                .map((m) => (
                  <g key={m.id} className={`lc-mark lc-mark--${m.tone} ${picked === m.id ? 'lc-mark--on' : ''}`} onClick={() => setPicked(m.id === picked ? null : m.id)} role="button" tabIndex={0} aria-label={`${m.label} at ${clock(m.t)}Z`} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setPicked(m.id)}>
                    <rect x={x(ms(m.t)) - 7} y={laneY0 + i * laneH - 1} width={14} height={14} className="lc-hit" />
                    {lane === 'money' ? <circle cx={x(ms(m.t))} cy={y(valueAt(tl, ms(m.t)).cents)} r={picked === m.id ? 5 : 3} className="lc-money-dot" /> : null}
                    <rect x={x(ms(m.t)) - 3} y={laneY0 + i * laneH + 3} width={6} height={6} rx={lane === 'money' ? 3 : 1} className="lc-pip" />
                  </g>
                ))}
            </g>
          ))}
          {flagBands.length || tl.flags.length
            ? tl.flags
                .filter((f) => ms(f.from) >= t0 && ['VSC', 'SAFETY_CAR', 'RED_FLAG'].includes(f.flag))
                .map((f) => (
                  <text key={`fl${f.from}`} x={x(ms(f.from)) + 3} y={plotTop + plotH - 4} className="lc-band-label">
                    {f.flag === 'VSC' ? 'VSC' : f.flag === 'RED_FLAG' ? 'RED' : 'SC'}
                  </text>
                ))
            : null}
          {sel ? <line x1={x(ms(sel.t))} x2={x(ms(sel.t))} y1={plotTop} y2={laneY0 + shownLanes.length * laneH} className="lc-sel" /> : null}
          {hover !== null && hv ? (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={plotTop} y2={plotTop + plotH} className="lc-cross" />
              <circle cx={x(hover)} cy={y(hv.cents)} r={4} className="lc-now" />
            </g>
          ) : null}
        </svg>
        {hover !== null && hv ? (
          <div className="lc-tip" style={{ left: `${Math.min(Math.max((x(hover) / W) * 100, 8), 82)}%` }} role="status">
            <b className="mono">{money(hv.cents)}</b>
            <span className="mono ld-muted">
              {clock(new Date(hover).toISOString())}Z · lap {tl.laps.filter((l) => ms(l.t) <= hover).at(-1)?.lap ?? '—'}
            </span>
            <span>{flagWord(hv.flag)}</span>
            <span className="ld-muted">
              {Object.entries(hv.positions)
                .map(([car, p]) => `car ${car} ${p ? `P${p}` : 'out'}`)
                .join(' · ')}
            </span>
          </div>
        ) : null}
      </div>
      <div className="lc-legend ld-small ld-muted">
        <span>
          <i className="lc-key lc-key--line" /> provisional payout (one series)
        </span>
        <span>
          <i className="lc-key lc-key--hold" /> VSC / Safety Car
        </span>
        <span>
          <i className="lc-key lc-key--red" /> red flag
        </span>
        <span>
          <i className="lc-key lc-key--rain" /> rain at the sensor
        </span>
        <span>Expected race-end value: not drawn (no calibrated finishing model yet).</span>
      </div>
      {sel ? (
        <div className={`lc-inspect lc-inspect--${sel.tone}`} aria-live="polite">
          <div className="lc-inspect-head">
            <div>
              <span className="lc-k">
                {KIND_LABEL[sel.kind] ?? sel.kind} · {clock(sel.t)}Z{selLap ? ` · lap ${selLap}` : ''}
              </span>
              <h3>{sel.label}</h3>
            </div>
            <div className="ld-chips">
              {atSel && beforeSel ? (
                <span className="mono">
                  {money(beforeSel.cents)} → {money(atSel.cents)} {atSel.cents !== beforeSel.cents ? <Delta cents={atSel.cents - beforeSel.cents} /> : null}
                </span>
              ) : null}
              {canSeek && selLap ? (
                <button type="button" className="btn" onClick={() => onReplayFrom(Math.max(1, selLap - 1))} title="restart the historical replay a lap before this moment; the state before it is rebuilt silently, as of its own time">
                  <IconRestart /> Replay from lap {Math.max(1, selLap - 1)}
                </button>
              ) : null}
            </div>
          </div>
          {sel.detail ? <p className="ld-small">{sel.detail}</p> : null}
          {wf ? <WorkflowSteps wf={wf} compact /> : null}
          {sel.caseStep ? <p className="ld-small ld-muted">From the audit trail of case {sel.caseStep.caseId}; the full case is below.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- the decision comparator

function OptionCard({ o, lowest, stay }: { o: StrategyOption; lowest: boolean; stay: StrategyOption | undefined }) {
  const [open, setOpen] = useState(false);
  const counterfactual = o.key === 'pit_if_green';
  const posRange = o.position_best !== null && o.position_worst !== null && o.position_best !== o.position_worst ? `P${o.position_best}–P${o.position_worst}` : null;
  const range = o.delta_best_cents !== o.delta_worst_cents ? `${signed(o.delta_best_cents)} to ${signed(o.delta_worst_cents)}` : null;
  return (
    <article className={`lc-opt ${lowest ? 'lc-opt--best' : ''} ${counterfactual ? 'lc-opt--cf' : ''} ${o.feasible ? '' : 'lc-opt--out'}`} aria-label={o.label}>
      <header className="lc-opt-head">
        <h4>{o.label}</h4>
        {lowest ? (
          <Chip tone="ok" icon={<IconApproved />}>
            lowest immediate risk
          </Chip>
        ) : counterfactual ? (
          <Chip tone="neutral">comparison, not a choice now</Chip>
        ) : !o.feasible ? (
          <Chip tone="alert" icon={<IconDenied />}>
            not feasible
          </Chip>
        ) : null}
      </header>
      <div className="lc-opt-pos">
        <span className="mono">P{o.position_now ?? '—'}</span>
        <span className="ld-muted">→</span>
        <b className="mono">{o.position_after ? `P${o.position_after}` : '—'}</b>
        {posRange ? <span className="ld-muted ld-small mono">range {posRange}</span> : null}
      </div>
      <dl className="lc-opt-nums">
        <div>
          <dt>Immediate payout</dt>
          <dd className="mono">{money(o.payout_after_cents)}</dd>
        </div>
        <div>
          <dt>Against {stay && o.key !== 'stay_out' ? 'staying out' : 'now'}</dt>
          <dd>
            <Delta cents={o.delta_cents} strong />
            {range ? <span className="ld-muted ld-small mono lc-range">range {range}</span> : null}
          </dd>
        </div>
        <div>
          <dt>Expected at the flag</dt>
          <dd className="ld-muted ld-small" title={o.expected_final_status}>
            {o.expected_final_cents !== null ? money(o.expected_final_cents) : 'Forecast unavailable'}
          </dd>
        </div>
        <div>
          <dt>Cost cap</dt>
          <dd className="ld-small">{o.cost_cap_cents !== null ? money(o.cost_cap_cents) : o.key === 'stay_out' ? 'No spend' : 'No spend evidenced'}</dd>
        </div>
      </dl>
      {o.pit_loss ? (
        <p className="ld-small lc-opt-loss">
          Stop costs <b className="mono">{lossText(o.pit_loss)}</b> under the {CONDITION_WORDS[o.pit_loss.condition]}{' '}
          <Chip tone={methodTone(o.pit_loss.method)}>{METHOD_WORDS[o.pit_loss.method]}{o.pit_loss.samples ? ` · ${o.pit_loss.samples} stop${o.pit_loss.samples === 1 ? '' : 's'}` : ''}</Chip>
        </p>
      ) : null}
      {o.cars_passed.length ? <p className="ld-small ld-muted">Lets {o.cars_passed.map((c) => `car ${c}`).join(', ')} past{o.cars_maybe.length ? `; ${o.cars_maybe.map((c) => `car ${c}`).join(', ')} too close to call` : ''}.</p> : null}
      {o.pace ? <p className="ld-small ld-muted">Pace: {o.pace.note}</p> : null}
      {!o.feasible && o.why_not ? <p className="ld-small">{o.why_not}</p> : null}
      {o.lines_lost.length ? <p className="ld-small lc-lost">Loses {o.lines_lost.join('; ')}</p> : null}
      {o.lines_gained.length ? <p className="ld-small lc-gained">Gains {o.lines_gained.join('; ')}</p> : null}
      <button type="button" className="lc-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide the arithmetic' : 'Show the arithmetic'}
      </button>
      {open ? (
        <div className="ld-small lc-arith">
          <b>Assumes</b>
          <ul>
            {o.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          <b>Unknown</b>
          <ul>
            {o.unknowns.map((a) => (
              <li key={a}>{a}</li>
            ))}
            <li>{o.expected_final_status}</li>
          </ul>
          {o.pit_loss ? <p className="ld-muted">{o.pit_loss.basis}</p> : null}
          <p className="ld-muted">Cost cap: {o.cost_cap_status}</p>
        </div>
      ) : null}
    </article>
  );
}

function CarTab({ c, on, pick }: { c: CarComparison; on: boolean; pick: () => void }) {
  const out = c.status === 'dns' || c.status === 'retired';
  return (
    <button type="button" role="tab" aria-selected={on} className={`lc-cartab ${on ? 'lc-cartab--on' : ''} ${out ? 'lc-cartab--out' : ''}`} onClick={pick}>
      <span className="mono lc-cartab-num">{c.car}</span>
      <span>
        <b>{c.driver_name}</b>
        <small>{c.status === 'dns' ? 'DNS · did not start' : c.status === 'retired' ? 'Out' : c.status === 'stopped_candidate' ? 'Stopped on track' : `P${c.position ?? '—'} · ${compoundWord(c.compound)} ${c.tyre_age_laps ?? '?'} laps`}</small>
      </span>
      <span className="mono lc-cartab-pay">{out ? '—' : money(c.payout_now_cents)}</span>
    </button>
  );
}

export function StrategyComparator({ advice }: { advice: Advice | null }) {
  const comps = advice?.comparisons ?? [];
  const [car, setCar] = useState<number | null>(null);
  const firstLive = comps.find((c) => c.options.length) ?? comps[0];
  const cur = comps.find((c) => c.car === car) ?? firstLive;
  const stay = cur?.options.find((o) => o.key === 'stay_out');
  return (
    <section className="ld-card lc-compare" aria-labelledby="lc-cmp-h">
      <div className="ld-card-head">
        <div>
          <h2 id="lc-cmp-h" className="ld-h">
            What should we do?
          </h2>
          <p className="ld-small ld-muted">
            Each decision the pit wall has now, priced on the contracts.{' '}
            {advice ? (
              <>
                As of <span className="mono">{clock(advice.as_of_utc)}Z</span>, lap {advice.lap ?? '—'}, {flagWord(advice.flag_status).toLowerCase()}.
              </>
            ) : null}
          </p>
        </div>
        <Chip tone="neutral" icon={<IconChart />}>
          immediate = position right after, held to the flag
        </Chip>
      </div>
      {comps.length ? (
        <>
          <div className="lc-cartabs" role="tablist" aria-label="Our cars">
            {comps.map((c) => (
              <CarTab key={c.car} c={c} on={c.car === cur?.car} pick={() => setCar(c.car)} />
            ))}
          </div>
          {cur ? <p className="lc-cmp-summary">{cur.summary}</p> : null}
          {cur?.out_reason ? <p className="ld-small ld-muted">{cur.out_reason}</p> : null}
          {cur?.options.length ? (
            <div className="lc-opts">
              {cur.options.map((o) => (
                <OptionCard key={o.key} o={o} lowest={o.key === cur.lowest_risk && cur.options.some((x) => x.delta_cents !== 0 || x.delta_worst_cents !== 0)} stay={stay} />
              ))}
            </div>
          ) : null}
          <StopCosts losses={advice?.pit_losses ?? []} flag={advice?.flag_status ?? null} />
        </>
      ) : (
        <p className="ld-muted">The comparator appears with the first strategy record of a São Paulo replay: stay out, pit now, the other compound, and the same stop under green when the race is neutralised, each with its position range and dollar change.</p>
      )}
    </section>
  );
}

function StopCosts({ losses, flag }: { losses: PitLoss[]; flag: string | null }) {
  if (!losses.length) return null;
  const now = flag === 'RED_FLAG' ? 'red_flag' : flag?.startsWith('VSC') ? 'vsc' : flag?.startsWith('SAFETY') ? 'safety_car' : 'green';
  return (
    <div className="lc-stopcosts">
      <h4>What a stop costs in this race, by condition</h4>
      <table className="ld-plan" aria-label="Pit stop cost by racing condition">
        <thead>
          <tr>
            <th>Condition</th>
            <th>Race time lost</th>
            <th>How we know</th>
          </tr>
        </thead>
        <tbody>
          {losses.map((l) => (
            <tr key={l.condition} className={l.condition === now ? 'ld-plan-rec' : ''}>
              <td>
                {sentence(CONDITION_WORDS[l.condition])}
                {l.condition === now ? <span className="ld-rec">now</span> : null}
              </td>
              <td className="mono">{lossText(l)}</td>
              <td className="ld-small ld-muted">
                <Chip tone={methodTone(l.method)}>{METHOD_WORDS[l.method]}</Chip> {l.basis}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ld-small ld-muted">A stop's cost is the in-lap plus out-lap against the cars that stayed out on the same two laps, not the pit-lane time. No fixed Safety Car discount is assumed.</p>
    </div>
  );
}

// ---------------------------------------------------------------- the agents

const STEP_ICON: Record<WorkflowStep['status'], ReactNode> = {
  done: <IconApproved />,
  skipped: <IconDenied />,
  waiting: <IconWaiting />,
  escalated: <IconPerson />,
  refused: <IconDenied />,
  not_required: <span className="lc-dash">–</span>,
};
const STEP_WORDS: Record<WorkflowStep['status'], string> = { done: 'done', skipped: 'skipped', waiting: 'waiting', escalated: 'needs a person', refused: 'refused', not_required: 'not required' };

export function WorkflowSteps({ wf, compact = false }: { wf: AgentWorkflow; compact?: boolean }) {
  return (
    <ol className={`lc-flow ${compact ? 'lc-flow--compact' : ''}`} aria-label={`What the agents did about: ${wf.title}`}>
      {wf.steps.map((st, i) => (
        <li key={st.key} className={`lc-flow-step lc-flow-step--${st.status}`}>
          <span className="lc-flow-n" aria-hidden="true">
            {STEP_ICON[st.status]}
          </span>
          <span className="lc-flow-body">
            <span className="lc-flow-title">
              {i + 1}. {st.label}
              <span className="ld-muted"> · {st.actor}</span>
              {st.latency_ms !== null ? <span className="mono ld-muted"> · {st.latency_ms} ms</span> : null}
              <span className={`lc-flow-status lc-flow-status--${st.status}`}>{STEP_WORDS[st.status]}</span>
            </span>
            {st.detail && !compact ? <span className="lc-flow-detail">{st.detail}</span> : null}
            {st.detail && compact && (st.status !== 'done' || st.key === 'jev' || st.key === 'analyst') ? <span className="lc-flow-detail">{st.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function jevLine(d: JevDecision | null | undefined): string {
  if (!d) return '';
  const route = ROUTE_WORDS[d.chosen_route] ?? d.chosen_route;
  if (!d.used) return `Jev ${words(d.status)}: deterministic route ${route}`;
  const conf = d.route_confidence !== null && d.route_confidence !== undefined ? ` · ${Math.round(d.route_confidence * 100)}% reported route confidence` : '';
  return `Jev classified: ${ROUTE_WORDS[d.route ?? ''] ?? d.route ?? route}${conf}${d.latency_ms !== null ? ` · ${d.latency_ms} ms` : ''}`;
}

export function AgentsPanel({ live, onOpenCase }: { live: LiveState; onOpenCase: (id: string) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [inspect, setInspect] = useState(false);
  const wfs = live.workflows;
  const latest = wfs[wfs.length - 1] ?? null;
  const cur = wfs.find((w) => w.workflow_id === picked) ?? latest;
  const decision = cur ? live.jevDecisions.find((d) => `${d.payload.kind}:${d.payload.at}` === cur.workflow_id || d.id === cur.workflow_id)?.payload.decision ?? null : null;
  const queue = live.cases.filter((c) => c.payload.scope === 'own_team' && ['awaiting_approval', 'awaiting_evidence', 'reconciling'].includes(c.payload.state));
  const probs = inspect && decision?.route_probabilities ? Object.entries(decision.route_probabilities).sort((a, b) => b[1] - a[1]) : [];
  useEffect(() => {
    if (picked && !wfs.some((w) => w.workflow_id === picked)) setPicked(null);
  }, [wfs, picked]);
  return (
    <section className="ld-card lc-agents" aria-labelledby="lc-ag-h">
      <div className="ld-card-head">
        <h2 id="lc-ag-h" className="ld-h">
          What the agents are doing
        </h2>
        <Chip tone={live.feed?.jev?.mode?.startsWith('api') ? 'ok' : 'hold'} icon={<IconBolt />}>
          {live.feed?.jev?.mode?.startsWith('api') ? `Jev live · p50 ${live.feed.jev.p50_ms ?? '—'} ms` : 'Jev: deterministic fallback'}
        </Chip>
      </div>
      <div className="lc-queue">
        <h3 className="lc-k">Needs a person</h3>
        {queue.length ? (
          <ul>
            {queue.map((c) => (
              <li key={c.id}>
                <Chip tone={c.payload.state === 'awaiting_approval' ? 'hold' : 'neutral'} icon={c.payload.state === 'awaiting_approval' ? <IconPerson /> : <IconWaiting />}>
                  {c.payload.state === 'awaiting_approval' ? 'Approval' : c.payload.state === 'awaiting_evidence' ? 'Evidence' : 'Invoice'}
                </Chip>
                <span className="ld-small">
                  car {c.payload.car}: {c.payload.next_action || c.payload.title}
                </span>
                <button type="button" className="lc-more" onClick={() => onOpenCase(c.id)}>
                  Open case
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ld-small ld-muted">Nothing waiting. Strategy and forecast updates are within the agents' authority; spend and repairs on our car always go to engineering and the controller.</p>
        )}
      </div>
      {cur ? (
        <>
          <div className="lc-agent-event">
            <span className="lc-k">
              {cur === latest ? 'Latest event' : 'Event'} · lap {cur.lap ?? '—'} · {clock(cur.event_time_utc)}Z
            </span>
            <h3>{cur.title}</h3>
            <p className="ld-small lc-jevline">
              {jevLine(decision)}{' '}
              <button type="button" className="lc-more" aria-expanded={inspect} onClick={() => setInspect((v) => !v)}>
                {inspect ? 'Hide decision' : 'Inspect decision'}
              </button>
            </p>
            {inspect && decision ? (
              <div className="ld-small lc-inspect-jev">
                <p className="ld-muted">
                  {decision.reason} Route confidence is Jev's own report; it never authorizes spend on its own.
                </p>
                {probs.length ? (
                  <ul className="ld-probs" aria-label="Route probabilities">
                    {probs.map(([k, v]) => (
                      <li key={k}>
                        <span>{ROUTE_WORDS[k] ?? k}</span>
                        <span className="ld-prob-bar">
                          <span style={{ width: `${Math.round(v * 100)}%` }} />
                        </span>
                        <span className="mono">{(v * 100).toFixed(0)}%</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="ld-muted mono">
                  {decision.model ?? 'no model'} · input {decision.input_hash ?? '—'} · deterministic {decision.deterministic_route} · status {decision.status}
                </p>
              </div>
            ) : null}
          </div>
          <WorkflowSteps wf={cur} />
          {cur.case_id ? (
            <button type="button" className="btn" onClick={() => onOpenCase(cur.case_id as string)}>
              <IconShield /> Open the financial case
            </button>
          ) : null}
          {wfs.length > 1 ? (
            <ol className="lc-wflist" aria-label="Earlier events">
              {[...wfs]
                .reverse()
                .slice(0, 8)
                .map((w) => (
                  <li key={w.workflow_id}>
                    <button type="button" className={`lc-wfrow ${w.workflow_id === cur.workflow_id ? 'lc-wfrow--on' : ''}`} onClick={() => setPicked(w.workflow_id)}>
                      <span className="mono ld-muted">{clock(w.event_time_utc)}</span>
                      <span>{w.title}</span>
                      <span className={`lc-flow-status lc-flow-status--${w.needs_person ? 'escalated' : w.steps.some((s) => s.status === 'waiting') ? 'waiting' : 'done'}`}>{w.outcome}</span>
                    </button>
                  </li>
                ))}
            </ol>
          ) : null}
        </>
      ) : (
        <p className="ld-muted ld-small">No material event yet. Each one is followed here: detected → Jev routes it → the financial analyst calculates → the cost cap agent reviews when money would be spent → an authorized automatic action or a person's review → the recorded outcome.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- opportunities (no case open)

const TEAM_NAMES: Record<string, string> = {
  red_bull: 'Red Bull', mclaren: 'McLaren', ferrari: 'Ferrari', mercedes: 'Mercedes', aston_martin: 'Aston Martin', alpine: 'Alpine', haas: 'Haas', rb: 'RB', williams: 'Williams', sauber: 'Sauber',
};

export function Opportunities({ advice }: { advice: Advice | null }) {
  const comps = (advice?.comparisons ?? []).filter((c) => c.options.length);
  const stake = comps
    .flatMap((c) => c.options.filter((o) => o.key !== 'stay_out' && o.key !== 'pit_if_green').map((o) => ({ c, o })))
    .sort((a, b) => Math.abs(b.o.delta_worst_cents) - Math.abs(a.o.delta_worst_cents))[0];
  const ch = advice?.championship ?? null;
  return (
    <section className="ld-card lc-opps" aria-labelledby="lc-opp-h">
      <div className="ld-card-head">
        <h2 id="lc-opp-h" className="ld-h">
          Financial opportunities being monitored
        </h2>
        <span className="ld-small ld-muted">No case open. When a material incident opens one, this panel becomes the active case.</span>
      </div>
      <div className="lc-opp-grid">
        <article className="lc-opp">
          <h3>Weather and tyre strategy</h3>
          {stake ? (
            <>
              <p className="lc-opp-big">
                <Delta cents={stake.o.delta_cents} strong /> <span className="ld-small ld-muted">at stake on one call</span>
              </p>
              <p className="ld-small">
                {stake.c.driver_name}: {stake.o.label.toLowerCase()} moves P{stake.o.position_now} → P{stake.o.position_after}
                {stake.o.position_best !== stake.o.position_worst ? ` (P${stake.o.position_best}–P${stake.o.position_worst})` : ''}. {advice?.weather_note}
              </p>
            </>
          ) : (
            <p className="ld-small ld-muted">No running car of ours to price.</p>
          )}
        </article>
        <article className="lc-opp">
          <h3>Championship position</h3>
          {ch ? (
            <>
              <p className="lc-opp-big mono">
                P{ch.position} <span className="ld-small ld-muted">constructors · {ch.points} pts</span>
              </p>
              <p className="ld-small">
                {ch.above_team ? `${ch.above_gap_points} pts behind ${TEAM_NAMES[ch.above_team] ?? ch.above_team} (one place up ${signed(ch.prize_up_one_cents)})` : 'Leading the table'}
                {ch.below_team ? `; ${ch.below_gap_points} pts ahead of ${TEAM_NAMES[ch.below_team] ?? ch.below_team} (one place down ${signed(ch.prize_down_one_cents)})` : ''}. This race adds {ch.points_this_race} pts at the current order.
              </p>
              <p className="ld-small ld-muted">{ch.note}</p>
            </>
          ) : (
            <p className="ld-small ld-muted">Standings unavailable.</p>
          )}
        </article>
        <article className="lc-opp">
          <h3>Cost-cap headroom</h3>
          {advice?.cap_headroom_cents !== null && advice?.cap_headroom_cents !== undefined ? (
            <p className="lc-opp-big mono">{money(advice.cap_headroom_cents)}</p>
          ) : (
            <p className="lc-opp-big ld-muted">Unknown</p>
          )}
          <p className="ld-small">{advice?.cap_headroom_source ?? 'not asked yet'}</p>
          <p className="ld-small ld-muted">Known commitments posted in the cost cap desk, not hypothetical crash costs.</p>
        </article>
      </div>
    </section>
  );
}
