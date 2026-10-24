// cost_cap_desk: the system of work for the F1 cost cap desk.
// Reducer names are pinned to camelCase (SCHEMA.md section 6) with an explicit
// `name`, because the module's SnakeCase policy would otherwise rename them.
// Every state-changing reducer except bootstrapAdmin goes through transition().
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb, { Allocation } from './schema';
import {
  ALLOCATED,
  ALLOCATION_BASES,
  ASSIGNABLE_ROLES,
  AUTONOMOUS_ROLE,
  INTEGER_SETTINGS,
  PROPOSAL_SOURCES,
  REOPEN_FIELDS,
  REVERSAL_FIELDS,
  STEP_KINDS,
  STEP_LIMITS,
  TRANSITIONS,
  TREATMENTS,
  TRUNCATION_MARKER,
  type Action,
  type ResourceKind,
} from './rules';
import {
  REOPENABLE_STATES,
  allocationRowsOf,
  bookedBookings,
  bumpCap,
  isAllocated,
  isLocked,
  ledgerDeltas,
  lineChain,
  plannedBookings,
  reversedItem,
  policyRefFor,
  prefixDiff,
  reopenItem,
  roleOf,
  subjectLine,
  transition,
  workItemOrThrow,
  writePrecedent,
  type AllocationInput,
  type CapDelta,
  type Ctx,
  type GlLine,
  type Proposal,
  type TransitionResult,
  type WorkItem,
} from './transition';
import {
  isIntegerString,
  parsePattern,
  requireIsoDate,
  requireNonEmpty,
  requireNonEmptyJson,
  requirePeriodKey,
  sha256Hex,
  snap,
  toJson,
  truncateUtf8,
  windowCoversPeriod,
  type Diff,
  type Json,
} from './util';
import {
  citationsOf,
  flipReport,
  flipReportJson,
  flips,
  lineFacts,
  parseCornerstones,
  policyForest,
  type Cornerstone,
  type FlipReport,
  type PolicyNode,
} from './rdr';

export { default } from './schema';

const bad = (msg: string) => new SenderError(msg);

// ---------------------------------------------------------------- roles

export const bootstrapAdmin = spacetimedb.reducer({ name: 'bootstrapAdmin' }, {}, ctx => {
  // Not routed through transition() (SCHEMA section 6), but still audited, and a
  // refusal is committed like any other denial.
  const empty = ctx.db.role.count() === 0n;
  const before = ctx.db.role.identity.find(ctx.sender);
  const row = { identity: ctx.sender, role: 'admin', label: 'bootstrap admin' };
  if (empty) ctx.db.role.insert(row);
  ctx.db.auditLog.insert({
    id: 0n,
    at: ctx.timestamp,
    actor: ctx.sender,
    actorRole: before?.role ?? 'none',
    action: 'bootstrap_admin',
    resourceKind: 'role',
    subjectId: ctx.sender.toHexString(),
    allowed: empty,
    fromState: before ? 'PRESENT' : 'ABSENT',
    toState: empty ? 'PRESENT' : before ? 'PRESENT' : 'ABSENT',
    reason: empty ? 'first identity becomes admin' : 'already_bootstrapped: role table is not empty',
    diff: empty ? JSON.stringify(prefixDiff('role', null, snap(row))) : '{}',
    evidence: '',
    policyId: undefined,
    policyVersion: undefined,
  });
});

function inviteState(inv: { used: boolean } | null): string {
  return inv === null ? 'ABSENT' : inv.used ? 'USED' : 'UNUSED';
}

export const createRoleInvite = spacetimedb.reducer(
  { name: 'createRoleInvite' },
  { role: t.string(), label: t.string(), code: t.string() },
  (ctx, { role, label, code }) => {
    if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
      throw bad(`unknown role ${JSON.stringify(role)}; expected one of ${ASSIGNABLE_ROLES.join(', ')}`);
    }
    requireNonEmpty('code', code);
    const hash = sha256Hex(code);
    const existing = ctx.db.roleInvite.code.find(hash);
    transition(ctx, {
      action: 'create_role_invite',
      resourceKind: 'role_invite',
      machine: 'role_invite',
      subjectId: `invite:${hash.slice(0, 16)}`,
      fromState: inviteState(existing),
      before: snap(existing),
      apply: () => {
        const row = { code: hash, role, label, used: false };
        ctx.db.roleInvite.insert(row);
        return { after: snap(row) };
      },
      reason: `invite for ${role} (${label})`,
      evidence: '',
    });
  }
);

export const claimRole = spacetimedb.reducer({ name: 'claimRole' }, { code: t.string() }, (ctx, { code }) => {
  const hash = sha256Hex(code);
  const inv = ctx.db.roleInvite.code.find(hash);
  transition(ctx, {
    action: 'claim_role',
    resourceKind: 'role_invite',
    machine: 'role_invite',
    subjectId: `invite:${hash.slice(0, 16)}`,
    fromState: inviteState(inv),
    before: snap(inv),
    apply: () => {
      const invite = inv!;
      const used = { ...invite, used: true };
      ctx.db.roleInvite.code.update(used);
      const roleRow = { identity: ctx.sender, role: invite.role, label: invite.label };
      ctx.db.role.insert(roleRow);
      return {
        after: snap(used),
        effects: prefixDiff(`role[${ctx.sender.toHexString()}]`, null, snap(roleRow)),
        reason: `claimed role ${invite.role} (${invite.label})`,
      };
    },
    reason: 'claim role',
    evidence: '',
  });
});

// ---------------------------------------------------------------- admin

export const setSetting = spacetimedb.reducer(
  { name: 'setSetting' },
  { key: t.string(), value: t.string() },
  (ctx, { key, value }) => {
    requireNonEmpty('key', key);
    if (INTEGER_SETTINGS.includes(key) && !isIntegerString(value)) {
      throw bad(`setting ${key} must be an integer, got ${JSON.stringify(value)}`);
    }
    const existing = ctx.db.setting.key.find(key);
    transition(ctx, {
      action: 'set_setting',
      resourceKind: 'setting',
      subjectId: key,
      fromState: existing ? 'SET' : 'ABSENT',
      toState: 'SET',
      before: snap(existing),
      apply: () => {
        const row = { key, value: value.trim() };
        if (existing) ctx.db.setting.key.update(row);
        else ctx.db.setting.insert(row);
        return { after: snap(row) };
      },
      reason: `${key}=${value.trim()}`,
      evidence: '',
    });
  }
);

export const loadRulebookEntry = spacetimedb.reducer(
  { name: 'loadRulebookEntry' },
  {
    id: t.string(),
    categoryCode: t.string(),
    treatment: t.string(),
    ruleVersion: t.string(),
    article: t.string(),
    effectiveFrom: t.string(),
    effectiveTo: t.option(t.string()),
    title: t.string(),
    text: t.string(),
    capLimitUsdMinor: t.option(t.i64()),
  },
  (ctx, args) => {
    requireNonEmpty('id', args.id);
    requireNonEmpty('categoryCode', args.categoryCode);
    if (!(TREATMENTS as readonly string[]).includes(args.treatment)) {
      throw bad(`treatment must be one of ${TREATMENTS.join(', ')}, got ${JSON.stringify(args.treatment)}`);
    }
    requireIsoDate('effectiveFrom', args.effectiveFrom);
    if (args.effectiveTo !== undefined) {
      requireIsoDate('effectiveTo', args.effectiveTo);
      if (args.effectiveTo < args.effectiveFrom) throw bad('effectiveTo is before effectiveFrom');
    }
    const existing = ctx.db.rulebookEntry.id.find(args.id);
    transition(ctx, {
      action: 'load_rulebook_entry',
      resourceKind: 'rulebook_entry',
      subjectId: args.id,
      fromState: existing ? 'LOADED' : 'ABSENT',
      toState: 'LOADED',
      before: snap(existing),
      apply: () => {
        const row = { ...args, effectiveTo: args.effectiveTo, capLimitUsdMinor: args.capLimitUsdMinor };
        if (existing) ctx.db.rulebookEntry.id.update(row);
        else ctx.db.rulebookEntry.insert(row);
        return { after: snap(row) };
      },
      reason: `${existing ? 'reload' : 'load'} ${args.id} (${args.treatment}, ${args.effectiveFrom}..${args.effectiveTo ?? 'open'})`,
      evidence: JSON.stringify([args.id]),
    });
  }
);

export const lockPeriod = spacetimedb.reducer(
  { name: 'lockPeriod' },
  { periodKey: t.string() },
  (ctx, { periodKey }) => {
    requirePeriodKey('periodKey', periodKey);
    const existing = ctx.db.period.key.find(periodKey);
    transition(ctx, {
      action: 'lock_period',
      resourceKind: 'period',
      machine: 'period',
      subjectId: periodKey,
      fromState: existing?.locked ? 'LOCKED' : 'OPEN',
      before: snap(existing),
      apply: () => {
        const row = { key: periodKey, locked: true, lockedBy: ctx.sender, lockedAt: ctx.timestamp };
        if (existing) ctx.db.period.key.update(row);
        else ctx.db.period.insert(row);
        return { after: snap(row) };
      },
      reason: `lock period ${periodKey}`,
      evidence: '',
    });
  }
);

// ---------------------------------------------------------------- sync (golden rows)

function createWorkItem(
  ctx: Ctx,
  kind: 'classification' | 'reversal',
  line: GlLine,
  reason: string,
  reverses?: WorkItem
): { effects: Diff; note: string } {
  const subjectRef = reverses ? reverses.id.toString() : line.id;
  const row = ctx.db.workItem.insert({
    id: 0n,
    kind,
    subjectRef,
    periodKey: line.periodKey,
    amountUsdMinor: line.amountUsdMinor,
    state: 'NEW',
    proposedBy: undefined,
    proposedCategoryCode: undefined,
    proposedRulebookEntryId: undefined,
    proposedPolicyId: undefined,
    reason,
    evidenceRefs: JSON.stringify(kind === 'reversal' ? [line.id, line.rawRef] : [line.rawRef]),
    question: undefined,
    answer: undefined,
    decidedBy: undefined,
    decidedReason: undefined,
    erpEntryId: undefined,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
    answeredBy: undefined,
    capEffectUsdMinor: undefined,
    proposalSource: '',
    reversesItemId: reverses?.id,
    superseded: false,
    postedCapEffectUsdMinor: undefined,
    postedTreatment: undefined,
  });
  const effects: Diff = {
    [`work_item[${row.id}]`]: {
      from: null,
      to: {
        kind,
        subject_ref: subjectRef,
        reverses_item_id: toJson(reverses?.id),
        state: 'NEW',
        period_key: line.periodKey,
        amount_usd_minor: toJson(line.amountUsdMinor),
      },
    },
    ...bumpCap(ctx, line.periodKey, { pending: line.amountUsdMinor }),
  };
  return { effects, note: `created work_item ${row.id} (${kind})` };
}

// A new line is always a classification, correction_of or not (SCHEMA section 10, defect 1):
// the ledger nets delta pairs itself; correction_of stays on the golden row as evidence.
function onGlLineFirstSight(ctx: Ctx, line: GlLine): { effects: Diff; note: string } {
  return createWorkItem(ctx, 'classification', line, '');
}

const GL_FIELD = {
  amount_usd_minor: 'amountUsdMinor',
  amount_minor: 'amountMinor',
  currency: 'currency',
  account_code: 'accountCode',
  vendor_id: 'vendorId',
  department_id: 'departmentId',
  memo: 'memo',
  posted_date: 'postedDate',
  period_key: 'periodKey',
} as const satisfies Record<string, keyof GlLine>;

function changedFields(before: GlLine, after: GlLine, fields: readonly (keyof typeof GL_FIELD)[]): string[] {
  return fields.filter(f => before[GL_FIELD[f]] !== after[GL_FIELD[f]]);
}

// Re-sync of a known line. Its latest work item decides what happens:
// - POSTED and a reversal-relevant field changed: one new reversal of that item (never an older one);
// - open (NEW, PROPOSED, NEEDS_INFO, APPROVED, REJECTED; classification or reversal): a change
//   to a reopen-relevant field moves PROPOSED/NEEDS_INFO/APPROVED back to NEW (audit `reopen`),
//   then amount and period are refreshed in place. At most one open reversal exists per line.
function onGlLineResync(ctx: Ctx, before: GlLine, after: GlLine): { effects: Diff; note: string } {
  const head = lineChain(ctx, after.id).at(-1);
  if (!head) return { effects: {}, note: 'no work item for this line' };

  if (head.state === 'POSTED') {
    const changed = changedFields(before, after, REVERSAL_FIELDS);
    if (changed.length === 0) return { effects: {}, note: `work_item ${head.id} is POSTED; no reversal-relevant change` };
    return createWorkItem(
      ctx,
      'reversal',
      after,
      `reversal: re-sync of gl line ${after.id} changed ${changed.join(', ')} after work item ${head.id} was POSTED`,
      head
    );
  }

  const changed = changedFields(before, after, REOPEN_FIELDS);
  let item = head;
  let effects: Diff = {};
  const notes: string[] = [];
  if (changed.length > 0 && REOPENABLE_STATES.includes(head.state)) {
    const reopened = reopenItem(ctx, head, `reopened by correction: ${changed.join(', ')}`, JSON.stringify([after.rawRef]));
    item = reopened.after;
    notes.push(`reopened work_item ${head.id} (${head.state} -> NEW: ${changed.join(', ')})`);
  }
  if (item.amountUsdMinor !== after.amountUsdMinor || item.periodKey !== after.periodKey) {
    const updated: WorkItem = { ...item, amountUsdMinor: after.amountUsdMinor, periodKey: after.periodKey, updatedAt: ctx.timestamp };
    ctx.db.workItem.id.update(updated);
    if (item.periodKey === updated.periodKey) {
      effects = bumpCap(ctx, item.periodKey, { pending: updated.amountUsdMinor - item.amountUsdMinor });
    } else {
      effects = {
        ...bumpCap(ctx, item.periodKey, { pending: -item.amountUsdMinor }),
        ...bumpCap(ctx, updated.periodKey, { pending: updated.amountUsdMinor }),
      };
    }
    item = updated;
    notes.push(`refreshed open work_item ${head.id} (${item.state})`);
  }
  if (notes.length === 0) return { effects: {}, note: `work_item ${head.id} unchanged` };
  return { effects: { ...prefixDiff(`work_item[${head.id}]`, snap(head), snap(item)), ...effects }, note: notes.join('; ') };
}

export const upsertGlLine = spacetimedb.reducer(
  { name: 'upsertGlLine' },
  {
    id: t.string(),
    rawRef: t.string(),
    postedDate: t.string(),
    periodKey: t.string(),
    accountId: t.string(),
    accountCode: t.string(),
    departmentId: t.string(),
    vendorId: t.option(t.string()),
    billId: t.option(t.string()),
    amountMinor: t.i64(),
    currency: t.string(),
    fxRateE6: t.i64(),
    amountUsdMinor: t.i64(),
    memo: t.string(),
    erpCategoryCode: t.string(),
    entity: t.string(),
    correctionOf: t.option(t.string()),
  },
  (ctx, args) => {
    requireNonEmpty('id', args.id);
    requireIsoDate('postedDate', args.postedDate);
    requirePeriodKey('periodKey', args.periodKey);
    if (args.correctionOf === args.id) throw bad('a gl line cannot be a correction of itself');
    const existing = ctx.db.glLine.id.find(args.id);
    transition(ctx, {
      action: 'sync_upsert',
      resourceKind: 'gl_line',
      subjectId: args.id,
      fromState: existing ? 'SYNCED' : 'ABSENT',
      toState: 'SYNCED',
      before: snap(existing),
      apply: () => {
        const row: GlLine = {
          ...args,
          vendorId: args.vendorId,
          billId: args.billId,
          correctionOf: args.correctionOf,
          syncedAt: ctx.timestamp,
        };
        if (existing) ctx.db.glLine.id.update(row);
        else ctx.db.glLine.insert(row);
        const { effects, note } = existing ? onGlLineResync(ctx, existing, row) : onGlLineFirstSight(ctx, row);
        return { after: snap(row), effects, reason: `sync ${args.rawRef}: ${note}` };
      },
      reason: `sync ${args.rawRef}`,
      evidence: JSON.stringify([args.rawRef]),
    });
  }
);

function syncRecord(
  ctx: Ctx,
  resourceKind: ResourceKind,
  id: string,
  rawRef: string,
  existing: object | undefined,
  row: object,
  write: () => void
): TransitionResult {
  requireNonEmpty('id', id);
  return transition(ctx, {
    action: 'sync_upsert',
    resourceKind,
    subjectId: id,
    fromState: existing ? 'SYNCED' : 'ABSENT',
    toState: 'SYNCED',
    before: snap(existing),
    apply: () => {
      write();
      return { after: snap(row) };
    },
    reason: `sync ${rawRef}`,
    evidence: JSON.stringify([rawRef]),
  });
}

export const upsertBillLine = spacetimedb.reducer(
  { name: 'upsertBillLine' },
  {
    id: t.string(),
    rawRef: t.string(),
    billId: t.string(),
    glLineId: t.option(t.string()),
    lineNo: t.u32(),
    description: t.string(),
    amountMinor: t.i64(),
    billText: t.string(),
    vendorId: t.string(),
    bankIbanOnBill: t.string(),
  },
  (ctx, args) => {
    const existing = ctx.db.billLine.id.find(args.id);
    const row = { ...args, glLineId: args.glLineId };
    syncRecord(ctx, 'bill_line', args.id, args.rawRef, existing ?? undefined, row, () =>
      existing ? ctx.db.billLine.id.update(row) : ctx.db.billLine.insert(row)
    );
  }
);

export const upsertVendor = spacetimedb.reducer(
  { name: 'upsertVendor' },
  {
    id: t.string(),
    rawRef: t.string(),
    name: t.string(),
    country: t.string(),
    relatedParty: t.bool(),
    relatedPartyEntity: t.option(t.string()),
    bankIban: t.string(),
    categoryHint: t.option(t.string()),
  },
  (ctx, args) => {
    const existing = ctx.db.vendor.id.find(args.id);
    const row = { ...args, relatedPartyEntity: args.relatedPartyEntity, categoryHint: args.categoryHint };
    syncRecord(ctx, 'vendor', args.id, args.rawRef, existing ?? undefined, row, () =>
      existing ? ctx.db.vendor.id.update(row) : ctx.db.vendor.insert(row)
    );
  }
);

export const upsertFairValue = spacetimedb.reducer(
  { name: 'upsertFairValue' },
  {
    id: t.string(),
    rawRef: t.string(),
    counterpartyVendorId: t.string(),
    item: t.string(),
    contractValueMinor: t.i64(),
    fairValueMinor: t.i64(),
    currency: t.string(),
    effectiveFrom: t.string(),
    basis: t.string(),
  },
  (ctx, args) => {
    requireIsoDate('effectiveFrom', args.effectiveFrom);
    const existing = ctx.db.fairValue.id.find(args.id);
    const row = { ...args };
    syncRecord(ctx, 'fair_value', args.id, args.rawRef, existing ?? undefined, row, () =>
      existing ? ctx.db.fairValue.id.update(row) : ctx.db.fairValue.insert(row)
    );
  }
);

// ---------------------------------------------------------------- work items

interface ItemStep {
  reason: string;
  evidence?: string;
  proposal?: Proposal;
  allocations?: AllocationInput[];
  policyId?: bigint;
  patch: (item: WorkItem) => Partial<WorkItem>;
  sideEffects?: (before: WorkItem, after: WorkItem) => Diff;
}

function itemStep(ctx: Ctx, workItemId: bigint, action: Action, step: ItemStep): TransitionResult {
  const item = workItemOrThrow(ctx, workItemId, bad);
  const policyId = step.allocations ? step.policyId : step.proposal ? step.proposal.policyId : item.proposedPolicyId;
  return transition(ctx, {
    action,
    resourceKind: 'work_item',
    machine: 'work_item',
    subjectId: item.id.toString(),
    fromState: item.state,
    before: snap(item),
    workItem: item,
    proposal: step.proposal,
    allocations: step.allocations,
    apply: () => {
      const target = TRANSITIONS.work_item[item.state]![action]!;
      const after: WorkItem = { ...item, ...step.patch(item), state: target, updatedAt: ctx.timestamp };
      ctx.db.workItem.id.update(after);
      return { after: snap(after), effects: step.sideEffects?.(item, after) };
    },
    reason: step.reason,
    evidence: step.evidence ?? item.evidenceRefs,
    policyRef: policyRefFor(ctx, policyId),
  });
}

export const propose = spacetimedb.reducer(
  { name: 'propose' },
  {
    workItemId: t.u64(),
    categoryCode: t.string(),
    rulebookEntryId: t.string(),
    policyId: t.option(t.u64()),
    reason: t.string(),
    evidenceRefs: t.string(),
    // SCHEMA section 10, defect 4: required for ADJUSTMENT treatments, absent otherwise.
    capEffectUsdMinor: t.option(t.i64()),
    // deterministic | llm | human_text; only deterministic proposals may be auto-approved.
    proposalSource: t.string(),
  },
  (ctx, { workItemId, categoryCode, rulebookEntryId, policyId, reason, evidenceRefs, capEffectUsdMinor, proposalSource }) => {
    requireNonEmpty('categoryCode', categoryCode);
    requireNonEmpty('rulebookEntryId', rulebookEntryId);
    requireNonEmpty('reason', reason);
    if (!(PROPOSAL_SOURCES as readonly string[]).includes(proposalSource)) {
      throw bad(`proposalSource must be one of ${PROPOSAL_SOURCES.join(', ')}, got ${JSON.stringify(proposalSource)}`);
    }
    itemStep(ctx, workItemId, 'propose', {
      reason,
      evidence: evidenceRefs,
      proposal: { categoryCode, rulebookEntryId, policyId, capEffectUsdMinor, proposalSource },
      patch: () => ({
        proposedBy: ctx.sender,
        proposedCategoryCode: categoryCode,
        proposedRulebookEntryId: rulebookEntryId,
        proposedPolicyId: policyId,
        capEffectUsdMinor,
        proposalSource,
        reason,
        evidenceRefs,
        decidedBy: undefined,
        decidedReason: undefined,
      }),
      // A whole-line proposal replaces an earlier (rejected) allocated one.
      sideEffects: before => dropAllocations(ctx, before.id),
    });
  }
);

function dropAllocations(ctx: Ctx, workItemId: bigint): Diff {
  const effects: Diff = {};
  for (const a of allocationRowsOf(ctx, workItemId)) {
    ctx.db.allocation.id.delete(a.id);
    effects[`allocation[${a.id}]`] = { from: toJson({ lineNo: a.lineNo, categoryCode: a.categoryCode, amountUsdMinor: a.amountUsdMinor }), to: null };
  }
  return effects;
}

// SCHEMA section 11.1: one gl line split across categories. Same roles, states and transition as
// propose; the item carries proposed_category_code = proposed_rulebook_entry_id = "ALLOCATED" and
// the split lives in the allocation table. Every validation failure is a denial.
export const proposeAllocations = spacetimedb.reducer(
  { name: 'proposeAllocations' },
  {
    workItemId: t.u64(),
    allocations: t.array(Allocation),
    reason: t.string(),
    evidenceRefs: t.string(),
    proposalSource: t.string(),
  },
  (ctx, { workItemId, allocations, reason, evidenceRefs, proposalSource }) => {
    requireNonEmpty('reason', reason);
    if (!(PROPOSAL_SOURCES as readonly string[]).includes(proposalSource)) {
      throw bad(`proposalSource must be one of ${PROPOSAL_SOURCES.join(', ')}, got ${JSON.stringify(proposalSource)}`);
    }
    allocations.forEach((a, i) => {
      if (!(ALLOCATION_BASES as readonly string[]).includes(a.basis)) {
        throw bad(`allocations[${i}].basis must be one of ${ALLOCATION_BASES.join(', ')}, got ${JSON.stringify(a.basis)}`);
      }
      requireNonEmpty(`allocations[${i}].basisRef`, a.basisRef);
      requireNonEmpty(`allocations[${i}].categoryCode`, a.categoryCode);
      requireNonEmpty(`allocations[${i}].rulebookEntryId`, a.rulebookEntryId);
    });
    const allocs: AllocationInput[] = allocations.map(a => ({ ...a, policyId: a.policyId, capEffectUsdMinor: a.capEffectUsdMinor }));
    const cited = [...new Set(allocs.map(a => a.policyId).filter((id): id is bigint => id !== undefined))];
    itemStep(ctx, workItemId, 'propose', {
      reason,
      evidence: evidenceRefs,
      allocations: allocs,
      policyId: cited.length === 1 ? cited[0] : undefined,
      patch: () => ({
        proposedBy: ctx.sender,
        proposedCategoryCode: ALLOCATED,
        proposedRulebookEntryId: ALLOCATED,
        proposedPolicyId: undefined,
        capEffectUsdMinor: undefined,
        proposalSource,
        reason,
        evidenceRefs,
        decidedBy: undefined,
        decidedReason: undefined,
      }),
      sideEffects: before => {
        const effects = dropAllocations(ctx, before.id);
        allocs.forEach((a, i) => {
          const row = ctx.db.allocation.insert({
            id: 0n,
            workItemId: before.id,
            lineNo: i + 1,
            basis: a.basis,
            basisRef: a.basisRef,
            categoryCode: a.categoryCode,
            rulebookEntryId: a.rulebookEntryId,
            policyId: a.policyId,
            amountUsdMinor: a.amountUsdMinor,
            capEffectUsdMinor: a.capEffectUsdMinor,
            postedTreatment: undefined,
            postedCapEffectUsdMinor: undefined,
          });
          const { id: _id, workItemId: _w, ...shown } = row;
          effects[`allocation[${row.id}]`] = { from: null, to: toJson(shown) };
        });
        return effects;
      },
    });
  }
);

export const ask = spacetimedb.reducer(
  { name: 'ask' },
  { workItemId: t.u64(), question: t.string() },
  (ctx, { workItemId, question }) => {
    requireNonEmpty('question', question);
    itemStep(ctx, workItemId, 'ask', {
      reason: question,
      patch: () => ({ question, answer: undefined }),
    });
  }
);

export const answer = spacetimedb.reducer(
  { name: 'answer' },
  { workItemId: t.u64(), answer: t.string() },
  (ctx, { workItemId, answer: text }) => {
    requireNonEmpty('answer', text);
    itemStep(ctx, workItemId, 'answer', {
      reason: text,
      patch: () => ({ answer: text, answeredBy: ctx.sender }),
      sideEffects: (_before, after) =>
        writePrecedent(ctx, after, after.proposedCategoryCode ?? '', `answer: Q: ${after.question ?? ''} A: ${text}`),
    });
  }
);

// For an auto_approver call, the audit evidence names the standing approval it relies on,
// including the human who granted autonomy, so every autonomous decision traces to them.
function approvalEvidence(ctx: Ctx, workItemId: bigint): string | undefined {
  if (roleOf(ctx) !== AUTONOMOUS_ROLE) return undefined;
  const item = ctx.db.workItem.id.find(workItemId);
  if (!item) return undefined; // itemStep throws for the unknown id
  const pol = item.proposedPolicyId !== undefined ? ctx.db.policy.id.find(item.proposedPolicyId) : null;
  const granted = pol?.autonomy === 'GRANTED';
  return JSON.stringify({
    standing_approval: {
      policy_id: toJson(item.proposedPolicyId),
      policy_key: pol?.policyKey ?? null,
      policy_version: pol?.version ?? null,
      autonomy: pol?.autonomy ?? null,
      autonomy_granted_by: granted ? toJson(pol.autonomyBy) : null,
      autonomy_granted_at: granted ? toJson(pol.autonomyAt) : null,
    },
    proposal_source: item.proposalSource,
    evidence_refs: item.evidenceRefs,
  });
}

export const approve = spacetimedb.reducer(
  { name: 'approve' },
  { workItemId: t.u64(), reason: t.string() },
  (ctx, { workItemId, reason }) => {
    itemStep(ctx, workItemId, 'approve', {
      reason,
      evidence: approvalEvidence(ctx, workItemId),
      patch: () => ({ decidedBy: ctx.sender, decidedReason: reason }),
      sideEffects: (_before, after) =>
        writePrecedent(ctx, after, after.proposedCategoryCode ?? '', `approve: ${reason}`),
    });
  }
);

export const reject = spacetimedb.reducer(
  { name: 'reject' },
  { workItemId: t.u64(), reason: t.string() },
  (ctx, { workItemId, reason }) => {
    requireNonEmpty('reason', reason);
    itemStep(ctx, workItemId, 'reject', {
      reason,
      patch: () => ({ decidedBy: ctx.sender, decidedReason: reason }),
      sideEffects: (_before, after) =>
        writePrecedent(ctx, after, after.proposedCategoryCode ?? '', `reject: ${reason}`),
    });
  }
);

// RELEVANT and ADJUSTMENT count toward the cap; EXCLUDED does not.
function addToBucket(d: CapDelta, treatment: string, amount: bigint): void {
  if (treatment === 'EXCLUDED') d.excluded = (d.excluded ?? 0n) + amount;
  else d.relevant = (d.relevant ?? 0n) + amount;
}

// limit_ledger: EXCLUDED amounts per cap year and category (SCHEMA section 11.1).
function bumpLedger(ctx: Ctx, key: string, capYear: number, categoryCode: string, delta: bigint): Diff {
  if (delta === 0n) return {};
  const existing = ctx.db.limitLedger.key.find(key);
  const after = { key, capYear, categoryCode, excludedUsdMinor: (existing?.excludedUsdMinor ?? 0n) + delta };
  if (existing) ctx.db.limitLedger.key.update(after);
  else ctx.db.limitLedger.insert(after);
  return prefixDiff(`limit_ledger[${key}]`, snap(existing), snap(after));
}

// `after` already carries posted_treatment and posted_cap_effect_usd_minor. Each booking (one per
// allocation for an allocated item) goes to its treatment's bucket and, when EXCLUDED, to the
// limit ledger. A reversal first subtracts exactly what the reversed item booked (per allocation
// for an allocated item; once: it is then marked superseded), in the reversal's own period, never
// the reversed item's, which may be locked; its ledger amounts come off the cap year they were
// booked in.
function postEffects(ctx: Ctx, after: WorkItem): Diff {
  const d: CapDelta = { pending: -after.amountUsdMinor, posted: 1 };
  const effects: Diff = {};
  const deltas = ledgerDeltas(ctx, after);
  for (const b of plannedBookings(ctx, after)) {
    addToBucket(d, b.treatment, b.effect);
    if (b.allocationId === undefined) continue;
    const row = ctx.db.allocation.id.find(b.allocationId)!;
    ctx.db.allocation.id.update({ ...row, postedTreatment: b.treatment, postedCapEffectUsdMinor: b.effect });
    effects[`allocation[${row.id}].posted_treatment`] = { from: null, to: b.treatment };
    effects[`allocation[${row.id}].posted_cap_effect_usd_minor`] = { from: null, to: toJson(b.effect) };
  }
  const rev = reversedItem(ctx, after);
  if (rev) {
    for (const b of bookedBookings(ctx, rev)) addToBucket(d, b.treatment, -b.effect);
    ctx.db.workItem.id.update({ ...rev, superseded: true, updatedAt: ctx.timestamp });
    effects[`work_item[${rev.id}].superseded`] = { from: false, to: true };
  }
  for (const [key, { capYear, categoryCode, delta }] of deltas) Object.assign(effects, bumpLedger(ctx, key, capYear, categoryCode, delta));
  return { ...effects, ...bumpCap(ctx, after.periodKey, d) };
}

export const post = spacetimedb.reducer(
  { name: 'post' },
  { workItemId: t.u64(), erpEntryId: t.string() },
  (ctx, { workItemId, erpEntryId }) => {
    requireNonEmpty('erpEntryId', erpEntryId);
    itemStep(ctx, workItemId, 'post', {
      reason: `posted as ${erpEntryId}`,
      // What post books (SCHEMA section 10, defect 4; 11.1): the line amount for RELEVANT and
      // EXCLUDED, the proposal's signed cap effect for an ADJUSTMENT. An allocated item records
      // posted_treatment "ALLOCATED" and the sum of its allocations' effects; each allocation row
      // records its own. Re-validation guarantees the entries resolve.
      patch: item => {
        const bookings = plannedBookings(ctx, item);
        if (isAllocated(item)) {
          return { erpEntryId, postedTreatment: ALLOCATED, postedCapEffectUsdMinor: bookings.reduce((s, b) => s + b.effect, 0n) };
        }
        return { erpEntryId, postedTreatment: bookings[0]!.treatment, postedCapEffectUsdMinor: bookings[0]!.effect };
      },
      sideEffects: (_before, after) => postEffects(ctx, after),
    });
  }
);

// ---------------------------------------------------------------- policies

// The RDR checks and evidence of a policy draft (SCHEMA section 11.2), computed once for both the
// denial reasons and the audit evidence. Cornerstones whose ref is a gl_line row are checked here:
// the draft must apply to its own, and a child must not apply to its parent's cornerstones of the
// parent's category. Other refs (2025 history) are checked by the proposer and marked so.
interface DraftAnalysis {
  violations: string[];
  evidence: string;
  flipReport: FlipReport;
}

function analyseDraft(ctx: Ctx, draft: PolicyNode, cornerstones: Cornerstone[], evidenceRefs: string): DraftAnalysis {
  const forest = policyForest(ctx, [draft]);
  const violations: string[] = [];
  const own = { checked: [] as string[], checked_by_proposer: [] as string[] };
  const notMatched: string[] = [];
  for (const c of cornerstones) {
    const line = ctx.db.glLine.id.find(c.ref);
    if (!line) {
      own.checked_by_proposer.push(c.ref);
      continue;
    }
    own.checked.push(c.ref);
    if (!forest.appliesIgnoringOwnState(draft, lineFacts(ctx, line), line.periodKey)) notMatched.push(c.ref);
  }
  if (notMatched.length > 0) {
    violations.push(`cornerstone_mismatch: the policy does not apply to its own cornerstones ${notMatched.join(', ')}`);
  }
  let parentCheck: { policy_id: Json; checked: string[]; checked_by_proposer: string[] } | null = null;
  const parent = draft.parentPolicyId !== undefined ? ctx.db.policy.id.find(draft.parentPolicyId) : undefined;
  if (parent) {
    const pc = { policy_id: toJson(parent.id), checked: [] as string[], checked_by_proposer: [] as string[] };
    parentCheck = pc;
    const parsed = parseCornerstones(parent.cornerstones || '[]');
    const conflicting: string[] = [];
    for (const c of typeof parsed === 'string' ? [] : parsed) {
      if (c.category_code !== parent.categoryCode) continue;
      const line = ctx.db.glLine.id.find(c.ref);
      if (!line) {
        pc.checked_by_proposer.push(c.ref);
        continue;
      }
      pc.checked.push(c.ref);
      if (forest.appliesIgnoringOwnState(draft, lineFacts(ctx, line), line.periodKey)) conflicting.push(c.ref);
    }
    if (conflicting.length > 0) {
      violations.push(
        `conflicting_cornerstone: the exception matches cornerstones of parent pol-${parent.id} (${parent.categoryCode}): ${conflicting.join(', ')}`
      );
    }
  }
  const report = flipReport(ctx, flips(ctx, forest, draft.id, it => subjectLine(ctx, it)), pk => isLocked(ctx, pk));
  const evidence = JSON.stringify({
    evidence_refs: evidenceRefs,
    cornerstones: { ...own, parent: parentCheck },
    flip_report: flipReportJson(report),
  });
  return { violations, evidence, flipReport: report };
}

export const proposePolicy = spacetimedb.reducer(
  { name: 'proposePolicy' },
  {
    policyKey: t.string(),
    version: t.u32(),
    categoryCode: t.string(),
    rulebookEntryId: t.string(),
    pattern: t.string(),
    rationale: t.string(),
    evidenceRefs: t.string(),
    precedentCount: t.u32(),
    effectiveFrom: t.string(),
    effectiveTo: t.option(t.string()),
    // SCHEMA section 11.2, appended after effectiveTo.
    parentPolicyId: t.option(t.u64()),
    cornerstones: t.string(),
  },
  (ctx, args) => {
    requireNonEmpty('policyKey', args.policyKey);
    requireNonEmpty('categoryCode', args.categoryCode);
    requireNonEmpty('rulebookEntryId', args.rulebookEntryId);
    requireNonEmpty('rationale', args.rationale);
    parsePattern(args.pattern);
    requireIsoDate('effectiveFrom', args.effectiveFrom);
    if (args.effectiveTo !== undefined) {
      requireIsoDate('effectiveTo', args.effectiveTo);
      if (args.effectiveTo < args.effectiveFrom) throw bad('effectiveTo is before effectiveFrom');
    }
    // "" is read as no cornerstones.
    const cornerstonesText = args.cornerstones.trim() === '' ? '[]' : args.cornerstones;
    const cornerstones = parseCornerstones(cornerstonesText);
    if (typeof cornerstones === 'string') throw bad(cornerstones);
    if (args.parentPolicyId !== undefined && !ctx.db.policy.id.find(args.parentPolicyId)) {
      throw bad(`unknown parent policy ${args.parentPolicyId}`);
    }
    const siblings = [...ctx.db.policy.policyKey.filter(args.policyKey)];
    const latest = siblings.reduce((m, p) => Math.max(m, p.version), 0);
    // version 0 means "next version for this policy_key".
    const version = args.version === 0 ? latest + 1 : args.version;
    if (siblings.some(p => p.version === version)) {
      throw bad(`policy ${args.policyKey} v${version} already exists (latest is v${latest}); pass 0 for the next version`);
    }
    const nextId = [...ctx.db.policy.iter()].reduce((m, p) => (p.id > m ? p.id : m), 0n) + 1n;
    const analysis = analyseDraft(
      ctx,
      {
        id: nextId,
        policyKey: args.policyKey,
        version,
        categoryCode: args.categoryCode,
        rulebookEntryId: args.rulebookEntryId,
        pattern: args.pattern,
        parentPolicyId: args.parentPolicyId,
        state: 'APPROVED', // hypothetically, for the flip report
        effectiveFrom: args.effectiveFrom,
        effectiveTo: args.effectiveTo,
      },
      cornerstones,
      args.evidenceRefs
    );
    transition(ctx, {
      action: 'propose_policy',
      resourceKind: 'policy',
      machine: 'policy',
      subjectId: args.policyKey,
      fromState: 'ABSENT',
      before: null,
      policyDraft: {
        categoryCode: args.categoryCode,
        rulebookEntryId: args.rulebookEntryId,
        effectiveFrom: args.effectiveFrom,
        rdrViolations: analysis.violations,
      },
      apply: () => {
        const row = ctx.db.policy.insert({
          id: 0n,
          ...args,
          effectiveTo: args.effectiveTo,
          parentPolicyId: args.parentPolicyId,
          cornerstones: cornerstonesText,
          flipReport: JSON.stringify(flipReportJson(analysis.flipReport)),
          version,
          state: 'PROPOSED',
          proposedBy: ctx.sender,
          decidedBy: undefined,
          decidedReason: undefined,
          createdAt: ctx.timestamp,
          decidedAt: undefined,
          autonomy: 'NONE',
          autonomyBy: undefined,
          autonomyEvidence: '',
          autonomyReason: undefined,
          autonomyAt: undefined,
        });
        return {
          after: snap(row),
          policyRef: { id: row.id, version },
          reason: `policy ${row.id} ${args.policyKey} v${version}${args.parentPolicyId !== undefined ? ` (exception to pol-${args.parentPolicyId})` : ''}: ${args.rationale}`,
        };
      },
      reason: args.rationale,
      evidence: analysis.evidence,
    });
  }
);

function decidePolicy(ctx: Ctx, policyId: bigint, action: 'approve_policy' | 'reject_policy', reason: string): void {
  const pol = ctx.db.policy.id.find(policyId);
  if (!pol) throw bad(`unknown policy ${policyId}`);
  transition(ctx, {
    action,
    resourceKind: 'policy',
    machine: 'policy',
    subjectId: pol.policyKey,
    fromState: pol.state,
    before: snap(pol),
    policy: pol,
    apply: () => {
      let after = {
        ...pol,
        state: TRANSITIONS.policy[pol.state]![action]!,
        decidedBy: ctx.sender,
        decidedReason: reason,
        decidedAt: ctx.timestamp,
      };
      ctx.db.policy.id.update(after);
      if (action !== 'approve_policy') return { after: snap(after) };
      const isNewVersion = [...ctx.db.policy.policyKey.filter(after.policyKey)].some(
        p => p.id !== after.id && p.version < after.version && p.state === 'APPROVED'
      );
      const effects = supersedeOlderVersions(ctx, after);
      if (after.parentPolicyId !== undefined || isNewVersion) {
        const { effects: e, postedLocked } = exceptionApproved(ctx, after);
        Object.assign(effects, e);
        if (postedLocked.length > 0) {
          // Locked-period items are left alone and stay listed in the flip report.
          after = { ...after, flipReport: mergePostedLocked(after.flipReport, postedLocked) };
          ctx.db.policy.id.update(after);
        }
      }
      return { after: snap(after), effects };
    },
    reason,
    evidence: pol.evidenceRefs,
    policyRef: { id: pol.id, version: pol.version },
  });
}

function mergePostedLocked(report: string, ids: bigint[]): string {
  let r: Record<string, Json> = {};
  try {
    const parsed: unknown = JSON.parse(report || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) r = parsed as Record<string, Json>;
  } catch {
    r = {};
  }
  const merged: Json[] = Array.isArray(r.posted_locked) ? [...r.posted_locked] : [];
  for (const id of ids) if (!merged.includes(toJson(id))) merged.push(toJson(id));
  return JSON.stringify({ open: [], posted_open_period: [], usd_minor_by_state: {}, ...r, posted_locked: merged });
}

// Approval of a child (an exception) or of a new version (SCHEMA section 11.2):
// - open items (PROPOSED, APPROVED) citing an ancestor of the approved policy, where the approved
//   policy applies to the line (or to the cited bill line), go back to NEW (audit `reopen`, reason
//   `exception approved: pol-<id>`), so the analyst re-proposes under the exception;
// - POSTED items in unlocked periods whose line now resolves to the approved policy with a
//   different category get a `reversal` work item (if the item is still the line's latest);
// - POSTED items in locked periods are left alone and returned for the flip report.
function exceptionApproved(ctx: Ctx, approved: { id: bigint }): { effects: Diff; postedLocked: bigint[] } {
  const effects: Diff = {};
  const forest = policyForest(ctx);
  const node = forest.byId.get(approved.id)!;
  const ancestors = new Set(forest.ancestors(node).map(a => a.id));
  if (ancestors.size > 0) {
    for (const state of ['PROPOSED', 'APPROVED']) {
      for (const it of [...ctx.db.workItem.state.filter(state)].sort((a, b) => Number(a.id - b.id))) {
        const line = subjectLine(ctx, it);
        if (!line) continue;
        const facts = lineFacts(ctx, line);
        const hit = citationsOf(ctx, it).some(
          c => c.policyId !== undefined && ancestors.has(c.policyId) && forest.applies(node, facts, it.periodKey, c.billLineId)
        );
        if (!hit) continue;
        Object.assign(effects, reopenItem(ctx, it, `exception approved: pol-${approved.id}`, JSON.stringify([line.rawRef])).effects);
      }
    }
  }
  const postedLocked: bigint[] = [];
  for (const f of flips(ctx, forest, approved.id, it => subjectLine(ctx, it))) {
    if (f.item.state !== 'POSTED') continue;
    if (isLocked(ctx, f.item.periodKey)) {
      postedLocked.push(f.item.id);
      continue;
    }
    const head = lineChain(ctx, f.line.id).at(-1);
    if (!head || head.id !== f.item.id) continue; // a newer item (or an open reversal) already follows it
    const { effects: e } = createWorkItem(
      ctx,
      'reversal',
      f.line,
      `reversal: exception approved: pol-${approved.id} reclassifies gl line ${f.line.id} ${f.from} -> ${f.to} after work item ${f.item.id} was POSTED`,
      f.item
    );
    Object.assign(effects, e);
  }
  if (postedLocked.length > 0) effects['flip_report.posted_locked'] = { from: null, to: postedLocked.map(id => toJson(id)) };
  return { effects, postedLocked };
}

// Approving version n+1 (SCHEMA section 10, defect 3): every lower APPROVED version of the
// policy_key loses autonomy (GRANTED -> SUSPENDED; the head may re-grant), and its open items
// (PROPOSED or APPROVED) in a period the new version is in force for go back to NEW with an
// audit `reopen` row, so they are re-proposed under the current version.
function supersedeOlderVersions(ctx: Ctx, newer: { id: bigint; policyKey: string; version: number; effectiveFrom: string; effectiveTo?: string }): Diff {
  const effects: Diff = {};
  const older = [...ctx.db.policy.policyKey.filter(newer.policyKey)].filter(
    p => p.id !== newer.id && p.version < newer.version && p.state === 'APPROVED'
  );
  for (const old of older) {
    if (old.autonomy === 'GRANTED') {
      ctx.db.policy.id.update({
        ...old,
        autonomy: 'SUSPENDED',
        autonomyBy: ctx.sender,
        autonomyReason: `superseded by ${newer.policyKey} v${newer.version} (policy ${newer.id})`,
        autonomyAt: ctx.timestamp,
      });
      effects[`policy[${old.id}].autonomy`] = { from: 'GRANTED', to: 'SUSPENDED' };
    }
    for (const state of ['PROPOSED', 'APPROVED']) {
      for (const it of [...ctx.db.workItem.state.filter(state)]) {
        // The whole-line citation, or any allocation's (SCHEMA section 11.1).
        if (!citationsOf(ctx, it).some(c => c.policyId === old.id)) continue;
        if (!windowCoversPeriod(newer.effectiveFrom, newer.effectiveTo, it.periodKey)) continue;
        const line = subjectLine(ctx, it);
        const { effects: e } = reopenItem(ctx, it, 'policy superseded', JSON.stringify(line ? [line.rawRef] : []));
        Object.assign(effects, e);
      }
    }
  }
  return effects;
}

export const approvePolicy = spacetimedb.reducer(
  { name: 'approvePolicy' },
  { policyId: t.u64(), reason: t.string() },
  (ctx, { policyId, reason }) => decidePolicy(ctx, policyId, 'approve_policy', reason)
);

export const rejectPolicy = spacetimedb.reducer(
  { name: 'rejectPolicy' },
  { policyId: t.u64(), reason: t.string() },
  (ctx, { policyId, reason }) => {
    requireNonEmpty('reason', reason);
    decidePolicy(ctx, policyId, 'reject_policy', reason);
  }
);

// ---------------------------------------------------------------- earned autonomy

function changeAutonomy(
  ctx: Ctx,
  policyId: bigint,
  action: 'grant_autonomy' | 'revoke_autonomy',
  reason: string,
  evidence: string | undefined
): void {
  const pol = ctx.db.policy.id.find(policyId);
  if (!pol) throw bad(`unknown policy ${policyId}`);
  transition(ctx, {
    action,
    resourceKind: 'policy',
    machine: 'autonomy',
    subjectId: pol.policyKey,
    fromState: pol.autonomy,
    before: snap(pol),
    policy: pol,
    apply: () => {
      const after = {
        ...pol,
        autonomy: TRANSITIONS.autonomy[pol.autonomy]![action]!,
        autonomyBy: ctx.sender,
        autonomyEvidence: evidence ?? pol.autonomyEvidence,
        autonomyReason: reason,
        autonomyAt: ctx.timestamp,
      };
      ctx.db.policy.id.update(after);
      return { after: snap(after) };
    },
    reason,
    evidence: evidence ?? pol.autonomyEvidence,
    policyRef: { id: pol.id, version: pol.version },
  });
}

export const grantAutonomy = spacetimedb.reducer(
  { name: 'grantAutonomy' },
  { policyId: t.u64(), evidence: t.string(), reason: t.string() },
  (ctx, { policyId, evidence, reason }) => {
    requireNonEmptyJson('evidence', evidence);
    requireNonEmpty('reason', reason);
    changeAutonomy(ctx, policyId, 'grant_autonomy', reason, evidence);
  }
);

export const revokeAutonomy = spacetimedb.reducer(
  { name: 'revokeAutonomy' },
  { policyId: t.u64(), reason: t.string() },
  (ctx, { policyId, reason }) => {
    requireNonEmpty('reason', reason);
    changeAutonomy(ctx, policyId, 'revoke_autonomy', reason, undefined);
  }
);

// ---------------------------------------------------------------- agent steps

// Not a state change and never denied: any identity holding a role may record, and the row
// is its own record (no audit row). Oversize fields are truncated, not rejected.
export const recordStep = spacetimedb.reducer(
  { name: 'recordStep' },
  {
    runId: t.string(),
    step: t.u32(),
    kind: t.string(),
    name: t.string(),
    input: t.string(),
    outputDigest: t.string(),
    outputExcerpt: t.string(),
    workItemId: t.option(t.u64()),
    model: t.option(t.string()),
  },
  (ctx, args) => {
    const actorRole = roleOf(ctx);
    if (actorRole === 'none') throw bad('recordStep requires a role: claim one with claimRole first');
    requireNonEmpty('runId', args.runId);
    if (!(STEP_KINDS as readonly string[]).includes(args.kind)) {
      throw bad(`kind must be one of ${STEP_KINDS.join(', ')}, got ${JSON.stringify(args.kind)}`);
    }
    if (args.workItemId !== undefined && !ctx.db.workItem.id.find(args.workItemId)) {
      throw bad(`unknown work item ${args.workItemId}`);
    }
    const cut = (v: string, max: number) => truncateUtf8(v, max, TRUNCATION_MARKER);
    ctx.db.agentStep.insert({
      id: 0n,
      runId: cut(args.runId, STEP_LIMITS.runId),
      actor: ctx.sender,
      actorRole,
      step: args.step,
      kind: args.kind,
      name: cut(args.name, STEP_LIMITS.name),
      input: cut(args.input, STEP_LIMITS.input),
      outputDigest: cut(args.outputDigest, STEP_LIMITS.outputDigest),
      outputExcerpt: cut(args.outputExcerpt, STEP_LIMITS.outputExcerpt),
      workItemId: args.workItemId,
      model: args.model === undefined ? undefined : cut(args.model, STEP_LIMITS.model),
      at: ctx.timestamp,
    });
  }
);
