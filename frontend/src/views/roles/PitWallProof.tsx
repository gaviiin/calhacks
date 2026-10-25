import { useEffect, useRef, useState } from 'react';
import { useRace } from '../../lib/race';
import { clock } from '../raceday/shared';
import './proof.css';

// pit-wall (SpacetimeDB) is the backend, and this strip shows it with its own rows: who is watching right now
// (race_online, kept by the module's connect/disconnect hooks), how long an event takes from the desk reading it to
// its commit (race_latency, measured inside the transaction) and from the commit to this screen (measured here), and
// every decision on the record (race_audit, written in the same transaction as the change or the refusal).

const ROLE: Record<string, string> = {
  race_head: 'head of racing finance', controller: 'controller', head_of_cost_cap: 'head of cost cap', cfo: 'CFO', observer: 'observer',
  race: 'race desk agent', owner: 'publisher (agents)', scheduler: 'pit-wall timer', none: 'no seat',
};
const ACTION: Record<string, string> = {
  request_posting: 'asked to post', record_posted: 'recorded a posting', record_failed: 'recorded a failed send', record_held: 'held an entry',
  posting_approved: 'approved a posting', posting_rejected: 'rejected a posting', confirm_effect: 'signed off an estimate',
  correct_effect: 'corrected an estimate', apply_answer: 'applied an answer', answer_question: 'answered a question',
  question_default: 'took a deadline default', approve_close: 'approved the weekend close', choose_option: 'chose an option',
  set_policy_autonomy: 'set a policy\'s autonomy', set_rules: 'changed the money rules', grant_seat: 'seated a person',
  action_approved: 'approved an action', action_rejected: 'rejected an action', action_done: 'marked an action done', action_cancelled: 'cancelled an action',
};

const usd = (cents: bigint) => `$${(Number(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Commit-to-screen: the wall time between the module's commit and this browser receiving the row. Only live updates
 * count: the row the page loads with was committed before the page existed. */
function useCommitToScreen(committedAt: string | undefined): number | null {
  const samples = useRef<number[]>([]);
  const first = useRef<string | undefined | null>(null);
  const [median, setMedian] = useState<number | null>(null);
  useEffect(() => {
    if (!committedAt) return;
    if (first.current === null) {
      first.current = committedAt; // the snapshot at load, not an update
      return;
    }
    if (committedAt === first.current) return;
    const ms = Date.now() - Date.parse(committedAt);
    if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return;
    samples.current = [...samples.current.slice(-19), ms];
    const sorted = [...samples.current].sort((a, b) => a - b);
    setMedian(sorted[Math.floor(sorted.length / 2)] ?? null);
  }, [committedAt]);
  return median;
}

export function PitWallProof() {
  const race = useRace();
  const [open, setOpen] = useState(false);
  const toScreen = useCommitToScreen(race.latency?.lastCommittedAt);
  if (!race.connected) return null;
  const refused = race.audit.filter((a) => !a.allowed);
  const agentRefused = refused.filter((a) => a.role === 'race' || a.role === 'owner' || a.name.startsWith('agent:'));
  const recent = [...race.audit].sort((a, b) => Number(b.auditId - a.auditId)).slice(0, open ? 12 : 4);
  const r = race.rules;
  const autoMax = r?.autoPostMaxCents ?? 25_000_000n;
  const cfo = r?.cfoCents ?? 100_000_000n;
  const lat = race.latency;
  return (
    <section className="proof" aria-label="pit-wall, live">
      <div className="proof-grid">
        <div className="proof-cell">
          <span className="proof-k">Watching now</span>
          <b className="mono proof-big">{race.online.length}</b>
          <span className="proof-sub">
            {race.online.length ? race.online.map((o) => `${o.name}${o.role !== 'observer' ? ` (${ROLE[o.role] ?? o.role})` : ''}`).join(' · ') : 'no dashboards connected'}
          </span>
        </div>
        <div className="proof-cell">
          <span className="proof-k">Event read → committed</span>
          <b className="mono proof-big">{lat ? `${lat.meanMs} ms` : '—'}</b>
          <span className="proof-sub">{lat ? `mean over ${lat.events} events · last ${lat.lastMs} ms · max ${lat.maxMs} ms` : 'no events yet'}</span>
        </div>
        <div className="proof-cell">
          <span className="proof-k">Committed → this screen</span>
          <b className="mono proof-big">{toScreen !== null ? `${toScreen} ms` : '—'}</b>
          <span className="proof-sub">{toScreen !== null ? 'median of the last 20 live updates; across devices it includes their clock offset' : 'waiting for a live update'}</span>
        </div>
        <div className="proof-cell">
          <span className="proof-k">Decisions on the record</span>
          <b className="mono proof-big">{race.audit.length}</b>
          <span className="proof-sub">
            {refused.length} refused{agentRefused.length ? `, ${agentRefused.length} of them an agent trying to act for a person` : ''}
          </span>
        </div>
        <div className="proof-cell">
          <span className="proof-k">You</span>
          <b className="proof-who">{race.mySeat ? race.mySeat.name : 'observer'}</b>
          <span className="proof-sub" title={race.identityHex ?? ''}>
            {race.mySeat ? ROLE[race.mySeat.role] ?? race.mySeat.role : `no seat · identity ${race.identityHex?.slice(0, 10) ?? '?'}…`}
          </span>
        </div>
      </div>
      <p className="proof-rules">
        Enforced in the database: the desk posts on its own only under {usd(autoMax)}; from {usd(autoMax)} the head of cost cap decides, from {usd(cfo)} the CFO;
        {r?.modelMayPostAlone ? ' estimates from Jev or the forecast agent may post alone;' : ' an estimate that is only Jev\'s or the forecast agent\'s needs a person\'s sign-off;'} agents never approve, and the
        person who signs off an estimate cannot also approve its posting. The ERP accepts a race entry only with pit-wall's authorization.
      </p>
      {recent.length ? (
        <ol className="proof-audit" aria-label="Latest decisions">
          {recent.map((a) => (
            <li key={String(a.auditId)} className={a.allowed ? '' : 'proof-refused'}>
              <span className="mono muted">{clock(a.at)}</span>
              <span>
                <b>{a.name}</b> {ACTION[a.action] ?? a.action.replace(/_/g, ' ')}
              </span>
              <span className={a.allowed ? 'proof-ok' : 'proof-no'}>{a.allowed ? 'allowed' : 'refused'}</span>
              <span className="muted proof-why">{a.reason}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {race.audit.length > 4 ? (
        <button type="button" className="proof-more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Fewer' : `More of the audit trail (${race.audit.length})`}
        </button>
      ) : null}
    </section>
  );
}
