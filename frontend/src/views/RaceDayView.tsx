import { useMemo } from 'react';
import { useRace } from '../lib/race';
import { sortTime } from '../lib/raceModel';
import { AccountPanel, accountHeadline } from './raceday/AccountPanel';
import { AskPanel, askHeadline } from './raceday/AskPanel';
import { ClosePanel, closeHeadline } from './raceday/ClosePanel';
import { DetectPanel, detectHeadline } from './raceday/DetectPanel';
import { LogPanel, logHeadline } from './raceday/LogPanel';
import { ReplanPanel, replanHeadline } from './raceday/ReplanPanel';
import { RespondPanel, respondHeadline } from './raceday/RespondPanel';
import { Stage, clock, type Headline } from './raceday/shared';

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

export function RaceDayView() {
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
          <p className="eyebrow">Race day · Williams Racing</p>
          <h1>{race.events.length ? 'From the moment a car stops to the CFO’s brief' : 'Waiting for the weekend'}</h1>
        </div>
        <p className="muted mono">{latest ? `session ${session} · race time ${clock(latest)} UTC` : race.connected ? 'connected · no events yet' : 'connecting to pit-wall…'}</p>
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
