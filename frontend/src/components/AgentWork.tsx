import { useMemo, useState } from 'react';
import { IconAgent, IconApproved, IconDenied, IconPolicy, IconQuestion } from './icons';
import { useCostCap } from '../lib/costcap';
import { categoryName, clock, parseJson, usdShort } from '../lib/format';

// What the agents did, in words, newest first: every decision step the Cap Analyst and the Policy
// Learner recorded, read as a sentence, with the line it was about and who approved it afterwards.

interface Row {
  id: string;
  t: number;
  who: 'analyst' | 'learner' | 'standing';
  verb: string;
  text: string;
  sub: string;
  itemKey: string | null;
  outcome: 'posted' | 'approved' | 'waiting' | 'rejected' | 'asked' | null;
}

const WHO: Record<Row['who'], string> = { analyst: 'Cap Analyst', learner: 'Policy Learner', standing: 'Standing approvals' };

export function useAgentWork(limit = 40): Row[] {
  const cc = useCostCap();
  return useMemo(() => {
    const out: Row[] = [];
    for (const steps of cc.decisionsByItem.values()) {
      for (const s of steps) {
        const input = parseJson<Record<string, unknown>>(s.input, {});
        const item = s.workItemId !== undefined ? cc.itemById.get(s.workItemId) : undefined;
        const gl = item ? cc.glLines.get(item.subjectRef) : undefined;
        const who: Row['who'] = s.actorRole === 'ai_policy_learner' ? 'learner' : s.actorRole === 'auto_approver' ? 'standing' : 'analyst';
        const action = String(input.action ?? s.name.split(':')[0] ?? 'decided');
        let verb = action.replace(/_/g, ' ');
        let text = '';
        if (s.name.startsWith('propose:policy')) {
          verb = 'drafted a policy';
          text = `${String(input.policy_key ?? '')} → ${categoryName(String(input.category_2026 ?? input.category_code ?? ''))}: ${String(input.why ?? '')}`;
        } else if (action === 'ask') {
          verb = 'asked a person';
          text = String(input.question ?? input.why ?? item?.question ?? '');
        } else if (who === 'standing' || s.name.startsWith('standing')) {
          verb = 'approved under';
          text = `${String(input.policy_key ?? input.policy ?? '')}${input.approved_by ? `, a rule ${String(input.approved_by)} approved` : ''}${input.why ? `: ${String(input.why)}` : ''}`.replace(/^: /, '') || s.name;
        } else if (action === 'propose') {
          verb = 'proposed';
          text = `${categoryName(String(input.category_code ?? item?.proposedCategoryCode ?? ''))}${input.policy_key ? ` under ${String(input.policy_key)}` : ''}${input.why ? `: ${String(input.why)}` : ''}`;
        } else {
          text = String(input.why ?? input.reason ?? s.outputExcerpt ?? '').slice(0, 200);
        }
        const outcome: Row['outcome'] = !item ? null : item.state === 'POSTED' ? 'posted' : item.state === 'APPROVED' ? 'approved' : item.state === 'REJECTED' ? 'rejected' : item.state === 'NEEDS_INFO' ? 'asked' : item.state === 'PROPOSED' ? 'waiting' : null;
        out.push({
          id: String(s.id),
          t: s.at.toDate().getTime(),
          who,
          verb,
          text: text || s.name,
          sub: item ? `${gl?.memo ?? item.subjectRef} · ${usdShort(item.amountUsdMinor)}` : s.runId,
          itemKey: item ? `item:${item.id}` : null,
          outcome,
        });
      }
    }
    return out.sort((a, b) => b.t - a.t).slice(0, limit);
  }, [cc, limit]);
}

export function AgentWork({ limit = 12, select }: { limit?: number; select?: (key: string) => void }) {
  const rows = useAgentWork(limit * 3);
  const [who, setWho] = useState<'all' | Row['who']>('all');
  const shown = rows.filter((r) => who === 'all' || r.who === who).slice(0, limit);
  if (!rows.length) return null;
  return (
    <section className="agentwork" aria-labelledby="aw-h">
      <div className="sec-head">
        <h2 id="aw-h">What the agents did</h2>
        <div className="filters" role="tablist" aria-label="Agent">
          {(['all', 'analyst', 'learner', 'standing'] as const).map((k) => (
            <button key={k} role="tab" aria-selected={who === k} className={who === k ? 'filter filter--on' : 'filter'} onClick={() => setWho(k)}>
              {k === 'all' ? 'Everything' : WHO[k]} <span className="mono">{k === 'all' ? rows.length : rows.filter((r) => r.who === k).length}</span>
            </button>
          ))}
        </div>
        <p className="muted">Every decision the agents and the standing-approval job recorded, newest first, with what happened to it afterwards. Agents propose; the outcome is a person's or a rule's.</p>
      </div>
      <ol className="work-feed">
        {shown.map((r) => (
          <li key={r.id} className={`work-row${r.itemKey && select ? ' work-row--link' : ''}`} onClick={() => r.itemKey && select?.(r.itemKey)}>
            <span className="work-time mono">{clock(new Date(r.t))}</span>
            <span className={`work-who work-who--${r.who}`}>
              {r.who === 'learner' ? <IconPolicy size={13} /> : r.who === 'standing' ? <IconApproved size={13} /> : r.verb === 'asked a person' ? <IconQuestion size={13} /> : <IconAgent size={13} />}
              {WHO[r.who]}
            </span>
            <span className="work-text">
              <b>{r.verb}</b> {r.text}
              <span className="work-sub muted">{r.sub}</span>
            </span>
            <span className={`work-outcome work-outcome--${r.outcome ?? 'none'}`}>
              {r.outcome === 'posted' || r.outcome === 'approved' ? <IconApproved size={12} /> : r.outcome === 'rejected' ? <IconDenied size={12} /> : null}
              {r.outcome === 'posted' ? 'posted' : r.outcome === 'approved' ? 'approved' : r.outcome === 'rejected' ? 'rejected' : r.outcome === 'waiting' ? 'waiting for a person' : r.outcome === 'asked' ? 'open question' : ''}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
