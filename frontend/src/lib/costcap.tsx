import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../cost_cap_bindings';
import type {
  AgentStep,
  Allocation,
  AuditLog,
  BillLine,
  CapPosition,
  GlLine,
  Policy,
  Precedent,
  Role,
  RoleInvite,
  RulebookEntry,
  Vendor,
  WorkItem,
} from '../cost_cap_bindings/types';

// One subscription per table for the whole dashboard, shared through context. agent_step is the
// big table (every read and tool call); only decisions and model calls are subscribed, which is
// what a reviewer reads next to a proposal.

export interface CostCapData {
  ready: boolean;
  /** the role and role_invite tables have arrived (a seat is judged only then) */
  seatsReady: boolean;
  workItems: readonly WorkItem[];
  itemById: Map<bigint, WorkItem>;
  itemBySubject: Map<string, WorkItem>;
  policies: readonly Policy[];
  policyById: Map<bigint, Policy>;
  audit: readonly AuditLog[];
  auditBySubject: Map<string, AuditLog[]>;
  rulebook: Map<string, RulebookEntry>;
  glLines: Map<string, GlLine>;
  billLinesByGl: Map<string, BillLine[]>;
  vendors: Map<string, Vendor>;
  allocationsByItem: Map<bigint, Allocation[]>;
  capPositions: readonly CapPosition[];
  settings: Map<string, string>;
  roles: readonly Role[];
  invites: readonly RoleInvite[];
  decisionsByItem: Map<bigint, AgentStep[]>;
  modelCallsByItem: Map<bigint, AgentStep[]>;
  modelCalls: readonly AgentStep[];
  precedentsByItem: Map<bigint, Precedent[]>;
  materiality: bigint;
  cap: bigint;
}

const Ctx = createContext<CostCapData | null>(null);

function group<K, V>(rows: readonly V[], key: (v: V) => K | undefined): Map<K, V[]> {
  const m = new Map<K, V[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === undefined) continue;
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export function CostCapDataProvider({ children }: { children: ReactNode }) {
  const [workItems, wiReady] = useTable(tables.workItem);
  const [policies] = useTable(tables.policy);
  const [audit] = useTable(tables.auditLog);
  const [rulebookRows] = useTable(tables.rulebookEntry);
  const [glRows] = useTable(tables.glLine);
  const [billRows] = useTable(tables.billLine);
  const [vendorRows] = useTable(tables.vendor);
  const [allocRows] = useTable(tables.allocation);
  const [capPositions] = useTable(tables.capPosition);
  const [settingRows] = useTable(tables.setting);
  const [roles, rolesReady] = useTable(tables.role);
  const [invites, invitesReady] = useTable(tables.roleInvite);
  const [decisions] = useTable(tables.agentStep.where((r) => r.kind.eq('decision')));
  const [modelCalls] = useTable(tables.agentStep.where((r) => r.kind.eq('model_call')));
  const [precedents] = useTable(tables.precedent);

  const value = useMemo<CostCapData>(() => {
    const settings = new Map(settingRows.map((s) => [s.key, s.value]));
    const byId = <T extends { id: bigint }>(rows: readonly T[]) => new Map(rows.map((r) => [r.id, r]));
    return {
      ready: wiReady,
      seatsReady: rolesReady && invitesReady,
      workItems,
      itemById: byId(workItems),
      itemBySubject: new Map(workItems.map((w) => [w.subjectRef, w])),
      policies,
      policyById: byId(policies),
      audit,
      auditBySubject: group(audit, (a) => a.subjectId),
      rulebook: new Map(rulebookRows.map((r) => [r.id, r])),
      glLines: new Map(glRows.map((g) => [g.id, g])),
      billLinesByGl: group(billRows, (b) => b.glLineId),
      vendors: new Map(vendorRows.map((v) => [v.id, v])),
      allocationsByItem: group(allocRows, (a) => a.workItemId),
      capPositions,
      settings,
      roles,
      invites,
      decisionsByItem: group(decisions, (s) => s.workItemId),
      modelCallsByItem: group(modelCalls, (s) => s.workItemId),
      modelCalls,
      precedentsByItem: group(precedents, (p) => p.workItemId),
      materiality: BigInt(settings.get('materiality_usd_minor') ?? '25000000'),
      cap: BigInt(settings.get('cap_usd_minor') ?? '21500000000'),
    };
  }, [
    wiReady, rolesReady, invitesReady, workItems, policies, audit, rulebookRows, glRows, billRows, vendorRows, allocRows,
    capPositions, settingRows, roles, invites, decisions, modelCalls, precedents,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCostCap(): CostCapData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCostCap outside CostCapDataProvider');
  return v;
}

export const abs = (v: bigint) => (v < 0n ? -v : v);

/** Who must decide a proposal: the module routes material items to the Head of Cost Cap. */
export function needsHead(item: WorkItem, materiality: bigint): boolean {
  return abs(item.amountUsdMinor) >= materiality;
}

/** What a proposal would add to Relevant Costs if posted as proposed (null: not proposed yet). */
export function proposedCapEffect(cc: CostCapData, item: WorkItem): bigint | null {
  const code = item.proposedCategoryCode;
  if (!code) return null;
  const effect = (entryId: string, amount: bigint, explicit: bigint | undefined) => {
    const t = cc.rulebook.get(entryId)?.treatment;
    if (t === 'RELEVANT') return amount;
    if (t === 'ADJUSTMENT') return explicit ?? 0n;
    return 0n;
  };
  if (code === 'ALLOCATED') {
    return (cc.allocationsByItem.get(item.id) ?? []).reduce(
      (s, a) => s + effect(a.rulebookEntryId, a.amountUsdMinor, a.capEffectUsdMinor),
      0n
    );
  }
  return effect(item.proposedRulebookEntryId ?? '', item.amountUsdMinor, item.capEffectUsdMinor);
}

export const OPEN_STATES = new Set(['PROPOSED', 'APPROVED']);
export const WAITING_STATES = new Set(['PROPOSED', 'NEEDS_INFO']);
