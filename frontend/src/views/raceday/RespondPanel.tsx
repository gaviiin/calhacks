import { useMemo } from 'react';
import { useRace, type RaceData } from '../../lib/race';
import { sortTime } from '../../lib/raceModel';
import { ActButton, clock, parse, roleLabel, type Headline } from './shared';

// Stage 3, respond: what the playbook set off. Internal, reversible actions run on their own; anything
// outward-facing or irreversible waits for the person who owns it.

export function respondHeadline(race: RaceData): Headline {
  const waiting = race.actions.filter((a) => a.status === 'awaiting_approval');
  if (waiting.length) return { value: `${waiting.length} to decide`, note: waiting[0]!.title, tone: 'hold' };
  return { value: `${race.actions.length} actions`, note: race.actions.length ? 'running on their own' : 'nothing set off yet', tone: race.actions.length ? 'ok' : 'muted' };
}

export function RespondPanel() {
  const race = useRace();
  const rows = useMemo(
    () => race.actions.slice().sort((a, b) => Number(b.status === 'awaiting_approval') - Number(a.status === 'awaiting_approval') || sortTime(a.updatedAt) - sortTime(b.updatedAt)),
    [race.actions]
  );
  return (
    <ul className="actions">
      {rows.map((a) => {
        const d = parse<Record<string, unknown>>(a.detailJson, {});
        return (
          <li key={a.actionKey} className={`action action--${a.status}`}>
            <div className="action-top">
              <span className="mono muted">{a.kind.replace(/_/g, ' ')}</span>
              <b>{a.title}</b>
              <span className={`state state--${a.status === 'awaiting_approval' ? 'hold' : a.status === 'rejected' ? 'rejected' : 'approved'}`}>{a.status === 'awaiting_approval' ? `waits for ${roleLabel(a.ownerRole)}` : a.status}</span>
              {a.dueAt && <span className="mono muted">due {a.dueAt.slice(0, 10)} {clock(a.dueAt)}</span>}
            </div>
            {typeof d.why === 'string' && <p className="muted">{d.why}</p>}
            {a.status === 'awaiting_approval' && (
              <div className="decide-actions">
                <ActButton label="Approve" primary run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'approved', by, at })} />
                <ActButton label="Reject" run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'rejected', by, at })} />
              </div>
            )}
          </li>
        );
      })}
      {!rows.length && <li className="muted">No actions yet.</li>}
    </ul>
  );
}
