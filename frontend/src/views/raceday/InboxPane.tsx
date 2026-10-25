import type { RaceInbox } from '../../components/inboxModel';
import { usdShort } from '../../lib/format';
import { useRace } from '../../lib/race';
import { QuestionCard } from './AskPanel';
import { ActButton, parse, roleLabel } from './shared';

// The inbox's right-hand pane for a race-day item: the same card the Race day page shows, decided here or there.

export function RaceInboxPane({ item }: { item: RaceInbox }) {
  const race = useRace();
  if (item.type === 'question') {
    const q = race.questions.find((x) => x.questionKey === item.question.questionKey) ?? item.question;
    return (
      <aside className="why">
        <h2>Race day: a question</h2>
        <ul className="questions">
          <QuestionCard q={q} />
        </ul>
      </aside>
    );
  }
  if (item.type === 'action') {
    const a = race.actions.find((x) => x.actionKey === item.action.actionKey) ?? item.action;
    const d = parse<Record<string, unknown>>(a.detailJson, {});
    return (
      <aside className="why">
        <h2>Race day: {roleLabel(a.ownerRole)} decides</h2>
        <p>
          <b>{a.title}</b>
        </p>
        {typeof d.why === 'string' && <p className="muted">{d.why}</p>}
        {Array.isArray(d.options) && (
          <ul className="questions">
            {(d.options as { id: string; label: string; feasible: boolean; hours_needed: number[]; cost_cents: number[]; expected_points: number }[]).map((o) => (
              <li key={o.id} className="question">
                <b>{o.label}</b>{' '}
                <span className="muted mono">
                  {o.hours_needed[1]} h · {usdShort(o.cost_cents[1] ?? 0)} · {o.expected_points.toFixed(1)} pts · {o.feasible ? 'fits the time' : 'does not fit'}
                </span>
                {a.status === 'awaiting_approval' && (
                  <div>
                    <ActButton label={`Choose: ${o.label.toLowerCase()}`} run={(by, at) => race.chooseOption({ actionKey: a.actionKey, option: o.id, by, at })} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">{a.outward ? 'Outward-facing' : 'Internal'} · {a.reversible ? 'reversible' : 'cannot be undone'} · the desk never does this on its own authority.</p>
        {a.status === 'awaiting_approval' && !Array.isArray(d.options) ? (
          <div className="decide-actions">
            <ActButton label="Approve" primary run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'approved', by, at })} />
            <ActButton label="Reject" run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'rejected', by, at })} />
          </div>
        ) : a.status !== 'awaiting_approval' ? (
          <p>Decided: {typeof d.chosen === 'string' ? `chose ${d.chosen.replace('_', ' ')}` : a.status} ({a.decidedBy}).</p>
        ) : null}
        <p className="muted">
          Full context on <a href="#/">Race day</a>, stage 3.
        </p>
      </aside>
    );
  }
  if (item.type === 'effect') {
    const e = race.effects.find((x) => x.effectKey === item.effect.effectKey) ?? item.effect;
    return (
      <aside className="why">
        <h2>Race day: Jev was unsure</h2>
        <p>
          <b>{e.memo}</b> <span className="mono">{usdShort(e.midCents)}</span>
        </p>
        <p className="muted">{e.why}</p>
        {e.status === 'needs_person' ? (
          <ActButton label="Confirm the band" primary run={(by, at) => race.confirm({ effectKey: e.effectKey, reason: 'Confirmed as booked by a person', by, at })} />
        ) : (
          <p>Now {e.status}.</p>
        )}
        <p className="muted">
          To change the band, use Correct on the line at <a href="#/race">#/race</a>.
        </p>
      </aside>
    );
  }
  const c = race.closes.find((x) => x.closeKey === item.close.closeKey) ?? item.close;
  return (
    <aside className="why">
      <h2>Race day: the sealed weekend</h2>
      <p className="mono small">root {c.rootHash}</p>
      {c.status === 'draft' ? (
        <ActButton label="Approve and send the briefs" primary run={(by, at) => race.approveClose({ closeKey: c.closeKey, by, at })} />
      ) : (
        <p>Status: {c.status}.</p>
      )}
      <p className="muted">
        Read the briefs on <a href="#/">Race day</a>, stage 7.
      </p>
    </aside>
  );
}
