import { useMemo } from 'react';
import { useRace, type RaceData } from '../../lib/race';
import { carLabel, damageLabel, sortTime } from '../../lib/raceModel';
import type { RaceBeliefs, RaceIncidents } from '../../module_bindings/types';
import { clock, parse, type Headline } from './shared';
import './detect.css';

// Stage 2, log: one incident per crash, its belief versioned as evidence arrives. The card says what we believe
// now; the history under it says what we believed when, and what changed our mind.

const STEPS = ['suspected', 'corroborated', 'confirmed', 'assessed', 'closed'] as const;
const STATE_CLASS: Record<string, string> = { suspected: 'state--proposed', corroborated: 'state--hold', confirmed: 'state--rejected', assessed: 'state--approved', closed: '' };
const SESSION_LABEL: Record<string, string> = { Qualifying: 'qualifying', Race: 'race', Sprint: 'sprint', Practice: 'practice' };

interface Belief {
  severity?: Record<string, number>;
  parts?: Record<string, number>;
  impact_kph?: number;
  signature?: string;
  where?: string;
  turn?: string;
  session_type?: string;
  out_of_session?: boolean;
  dns?: boolean;
  laps_after?: number;
  corroborated_after_s?: number;
}

const topSeverity = (b: Belief): [string, number] | null => {
  const s = b.severity;
  if (!s) return null;
  const top = Object.entries(s).sort((a, z) => z[1] - a[1])[0];
  return top ?? null;
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** What one version added to the belief, against the version before it: the chips under its cause. */
function changes(prev: Belief | null, cur: Belief): string[] {
  const out: string[] = [];
  const a = prev ? topSeverity(prev) : null;
  const b = topSeverity(cur);
  if (b && (!a || a[0] !== b[0] || Math.abs(a[1] - b[1]) >= 0.05)) out.push(`severity ${b[0]} ${pct(b[1])}`);
  if (cur.impact_kph != null && prev?.impact_kph == null) out.push(`${cur.impact_kph} km/h`);
  if (cur.turn && cur.turn !== prev?.turn) out.push(cur.turn);
  if (cur.out_of_session && !prev?.out_of_session) out.push('out of the session');
  if (cur.dns && !prev?.dns) out.push('did not start');
  if (cur.laps_after && !prev?.laps_after) out.push(`ran ${cur.laps_after} more laps`);
  return out;
}

function history(inc: RaceIncidents, beliefs: readonly RaceBeliefs[]): { version: number; at: string; status: string; cause: string; chips: string[] }[] {
  const rows = beliefs.filter((v) => v.incidentKey === inc.incidentKey).sort((a, z) => a.version - z.version);
  if (!rows.length) return [{ version: inc.version, at: inc.updatedAt, status: inc.status, cause: inc.cause, chips: [] }];
  let prev: Belief | null = null;
  return rows.map((v) => {
    const b = parse<Belief>(v.beliefJson, {});
    const chips = changes(prev, b);
    prev = b;
    return { version: v.version, at: v.at, status: v.status, cause: v.cause, chips };
  });
}

export function logHeadline(race: RaceData): Headline {
  const n = race.incidents.length;
  if (!n) return { value: '0', note: 'no incidents', tone: 'muted' };
  const open = race.incidents.filter((i) => i.status !== 'assessed' && i.status !== 'closed').length;
  const confirmed = race.incidents.filter((i) => i.status === 'confirmed').length;
  const note = open ? `${confirmed ? `${confirmed} confirmed · ` : ''}${open} not yet assessed by a person` : 'all assessed';
  return { value: `${n} incident${n > 1 ? 's' : ''}`, note, tone: open ? 'hold' : 'ok' };
}

export function LogPanel() {
  const race = useRace();
  const rows = useMemo(() => race.incidents.slice().sort((a, b) => sortTime(a.firstSeenAt) - sortTime(b.firstSeenAt)), [race.incidents]);
  return (
    <ul className="incidents">
      {rows.map((i) => {
        const b = parse<Belief>(i.beliefJson, {});
        const top = topSeverity(b);
        const parts = b.parts ? damageLabel(b.parts, 0.5, 3) : null;
        const reached = STEPS.indexOf(i.status as (typeof STEPS)[number]);
        const versions = history(i, race.beliefs);
        const session = b.session_type ? SESSION_LABEL[b.session_type] ?? b.session_type.toLowerCase() : `session ${i.sessionKey}`;
        return (
          <li key={i.incidentKey} className={`incident incident--${i.status}`}>
            <div className="incident-top">
              <b className="mono">{carLabel(i.driverNumber)}</b>
              <span className={`state incident-chip ${STATE_CLASS[i.status] ?? ''}`}>{i.status}</span>
              <span className="muted">
                {session} · first seen <span className="mono">{clock(i.firstSeenAt)}</span>
                {b.where ? ` · ${b.where}` : ''}
              </span>
              <span className="mono muted incident-key">
                {i.incidentKey} v{i.version}
              </span>
            </div>
            <dl className="incident-facts">
              <div>
                <dt>Impact</dt>
                <dd className="mono">{b.impact_kph != null ? `${b.impact_kph} km/h` : '—'}</dd>
              </div>
              <div>
                <dt>Severity</dt>
                <dd className="mono">{top ? `${top[0]} ${pct(top[1])}` : '—'}</dd>
              </div>
              <div>
                <dt>Likely hit</dt>
                <dd>{parts ?? '—'}</dd>
              </div>
              <div>
                <dt>Session</dt>
                <dd>{b.dns ? 'did not start the race' : b.out_of_session ? 'out of the session' : b.laps_after ? `ran ${b.laps_after} more laps` : 'still in it'}</dd>
              </div>
            </dl>
            <ol className="incident-steps" aria-label={`Status: ${i.status}`}>
              {STEPS.map((s, n) => (
                <li key={s} className={n <= reached ? 'step--reached' : ''} aria-current={n === reached ? 'step' : undefined}>
                  <span aria-hidden>{n <= reached ? '●' : '○'}</span> {s}
                </li>
              ))}
            </ol>
            <p className="eyebrow beliefs-head">What we believed when</p>
            <ol className="beliefs belief-history">
              {versions.map((v) => (
                <li key={v.version}>
                  <span className="mono muted">
                    v{v.version} {clock(v.at)}
                  </span>
                  <span className={`state ${STATE_CLASS[v.status] ?? ''}`}>{v.status}</span>
                  <span>{v.cause}</span>
                  {v.chips.length > 0 && (
                    <span className="belief-chips">
                      {v.chips.map((c) => (
                        <span key={c} className="belief-chip mono">
                          {c}
                        </span>
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </li>
        );
      })}
      {!rows.length && <li className="muted">Nothing logged yet. An incident opens on the first signal and is versioned as each new one arrives.</li>}
    </ul>
  );
}
