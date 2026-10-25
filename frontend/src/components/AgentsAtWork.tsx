import { useMemo } from 'react';
import { IconAgent, IconApproved, IconDoc, IconPolicy, IconShield } from './icons';
import { useCostCap } from '../lib/costcap';
import { useEvidence } from '../lib/evidence';
import { clock, plural } from '../lib/format';
import { useSim } from '../lib/sim';

// Each actor on the desk, in words: what it is for, what it did, and whether it is working now.

interface Actor {
  role: string;
  name: string;
  job: string;
  kind: 'agent' | 'rule' | 'system' | 'person';
  /** the Makefile target that runs it */
  target?: string;
}

const ACTORS: Actor[] = [
  { role: 'ai_cap_analyst', name: 'Cap Analyst', job: 'Reads every ledger line and proposes its cost cap category under a house policy. Asks a person when no policy covers it.', kind: 'agent', target: 'analyst' },
  { role: 'ai_policy_learner', name: 'Policy Learner', job: 'Drafts house policies from last year’s books and from each decision a person makes, for the Head of Cost Cap to approve.', kind: 'agent', target: 'learner' },
  { role: 'auto_approver', name: 'Standing approvals', job: 'Approves what an approved rule decided, at any amount. Never a line a person has not ruled on before.', kind: 'rule', target: 'standing' },
  { role: 'gateway', name: 'ERP gateway', job: 'The only thing that posts. Takes approved lines to the ledger.', kind: 'system', target: 'gateway' },
  { role: 'red_team', name: 'Red team', job: 'Tries every forbidden action on purpose; each must be refused and logged.', kind: 'system', target: 'redteam' },
  { role: 'fia', name: 'FIA feed', job: 'Captures stewards’ decisions and classifications from fia.com as they are published.', kind: 'system', target: 'evidence-replay' },
];

const VERB: Record<string, string> = {
  propose: 'proposed',
  ask: 'asked',
  approve: 'approved',
  reject: 'rejected',
  post: 'posted',
  propose_policy: 'drafted policies',
  approve_policy: 'approved policies',
  teach_policy: 'taught rules',
  answer: 'answered',
  record_step: 'recorded steps',
  upsert_gl_line: 'synced lines',
};

export function AgentsAtWork() {
  const cc = useCostCap();
  const ev = useEvidence();
  const sim = useSim();
  const rows = useMemo(() => {
    const by = new Map<string, { acts: Map<string, number>; denied: number; last: number }>();
    for (const a of cc.audit) {
      const r = by.get(a.actorRole) ?? { acts: new Map(), denied: 0, last: 0 };
      if (a.allowed) r.acts.set(a.action, (r.acts.get(a.action) ?? 0) + 1);
      else r.denied++;
      r.last = Math.max(r.last, a.at.toDate().getTime());
      by.set(a.actorRole, r);
    }
    return by;
  }, [cc.audit]);
  const fiaLast = ev.documents.reduce((m, d) => Math.max(m, Date.parse(d.ingestedAt) || 0), 0);

  return (
    <section className="actors" aria-labelledby="actors-h">
      <div className="sec-head">
        <h2 id="actors-h">What the agents are doing</h2>
        <p className="muted">Agents propose, rules a person approved decide the routine, people decide the rest, and only the gateway posts.</p>
      </div>
      <ul className="actor-list">
        {ACTORS.map((a) => {
          const r = rows.get(a.role);
          const running = a.target ? sim.running.some((j) => j.target === a.target || j.target === 'cost-cap-run') : false;
          const acts = r ? [...r.acts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3) : [];
          const last = a.role === 'fia' ? fiaLast : r?.last ?? 0;
          const did =
            a.role === 'fia'
              ? ev.documents.length
                ? `${plural(ev.documents.length, 'document')} on file`
                : 'nothing captured yet'
              : acts.length
                ? acts.map(([k, n]) => `${VERB[k] ?? k.replace(/_/g, ' ')} ${n.toLocaleString()}`).join(' · ')
                : 'nothing yet';
          return (
            <li key={a.role} className={`actor actor--${a.kind}${running ? ' actor--running' : ''}`}>
              <span className="actor-icon">
                {a.kind === 'agent' ? <IconAgent size={15} /> : a.kind === 'rule' ? <IconApproved size={15} /> : a.role === 'red_team' ? <IconShield size={15} /> : a.role === 'fia' ? <IconDoc size={15} /> : <IconPolicy size={15} />}
              </span>
              <span className="actor-name">{a.name}</span>
              <span className={`actor-state${running ? ' actor-state--on' : ''}`}>{running ? 'working now' : last ? `idle since ${clock(new Date(last))}` : 'has not run'}</span>
              <span className="actor-job muted">{a.job}</span>
              <span className="actor-did">
                {did}
                {r?.denied ? <span className="tone-alert"> · {r.denied} refused</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
