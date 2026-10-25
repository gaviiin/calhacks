import { useMemo } from 'react';
import { useRace, type RaceData } from '../../lib/race';
import { carLabel, sortTime } from '../../lib/raceModel';
import { clock, parse, type Headline } from './shared';

// Stage 2, log: one incident per crash, its belief versioned as evidence arrives (what we believed when).

const STATUS_TONE: Record<string, string> = { suspected: 'hold', corroborated: 'hold', confirmed: 'alert', assessed: 'ok', closed: 'muted' };

export function logHeadline(race: RaceData): Headline {
  const n = race.incidents.length;
  if (!n) return { value: '0', note: 'no incidents', tone: 'muted' };
  const open = race.incidents.filter((i) => i.status !== 'assessed' && i.status !== 'closed').length;
  return { value: `${n} incident${n > 1 ? 's' : ''}`, note: open ? `${open} not yet assessed by a person` : 'all assessed', tone: open ? 'hold' : 'ok' };
}

export function LogPanel() {
  const race = useRace();
  const rows = useMemo(() => race.incidents.slice().sort((a, b) => sortTime(a.firstSeenAt) - sortTime(b.firstSeenAt)), [race.incidents]);
  return (
    <ul className="incidents">
      {rows.map((i) => {
        const b = parse<Record<string, unknown>>(i.beliefJson, {});
        const versions = race.beliefs.filter((v) => v.incidentKey === i.incidentKey).sort((a, z) => a.version - z.version);
        const sev = b.severity as Record<string, number> | undefined;
        const top = sev ? Object.entries(sev).sort((a, z) => z[1] - a[1])[0] : undefined;
        return (
          <li key={i.incidentKey} className="incident">
            <div className="incident-top">
              <b className="mono">{carLabel(i.driverNumber)}</b>
              <span className={`state state--${STATUS_TONE[i.status] === 'ok' ? 'approved' : STATUS_TONE[i.status] === 'alert' ? 'rejected' : 'proposed'}`}>{i.status}</span>
              <span className="mono muted">first seen {clock(i.firstSeenAt)}</span>
              {top && (
                <span className="mono">
                  {top[0]} {Math.round(top[1] * 100)}%
                </span>
              )}
              {b.impact_kph != null && <span className="mono muted">{String(b.impact_kph)} km/h</span>}
            </div>
            <ol className="beliefs">
              {versions.map((v) => (
                <li key={v.beliefKey}>
                  <span className="mono muted">v{v.version} {clock(v.at)}</span> <span>{v.cause}</span>
                </li>
              ))}
            </ol>
          </li>
        );
      })}
      {!rows.length && <li className="muted">Nothing logged yet.</li>}
    </ul>
  );
}
