import { useMemo, useState } from 'react';
import { ActivityLanes, type Lane, type LaneEvent, type Marker } from '../components/ActivityLanes';
import { IconApproved, IconDenied } from '../components/icons';
import { DRIVERS } from '../lib/raceModel';
import { useRace, type RaceData } from '../lib/race';
import { clock } from './raceday/shared';

// pit-wall's audit log on the race clock. Every row is placed at the race time of what it acted on:
// the crash an incident key names, the question, the entry, the effect, the plan, the action. The
// rows themselves keep the wall-clock time pit-wall wrote them, shown beside it in the table; a replay
// writes a whole weekend in minutes, so the wall clock alone says nothing about when in the race a
// decision fell. Set-up rows (seats, rules, the replay switch) have no race time and stay in the
// table only.

type Row = RaceData['audit'][number];

const LANES: Lane[] = [
  { key: 'desk', label: 'Desk agents', kind: 'agent', note: 'estimates, entries, postings' },
  { key: 'person', label: 'People', kind: 'person', note: 'calls made from a seat' },
  { key: 'replayed', label: 'Recorded decisions', kind: 'person', note: "the weekend's own calls" },
  { key: 'timer', label: 'pit-wall timer', kind: 'system', note: 'a deadline passed' },
];

const SETUP = new Set(['grant_seat', 'set_rules', 'set_replay_decisions', 'set_policy_autonomy']);
const DECISION = /^(answer_question|choose_option|approve_close|confirm_effect|correct_effect|plan_edited|action_|plan_(?!edit_)|posting_)/;
const INCIDENT = /^\d+-\d+-\d+-\d+/;

export function laneOf(a: Row): string | null {
  if (SETUP.has(a.action)) return null;
  if (a.role === 'scheduler') return 'timer';
  if (!DECISION.test(a.action)) return 'desk';
  return a.name === 'publisher' ? 'replayed' : 'person';
}

/** The race time an audit row belongs to, or null when it has none. */
export function useRaceTime(): (a: Row) => number | null {
  const race = useRace();
  return useMemo(() => {
    const ts = race.incidents.map((i) => Date.parse(i.firstSeenAt)).filter((t) => !Number.isNaN(t));
    for (const e of race.events) {
      const t = Date.parse(e.at);
      if (!Number.isNaN(t)) ts.push(t);
    }
    // the weekend's window: a time outside it is a wall-clock stamp, not a race time
    const lo = ts.length ? Math.min(...ts) - 2 * 86_400_000 : -Infinity;
    const hi = ts.length ? Math.max(...ts) + 2 * 86_400_000 : Infinity;
    const ok = (iso: string | undefined) => {
      const t = iso ? Date.parse(iso) : NaN;
      return !Number.isNaN(t) && t >= lo && t <= hi ? t : null;
    };
    const entries = new Map(race.entries.map((e) => [e.entryKey, e.at]));
    const effects = new Map(race.effects.map((e) => [e.effectKey, e.at]));
    const questions = new Map(race.questions.map((q) => [q.questionKey, q]));
    const actions = new Map(race.actions.map((a) => [a.actionKey, a.updatedAt]));
    const plans = new Map(race.plans.map((p) => [p.planKey, p]));
    const edits = new Map<string, string[]>();
    for (const e of race.planEdits) edits.set(e.planKey, [...(edits.get(e.planKey) ?? []), e.appliedAt || e.at]);
    const closes = new Map(race.closes.map((c) => [c.closeKey, c.closedAt]));
    const incidents = new Map(race.incidents.map((i) => [i.incidentKey, i.firstSeenAt]));

    return (a: Row) => {
      if (SETUP.has(a.action)) return null;
      const k = a.targetKey;
      const q = questions.get(k);
      if (q) return (a.action.startsWith('question_') ? ok(q.deadlineAt) : null) ?? ok(q.createdAt);
      const p = plans.get(k);
      if (p) {
        const t = a.action.startsWith('plan_edit') ? (edits.get(k) ?? []).map(ok).find((x) => x !== null) : null;
        return t ?? (/^plan_(approved|rejected|revising)$/.test(a.action) ? ok(p.approvedAt) : null) ?? ok(p.updatedAt) ?? ok(incidents.get(p.incidentKey));
      }
      const t = ok(entries.get(k)) ?? ok(effects.get(k)) ?? ok(actions.get(k)) ?? ok(closes.get(k));
      if (t !== null) return t;
      const m = INCIDENT.exec(k);
      return m ? ok(incidents.get(m[0])) : null;
    };
  }, [race.incidents, race.events, race.entries, race.effects, race.questions, race.actions, race.plans, race.planEdits, race.closes]);
}

const hhmm = (t: number | null) => (t === null ? '—' : new Date(t).toISOString().slice(11, 19));

export function RaceAuditView() {
  const race = useRace();
  const raceTime = useRaceTime();
  const [win, setWin] = useState<[number, number] | null>(null);
  const [only, setOnly] = useState<'all' | 'refused'>('all');

  const placed = useMemo(() => race.audit.map((a) => ({ a, t: raceTime(a), lane: laneOf(a) })), [race.audit, raceTime]);
  const events = useMemo<LaneEvent[]>(
    () => placed.flatMap(({ a, t, lane }) => (t === null || lane === null ? [] : [{ t, lane, allowed: a.allowed, action: a.action }])),
    [placed]
  );
  const markers = useMemo<Marker[]>(() => {
    const out: Marker[] = race.incidents.map((i) => ({
      t: Date.parse(i.firstSeenAt),
      label: `${DRIVERS[i.driverNumber] ?? i.driverNumber} · ${i.sessionKey === 9627 ? 'quali' : 'race'}`,
    }));
    for (const c of race.closes) out.push({ t: Date.parse(c.closedAt), label: 'sealed' });
    return out.filter((m) => !Number.isNaN(m.t));
  }, [race.incidents, race.closes]);

  const wall = useMemo(() => {
    const ts = race.audit.map((a) => Date.parse(a.at)).filter((t) => !Number.isNaN(t));
    return ts.length ? Math.max(...ts) - Math.min(...ts) : 0;
  }, [race.audit]);
  const refused = race.audit.filter((a) => !a.allowed).length;
  const rows = useMemo(
    () =>
      placed
        .filter(({ a, t }) => (only === 'all' || !a.allowed) && (!win || (t !== null && t >= win[0] && t < win[1])))
        .sort((x, y) => (y.t ?? -Infinity) - (x.t ?? -Infinity) || Number(y.a.auditId - x.a.auditId)),
    [placed, only, win]
  );

  return (
    <div className="audit audit--race">
      <ActivityLanes
        id="race-spine"
        title="Race weekend, on the race clock"
        blurb={
          <>
            One lane per actor. Each row sits at the race time of what it acted on: the crash, its question, the entry, the plan. pit-wall wrote these{' '}
            {wall < 3_600_000 ? `within ${Math.max(1, Math.round(wall / 60_000))} minutes` : 'over a longer stretch'} of wall clock, which the Written column keeps.
          </>
        }
        lanes={LANES}
        events={events}
        unit="minute"
        markers={markers}
        undated={placed.length - events.length}
        undatedWord="set-up row"
        empty="Nothing on pit-wall yet. Press Lap 32 in the bar and the desk's lanes fill in as it works the weekend."
        onWindow={(a, b) => setWin([a, b])}
      />
      <section aria-labelledby="race-audit-h">
        <div className="sec-head">
          <h1 id="race-audit-h">pit-wall audit log</h1>
          <p className="muted">
            {race.audit.length.toLocaleString()} rows, each written in the same transaction as the change it records. {refused} were refused and kept.
          </p>
        </div>
        <div className="filters">
          <button className={only === 'refused' ? 'filter filter--on' : 'filter'} onClick={() => setOnly('refused')}>
            Refused <span className="mono">{refused}</span>
          </button>
          <button className={only === 'all' ? 'filter filter--on' : 'filter'} onClick={() => setOnly('all')}>
            Everything <span className="mono">{race.audit.length}</span>
          </button>
          {win && (
            <button className="filter filter--on" onClick={() => setWin(null)}>
              {hhmm(win[0]).slice(0, 5)} – {hhmm(win[1]).slice(0, 5)} UTC <IconDenied size={11} title="clear the time window" />
            </button>
          )}
        </div>
        <div className="table-wrap">
          <table className="data audit-table">
            <thead>
              <tr>
                <th>Race time</th>
                <th>Written</th>
                <th>Who</th>
                <th>Action</th>
                <th>Target</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map(({ a, t }) => (
                <tr key={String(a.auditId)} className={a.allowed ? undefined : 'row--denied'}>
                  <td className="mono">{hhmm(t)}</td>
                  <td className="mono muted">{clock(a.at)}</td>
                  <td>{a.name === 'publisher' ? 'desk' : a.name}</td>
                  <td className="mono">{a.action}</td>
                  <td className="mono" title={a.targetKey}>
                    {a.targetKey.length > 28 ? `${a.targetKey.slice(0, 10)}…${a.targetKey.slice(-14)}` : a.targetKey}
                  </td>
                  <td>
                    {a.allowed ? (
                      <span className="outcome-cell">
                        <IconApproved size={12} /> {a.reason || 'done'}
                      </span>
                    ) : (
                      <span className="outcome-cell outcome-cell--refused" title={a.reason}>
                        <IconDenied size={12} /> {a.reason}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 300 && <p className="muted">Showing 300 of {rows.length.toLocaleString()}.</p>}
        </div>
      </section>
    </div>
  );
}
