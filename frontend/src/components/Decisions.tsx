import { useMemo } from 'react';
import { Composition } from '../charts/Composition';
import { useCostCap } from '../lib/costcap';

// Who decided January's lines, and where each line stands. Lime is a person; steel is a rule a
// person approved; ink is Claude; the outline is what still waits.

export function useDecisionMix() {
  const cc = useCostCap();
  return useMemo(() => {
    const items = cc.workItems.filter((w) => w.kind === 'classification');
    const by = { policy: 0, claude: 0, waiting: 0 };
    const state = { posted: 0, approved: 0, proposed: 0, asked: 0, rejected: 0, fresh: 0 };
    for (const w of items) {
      if (w.proposalSource === 'deterministic') by.policy++;
      else if (w.proposalSource === 'llm') by.claude++;
      else by.waiting++;
      if (w.state === 'POSTED') state.posted++;
      else if (w.state === 'APPROVED') state.approved++;
      else if (w.state === 'PROPOSED') state.proposed++;
      else if (w.state === 'NEEDS_INFO') state.asked++;
      else if (w.state === 'REJECTED') state.rejected++;
      else state.fresh++;
    }
    const who = { standing: 0, people: 0, refused: 0 };
    for (const a of cc.audit) {
      if (!a.allowed) who.refused++;
      else if (a.action === 'approve' && a.actorRole === 'auto_approver') who.standing++;
      else if (a.actorRole.startsWith('human_') && ['approve', 'reject', 'answer', 'teach_policy', 'approve_policy'].includes(a.action)) who.people++;
    }
    return { items: items.length, by, state, who };
  }, [cc]);
}

export function Decisions() {
  const m = useDecisionMix();
  if (!m.items) return null;
  const n = (v: number) => v.toLocaleString('en-US');
  return (
    <section className="decisions" aria-labelledby="dec-h">
      <div className="sec-head">
        <h2 id="dec-h">Who decided</h2>
        <p className="muted">
          {n(m.items)} ledger lines this month. A person sees a line only when no rule they approved covers it; the rest is decided by code under a
          policy and approved by the standing-approval job.
        </p>
      </div>
      <div className="decisions-grid">
        <div>
          <h3>Proposed by</h3>
          <Composition
            format={n}
            ariaLabel="Lines proposed by code under a policy, by Claude, or not yet proposed"
            parts={[
              { key: 'policy', label: 'code, under an approved policy', value: m.by.policy, color: '--steel' },
              { key: 'claude', label: 'Claude, no policy covered it', value: m.by.claude, color: '--ink' },
              { key: 'none', label: 'not yet proposed', value: m.by.waiting, color: '--muted', outline: true },
            ]}
          />
        </div>
        <div>
          <h3>Approved by</h3>
          <Composition
            format={n}
            ariaLabel="Approvals by the standing-approval job versus people, and attempts refused"
            parts={[
              { key: 'standing', label: 'a rule a person approved', value: m.who.standing, color: '--steel' },
              { key: 'people', label: 'a person, this month', value: m.who.people, color: '--lime' },
              { key: 'refused', label: 'refused by the module', value: m.who.refused, color: '--alert' },
            ]}
          />
        </div>
        <div>
          <h3>Where the lines stand</h3>
          <Composition
            format={n}
            ariaLabel="Lines by state"
            parts={[
              { key: 'posted', label: 'posted to the ERP', value: m.state.posted, color: '--lime' },
              { key: 'approved', label: 'approved, not yet posted', value: m.state.approved, color: '--steel' },
              { key: 'proposed', label: 'waiting for a person', value: m.state.proposed, color: '--hold' },
              { key: 'asked', label: 'asked a question', value: m.state.asked, color: '--hold', outline: true },
              { key: 'rejected', label: 'rejected', value: m.state.rejected, color: '--alert' },
              { key: 'fresh', label: 'new', value: m.state.fresh, color: '--muted', outline: true },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
