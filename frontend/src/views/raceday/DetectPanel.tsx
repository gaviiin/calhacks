import { useMemo } from 'react';
import { useRace, type RaceData } from '../../lib/race';
import { carLabel, eventDetail, isTeamCar, kindMeta, payloadOf, sortTime } from '../../lib/raceModel';
import type { RaceEvents } from '../../module_bindings/types';
import { clock, type Headline } from './shared';
import './detect.css';

// Stage 1, detect: the telemetry tripwire against everything slower. For each stop of one of our cars, how long
// the other signals took to say the same thing: the red flag, race control naming the car, the laps stopping.

const FIELD_STOP_MS = 5 * 60_000; // a red flag, SC or VSC this soon after the stop is about it
const NAMING_MS = 30 * 60_000; // race control's lag runs to minutes (4m21s for Albon in Canada), not to the next crash

interface Signal {
  label: string;
  at: string | null; // null: never (session over) or not yet
}

interface Lead {
  key: string;
  car: number;
  sessionKey: number;
  at: string;
  summary: string;
  signals: Signal[];
  over: boolean; // the session has finished, so a missing signal is "never", not "not yet"
}

function sessionOver(evs: readonly RaceEvents[], sessionKey: number): boolean {
  return evs.some(
    (e) => e.sessionKey === sessionKey && (e.kind === 'retirement_confirmed' || e.kind === 'standings' || (e.kind === 'session_status' && /FINISH/.test(String(payloadOf(e).message ?? ''))))
  );
}

export function leads(race: Pick<RaceData, 'events'>): Lead[] {
  const evs = race.events.slice().sort((a, b) => sortTime(a.at) - sortTime(b.at));
  const first = (from: number, within: number, test: (e: RaceEvents) => boolean) => evs.find((e) => sortTime(e.at) >= from && sortTime(e.at) - from <= within && test(e))?.at ?? null;
  return evs
    .filter((e) => e.kind === 'car_stopped' && isTeamCar(e.driverNumber))
    .map((s) => {
      const t = sortTime(s.at);
      const same = (e: RaceEvents) => e.sessionKey === s.sessionKey;
      const ours = (e: RaceEvents) => same(e) && e.driverNumber === s.driverNumber;
      const field = first(t, FIELD_STOP_MS, (e) => same(e) && (e.kind === 'red_flag' || ((e.kind === 'safety_car' || e.kind === 'vsc') && payloadOf(e).deployed === true)));
      const fieldKind = field ? evs.find((e) => e.at === field && same(e) && ['red_flag', 'safety_car', 'vsc'].includes(e.kind))?.kind : 'red_flag';
      const p = payloadOf(s);
      return {
        key: s.eventKey,
        car: s.driverNumber,
        sessionKey: s.sessionKey,
        at: s.at,
        summary: String(p.summary ?? ''),
        over: sessionOver(evs, s.sessionKey),
        signals: [
          { label: fieldKind ? kindMeta(fieldKind).label : 'Red flag', at: field },
          { label: 'Race control names the car', at: first(t, NAMING_MS, (e) => ours(e) && (e.kind === 'incident' || e.kind === 'penalty')) },
          { label: 'Laps stop (retirement call)', at: first(t, 3 * 60 * 60_000, (e) => ours(e) && e.kind === 'retirement_suspected') },
        ],
      };
    });
}

/** "+9 s", "+4m21s", "+1h02m". */
export function lag(from: string, to: string): string {
  const s = Math.max(0, Math.round((sortTime(to) - sortTime(from)) / 1000));
  if (s < 90) return `+${s} s`;
  if (s < 3600) return `+${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `+${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// Lags run from seconds to most of an hour: a log scale keeps 9 s and 24 min on one bar.
const LOG_MAX = Math.log10(3600);
const barPct = (from: string, to: string) => {
  const s = Math.max(1, (sortTime(to) - sortTime(from)) / 1000);
  return Math.min(100, Math.max(3, (Math.log10(s) / LOG_MAX) * 100));
};

export function detectHeadline(race: RaceData): Headline {
  const l = leads(race);
  if (!l.length) return { value: '—', note: 'watching our cars by telemetry', tone: 'muted' };
  const last = l[l.length - 1]!;
  const [field, rc] = last.signals;
  const parts = [field?.at ? `${field.label.toLowerCase()} ${lag(last.at, field.at)}` : null, rc?.at ? `race control ${lag(last.at, rc.at)}` : last.over ? 'race control never named it' : 'race control silent'];
  return { value: `${l.length} stop${l.length > 1 ? 's' : ''}`, note: `${carLabel(last.car)} ${clock(last.at)} · telemetry first · ${parts.filter(Boolean).join(' · ')}`, tone: 'alert' };
}

const TAPE_KINDS = ['car_stopped', 'incident', 'retirement_suspected', 'retirement_confirmed', 'pit_stop', 'penalty'];
const FIELD_KINDS = ['red_flag', 'safety_car', 'vsc'];

export function DetectPanel() {
  const race = useRace();
  const l = useMemo(() => leads(race), [race]);
  const tape = useMemo(
    () =>
      race.events
        .filter((e) => (isTeamCar(e.driverNumber) && TAPE_KINDS.includes(e.kind)) || (FIELD_KINDS.includes(e.kind) && (e.kind === 'red_flag' || payloadOf(e).deployed === true)))
        .sort((a, b) => sortTime(b.at) - sortTime(a.at))
        .slice(0, 14),
    [race.events]
  );
  return (
    <div className="detect">
      <ol className="speed-story" aria-label="Each stop, and how long every other signal took">
        {l.map((x) => (
          <li key={x.key} className="speed-row">
            <div className="speed-head">
              <b className="mono">{carLabel(x.car)}</b>
              <span className="mono">{clock(x.at)}</span>
              <span className="muted mono">session {x.sessionKey}</span>
              <span>{x.summary}</span>
            </div>
            <ul className="speed-signals">
              <li className="speed-signal speed-signal--first">
                <span className="speed-label">Telemetry</span>
                <span className="speed-lag mono tone-ok">0 s · first</span>
                <span className="speed-bar" aria-hidden>
                  <span style={{ width: '3%' }} />
                </span>
              </li>
              {x.signals.map((s) => (
                <li key={s.label} className={`speed-signal ${s.at ? '' : 'speed-signal--never'}`}>
                  <span className="speed-label">{s.label}</span>
                  <span className="speed-lag mono">{s.at ? `${lag(x.at, s.at)} · ${clock(s.at)}` : x.over ? 'never' : 'not yet'}</span>
                  <span className="speed-bar" aria-hidden>
                    {s.at && <span style={{ width: `${barPct(x.at, s.at)}%` }} />}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
        {!l.length && <li className="muted">No stops yet. The tripwire reads our cars’ telemetry at about 4 Hz and fires on a hard stop from racing speed.</li>}
      </ol>
      <div className="detect-tape">
        <p className="eyebrow">Team tape</p>
        <ol className="mini-tape">
          {tape.map((e) => (
            <li key={e.eventKey} className={`tape-row ${e.kind === 'car_stopped' ? 'tape-row--stop' : ''}`}>
              <span className="mono muted">{clock(e.at)}</span>
              <span className="mono">{carLabel(e.driverNumber)}</span>
              <span className="tape-kind">{kindMeta(e.kind).label}</span>
              <span className="muted tape-detail">{e.kind === 'car_stopped' ? String(payloadOf(e).summary ?? '') : eventDetail(e)}</span>
            </li>
          ))}
          {!tape.length && <li className="muted">Nothing about our cars yet.</li>}
        </ol>
      </div>
    </div>
  );
}
