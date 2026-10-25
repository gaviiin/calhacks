import { useMemo, useState } from 'react';
import { AgentWork } from '../components/AgentWork';
import { CapTrack } from '../components/CapTrack';
import { CapTrajectory } from '../components/CapTrajectory';
import { Decisions } from '../components/Decisions';
import { resolveEntry, type InboxItem } from '../components/inboxModel';
import type { SeatStatus } from '../components/Shell';
import { WhyPane } from '../components/Why';
import type { Policy, WorkItem } from '../cost_cap_bindings/types';
import { abs, proposedCapEffect, useCostCap } from '../lib/costcap';
import { categoryName, usdShort } from '../lib/format';

const STATES = ['NEW', 'NEEDS_INFO', 'PROPOSED', 'APPROVED', 'POSTED', 'REJECTED'] as const;
const STATE_LABEL: Record<string, string> = {
  NEW: 'New',
  NEEDS_INFO: 'Asked',
  PROPOSED: 'Proposed',
  APPROVED: 'Approved',
  POSTED: 'Posted',
  REJECTED: 'Rejected',
};

/** Where the month's money went: lines by proposed category, one series, sorted. */
function CategoryBars() {
  const cc = useCostCap();
  const rows = useMemo(() => {
    const m = new Map<string, { usd: number; lines: number; treatment: string }>();
    for (const w of cc.workItems) {
      if (w.kind !== 'classification') continue;
      if (w.proposedCategoryCode === 'ALLOCATED') {
        for (const a of cc.allocationsByItem.get(w.id) ?? []) {
          const r = m.get(a.categoryCode) ?? { usd: 0, lines: 0, treatment: cc.rulebook.get(a.rulebookEntryId)?.treatment ?? '' };
          r.usd += Number(abs(a.amountUsdMinor));
          r.lines += 1;
          m.set(a.categoryCode, r);
        }
        continue;
      }
      const code = w.proposedCategoryCode ?? 'UNCLASSIFIED';
      const r = m.get(code) ?? { usd: 0, lines: 0, treatment: code === 'UNCLASSIFIED' ? '' : cc.rulebook.get(w.proposedRulebookEntryId ?? '')?.treatment ?? '' };
      r.usd += Number(abs(w.amountUsdMinor));
      r.lines += 1;
      m.set(code, r);
    }
    return [...m.entries()].sort((a, b) => b[1].usd - a[1].usd);
  }, [cc]);
  const max = Math.max(1, ...rows.map(([, r]) => r.usd));
  const top = rows.slice(0, 14);
  const rest = rows.slice(14);
  const restUsd = rest.reduce((s, [, r]) => s + r.usd, 0);
  return (
    <section className="bars" aria-labelledby="bars-h">
      <div className="sec-head">
        <h2 id="bars-h">Where January went</h2>
        <p className="muted">Ledger lines by the category proposed for them, split invoices by bill line. A marker shows lines inside the cap.</p>
      </div>
      <table className="bartable">
        <tbody>
          {top.map(([code, r]) => (
            <tr key={code}>
              <th scope="row">
                {code === 'UNCLASSIFIED' ? 'Not yet classified' : categoryName(code)}
                {r.treatment === 'RELEVANT' && <span className="treat treat--in">inside</span>}
              </th>
              <td className="bar-cell">
                <span className="bar" style={{ width: `${(r.usd / max) * 100}%` }} />
              </td>
              <td className="num mono">{usdShort(r.usd)}</td>
              <td className="num mono muted">{r.lines}</td>
            </tr>
          ))}
          {rest.length > 0 && (
            <tr>
              <th scope="row">{rest.length} other categories</th>
              <td className="bar-cell">
                <span className="bar bar--other" style={{ width: `${(restUsd / max) * 100}%` }} />
              </td>
              <td className="num mono">{usdShort(restUsd)}</td>
              <td className="num mono muted">{rest.reduce((s, [, r]) => s + r.lines, 0)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function PolicyTree({ select }: { select: (key: string) => void }) {
  const cc = useCostCap();
  const [all, setAll] = useState(false);
  const everyRoot = cc.policies.filter((p) => p.parentPolicyId === undefined).sort((a, b) => b.precedentCount - a.precedentCount);
  const roots = all ? everyRoot : everyRoot.slice(0, 12);
  const kids = (p: Policy) => cc.policies.filter((c) => c.parentPolicyId === p.id);
  const used = useMemo(() => {
    const m = new Map<bigint, number>();
    for (const w of cc.workItems) if (w.proposedPolicyId !== undefined) m.set(w.proposedPolicyId, (m.get(w.proposedPolicyId) ?? 0) + 1);
    return m;
  }, [cc.workItems]);
  const row = (p: Policy, depth: number) => (
    <li key={String(p.id)}>
      <button className={`policy-row policy-row--${p.state.toLowerCase()}`} style={{ paddingLeft: 10 + depth * 18 }} onClick={() => select(`policy:${p.id}`)}>
        <span className={depth ? 'mono policy-key policy-key--child' : 'mono policy-key'}>{p.policyKey}</span>
        <span>{categoryName(p.categoryCode)}</span>
        <span className="mono muted">{p.precedentCount} precedents</span>
        <span className="mono muted">{used.get(p.id) ?? 0} lines this month</span>
        <span className={`state state--${p.state.toLowerCase()}`}>{p.state.toLowerCase()}</span>
      </button>
      {kids(p).length > 0 && <ul>{kids(p).map((c) => row(c, depth + 1))}</ul>}
    </li>
  );
  return (
    <section className="policies" aria-labelledby="pol-h">
      <div className="sec-head">
        <h2 id="pol-h">House policies</h2>
        <p className="muted">
          Drafted by the Policy Learner from 2025, each approved by the Head of Cost Cap. Exceptions sit under the policy they refine and win on the lines
          they match.
        </p>
      </div>
      <ul className="policy-tree">{roots.map((p) => row(p, 0))}</ul>
      {everyRoot.length > 12 && (
        <button className="btn btn--small" onClick={() => setAll((a) => !a)}>
          {all ? 'Show the 12 most used' : `Show all ${everyRoot.length} policies`}
        </button>
      )}
    </section>
  );
}

export function CostCapView({ status, inbox }: { status: SeatStatus; inbox: InboxItem[] }) {
  const cc = useCostCap();
  const [picked, setState] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of cc.workItems) m.set(w.state, (m.get(w.state) ?? 0) + 1);
    return m;
  }, [cc.workItems]);
  // open on what waits for a person, else the first state with lines
  const state = picked ?? ['PROPOSED', 'NEEDS_INFO', 'APPROVED', 'POSTED', 'NEW', 'REJECTED'].find((s) => counts.get(s)) ?? 'PROPOSED';
  const rows = cc.workItems
    .filter((w) => w.state === state)
    .slice()
    .sort((a, b) => Number(abs(b.amountUsdMinor) - abs(a.amountUsdMinor)));
  const toEntry = (key: string | null) => resolveEntry(key, inbox, cc);
  const line = (w: WorkItem) => cc.glLines.get(w.subjectRef);

  return (
    <div className="costcap">
      <CapTrack />
      <div className="two-up">
        <CapTrajectory compact />
        <Decisions />
      </div>
      <div className="split">
        <div className="split-list">
          <section aria-labelledby="queue-h">
            <div className="sec-head">
              <h2 id="queue-h">The queue</h2>
              <div className="filters" role="tablist" aria-label="State">
                {STATES.map((s) => (
                  <button key={s} role="tab" aria-selected={state === s} className={state === s ? 'filter filter--on' : 'filter'} onClick={() => setState(s)}>
                    {STATE_LABEL[s]} <span className="mono">{counts.get(s) ?? 0}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Proposed</th>
                    <th>By</th>
                    <th className="num">USD</th>
                    <th className="num">Cap effect</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 120).map((w) => {
                    const eff = proposedCapEffect(cc, w);
                    return (
                      <tr key={String(w.id)} className={selected === `item:${w.id}` ? 'row--on' : undefined} onClick={() => setSelected(`item:${w.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelected(`item:${w.id}`)}>
                        <td>
                          <span className="cell-title">{line(w)?.memo ?? w.subjectRef}</span>
                          <span className="cell-sub mono">{w.subjectRef}</span>
                        </td>
                        <td>{w.state === 'NEEDS_INFO' ? 'asked' : categoryName(w.proposedCategoryCode)}</td>
                        <td className="mono">{w.proposalSource === 'llm' ? 'Claude' : w.proposalSource === 'deterministic' ? 'policy' : w.proposalSource || '—'}</td>
                        <td className="num mono">{usdShort(w.amountUsdMinor)}</td>
                        <td className="num mono">{eff === null ? '—' : usdShort(eff)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rows.length > 120 && <p className="muted">Showing the 120 largest of {rows.length}.</p>}
              {!rows.length && <p className="muted empty">No lines are {STATE_LABEL[state].toLowerCase()}.</p>}
            </div>
          </section>
          <CategoryBars />
          <AgentWork limit={16} select={setSelected} />
          <PolicyTree select={setSelected} />
        </div>
        <WhyPane entry={toEntry(selected)} status={status} />
      </div>
    </div>
  );
}
