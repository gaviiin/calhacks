import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CostId } from '../../blueprint/catalog';
import { IconAgent, IconApproved, IconBolt, IconDenied, IconExternal, IconFlag, IconLive, IconPerson, IconQuestion, IconWaiting } from '../../components/icons';
import { usdShort } from '../../lib/format';
import { RaceScope, latestMeeting, useRace } from '../../lib/race';
import { TRACK_LABEL, sortTime } from '../../lib/raceModel';
import { clock, parse, roleLabel } from '../raceday/shared';
import { Pill, type Tone } from '../roles/kit';
import { Bullet, Dots, LapAxis, Ring, Shares, Spark } from './charts';
import { Hero, LENSES } from './Hero';
import { LIFE_PARTS, lifeCss, useDesk, type Alert, type Desk, type DeskCar, type DeskLens, type DeskPart, type TrailItem } from './model';
import { AlertRow, CarTab, PartRow, PartsHead, TrailRow, WaitingRows } from './panels';
import { SideSheet, type SheetTarget } from './Sheet';
import './desk.css';

// The home screen: the car in a dark display case, its parts ledger beside it, and under them the instruments that
// answer what the race did to the parts and what that did to the money. One drill-down pattern: hover peeks, click
// opens a side sheet, the sheet's footer opens the full role view.

const WEEKENDS: Record<number, string> = { 1249: 'São Paulo 2024', 1285: 'Canada 2026', 1254: 'Australia 2025' };

export function HomeView({ nav }: { nav: (h: string) => void }) {
  const all = useRace();
  const meeting = useMemo(() => latestMeeting(all), [all]);
  return (
    <RaceScope meeting={meeting}>
      <Home nav={nav} meeting={meeting} />
    </RaceScope>
  );
}

function Home({ nav, meeting }: { nav: (h: string) => void; meeting: number | null }) {
  const desk = useDesk();
  const [carN, setCarN] = useState<number | null>(null);
  const [lens, setLens] = useState<DeskLens>('life');
  const [hoverCost, setHoverCost] = useState<CostId | null>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const car = desk.cars.find((c) => c.number === carN) ?? desk.cars.find((c) => c.damaged || c.incident) ?? desk.cars[0] ?? null;

  // a stopped car nobody has read yet is drawn under the condition lens, as the garage does
  const autoLens: DeskLens = car && car.condition.source === 'none' && (car.condition.status === 'stopped' || car.condition.status === 'out') && !car.read.repairedSince ? 'condition' : lens;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === '1' && desk.cars[0]) setCarN(desk.cars[0].number);
      if (e.key === '2' && desk.cars[1]) setCarN(desk.cars[1].number);
      if (e.key === 'Escape') setSheet(null);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [desk.cars]);

  const go = useCallback(
    (tab: string, anchor?: string) => {
      nav(`/day/${tab}`);
      if (anchor) window.setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    },
    [nav],
  );
  const open = useCallback((t: SheetTarget) => setSheet(t), []);

  if (!car) {
    return (
      <div className="home home--empty">
        <AlertRail alerts={desk.alerts} go={go} open={open} />
        <section className="glass home-wait">
          <Pill tone="neutral">{desk.race.connected ? 'No weekend loaded' : 'Connecting to pit-wall'}</Pill>
          <span>Press Replay or Lap 32 in the bar.</span>
        </section>
      </div>
    );
  }
  return (
    <div className="home">
      <AlertRail alerts={desk.alerts} go={go} open={open} />
      <div className="home-grid">
        <Stage desk={desk} car={car} lens={autoLens} setLens={setLens} setCar={setCarN} hoverCost={hoverCost} setHoverCost={setHoverCost} meeting={meeting} open={open} />
        <PartsPanel car={car} hoverCost={hoverCost} setHoverCost={setHoverCost} desk={desk} open={open} />
        <TimelinePanel desk={desk} open={open} />
        <AgentPanel desk={desk} open={open} go={go} />
        <CapPanel desk={desk} open={open} go={go} />
        <SparesPanel desk={desk} go={go} open={open} />
        <OddsPanel desk={desk} go={go} />
        <OrderPanel desk={desk} />
        <ProofPanel desk={desk} go={go} />
      </div>
      <Basis desk={desk} />
      {sheet ? <SideSheet target={sheet} desk={desk} close={() => setSheet(null)} go={go} open={open} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ alert rail

const RAIL: { kind: Alert['kind']; word: [string, string]; icon: ReactNode }[] = [
  { kind: 'plan', word: ['plan to approve', 'plans to approve'], icon: <IconPerson size={12} /> },
  { kind: 'held', word: ['to approve', 'to approve'], icon: <IconPerson size={12} /> },
  { kind: 'question', word: ['question', 'questions'], icon: <IconQuestion size={12} /> },
  { kind: 'decision', word: ['decision', 'decisions'], icon: <IconPerson size={12} /> },
  { kind: 'unsure', word: ['Jev unsure', 'Jev unsure'], icon: <IconQuestion size={12} /> },
  { kind: 'close', word: ['close to approve', 'close to approve'], icon: <IconWaiting size={12} /> },
  { kind: 'penalty', word: ['grid penalty', 'grid penalties'], icon: <IconDenied size={12} /> },
  { kind: 'damaged', word: ['damaged', 'damaged'], icon: <IconDenied size={12} /> },
  { kind: 'nospare', word: ['no spare', 'no spare'], icon: <IconWaiting size={12} /> },
  { kind: 'refused', word: ['refused', 'refused'], icon: <IconDenied size={12} /> },
];

function AlertRail({ alerts, go, open }: { alerts: Alert[]; go: (tab: string, anchor?: string) => void; open: (t: SheetTarget) => void }) {
  const [peek, setPeek] = useState<Alert['kind'] | null>(null);
  const groups = RAIL.map((r) => ({ ...r, items: alerts.filter((a) => a.kind === r.kind) })).filter((g) => g.items.length);
  return (
    <div className="rail" role="toolbar" aria-label="Alerts">
      {groups.length ? (
        groups.map((g) => {
          const tone = g.items[0]!.tone;
          const n = g.kind === 'refused' || g.kind === 'close' ? null : g.items.length;
          return (
            <span key={g.kind} className="rail-item" onMouseEnter={() => setPeek(g.kind)} onMouseLeave={() => setPeek(null)}>
              <button type="button" className={`g-alert g-alert--${tone}`} onClick={() => (g.kind === 'plan' && g.items.length === 1 ? open({ kind: 'plan', id: g.items[0]!.key.slice(5) }) : g.kind === 'held' || g.kind === 'close' || g.kind === 'unsure' || g.kind === 'plan' ? document.getElementById('needs-you')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) : open({ kind: 'alerts', id: g.kind }))}>
                {g.icon}
                {n !== null ? <b className="mono">{n}</b> : null}
                <span>{g.items.length === 1 ? g.word[0] : g.word[1]}</span>
              </button>
              {peek === g.kind ? (
                <ul className="peek glass--raised rail-peek">
                  {g.items.slice(0, 6).map((a) => (
                    <li key={a.key}>
                      <b>{a.title}</b>
                      <span>{a.detail}</span>
                    </li>
                  ))}
                  {g.items.length > 6 ? <li className="muted">+{g.items.length - 6} more</li> : null}
                </ul>
              ) : null}
            </span>
          );
        })
      ) : (
        <span className="g-alert g-alert--ok">
          <IconApproved size={12} />
          <span>All clear</span>
        </span>
      )}
      <span className="rail-fill" />
      <button type="button" className="rail-link" onClick={() => go('cfo')}>
        <IconExternal size={12} /> Role views
      </button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ the stage

const COMPOUND: Record<string, string> = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };

function HeatStrip({ car, lens }: { car: DeskCar; lens: DeskLens }) {
  const byCost = new Map(car.parts.map((p) => [p.cost, p]));
  return (
    <span className="heat" aria-hidden>
      {LIFE_PARTS.map((cost) => {
        const p = byCost.get(cost);
        let color = 'rgba(140,180,255,.22)';
        if (p?.life) {
          if (lens === 'condition') color = p.health === 'damaged' ? 'var(--g-d-alert)' : p.health === 'watch' ? 'var(--g-d-hold)' : p.health === 'unknown' ? 'rgba(140,180,255,.35)' : 'rgba(140,180,255,.55)';
          else if (lens === 'cap') color = p.capYear === 'booked' ? 'var(--g-d-alert)' : p.capYear === 'this' ? 'var(--g-d-hold)' : 'rgba(140,180,255,.3)';
          else color = p.lifeStatus === 'replaced' ? '#eaf4ff' : p.lifeStatus === 'damaged' ? 'var(--g-d-alert)' : lifeCss(p.usedPct);
        }
        return <i key={cost} style={{ background: color }} title={p ? `${p.short} ${Math.round(p.usedPct)}%` : cost} />;
      })}
    </span>
  );
}

function Stage({ desk, car, lens, setLens, setCar, hoverCost, setHoverCost, meeting, open }: { desk: Desk; car: DeskCar; lens: DeskLens; setLens: (l: DeskLens) => void; setCar: (n: number) => void; hoverCost: CostId | null; setHoverCost: (c: CostId | null) => void; meeting: number | null; open: (t: SheetTarget) => void }) {
  const t = desk.tape;
  const r = car.read;
  const inc = car.incident;
  const belief = inc ? parse<{ impact_kph?: number; decel_g?: number; lap?: number; assessed_as?: string; severity?: Record<string, number> }>(inc.beliefJson, {}) : null;
  const top = belief?.severity ? Object.entries(belief.severity).sort((a, b) => b[1] - a[1])[0] : null;
  const sev = belief?.assessed_as ?? top?.[0] ?? null;
  const flagTone = t.track === 'RED' ? 'alert' : t.track === 'SC' || t.track === 'VSC' ? 'hold' : t.track === 'GREEN' ? 'live' : 'muted';
  return (
    <section className="glass--dark hstage" aria-label="The car">
      <div className="hs-top">
        <div className="hs-cars" role="tablist" aria-label="Cars">
          {desk.cars.map((c) => (
            <span key={c.number} className="hs-cartab">
              <CarTab car={c} on={c.number === car.number} onPick={() => setCar(c.number)} />
              <HeatStrip car={c} lens={lens} />
            </span>
          ))}
        </div>
        <div className="hs-race glass-chip--dark" title={`${t.sessionName} · ${TRACK_LABEL[t.track]}${t.last ? ` · ${clock(t.last)} UTC` : ''}`}>
          <span className={`lamp lamp--${flagTone}`} aria-hidden />
          <span className="hs-flag">{TRACK_LABEL[t.track]}</span>
          <span className="hs-sep" />
          <span className="mono">
            {meeting && WEEKENDS[meeting] ? WEEKENDS[meeting] : ''} · {t.sessionName}
            {t.fieldLap ? ` · L${t.fieldLap}` : ''}
          </span>
          {r.tyre ? (
            <>
              <span className="hs-sep" />
              <i className={`tyre tyre--${COMPOUND[r.tyre.compound] ?? 'X'}`} aria-hidden>
                {COMPOUND[r.tyre.compound] ?? '?'}
              </i>
              <span className="mono">{r.tyre.age}L</span>
            </>
          ) : null}
          {r.gap ? (
            <>
              <span className="hs-sep" />
              <span className="mono">{r.gap}</span>
            </>
          ) : null}
          {r.lastPit ? (
            <>
              <span className="hs-sep" />
              <span className="mono">P L{r.lastPit}</span>
            </>
          ) : null}
        </div>
        <div className="hs-lens">
          <div className="gseg gseg--dark" role="radiogroup" aria-label="Lens">
            {LENSES.map((l) => (
              <button key={l.id} type="button" role="radio" aria-checked={lens === l.id} className={lens === l.id ? 'is-on' : ''} onClick={() => setLens(l.id)} title={l.title}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <Hero car={car} lens={lens} highlightCost={hoverCost} onHoverCost={setHoverCost} corner={inc && belief ? (
        <button type="button" className={`hs-incident glass-chip--dark ${sev === 'heavy' || sev === 'moderate' ? 'hs-incident--hot' : ''}`} onClick={() => open({ kind: 'incident', id: inc.incidentKey })} title={inc.cause || 'Open the incident'}>
          <IconBolt size={13} />
          <span className="mono">
            {belief.impact_kph ? `${belief.impact_kph} km/h` : 'stopped'}
            {belief.decel_g ? ` · ${belief.decel_g} g` : ''}
            {belief.lap ? ` · L${belief.lap}` : ''}
          </span>
          {sev ? <Pill tone={sev === 'heavy' ? 'bad' : sev === 'moderate' ? 'wait' : 'neutral'}>{sev.charAt(0).toUpperCase() + sev.slice(1)}</Pill> : null}
          <span className="hs-v mono">v{inc.version}</span>
        </button>
      ) : null} />
    </section>
  );
}

// ------------------------------------------------------------------------------------------ parts

function PanelHead({ title, aside, onOpen, tip }: { title: string; aside?: ReactNode; onOpen?: () => void; tip?: string }) {
  return (
    <header className="g-panel-head" title={tip}>
      <h2>{title}</h2>
      {aside ? <span className="g-panel-aside">{aside}</span> : null}
      {onOpen ? (
        <button type="button" className="g-open" onClick={onOpen} aria-label={`Open ${title}`}>
          <IconExternal size={14} />
        </button>
      ) : null}
    </header>
  );
}

function PartsPanel({ car, hoverCost, setHoverCost, desk, open }: { car: DeskCar; hoverCost: CostId | null; setHoverCost: (c: CostId | null) => void; desk: Desk; open: (t: SheetTarget) => void }) {
  const h = desk.finance.hardware;
  return (
    <section className="glass panel-parts" aria-label="Parts">
      <PanelHead title={`Parts · car ${car.number}`} aside={<span className="mono">{car.parts.filter((p) => p.life).length} followed</span>} onOpen={() => open({ kind: 'parts', id: String(car.number) })} tip="Each part's life from the laps it ran, the stress events Jev classified and the crashes. Wear is never booked: it sets when each replacement counts against the cap." />
      <ul className="dk-parts">
        <PartsHead />
        {car.parts.map((p) => (
          <span key={p.key} onClick={() => open({ kind: 'part', id: p.key })} role="presentation">
            <PartRow p={p} on={hoverCost === p.cost} onHover={setHoverCost} />
          </span>
        ))}
      </ul>
      <footer className="parts-foot">
        <Fig label="Due 2024" value={usdShort(h.dueCents)} sub={`${h.dueParts} parts`} tone={h.dueParts ? 'wait' : undefined} />
        <Fig label="Replaced" value={String(h.replaced)} sub="booked" />
        <Fig label="Into 2024" value={h.forward ? usdShort(h.forward) : '$0'} sub="pulled in" />
        <Fig label="Penalty" value={String(h.penalties)} tone={h.penalties ? 'bad' : undefined} sub="past allocation" />
      </footer>
    </section>
  );
}

function Fig({ label, value, sub, tone, size = 'md' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone | 'live'; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  return (
    <div className={`fig fig--${size} ${tone ? `fig--${tone}` : ''}`}>
      <span className="fig-label">{label}</span>
      <span className="fig-value mono">{value}</span>
      {sub ? <span className="fig-sub">{sub}</span> : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ the race on one axis

const MARK_TONE: Record<string, string> = { crash: 'alert', contact: 'hold', sc: 'hold', vsc: 'hold', red: 'alert', pit: 'ink', penalty: 'alert' };

function TimelinePanel({ desk, open }: { desk: Desk; open: (t: SheetTarget) => void }) {
  const tl = desk.timeline;
  const marks = tl.marks.map((m) => ({ x: m.lap, tone: MARK_TONE[m.kind] ?? 'ink', label: m.label, big: m.kind === 'crash' || m.kind === 'red' }));
  const last = tl.cost.mid[tl.cost.mid.length - 1] ?? 0;
  const incs = desk.race.incidents.slice().sort((a, b) => sortTime(a.firstSeenAt) - sortTime(b.firstSeenAt));
  return (
    <section className="glass panel-timeline" aria-label="The race">
      <PanelHead title={`${desk.tape.sessionName} · cost by lap`} aside={<span className="mono">{last ? usdShort(last) : '—'}</span>} tip="Cumulative weekend cost (price-book mid) by lap, with what happened: crashes, contacts, safety cars, red flags, pit stops." />
      {tl.laps ? (
        <LapAxis xs={tl.cost.xs} line={tl.cost.mid} marks={marks} format={usdShort} xLabel={(x) => `L${x}`} now={desk.tape.fieldLap ?? undefined} height={108} />
      ) : (
        <div className="empty-chart">No laps yet</div>
      )}
      <ul className="tl-incidents">
        {incs.map((i) => {
          const b = parse<{ impact_kph?: number; lap?: number; assessed_as?: string }>(i.beliefJson, {});
          const booked = desk.race.entries.filter((e) => e.incidentKey === i.incidentKey).length;
          return (
            <li key={i.incidentKey}>
              <button type="button" onClick={() => open({ kind: 'incident', id: i.incidentKey })} title={i.cause}>
                <span className={`lamp lamp--${b.assessed_as === 'heavy' ? 'alert' : b.assessed_as === 'moderate' ? 'hold' : 'muted'}`} aria-hidden />
                <b className="mono">
                  #{i.driverNumber} {i.sessionKey === 9627 ? 'Q' : `L${b.lap ?? '?'}`}
                </b>
                <span className="mono">{b.impact_kph ? `${b.impact_kph} km/h` : clock(i.firstSeenAt)}</span>
                <span>{b.assessed_as ?? i.status}</span>
                <span className="mono muted">{booked ? `${booked} entries` : ''}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------------------------------ agent activity

const FILTERS: { id: string; label: string; test: (t: TrailItem) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'refused', label: 'Refused', test: (t) => t.outcome === 'refused' },
  { id: 'held', label: 'Held', test: (t) => t.outcome === 'held' || t.outcome === 'asked' },
  { id: 'people', label: 'People', test: (t) => t.actor === 'person' },
];

function AgentPanel({ desk, open, go }: { desk: Desk; open: (t: SheetTarget) => void; go: (tab: string, anchor?: string) => void }) {
  const [filter, setFilter] = useState('all');
  const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0]!;
  const rows = desk.trail.filter(f.test).slice(0, 120);
  const p = desk.proof;
  const latencies = useMemo(() => desk.race.effects.map((e) => parse<{ ms?: number }>(e.jevJson, {}).ms).filter((x): x is number => typeof x === 'number' && x > 0).slice(-24), [desk.race.effects]);
  const waiting = desk.alerts.filter((a) => a.action).length;
  return (
    <section className="glass panel-agent" aria-label="The agent">
      <PanelHead
        title="Agent"
        aside={
          <span className="agent-aside" title={`Event read to committed: mean ${p.meanMs ?? '—'} ms, last ${p.lastMs ?? '—'} ms, max ${p.maxMs ?? '—'} ms over ${p.events.toLocaleString('en-US')} events; Jev's last reads as a line`}>
            <span className="lamp lamp--live" aria-hidden />
            <span className="mono">{p.meanMs !== null ? `${p.meanMs} ms` : '—'}</span>
            <Spark values={latencies.length > 1 ? latencies : [0, 0]} width={48} height={14} area={false} baseline={false} min={0} />
            <span className="mono muted">{p.events.toLocaleString('en-US')}</span>
          </span>
        }
        onOpen={() => go('accounting')}
        tip="What the agent did, what it refused to do, and what waits for a person. Every row is on the record in pit-wall."
      />
      <div id="needs-you" className="needs">
        <h3>
          Needs you <span className="mono">{waiting}</span>
        </h3>
        <WaitingRows held={desk.held} plans={desk.plans} onOpenPlan={(key) => open({ kind: 'plan', id: key })} />
      </div>
      <div className="stream-head">
        <div className="gseg" role="radiogroup" aria-label="Show">
          {FILTERS.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={filter === x.id} className={filter === x.id ? 'is-on' : ''} onClick={() => setFilter(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <span className="mono muted" title={`${p.decisions} decisions on the record, ${p.refused} refused, ${p.agentRefused} of them an agent trying to act for a person`}>
          {p.decisions} · {p.refused} refused
        </span>
      </div>
      <ol className="stream">
        {rows.map((it) => (
          <span key={it.key} onClick={() => (it.key.startsWith('po:') ? open({ kind: 'decision', id: it.key.slice(3) }) : null)} role="presentation">
            <TrailRow it={it} />
          </span>
        ))}
        {!rows.length ? <li className="stream-empty">Nothing yet</li> : null}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------------------------------ cost cap

function CapPanel({ desk, open, go }: { desk: Desk; open: (t: SheetTarget) => void; go: (tab: string) => void }) {
  const f = desk.finance;
  const cap = f.cap;
  const lo = cap ? Math.min(cap.capCents, cap.p10) : 0;
  const hi = cap ? Math.max(cap.capCents, cap.p90) : 1;
  const pad = cap ? Math.max(hi - lo, cap.capCents * 0.01) : 1;
  const min = cap ? Math.max(lo - pad * 0.6, 0) : 0;
  const max = cap ? hi + pad * 0.3 : 1;
  const b = f.books;
  return (
    <section className="glass panel-cap" aria-label="Cost cap">
      <PanelHead title={`Cost cap ${cap?.year ?? ''}`} aside={cap ? <span className="mono" title={cap.basis}>cap {usdShort(cap.capCents)}</span> : undefined} onOpen={() => go('cfo')} tip="Year-end cap spend from 10,000 season re-runs (P10 to P90, P50 marked) against the cap; the chance of an overspend; this weekend's cost band and where its entries sit." />
      {cap ? (
        <>
          <div className="cap-top">
            <Fig label="P(overspend)" value={pctWord(cap.pOver)} size="xl" tone={cap.pOver >= 0.5 ? 'bad' : cap.pOver >= 0.1 ? 'wait' : undefined} sub={`material ${pctWord(cap.pMat)}`} />
            <div className="cap-states">
              <Shares parts={[{ tone: 'navy', value: Math.max(1 - cap.pOver, 0), label: 'Under' }, { tone: 'wait', value: Math.max(cap.pOver - cap.pMat, 0), label: 'Minor' }, { tone: 'bad', value: cap.pMat, label: 'Material' }]} height={6} />
              <span className="legend">
                <i className="sw sw--navy" /> Under <i className="sw sw--wait" /> Minor <i className="sw sw--bad" /> Material
              </span>
            </div>
          </div>
          <div className="cap-bullet" title={`Year-end P10 ${usdShort(cap.p10)}, P50 ${usdShort(cap.p50)}, P90 ${usdShort(cap.p90)}; the line is the cap ${usdShort(cap.capCents)}. The bar starts at ${usdShort(min)}.`}>
            <Bullet value={cap.p50} limit={cap.capCents} band={[cap.p10, cap.p90]} min={min} max={max} tone={cap.p50 > cap.capCents ? 'bad' : 'navy'} height={12} label="year-end spend against the cap" />
            <span className="cap-scale mono">
              <span>P10 {usdShort(cap.p10)}</span>
              <span>P50 {usdShort(cap.p50)}</span>
              <span>P90 {usdShort(cap.p90)}</span>
            </span>
          </div>
        </>
      ) : (
        <div className="empty-chart">The cap forecast runs with the season</div>
      )}
      <div className="cap-rows">
        <div className="cap-row" title={`Weekend cost, price-book mid, provisional: ${usdShort(f.cost.low)} to ${usdShort(f.cost.high)} over ${f.cost.n} effects`}>
          <span className="fig-label">Weekend</span>
          <RangeBar low={f.cost.low} mid={f.cost.mid} high={f.cost.high} />
          <span className="mono cap-row-v">{f.cost.n ? usdShort(f.cost.mid) : '—'}</span>
        </div>
        <div className="cap-row" title={`Posted ${usdShort(b.posted.c)} (${b.posted.k}) · held ${usdShort(b.held.c)} (${b.held.k}) · not routed ${usdShort(b.unrouted.c)} (${b.unrouted.k})${b.rejected.k ? ` · rejected ${usdShort(b.rejected.c)} (${b.rejected.k})` : ''}`}>
          <span className="fig-label">Books</span>
          <Shares parts={[{ tone: 'navy', value: b.posted.c, label: 'Posted' }, { tone: 'wait', value: b.held.c, label: 'Held' }, { tone: 'gray', value: b.unrouted.c, label: 'Not routed' }, { tone: 'bad', value: b.rejected.c, label: 'Rejected' }]} height={8} />
          <span className="mono cap-row-v">{usdShort(b.posted.c)}</span>
        </div>
        <div className="cap-row" title="What this weekend's running brings into this year's cap: replacements due by wear before the season ends, at the price-book mid">
          <span className="fig-label">Into 2024</span>
          <span className="cap-into">
            {f.hardware.dueParts ? <Pill tone="wait">{f.hardware.dueParts} due by wear</Pill> : <Pill tone="neutral">none due</Pill>}
            {f.hardware.forward ? <Pill tone="wait">+{usdShort(f.hardware.forward)} pulled in</Pill> : null}
          </span>
          <span className="mono cap-row-v">{usdShort(f.hardware.dueCents)}</span>
        </div>
      </div>
      {f.erp.length ? (
        <button type="button" className="cap-erp" onClick={() => open({ kind: 'decision', id: f.erp[0]!.id })} title={f.erp.map((e) => `${e.id} · ${e.memo}`).join('\n')}>
          <IconApproved size={11} /> {f.erp.length} in the ERP · last {f.erp[0]!.id}
        </button>
      ) : null}
    </section>
  );
}

function pctWord(x: number): string {
  return `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
}

function RangeBar({ low, mid, high }: { low: number; mid: number; high: number }) {
  const max = Math.max(high, 1) * 1.04;
  const at = (x: number) => `${Math.max(0, Math.min(100, (x / max) * 100))}%`;
  return (
    <span className="range" role="img" aria-label={`${usdShort(low)} to ${usdShort(high)}, mid ${usdShort(mid)}`}>
      <span className="range-band" style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} />
      <span className="range-mid" style={{ left: at(mid) }} />
    </span>
  );
}

// ------------------------------------------------------------------------------------------ spares and the factory

const ACTION_WORD: Record<string, string> = {
  spares_reserve: 'Spare', work_order: 'Work order', td017_move: 'Inventory', evidence_pack: 'Evidence', parc_ferme_list: 'Parc fermé', pu_check: 'PU check', hand_carry: 'Hand-carry', freight: 'Freight', fia_notice: 'FIA notice',
};

function SparesPanel({ desk, go, open }: { desk: Desk; go: (tab: string, anchor?: string) => void; open: (t: SheetTarget) => void }) {
  const reserved = desk.parts.filter((p) => p.spare && !p.spare.released);
  const byCar = new Map<number, DeskPart[]>();
  for (const p of reserved) byCar.set(p.car, [...(byCar.get(p.car) ?? []), p]);
  const acts = desk.actions;
  const kinds = new Map<string, { auto: number; wait: number; done: number }>();
  for (const a of [...acts.desk, ...acts.waiting, ...acts.done]) {
    if (a.kind === 'spares_reserve') continue;
    const k = kinds.get(a.kind) ?? { auto: 0, wait: 0, done: 0 };
    if (a.status === 'auto') k.auto++;
    else if (a.status === 'awaiting_approval') k.wait++;
    else k.done++;
    kinds.set(a.kind, k);
  }
  const s = desk.spares;
  return (
    <section className="glass panel-spares" aria-label="Spares and the factory">
      <PanelHead
        title="Spares"
        aside={
          <span className="pips-legend">
            <i className="pip pip--track" /> {s.track} track <i className="pip pip--factory" /> {s.factory} Grove <i className="pip pip--make" /> {s.make} make
          </span>
        }
        onOpen={() => open({ kind: 'logistics', id: '' })}
        tip="Spares reserved for each damaged part: at the track, at the factory in Grove, or to be made; and the work the desk raised to follow (work orders, inventory moves, freight)."
      />
      {reserved.length ? (
        <ul className="spares">
          {[...byCar.entries()].map(([car, parts]) => (
            <li key={car}>
              <span className="mono spares-car">{car}</span>
              <span className="spares-parts">
                {parts.map((p) => (
                  <button key={p.key} type="button" className={`spare spare--${p.spare!.source}`} onClick={() => open({ kind: 'part', id: p.key })} title={`${p.label}: ${p.spare!.source === 'at_track' ? `spare at the track${p.spare!.atTrackAfter !== null ? `, ${p.spare!.atTrackAfter} left` : ''}` : p.spare!.source === 'factory' ? `from Grove${p.spare!.factoryAfter !== null ? `, ${p.spare!.factoryAfter} left there` : ''}` : 'to be made'}`}>
                    <i className={`pip pip--${p.spare!.source === 'at_track' ? 'track' : p.spare!.source}`} aria-hidden />
                    {p.short}
                    {p.spare!.source === 'make' ? <span className="mono muted">{leadWord(p.cost)}</span> : null}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-chart">No spares reserved</div>
      )}
      <ul className="works">
        {[...kinds.entries()].sort((a, b) => b[1].auto + b[1].wait + b[1].done - (a[1].auto + a[1].wait + a[1].done)).slice(0, 4).map(([kind, k]) => (
          <li key={kind} title={`${ACTION_WORD[kind] ?? kind}: ${k.auto} by the desk, ${k.wait} waiting for a person, ${k.done} decided`}>
            <span className="works-k">{ACTION_WORD[kind] ?? kind.replace(/_/g, ' ')}</span>
            <Shares parts={[{ tone: 'navy', value: k.done, label: 'decided' }, { tone: 'wait', value: k.wait, label: 'waiting' }, { tone: 'gray', value: k.auto, label: 'by the desk' }]} height={6} />
            <span className="mono works-n">{k.auto + k.wait + k.done}</span>
          </li>
        ))}
      </ul>
      {acts.waiting.length ? (
        <button type="button" className="link-row" onClick={() => go('garage', 'next-steps')}>
          <IconWaiting size={11} /> {acts.waiting.length} waiting · first {acts.waiting[0]!.dueAt ? clock(acts.waiting[0]!.dueAt).slice(0, 5) : ''} · {roleLabel(acts.waiting[0]!.ownerRole)}
        </button>
      ) : null}
    </section>
  );
}

const LEAD: Partial<Record<CostId, number>> = { chassis: 14, gearbox: 7, floor: 5, front_wing: 3, rear_wing: 3, front_suspension: 5, rear_suspension: 5, bodywork: 3, brakes: 2, electronics: 3, power_unit: 10 };
const leadWord = (c: CostId) => (LEAD[c] ? `${LEAD[c]}d` : '');

// ------------------------------------------------------------------------------------------ season odds

function OddsPanel({ desk, go }: { desk: Desk; go: (tab: string) => void }) {
  const pz = desk.finance.prize;
  const sim = desk.finance.sim;
  return (
    <section className="glass panel-odds" aria-label="Season odds">
      <PanelHead title="Season" aside={sim ? <span className="mono" title={`${sim.seasons.toLocaleString('en-US')} seasons re-run at ${clock(sim.at)} UTC in ${sim.runtimeMs} ms`}>{sim.seasons.toLocaleString('en-US')} · {sim.runtimeMs} ms</span> : undefined} onOpen={() => go('strategy')} tip="The championship re-run 10,000 times after every change: the chance of holding the place, the expected prize money, and why it moved." />
      {pz ? (
        <>
          <div className="odds-top">
            <Fig label={`P(P${pz.target} or better)`} value={pctWord(pz.pTarget)} size="xl" sub={pz.baseline !== null ? `from ${pctWord(pz.baseline)}` : undefined} tone={pz.baseline !== null && pz.pTarget < pz.baseline - 0.05 ? 'bad' : undefined} />
            <Spark values={pz.history.length > 1 ? pz.history : [pz.pTarget, pz.pTarget]} width={150} height={44} min={0} max={1} label={`P(P${pz.target}) over ${pz.history.length} runs`} />
          </div>
          <div className="odds-prize">
            <Fig label="Expected prize" value={usdShort(pz.expected)} size="lg" sub={<span className={pz.delta < 0 ? 'tone-alert mono' : 'mono'}>{pz.delta > 0 ? '+' : ''}{usdShort(pz.delta)} vs baseline</span>} />
            <Diverging ours={pz.ours} rivals={pz.rivals} />
          </div>
        </>
      ) : (
        <div className="empty-chart">The season runs with the first event</div>
      )}
    </section>
  );
}

function Diverging({ ours, rivals }: { ours: number; rivals: number }) {
  const max = Math.max(Math.abs(ours), Math.abs(rivals), 1);
  const row = (label: string, v: number, tone: string) => (
    <div className="div-row" key={label}>
      <span className="fig-label">{label}</span>
      <span className="div-track" aria-hidden>
        <span className={`div-fill div-fill--${tone} ${v < 0 ? 'div-fill--neg' : ''}`} style={{ width: `${(Math.abs(v) / max) * 50}%` }} />
      </span>
      <span className={`mono div-v ${v < 0 ? 'tone-alert' : ''}`}>{v > 0 ? '+' : ''}{usdShort(v)}</span>
    </div>
  );
  return (
    <div className="div" title="Why the prize moved: our weekend as the cars ran against our baseline, and the rivals' weekend">
      {row('Ours', ours, 'navy')}
      {row('Rivals', rivals, 'sky')}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ running order

function OrderPanel({ desk }: { desk: Desk }) {
  const o = desk.order;
  const t = desk.tape;
  const half = Math.ceil(o.length / 2);
  const cols = [o.slice(0, half), o.slice(half)];
  return (
    <section className="glass panel-order" aria-label="Running order">
      <PanelHead title="Order" aside={<span className="mono">{o.filter((r) => !r.out).length} running{t.fieldLap ? ` · L${t.fieldLap}` : ''}</span>} tip="The field by position from the timing tape; our cars marked; stopped cars and non-starters at the end." />
      {o.length ? (
        <div className="tower">
          {cols.map((col, ci) => (
            <ol key={ci} start={ci * half + 1}>
              {col.map((r, i) => (
                <li key={r.n} className={`${r.ours ? 'is-ours' : ''} ${r.out ? 'is-out' : ''}`} title={r.team}>
                  <span className="tower-pos mono">{r.out ? (r.dns ? 'DNS' : 'OUT') : ci * half + i + 1}</span>
                  <span className="tower-num mono">{r.n}</span>
                  <span className="tower-code">{r.code}</span>
                </li>
              ))}
            </ol>
          ))}
        </div>
      ) : (
        <div className="empty-chart">Positions appear with the first lap</div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------ proof

function ProofPanel({ desk, go }: { desk: Desk; go: (tab: string) => void }) {
  const p = desk.proof;
  const r = desk.race.rules;
  const log = (ms: number | null) => (ms === null ? 0 : Math.log10(Math.max(ms, 1) + 1));
  const LOGMAX = Math.log10(51);
  return (
    <section className="glass panel-proof" aria-label="Proof">
      <PanelHead title="On the record" aside={<span className="mono">{p.online} watching</span>} onOpen={() => go('accounting')} tip="pit-wall's own rows: how long an event takes from read to commit, who is watching, and every decision allowed or refused, with the money rules the database enforces." />
      <div className="proof-lat">
        {[
          { k: 'mean', v: p.meanMs },
          { k: 'last', v: p.lastMs },
          { k: 'max', v: p.maxMs },
        ].map((x) => (
          <div key={x.k} className="proof-row" title={`${x.k} event read to committed: ${x.v ?? '—'} ms`}>
            <span className="fig-label">{x.k}</span>
            <Bullet value={log(x.v)} max={LOGMAX} tone="sky" height={6} ticks={[{ at: log(10), label: '10 ms' }]} />
            <span className="mono proof-v">{x.v !== null ? `${x.v} ms` : '—'}</span>
          </div>
        ))}
      </div>
      <div className="proof-dec" title={`${p.decisions} decisions on the record: ${p.decisions - p.refused} allowed, ${p.refused} refused (${p.agentRefused} an agent acting for a person)`}>
        <span className="fig-label">Decisions</span>
        <Shares parts={[{ tone: 'navy', value: p.decisions - p.refused, label: 'allowed' }, { tone: 'bad', value: p.refused, label: 'refused' }]} height={8} />
        <span className="mono proof-v">{p.decisions}</span>
      </div>
      <ul className="rules" title="The posting rule pit-wall enforces: no amount threshold; the chief of staff approves the response plan, a line with a precedent in the team's history posts on its own, a line with none waits for the Head of Cost Cap">
        <li title="The chief of staff approves the team's reaction to an incident as a whole before anything executes or posts">
          <IconPerson size={11} /> plan: Chief of Staff
        </li>
        <li title="A line whose closest case in the team's history scores at least 0.80 executes and posts on its own, whatever its amount">
          <IconAgent size={11} /> precedent <span className="mono">≥ 0.80</span> posts alone
        </li>
        <li title="A line with no case close enough (or a familiar part at an unfamiliar price) waits for the Head of Cost Cap">
          <IconPerson size={11} /> novel: HCC
        </li>
        <li title={r?.modelMayPostAlone ? 'Estimates from Jev or the forecast agent may post alone' : 'An estimate that is only Jev’s and has no precedent needs a person’s sign-off'}>
          <IconLive size={11} /> Jev unsure: a person
        </li>
      </ul>
      {p.names.length ? (
        <span className="proof-who">
          {p.names.slice(0, 6).map((nm, i) => (
            <i key={i} className="avatar" title={nm}>
              {nm.slice(0, 1).toUpperCase()}
            </i>
          ))}
        </span>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------------------------------ basis

function Basis({ desk }: { desk: Desk }) {
  const f = desk.finance;
  return (
    <details className="basis">
      <summary>Basis</summary>
      <ul>
        <li>Every part-life figure is a stated assumption in race/life.py: life in km per part, life already used at the weekend start, the share a stress event takes by Jev's severity; the laps, race-control messages and crashes are real (OpenF1).</li>
        <li>Prices are the price book's GBP bands (press figures where published, assumptions otherwise) at 1.27 USD/GBP; replacements count against the cap at first use (Financial Regulations Issue 22); wear is never booked (Art. 3.1(o)).</li>
        {f.cap ? <li>{f.cap.basis}</li> : null}
        {f.sim ? <li>{f.sim.seasons.toLocaleString('en-US')} seasons at {clock(f.sim.at)} UTC in {f.sim.runtimeMs} ms.</li> : null}
        <li>Not affiliated with Williams Racing; money on race day is press estimates and stated assumptions.</li>
      </ul>
    </details>
  );
}

export { Fig, Dots as DotsRef, Ring as RingRef, AlertRow as AlertRowRef, IconFlag as FlagRef };
