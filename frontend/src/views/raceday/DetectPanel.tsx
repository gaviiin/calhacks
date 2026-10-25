import { useMemo } from 'react';
import { useRace, type RaceData } from '../../lib/race';
import { carLabel, eventDetail, isTeamCar, sortTime } from '../../lib/raceModel';
import { clock, parse, type Headline } from './shared';

// Stage 1, detect: the telemetry tripwire against everything slower (a red flag, race control, laps stopping).

interface Lead {
  car: number;
  at: string;
  summary: string;
  redFlag: string | null;
  raceControl: string | null;
}

export function leads(race: Pick<RaceData, 'events'>): Lead[] {
  const evs = race.events.slice().sort((a, b) => sortTime(a.at) - sortTime(b.at));
  return evs
    .filter((e) => e.kind === 'car_stopped' && isTeamCar(e.driverNumber))
    .map((s) => {
      const t = sortTime(s.at);
      const red = evs.find((e) => e.kind === 'red_flag' && e.sessionKey === s.sessionKey && sortTime(e.at) >= t && sortTime(e.at) - t < 300_000);
      const rc = evs.find((e) => e.kind === 'incident' && e.driverNumber === s.driverNumber && e.sessionKey === s.sessionKey && sortTime(e.at) >= t);
      return { car: s.driverNumber, at: s.at, summary: String(parse<Record<string, unknown>>(s.payloadJson, {}).summary ?? ''), redFlag: red?.at ?? null, raceControl: rc?.at ?? null };
    });
}

const secs = (a: string, b: string) => Math.round((sortTime(b) - sortTime(a)) / 1000);

export function detectHeadline(race: RaceData): Headline {
  const l = leads(race);
  if (!l.length) return { value: '—', note: 'watching cars by telemetry', tone: 'muted' };
  const last = l[l.length - 1]!;
  const ahead = last.redFlag ? `${secs(last.at, last.redFlag)} s before the red flag` : 'race control silent';
  return { value: `${l.length} stop${l.length > 1 ? 's' : ''}`, note: `${carLabel(last.car)} · ${ahead}`, tone: 'alert' };
}

export function DetectPanel() {
  const race = useRace();
  const l = useMemo(() => leads(race), [race]);
  const tape = useMemo(
    () => race.events.filter((e) => isTeamCar(e.driverNumber) && ['car_stopped', 'incident', 'retirement_suspected', 'retirement_confirmed', 'pit_stop', 'penalty'].includes(e.kind)).sort((a, b) => sortTime(b.at) - sortTime(a.at)).slice(0, 12),
    [race.events]
  );
  return (
    <div className="stage-grid">
      <ul className="leads">
        {l.map((x) => (
          <li key={x.at + x.car}>
            <b className="mono">{carLabel(x.car)}</b> <span className="mono">{clock(x.at)}</span> <span>{x.summary}</span>
            <span className="muted">
              {x.redFlag ? ` · red flag +${secs(x.at, x.redFlag)} s` : ''}
              {x.raceControl ? ` · race control +${secs(x.at, x.raceControl)} s` : ' · race control never names the car'}
            </span>
          </li>
        ))}
        {!l.length && <li className="muted">No stops yet. The tripwire reads car telemetry at about 4 Hz.</li>}
      </ul>
      <ol className="mini-tape">
        {tape.map((e) => (
          <li key={e.eventKey}>
            <span className="mono muted">{clock(e.at)}</span> <span className="mono">{carLabel(e.driverNumber)}</span> <span>{e.kind.replace(/_/g, ' ')}</span>{' '}
            <span className="muted">{eventDetail(e)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
