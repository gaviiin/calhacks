// transition(): the one door every state-changing reducer goes through.
// It resolves the caller's role, checks the roles matrix, the state machine,
// separation of duties, materiality, period lock, rulebook validity and policy
// validity, then either applies the change or refuses it, and in both cases
// writes exactly one audit_log row in the same reducer transaction (plus one `reopen` row
// per work item a sync correction or a superseding policy version sent back to NEW).
// A refusal is committed (allowed=false), never thrown.
import type { InferSchema, ReducerCtx } from 'spacetimedb/server';
import type spacetimedb from './schema';
import {
  ACTION_TARGET,
  AUTONOMOUS_ROLE,
  DETERMINISTIC_SOURCE,
  MATERIALITY_ACTIONS,
  MATERIALITY_ROLE,
  PERIOD_LOCKED_ACTIONS,
  SETTING_KEYS,
  TRANSITIONS,
  can,
  type Action,
  type Machine,
  type ResourceKind,
} from './rules';
import {
  diffSnapshots,
  excerpt,
  isIntegerString,
  parsePattern,
  patternMismatches,
  snap,
  toJson,
  windowCoversDate,
  windowCoversPeriod,
  type Diff,
  type Json,
  type Snapshot,
} from './util';

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
export type WorkItem = NonNullable<ReturnType<Ctx['db']['workItem']['id']['find']>>;
export type Policy = NonNullable<ReturnType<Ctx['db']['policy']['id']['find']>>;
export type GlLine = NonNullable<ReturnType<Ctx['db']['glLine']['id']['find']>>;

export interface Proposal {
  categoryCode: string;
  rulebookEntryId: string;
  policyId?: bigint;
  capEffectUsdMinor?: bigint;
  proposalSource?: string;
}

// The proposal a PROPOSED/APPROVED item carries, re-validated at approve and post.
export function proposalOf(item: WorkItem): Proposal | undefined {
  if (item.proposedCategoryCode === undefined || item.proposedRulebookEntryId === undefined) return undefined;
  return {
    categoryCode: item.proposedCategoryCode,
    rulebookEntryId: item.proposedRulebookEntryId,
    policyId: item.proposedPolicyId,
    capEffectUsdMinor: item.capEffectUsdMinor,
    proposalSource: item.proposalSource,
  };
}

export interface PolicyDraft {
  categoryCode: string;
  rulebookEntryId: string;
  effectiveFrom: string;
}

export interface ApplyResult {
  after: Snapshot | null;
  // Side effects on other rows, keyed "table[key].column" or "table[key]".
  effects?: Diff;
  // Overrides for values only known once the write happened (e.g. a new auto-inc id).
  reason?: string;
  policyRef?: { id: bigint; version?: number };
}

export interface TransitionRequest {
  action: Action;
  resourceKind: ResourceKind;
  subjectId: string;
  // When set, (fromState, action) must be an edge of this state machine.
  machine?: Machine;
  fromState: string;
  // For resources without a machine (records, settings): the state label after the write.
  toState?: string;
  before: Snapshot | null;
  // Guards that need the subject row.
  workItem?: WorkItem;
  proposal?: Proposal;
  policy?: Policy;
  policyDraft?: PolicyDraft;
  // Performs the writes. Only called when every check passes.
  apply: () => ApplyResult;
  reason: string;
  evidence: string;
  policyRef?: { id: bigint; version?: number };
}

export interface TransitionResult {
  allowed: boolean;
  reason: string;
  auditId: bigint;
  toState: string;
}

export function roleOf(ctx: Ctx): string {
  return ctx.db.role.identity.find(ctx.sender)?.role ?? 'none';
}

export function transition(ctx: Ctx, req: TransitionRequest): TransitionResult {
  const actorRole = roleOf(ctx);
  const violations: string[] = [];

  if (!can(actorRole, req.resourceKind, req.action)) {
    violations.push(`role_not_permitted: role '${actorRole}' may not ${req.action} on ${req.resourceKind}`);
  }

  let toState = req.toState ?? req.fromState;
  if (req.machine) {
    const target = TRANSITIONS[req.machine][req.fromState]?.[req.action];
    if (target === undefined) {
      violations.push(`invalid_transition: ${req.machine} in state ${req.fromState} has no '${req.action}' transition`);
      toState = ACTION_TARGET[req.action] ?? req.fromState;
    } else {
      toState = target;
    }
  }

  violations.push(...guardViolations(ctx, actorRole, req));

  const allowed = violations.length === 0;
  let diff: Diff = {};
  let reason = violations.join('; ');
  let policyRef = req.policyRef;
  if (allowed) {
    const result = req.apply();
    diff = { ...diffSnapshots(req.before, result.after), ...(result.effects ?? {}) };
    reason = result.reason ?? req.reason;
    policyRef = result.policyRef ?? policyRef;
  }

  const row = ctx.db.auditLog.insert({
    id: 0n,
    at: ctx.timestamp,
    actor: ctx.sender,
    actorRole,
    action: req.action,
    resourceKind: req.resourceKind,
    subjectId: req.subjectId,
    allowed,
    fromState: req.fromState,
    toState,
    reason,
    diff: JSON.stringify(diff),
    evidence: req.evidence,
    policyId: policyRef?.id,
    policyVersion: policyRef?.version,
  });
  return { allowed, reason: row.reason, auditId: row.id, toState };
}

// ---------- guards ----------

function guardViolations(ctx: Ctx, actorRole: string, req: TransitionRequest): string[] {
  const v: string[] = [];
  const item = req.workItem;
  if (item) {
    if (req.action === 'approve' || req.action === 'reject') {
      if (item.proposedBy !== undefined && item.proposedBy.isEqual(ctx.sender)) {
        v.push(`separation_of_duties: caller proposed work item ${item.id} and may not ${req.action} it`);
      }
      if (item.answeredBy !== undefined && item.answeredBy.isEqual(ctx.sender)) {
        v.push(`separation_of_duties: caller answered the question on work item ${item.id} and may not ${req.action} it`);
      }
    }
    if (MATERIALITY_ACTIONS.includes(req.action) && actorRole !== MATERIALITY_ROLE) {
      const threshold = materiality(ctx);
      // Materiality is about size, not sign: a large credit (a reversal, a refund) moves the
      // cap as much as a large charge, so compare the absolute amount.
      const size = item.amountUsdMinor < 0n ? -item.amountUsdMinor : item.amountUsdMinor;
      if (threshold === undefined || size >= threshold) {
        v.push(
          `materiality: |amount_usd_minor| ${size} >= materiality_usd_minor ${threshold ?? '(unset: everything is material)'}; only ${MATERIALITY_ROLE} may ${req.action}`
        );
      }
    }
    if (PERIOD_LOCKED_ACTIONS.includes(req.action) && isLocked(ctx, item.periodKey)) {
      v.push(`period_locked: period ${item.periodKey} is locked`);
    }
    // propose checks the incoming proposal; approve and post re-run the same checks against
    // the current rows, so a rulebook reload, a new policy version or a corrected line is
    // caught before anything is decided or booked (SCHEMA section 10, defect 3).
    const revalidating = (req.action === 'approve' || req.action === 'post') && TRANSITIONS.work_item[item.state]?.[req.action] !== undefined;
    const proposal = req.proposal ?? (revalidating ? proposalOf(item) : undefined);
    if (proposal) v.push(...proposalViolations(ctx, item, proposal));
    else if (revalidating) v.push(`rulebook_invalid: work item ${item.id} carries no proposal to re-validate`);
    if (req.action === 'approve' && actorRole === AUTONOMOUS_ROLE) v.push(...standingApprovalViolations(ctx, item));
    if (req.action === 'post' && item.kind === 'reversal') v.push(...reversalViolations(ctx, item));
  }
  if (req.action === 'lock_period') v.push(...lockViolations(ctx, req.subjectId));
  if (req.policy && req.action === 'approve_policy' && req.policy.proposedBy.isEqual(ctx.sender)) {
    v.push(`separation_of_duties: caller proposed policy ${req.policy.id} and may not approve it`);
  }
  if (req.policy && req.action === 'grant_autonomy' && req.policy.state !== 'APPROVED') {
    v.push(`autonomy_invalid: policy ${req.policy.id} is ${req.policy.state}, not APPROVED`);
  }
  if (req.policyDraft) v.push(...policyDraftViolations(ctx, req.policyDraft));
  return v;
}

function proposalViolations(ctx: Ctx, item: WorkItem, p: Proposal): string[] {
  const v: string[] = [];
  const pk = item.periodKey;
  const entry = ctx.db.rulebookEntry.id.find(p.rulebookEntryId);
  if (!entry) {
    v.push(`rulebook_invalid: rulebook entry ${p.rulebookEntryId} does not exist`);
  } else {
    if (entry.categoryCode !== p.categoryCode) {
      v.push(`rulebook_invalid: entry ${entry.id} is category ${entry.categoryCode}, not ${p.categoryCode}`);
    }
    if (!windowCoversPeriod(entry.effectiveFrom, entry.effectiveTo, pk)) {
      v.push(
        `rulebook_invalid: entry ${entry.id} (in force ${entry.effectiveFrom}..${entry.effectiveTo ?? 'open'}) is not in force for period ${pk}`
      );
    }
    // Cap effect (defect 4): ADJUSTMENT treatments carry their signed effect; the others use the line.
    if (entry.treatment === 'ADJUSTMENT' && p.capEffectUsdMinor === undefined) {
      v.push(`cap_effect_invalid: entry ${entry.id} is an ADJUSTMENT; capEffectUsdMinor is required`);
    } else if (entry.treatment !== 'ADJUSTMENT' && p.capEffectUsdMinor !== undefined) {
      v.push(`cap_effect_invalid: entry ${entry.id} is ${entry.treatment}; capEffectUsdMinor must be absent (the line amount is used)`);
    }
  }
  if (p.policyId === undefined) return v;

  const pol = ctx.db.policy.id.find(p.policyId);
  if (!pol) {
    v.push(`policy_invalid: policy ${p.policyId} does not exist`);
    return v;
  }
  const tag = `policy ${pol.id} (${pol.policyKey} v${pol.version})`;
  if (pol.state !== 'APPROVED') v.push(`policy_invalid: ${tag} is ${pol.state}, not APPROVED`);
  if (pol.categoryCode !== p.categoryCode) {
    v.push(`policy_invalid: ${tag} is category ${pol.categoryCode}, not ${p.categoryCode}`);
  }
  if (!windowCoversPeriod(pol.effectiveFrom, pol.effectiveTo, pk)) {
    v.push(`policy_invalid: ${tag} (in force ${pol.effectiveFrom}..${pol.effectiveTo ?? 'open'}) is not in force for period ${pk}`);
  }
  for (const other of ctx.db.policy.policyKey.filter(pol.policyKey)) {
    if (
      other.state === 'APPROVED' &&
      other.version > pol.version &&
      windowCoversPeriod(other.effectiveFrom, other.effectiveTo, pk)
    ) {
      v.push(`policy_invalid: ${tag} is superseded by policy ${other.id} v${other.version} for period ${pk}`);
      break;
    }
  }
  const line = subjectLine(ctx, item);
  if (!line) {
    v.push(`policy_invalid: work item ${item.id} has no gl line to match ${tag} against`);
  } else {
    try {
      const pattern = parsePattern(pol.pattern);
      const vend = line.vendorId !== undefined ? ctx.db.vendor.id.find(line.vendorId) : undefined;
      const bad = patternMismatches(pattern, {
        vendorId: line.vendorId,
        accountCode: line.accountCode,
        departmentId: line.departmentId,
        memo: line.memo,
        amountUsdMinor: line.amountUsdMinor,
        relatedParty: vend?.relatedParty,
      });
      if (bad.length > 0) {
        v.push(`policy_invalid: ${tag} pattern does not match gl line ${line.id} on ${bad.join(', ')}`);
      }
    } catch {
      v.push(`policy_invalid: ${tag} has an unparsable pattern`);
    }
  }
  return v;
}

// auto_approver: the proposal must be deterministic and cite a policy that is APPROVED, in
// force for the item's period and has autonomy GRANTED (SUSPENDED and REVOKED fail here; a
// superseded version fails the re-validation above). Materiality and SoD are general guards.
function standingApprovalViolations(ctx: Ctx, item: WorkItem): string[] {
  const v: string[] = [];
  if (item.proposalSource !== DETERMINISTIC_SOURCE) {
    v.push(
      `standing_approval: work item ${item.id} proposal_source is ${JSON.stringify(item.proposalSource)}; ${AUTONOMOUS_ROLE} may only approve ${DETERMINISTIC_SOURCE} proposals`
    );
  }
  if (item.proposedPolicyId === undefined) {
    v.push(`standing_approval: work item ${item.id} cites no policy; ${AUTONOMOUS_ROLE} may only approve under a policy with autonomy GRANTED`);
    return v;
  }
  const pol = ctx.db.policy.id.find(item.proposedPolicyId);
  if (!pol) {
    v.push(`standing_approval: cited policy ${item.proposedPolicyId} does not exist`);
    return v;
  }
  const tag = `policy ${pol.id} (${pol.policyKey} v${pol.version})`;
  if (pol.state !== 'APPROVED') v.push(`standing_approval: ${tag} is ${pol.state}, not APPROVED`);
  if (!windowCoversPeriod(pol.effectiveFrom, pol.effectiveTo, item.periodKey)) {
    v.push(`standing_approval: ${tag} is not in force for period ${item.periodKey}`);
  }
  if (pol.autonomy !== 'GRANTED') v.push(`standing_approval: ${tag} autonomy is ${pol.autonomy}, not GRANTED`);
  return v;
}

// post of a reversal: the item it backs out must still be the POSTED, not yet superseded state.
function reversalViolations(ctx: Ctx, item: WorkItem): string[] {
  if (item.reversesItemId === undefined) return [`reversal_invalid: reversal ${item.id} names no reverses_item_id`];
  const rev = ctx.db.workItem.id.find(item.reversesItemId);
  if (!rev) return [`reversal_invalid: reversal ${item.id} reverses unknown work item ${item.reversesItemId}`];
  const v: string[] = [];
  if (rev.state !== 'POSTED') v.push(`reversal_invalid: reversed work item ${rev.id} is ${rev.state}, not POSTED`);
  if (rev.superseded) v.push(`reversal_invalid: reversed work item ${rev.id} is already superseded`);
  return v;
}

// lock_period (defect 8): every work item in the period must be POSTED.
function lockViolations(ctx: Ctx, periodKey: string): string[] {
  const open = [...ctx.db.workItem.periodKey.filter(periodKey)]
    .filter(it => it.state !== 'POSTED')
    .sort((a, b) => Number(a.id - b.id));
  if (open.length === 0) return [];
  const ids = open.slice(0, 10).map(it => it.id.toString());
  return [
    `period_not_ready: ${open.length} work item${open.length === 1 ? '' : 's'} in period ${periodKey} ${open.length === 1 ? 'is' : 'are'} not POSTED: ${ids.join(', ')}${open.length > ids.length ? ', …' : ''}`,
  ];
}

function policyDraftViolations(ctx: Ctx, d: PolicyDraft): string[] {
  const v: string[] = [];
  const entry = ctx.db.rulebookEntry.id.find(d.rulebookEntryId);
  if (!entry) {
    v.push(`rulebook_invalid: rulebook entry ${d.rulebookEntryId} does not exist`);
    return v;
  }
  if (entry.categoryCode !== d.categoryCode) {
    v.push(`rulebook_invalid: entry ${entry.id} is category ${entry.categoryCode}, not ${d.categoryCode}`);
  }
  if (!windowCoversDate(entry.effectiveFrom, entry.effectiveTo, d.effectiveFrom)) {
    v.push(
      `rulebook_invalid: entry ${entry.id} (in force ${entry.effectiveFrom}..${entry.effectiveTo ?? 'open'}) is not in force on ${d.effectiveFrom}`
    );
  }
  return v;
}

// ---------- lookups shared by reducers ----------

export function materiality(ctx: Ctx): bigint | undefined {
  const s = ctx.db.setting.key.find(SETTING_KEYS.materiality);
  if (!s || !isIntegerString(s.value)) return undefined;
  return BigInt(s.value.trim());
}

export function isLocked(ctx: Ctx, periodKey: string): boolean {
  return ctx.db.period.key.find(periodKey)?.locked === true;
}

export function workItemOrThrow(ctx: Ctx, id: bigint, err: (msg: string) => Error): WorkItem {
  const item = ctx.db.workItem.id.find(id);
  if (!item) throw err(`unknown work item ${id}`);
  return item;
}

// The work items of one gl line, oldest first: its classification item, then each reversal
// that reverses the item before it (reversal.subject_ref = reverses_item_id = that item's id).
// The last element is the line's latest work item (SCHEMA section 10, defect 1).
export function lineChain(ctx: Ctx, glLineId: string): WorkItem[] {
  let cur: WorkItem | undefined;
  for (const it of ctx.db.workItem.subjectRef.filter(glLineId)) {
    if (it.kind === 'classification' && (cur === undefined || it.id > cur.id)) cur = it;
  }
  if (!cur) return [];
  const chain = [cur];
  for (;;) {
    let next: WorkItem | undefined;
    for (const r of ctx.db.workItem.subjectRef.filter(cur.id.toString())) {
      if (r.kind === 'reversal' && (next === undefined || r.id > next.id)) next = r;
    }
    if (!next) return chain;
    chain.push(next);
    cur = next;
  }
}

// The gl line id a work item is about: its subject_ref for a classification; for a reversal,
// follow reverses_item_id down to the classification item.
export function lineIdOf(ctx: Ctx, item: WorkItem): string | undefined {
  let cur: WorkItem | undefined = item;
  for (let hops = 0; cur && hops < 64; hops++) {
    if (cur.kind !== 'reversal') return cur.subjectRef;
    const next: bigint | undefined = cur.reversesItemId ?? (/^\d+$/.test(cur.subjectRef) ? BigInt(cur.subjectRef) : undefined);
    cur = next === undefined ? undefined : (ctx.db.workItem.id.find(next) ?? undefined);
  }
  return undefined;
}

export function subjectLine(ctx: Ctx, item: WorkItem): GlLine | undefined {
  const id = lineIdOf(ctx, item);
  return id === undefined ? undefined : ctx.db.glLine.id.find(id) ?? undefined;
}

// Moves an open item back to NEW, clearing everything a proposal or a question wrote, and
// writes the `reopen` audit row (allowed, actor = the caller whose reducer caused it).
// Returns the updated item and the diff entries for the caller's own audit row.
export function reopenItem(ctx: Ctx, item: WorkItem, reason: string, evidenceRefs: string): { after: WorkItem; effects: Diff } {
  const after: WorkItem = {
    ...item,
    state: 'NEW',
    proposedBy: undefined,
    proposedCategoryCode: undefined,
    proposedRulebookEntryId: undefined,
    proposedPolicyId: undefined,
    capEffectUsdMinor: undefined,
    proposalSource: '',
    reason: '',
    evidenceRefs,
    question: undefined,
    answer: undefined,
    decidedBy: undefined,
    decidedReason: undefined,
    updatedAt: ctx.timestamp,
  };
  ctx.db.workItem.id.update(after);
  const pol = item.proposedPolicyId !== undefined ? ctx.db.policy.id.find(item.proposedPolicyId) : null;
  ctx.db.auditLog.insert({
    id: 0n,
    at: ctx.timestamp,
    actor: ctx.sender,
    actorRole: roleOf(ctx),
    action: 'reopen',
    resourceKind: 'work_item',
    subjectId: item.id.toString(),
    allowed: true,
    fromState: item.state,
    toState: 'NEW',
    reason,
    diff: JSON.stringify(diffSnapshots(snap(item), snap(after))),
    evidence: evidenceRefs,
    policyId: item.proposedPolicyId,
    policyVersion: pol?.version,
  });
  return { after, effects: { [`work_item[${item.id}].state`]: { from: item.state, to: 'NEW' } } };
}

export const REOPENABLE_STATES: readonly string[] = ['PROPOSED', 'NEEDS_INFO', 'APPROVED'];

export function policyRefFor(ctx: Ctx, policyId: bigint | undefined): { id: bigint; version?: number } | undefined {
  if (policyId === undefined) return undefined;
  const pol = ctx.db.policy.id.find(policyId);
  return { id: policyId, version: pol?.version };
}

// ---------- side effects (returned as diff entries) ----------

export interface CapDelta {
  relevant?: bigint;
  excluded?: bigint;
  pending?: bigint;
  posted?: number;
}

export function bumpCap(ctx: Ctx, periodKey: string, d: CapDelta): Diff {
  const existing = ctx.db.capPosition.periodKey.find(periodKey);
  const before = existing ?? {
    periodKey,
    relevantUsdMinor: 0n,
    excludedUsdMinor: 0n,
    pendingUsdMinor: 0n,
    postedItems: 0,
    updatedAt: ctx.timestamp,
  };
  const after = {
    ...before,
    relevantUsdMinor: before.relevantUsdMinor + (d.relevant ?? 0n),
    excludedUsdMinor: before.excludedUsdMinor + (d.excluded ?? 0n),
    pendingUsdMinor: before.pendingUsdMinor + (d.pending ?? 0n),
    postedItems: before.postedItems + (d.posted ?? 0),
    updatedAt: ctx.timestamp,
  };
  if (existing) ctx.db.capPosition.periodKey.update(after);
  else ctx.db.capPosition.insert(after);
  return prefixDiff(`cap_position[${periodKey}]`, existing ? snapOf(before) : null, snapOf(after));
}

export function prefixDiff(prefix: string, before: Snapshot | null, after: Snapshot | null): Diff {
  const out: Diff = {};
  for (const [k, change] of Object.entries(diffSnapshots(before, after))) out[`${prefix}.${k}`] = change;
  return out;
}

function snapOf(row: object): Snapshot {
  return toJson(row) as Snapshot;
}

export function patternSummary(ctx: Ctx, item: WorkItem): string {
  const line = subjectLine(ctx, item);
  if (!line) return JSON.stringify({ work_item_id: toJson(item.id) });
  const vend = line.vendorId !== undefined ? ctx.db.vendor.id.find(line.vendorId) : undefined;
  const summary: Record<string, Json> = {
    gl_line_id: line.id,
    vendor_id: line.vendorId ?? null,
    account_code: line.accountCode,
    department_id: line.departmentId,
    related_party: vend ? vend.relatedParty : null,
    amount_usd_minor: toJson(line.amountUsdMinor),
    memo: excerpt(line.memo),
  };
  return JSON.stringify(summary);
}

export function writePrecedent(ctx: Ctx, item: WorkItem, categoryCode: string, reason: string): Diff {
  const row = ctx.db.precedent.insert({
    id: 0n,
    workItemId: item.id,
    patternSummary: patternSummary(ctx, item),
    categoryCode,
    decidedBy: ctx.sender,
    reason,
    at: ctx.timestamp,
  });
  return { [`precedent[${row.id}]`]: { from: null, to: { category_code: categoryCode, reason } } };
}
