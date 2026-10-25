import { useMemo } from 'react';
import type { CostCapData } from '../lib/costcap';
import { useCostCap } from '../lib/costcap';
import { ActivityLanes, type Lane, type LaneEvent } from './ActivityLanes';

// The books on the ledger's clock. Every audit row is placed on the posted date of the line it acted
// on (a work item's GL line, a synced bill line's GL line), a policy on the date it takes effect and
// a period lock on the period's last day, so the activity sits where the month's spend does. People's
// decisions are lime, everything agents and systems did is steel, and an attempt the module refused is
// a coral mark on the lane that tried it. The audit view is this chart's table.

const LANES: Lane[] = [
  { key: 'sync', label: 'Sync job', kind: 'system', note: 'systems of record → work' },
  { key: 'ai_policy_learner', label: 'Policy Learner', kind: 'agent', note: 'Claude · drafts policies' },
  { key: 'ai_cap_analyst', label: 'Cap Analyst', kind: 'agent', note: 'Claude · proposes, asks' },
  { key: 'auto_approver', label: 'Standing approvals', kind: 'system', note: 'what a rule decided' },
  { key: 'human_head_of_cost_cap', label: 'Head of Cost Cap', kind: 'person', note: 'new scenarios, policies' },
  { key: 'human_controller', label: 'Controller', kind: 'person', note: 'below materiality' },
  { key: 'gateway', label: 'ERP gateway', kind: 'system', note: 'the only poster' },
  { key: 'red_team', label: 'Red team', kind: 'system', note: 'forbidden calls on purpose' },
];

type Row = CostCapData['audit'][number];

/** The ledger date an audit row belongs to, or null for set-up rows (roles, settings, the rulebook, vendors). */
export function useLedgerTime(): (a: Row) => number | null {
  const cc = useCostCap();
  return useMemo(() => {
    const billGl = new Map<string, string>();
    for (const [gl, bills] of cc.billLinesByGl) for (const b of bills) billGl.set(b.id, gl);
    const policyFrom = new Map(cc.policies.map((p) => [p.policyKey, p.effectiveFrom]));
    const glDate = (id: string | undefined) => {
      const d = id ? cc.glLines.get(id)?.postedDate : undefined;
      const t = d ? Date.parse(`${d.slice(0, 10)}T00:00:00Z`) : NaN;
      return Number.isNaN(t) ? null : t;
    };
    return (a: Row) => {
      switch (a.resourceKind) {
        case 'work_item': {
          const id = /^\d+$/.test(a.subjectId) ? BigInt(a.subjectId) : null;
          const ref = id === null ? undefined : cc.itemById.get(id)?.subjectRef;
          return glDate(ref) ?? glDate(ref && billGl.get(ref));
        }
        case 'gl_line':
          return glDate(a.subjectId);
        case 'bill_line':
          return glDate(billGl.get(a.subjectId));
        case 'policy': {
          const d = policyFrom.get(a.subjectId);
          const t = d ? Date.parse(`${d.slice(0, 10)}T00:00:00Z`) : NaN;
          return Number.isNaN(t) ? null : t;
        }
        case 'period': {
          const m = /^(\d{4})-(\d{2})$/.exec(a.subjectId);
          return m ? Date.UTC(Number(m[1]), Number(m[2]), 0) : null;
        }
        default:
          return null;
      }
    };
  }, [cc.billLinesByGl, cc.policies, cc.glLines, cc.itemById]);
}

export function Spine({ onWindow }: { onWindow?: (from: number, to: number) => void }) {
  const cc = useCostCap();
  const ledgerTime = useLedgerTime();
  const { events, undated } = useMemo(() => {
    const events: LaneEvent[] = [];
    let undated = 0;
    for (const a of cc.audit) {
      const t = ledgerTime(a);
      if (t === null || !LANES.some((l) => l.key === a.actorRole)) undated += 1;
      else events.push({ t, lane: a.actorRole, allowed: a.allowed, action: a.action });
    }
    return { events, undated };
  }, [cc.audit, ledgerTime]);

  return (
    <ActivityLanes
      id="spine"
      title="The books, by ledger date"
      blurb="One lane per actor. Each row sits on the posted date of the line it acted on; a policy on the day it takes effect, a period lock on the period's last day."
      lanes={LANES}
      events={events}
      unit="day"
      undated={undated}
      undatedWord="set-up row"
      empty={
        <>
          Nothing has touched the books yet. Run <code>make cost-cap-run</code>, and every actor's lane fills in here as it works.
        </>
      }
      onWindow={onWindow}
    />
  );
}
