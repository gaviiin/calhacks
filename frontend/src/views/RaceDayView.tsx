import { useEffect, useMemo, useState } from 'react';
import { RaceScope, latestMeeting, useRace } from '../lib/race';
import { sortTime } from '../lib/raceModel';
import { AccountPanel, accountHeadline } from './raceday/AccountPanel';
import { AskPanel, askHeadline } from './raceday/AskPanel';
import { ClosePanel, closeHeadline } from './raceday/ClosePanel';
import { DetectPanel, detectHeadline } from './raceday/DetectPanel';
import { LogPanel, logHeadline } from './raceday/LogPanel';
import { ReplanPanel, replanHeadline } from './raceday/ReplanPanel';
import { RespondPanel, respondHeadline } from './raceday/RespondPanel';
import { Stage, clock, type Headline } from './raceday/shared';
import { AccountingView } from './roles/AccountingView';
import { CFOView } from './roles/CFOView';
import { FlowFocus } from './roles/focus';
import { IncidentFlow } from './roles/IncidentFlow';
import { PitWallView } from './roles/PitWallView';
import { ReplayControl } from './roles/ReplayControl';
import { ServiceStrip } from './roles/ServiceStrip';
import { StrategyView } from './roles/StrategyView';

// One weekend, a view for each person who works it, in the order an incident reaches them: the garage sees the car
// and makes the engineering call, the strategist the race call, accounting books what follows, the CFO reads the
// season. Every view reads the same live rows; none of them recommends.
const ROLES = [
  { id: 'garage', label: 'Garage', who: 'pit crew, engineers and the Team Principal', View: PitWallView },
  { id: 'strategy', label: 'Strategy', who: 'head of strategy', View: StrategyView },
  { id: 'accounting', label: 'Accounting', who: 'financial controller and accountants', View: AccountingView },
  { id: 'cfo', label: 'CFO', who: 'CFO and Head of Cost Cap', View: CFOView },
] as const;
const ALIAS: Record<string, string> = { pitwall: 'garage' };

// Race day: one weekend read as seven stages, from the moment a car stops to the CFO's brief. The rail shows one
// figure per stage; each stage opens to its detail. The full live desk (timing, blueprint, tape) stays at #/race.

const STAGES: { id: string; title: string; head: (r: ReturnType<typeof useRace>) => Headline; Panel: () => JSX.Element }[] = [
  { id: 'detect', title: 'Detect', head: detectHeadline, Panel: DetectPanel },
  { id: 'log', title: 'Log', head: logHeadline, Panel: LogPanel },
  { id: 'respond', title: 'Respond', head: respondHeadline, Panel: RespondPanel },
  { id: 'account', title: 'Account', head: accountHeadline, Panel: AccountPanel },
  { id: 'ask', title: 'Ask', head: askHeadline, Panel: AskPanel },
  { id: 'replan', title: 'Re-plan', head: replanHeadline, Panel: ReplanPanel },
  { id: 'close', title: 'Close', head: closeHeadline, Panel: ClosePanel },
];

const WEEKENDS: Record<number, string> = { 1249: 'São Paulo Grand Prix 2024', 1285: 'Canadian Grand Prix 2026', 1254: 'Australian Grand Prix 2025' };
const SESSIONS: Record<number, string> = { 9627: 'Qualifying', 9636: 'Race', 11291: 'Race', 9693: 'Race' };

export function RaceDayView({ role, nav }: { role: string | null; nav: (h: string) => void }) {
  const all = useRace();
  const meeting = useMemo(() => latestMeeting(all), [all]);
  const [focus, setFocus] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const t = window.setTimeout(() => (document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), setAnchor(null)), 60);
    return () => window.clearTimeout(t);
  }, [anchor, role]);
  // #/day/flow: the seven stages in order, kept for the pitch deck and off the switcher.
  if (role === 'flow') {
    return (
      <RaceScope meeting={meeting}>
        <Weekend meeting={meeting} />
      </RaceScope>
    );
  }
  const r = ROLES.find((x) => x.id === (ALIAS[role ?? ''] ?? role)) ?? ROLES[0];
  const go = (tab: string, anchor?: string) => {
    nav(`/day/${tab}`);
    if (anchor) setAnchor(anchor);
  };
  return (
    <FlowFocus value={{ incidentKey: focus, setIncidentKey: setFocus }}>
    <RaceScope meeting={meeting}>
      <div className="day-bar">
        <nav className="day-tabs" aria-label="Views">
          {ROLES.map((x) => (
            <a key={x.id} href={`#/day/${x.id}`} className={x.id === r.id ? 'day-tab day-tab--on' : 'day-tab'} aria-current={x.id === r.id ? 'page' : undefined}
               onClick={(e) => (e.preventDefault(), nav(`/day/${x.id}`))} title={`For the ${x.who}`}>
              {x.label}
            </a>
          ))}
        </nav>
        <WeekendHeader meeting={meeting} />
      </div>
      <IncidentFlow tab={r.id} go={go} />
      <r.View />
    </RaceScope>
    </FlowFocus>
  );
}

function WeekendHeader({ meeting }: { meeting: number | null }) {
  const race = useRace();
  const latest = useMemo(() => race.events.reduce<string>((m, e) => (sortTime(e.at) > sortTime(m || '1970-01-01T00:00:00Z') ? e.at : m), ''), [race.events]);
  const session = race.events.find((x) => x.at === latest)?.sessionKey ?? null;
  return (
    <div className="day-meta">
      <span className="day-weekend">{meeting && WEEKENDS[meeting] ? WEEKENDS[meeting] : 'No weekend yet'}</span>
      {latest && (
        <span className="day-clock mono" title="Race time of the latest event (UTC)">
          {session !== null ? SESSIONS[session] ?? `S${session}` : ''} {clock(latest)}
        </span>
      )}
      <ServiceStrip />
      <ReplayControl />
    </div>
  );
}

function Weekend({ meeting }: { meeting: number | null }) {
  const race = useRace();
  const latest = useMemo(() => race.events.reduce<string>((m, e) => (sortTime(e.at) > sortTime(m || '1970-01-01T00:00:00Z') ? e.at : m), ''), [race.events]);
  const session = useMemo(() => {
    const e = race.events.find((x) => x.at === latest);
    return e ? e.sessionKey : null;
  }, [race.events, latest]);
  return (
    <div className="raceday">
      <header className="raceday-head">
        <div>
          <p className="eyebrow">Race day · Williams Racing{meeting && WEEKENDS[meeting] ? ` · ${WEEKENDS[meeting]}` : ''}</p>
          <h1>{race.events.length ? 'From the moment a car stops to the CFO’s brief' : 'Waiting for the weekend'}</h1>
        </div>
        <p className="muted mono">
          {latest ? `${session !== null ? SESSIONS[session] ?? `session ${session}` : ''} · race time ${clock(latest)} UTC` : race.connected ? 'connected · no events yet' : 'connecting to pit-wall…'}
        </p>
      </header>
      <ol className="rail" aria-label="The flow">
        {STAGES.map((s, i) => {
          const h = s.head(race);
          return (
            <li key={s.id} className="rail-step">
              <a href={`#/stage-${s.id}`} onClick={(e) => (e.preventDefault(), document.getElementById(`stage-${s.id}`)?.scrollIntoView({ behavior: 'smooth' }))}>
                <span className="rail-n mono">{i + 1}</span>
                <span className="rail-title">{s.title}</span>
                <span className={`rail-value mono ${h.tone ? `tone-${h.tone}` : ''}`}>{h.value}</span>
              </a>
            </li>
          );
        })}
      </ol>
      {STAGES.map((s, i) => (
        <Stage key={s.id} n={i + 1} id={s.id} title={s.title} headline={s.head(race)}>
          <s.Panel />
        </Stage>
      ))}
      <p className="muted raceday-foot">
        Not affiliated with Williams Racing. Timing, telemetry and results are real (OpenF1, Jolpica); money is press estimates and stated assumptions. The full live desk is at <a href="#/race">#/race</a>.
      </p>
    </div>
  );
}
