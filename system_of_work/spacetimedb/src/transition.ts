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
  ALLOCATED,
  APPORTIONABLE,
  AUTONOMOUS_ROLE,
  RELEVANT_CATEGORY,
  DETERMINISTIC_SOURCE,
  HUMAN_TEXT_SOURCE,
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
import { lineFacts, policyForest, precedenceViolations, subjectOf, type PolicyForest } from './rdr';

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
  // Cornerstone and parent checks (SCHEMA section 11.2), computed by the caller with
  // analyseDraft() because the same pass yields the audit evidence and the flip report.
  rdrViolations?: string[];
}

// One split of an allocated proposal (SCHEMA section 11.1): the reducer argument, or a stored row.
export interface AllocationInput {
  basis: string;
  basisRef: string;
  categoryCode: string;
  rulebookEntryId: string;
  policyId?: bigint;
  amountUsdMinor: bigint;
  capEffectUsdMinor?: bigint;
}

export type AllocationRow = NonNullable<ReturnType<Ctx['db']['allocation']['id']['find']>>;

export function allocationRowsOf(ctx: Ctx, itemId: bigint): AllocationRow[] {
  return [...ctx.db.allocation.workItemId.filter(itemId)].sort((a, b) => a.lineNo - b.lineNo);
}

export function isAllocated(item: WorkItem): boolean {
  return item.proposedCategoryCode === ALLOCATED;
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
  // proposeAllocations: the incoming split (approve/post re-validate the stored rows).
  allocations?: AllocationInput[];
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
    if (MATERIALITY_ACTIONS.includes(req.action) && actorRole !== MATERIALITY_ROLE && actorRole !== AUTONOMOUS_ROLE) {
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
    const before = v.length;
    if (req.allocations) v.push(...allocationViolations(ctx, item, req.allocations));
    else if (!req.proposal && proposal && isAllocated(item)) v.push(...allocationViolations(ctx, item, allocationRowsOf(ctx, item.id)));
    else if (proposal) v.push(...proposalViolations(ctx, item, proposal));
    else if (revalidating) v.push(`rulebook_invalid: work item ${item.id} carries no proposal to re-validate`);
    // Category limits (SCHEMA section 11.1): checked at propose and approve, so an over-limit
    // proposal is denied up front, and again at post, since the limit can be consumed between
    // approve and post. Only for an otherwise valid proposal: the bookings need its entries.
    if (v.length === before && (revalidating || (req.action === 'propose' && (req.allocations || req.proposal)))) {
      const planned = req.allocations
        ? bookingsOf(ctx, item, req.allocations)
        : req.proposal
          ? bookingsOf(ctx, item, [{ ...req.proposal, amountUsdMinor: item.amountUsdMinor }])
          : plannedBookings(ctx, item);
      v.push(...limitViolations(ctx, item, planned, req.action === 'post' ? 'post' : 'proposal'));
    }
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
  if (req.policyDraft) v.push(...policyDraftViolations(ctx, req.policyDraft), ...(req.policyDraft.rdrViolations ?? []));
  return v;
}

function proposalViolations(ctx: Ctx, item: WorkItem, p: Proposal): string[] {
  return citationViolations(ctx, item, p, subjectLine(ctx, item), undefined, '');
}

// The checks for one citation (a whole-line proposal, or one allocation with `label` set):
// rulebook entry exists, is of the category and in force for the period; cap effect present
// exactly for ADJUSTMENT; and, when a policy is cited, the policy is APPROVED, same category, in
// force, not superseded, its pattern matches (for a bill-line allocation, description_regex is
// matched against that bill line), and then the RDR precedence checks (SCHEMA section 11.2):
// its ancestors apply, no approved child applies (exception_applies), and the resolution for the
// line is this policy (policy_conflict).
function citationViolations(
  ctx: Ctx,
  item: WorkItem,
  p: { categoryCode: string; rulebookEntryId: string; policyId?: bigint; capEffectUsdMinor?: bigint },
  line: GlLine | undefined,
  billLineId: string | undefined,
  label: string,
  forest?: PolicyForest
): string[] {
  const v: string[] = [];
  const L = label;
  const pk = item.periodKey;
  const entry = ctx.db.rulebookEntry.id.find(p.rulebookEntryId);
  if (!entry) {
    v.push(`rulebook_invalid: ${L}rulebook entry ${p.rulebookEntryId} does not exist`);
  } else {
    if (entry.categoryCode !== p.categoryCode) {
      v.push(`rulebook_invalid: ${L}entry ${entry.id} is category ${entry.categoryCode}, not ${p.categoryCode}`);
    }
    if (!windowCoversPeriod(entry.effectiveFrom, entry.effectiveTo, pk)) {
      v.push(
        `rulebook_invalid: ${L}entry ${entry.id} (in force ${entry.effectiveFrom}..${entry.effectiveTo ?? 'open'}) is not in force for period ${pk}`
      );
    }
    // Cap effect (defect 4): ADJUSTMENT treatments carry their signed effect; the others use the line.
    if (entry.treatment === 'ADJUSTMENT' && p.capEffectUsdMinor === undefined) {
      v.push(`cap_effect_invalid: ${L}entry ${entry.id} is an ADJUSTMENT; capEffectUsdMinor is required`);
    } else if (entry.treatment !== 'ADJUSTMENT' && p.capEffectUsdMinor !== undefined) {
      v.push(`cap_effect_invalid: ${L}entry ${entry.id} is ${entry.treatment}; capEffectUsdMinor must be absent (the line amount is used)`);
    }
  }
  if (p.policyId === undefined) return v;

  const pol = ctx.db.policy.id.find(p.policyId);
  if (!pol) {
    v.push(`policy_invalid: ${L}policy ${p.policyId} does not exist`);
    return v;
  }
  const policyStart = v.length;
  const tag = `policy ${pol.id} (${pol.policyKey} v${pol.version})`;
  if (pol.state !== 'APPROVED') v.push(`policy_invalid: ${L}${tag} is ${pol.state}, not APPROVED`);
  if (pol.categoryCode !== p.categoryCode) {
    v.push(`policy_invalid: ${L}${tag} is category ${pol.categoryCode}, not ${p.categoryCode}`);
  }
  if (!windowCoversPeriod(pol.effectiveFrom, pol.effectiveTo, pk)) {
    v.push(`policy_invalid: ${L}${tag} (in force ${pol.effectiveFrom}..${pol.effectiveTo ?? 'open'}) is not in force for period ${pk}`);
  }
  for (const other of ctx.db.policy.policyKey.filter(pol.policyKey)) {
    if (
      other.state === 'APPROVED' &&
      other.version > pol.version &&
      windowCoversPeriod(other.effectiveFrom, other.effectiveTo, pk)
    ) {
      v.push(`policy_invalid: ${L}${tag} is superseded by policy ${other.id} v${other.version} for period ${pk}`);
      break;
    }
  }
  if (!line) {
    v.push(`policy_invalid: ${L}work item ${item.id} has no gl line to match ${tag} against`);
    return v;
  }
  try {
    const pattern = parsePattern(pol.pattern);
    const bad = patternMismatches(pattern, subjectOf(lineFacts(ctx, line), billLineId));
    if (bad.length > 0) {
      const where = billLineId === undefined ? `gl line ${line.id}` : `bill line ${billLineId} of gl line ${line.id}`;
      v.push(`policy_invalid: ${L}${tag} pattern does not match ${where} on ${bad.join(', ')}`);
    }
  } catch {
    v.push(`policy_invalid: ${L}${tag} has an unparsable pattern`);
  }
  // RDR precedence only for a citation that is otherwise valid, so each denial names one cause.
  if (v.length === policyStart) v.push(...precedenceViolations(ctx, pol, line, pk, billLineId, L, forest ?? policyForest(ctx)));
  return v;
}

// ---------- allocations (SCHEMA section 11.1) ----------

const SHARE_REF = /^(.+):(0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/;

function parseShare(ref: string): { departmentId: string; num: bigint; den: bigint } | undefined {
  const m = SHARE_REF.exec(ref.trim());
  if (!m) return undefined;
  const [whole, frac = ''] = m[2]!.split('.');
  const den = 10n ** BigInt(frac.length);
  return { departmentId: m[1]!, num: BigInt(whole || '0') * den + BigInt(frac || '0'), den };
}

// The rulebook entry of `categoryCode` in force for the whole period that carries a cap limit.
export function limitedEntry(ctx: Ctx, categoryCode: string, periodKey: string) {
  for (const e of ctx.db.rulebookEntry.categoryCode.filter(categoryCode)) {
    if (e.capLimitUsdMinor !== undefined && windowCoversPeriod(e.effectiveFrom, e.effectiveTo, periodKey)) return e;
  }
  return undefined;
}

export function capYearOf(periodKey: string): number {
  return Number(periodKey.slice(0, 4));
}

export function limitKey(capYear: number, categoryCode: string): string {
  return `${capYear}|${categoryCode}`;
}

function ledgerExcluded(ctx: Ctx, capYear: number, categoryCode: string): bigint {
  return ctx.db.limitLedger.key.find(limitKey(capYear, categoryCode))?.excludedUsdMinor ?? 0n;
}

export function allocationViolations(ctx: Ctx, item: WorkItem, allocs: AllocationInput[]): string[] {
  const v: string[] = [];
  if (allocs.length < 2) v.push(`allocation_invalid: at least two allocations are required, got ${allocs.length}`);
  const sum = allocs.reduce((s, a) => s + a.amountUsdMinor, 0n);
  if (sum !== item.amountUsdMinor) {
    v.push(`allocation_sum_mismatch: allocations sum to ${sum}, work item ${item.id} amount_usd_minor is ${item.amountUsdMinor}`);
  }
  const line = subjectLine(ctx, item);
  if (!line) {
    v.push(`allocation_invalid: work item ${item.id} has no gl line to allocate`);
    return v;
  }
  const billLines = [...ctx.db.billLine.glLineId.filter(line.id)];
  const used = new Map<string, number>();
  const forest = policyForest(ctx);
  const pk = item.periodKey;
  allocs.forEach((a, i) => {
    const n = i + 1;
    const L = `allocation ${n}: `;
    let billLineId: string | undefined;
    switch (a.basis) {
      case 'bill_line': {
        const bl = ctx.db.billLine.id.find(a.basisRef);
        if (!bl || bl.glLineId !== line.id) {
          v.push(`allocation_invalid: ${L}${a.basisRef} is not a bill line of gl line ${line.id}`);
        } else if (used.has(a.basisRef)) {
          v.push(`allocation_invalid: ${L}bill line ${a.basisRef} is already used by allocation ${used.get(a.basisRef)}`);
        } else {
          used.set(a.basisRef, n);
          billLineId = a.basisRef;
        }
        break;
      }
      case 'share': {
        const share = parseShare(a.basisRef);
        if (!APPORTIONABLE.includes(a.categoryCode) && a.categoryCode !== RELEVANT_CATEGORY) {
          v.push(
            `apportionment_not_permitted: ${L}${a.categoryCode} must be Directly Attributable; only ${APPORTIONABLE.join(', ')} (and their ${RELEVANT_CATEGORY} complement) may be apportioned by a share`
          );
        }
        if (!share) {
          v.push(`allocation_invalid: ${L}share basis_ref ${JSON.stringify(a.basisRef)} must be "<department_id>:<share between 0 and 1>"`);
        } else {
          // amount = line total x share, to within one minor unit (either side may round).
          const diff = a.amountUsdMinor * share.den - item.amountUsdMinor * share.num;
          if ((diff < 0n ? -diff : diff) > share.den) {
            v.push(`allocation_invalid: ${L}amount ${a.amountUsdMinor} is not ${a.basisRef.split(':').pop()} of ${item.amountUsdMinor}`);
          }
        }
        break;
      }
      case 'cap_limit': {
        // The within-limit part of a split at a category limit: the limited EXCLUDED category itself.
        if (a.categoryCode !== a.basisRef) {
          v.push(`allocation_invalid: ${L}a cap_limit allocation is in its basis_ref category ${a.basisRef}, not ${a.categoryCode}`);
        }
        if (!limitedEntry(ctx, a.basisRef, pk)) {
          v.push(`allocation_invalid: ${L}category ${a.basisRef} has no cap limit in force for period ${pk}`);
        }
        break;
      }
      case 'cap_limit_excess': {
        if (a.categoryCode !== RELEVANT_CATEGORY) {
          v.push(`allocation_invalid: ${L}a cap_limit_excess allocation is ${RELEVANT_CATEGORY}, not ${a.categoryCode}`);
        }
        if (!limitedEntry(ctx, a.basisRef, pk)) {
          v.push(`allocation_invalid: ${L}category ${a.basisRef} has no cap limit in force for period ${pk}`);
          break;
        }
        // The within-limit sibling: one cap_limit allocation, or bill-line allocations, in that category.
        if (!allocs.some(o => o !== a && o.categoryCode === a.basisRef && (o.basis === 'cap_limit' || o.basis === 'bill_line'))) {
          v.push(`allocation_invalid: ${L}cap_limit_excess of ${a.basisRef} needs a sibling allocation in ${a.basisRef} (basis cap_limit or bill_line)`);
        }
        break;
      }
      default:
        v.push(`allocation_invalid: ${L}unknown basis ${JSON.stringify(a.basis)}`);
    }
    v.push(...citationViolations(ctx, item, a, line, billLineId, L, forest));
  });
  if (allocs.some(a => a.basis === 'bill_line')) {
    const missing = billLines.filter(b => !used.has(b.id)).map(b => b.id).sort();
    if (missing.length > 0) v.push(`allocation_invalid: bill-line allocations must cover every bill line of gl line ${line.id}; missing ${missing.join(', ')}`);
  }
  // A split at a limit: per category, exactly one cap_limit and exactly one cap_limit_excess.
  const limitCats = new Set(allocs.filter(a => a.basis === 'cap_limit' || a.basis === 'cap_limit_excess').map(a => a.basisRef));
  for (const cat of [...limitCats].sort()) {
    const within = allocs.filter(a => a.basis === 'cap_limit' && a.basisRef === cat).length;
    const excess = allocs.filter(a => a.basis === 'cap_limit_excess' && a.basisRef === cat).length;
    if (within > 1) v.push(`allocation_invalid: ${within} cap_limit allocations for ${cat}; a split at a limit has exactly one`);
    if (excess > 1) v.push(`allocation_invalid: ${excess} cap_limit_excess allocations for ${cat}; a split at a limit has exactly one`);
    if (within >= 1 && excess === 0) v.push(`allocation_invalid: the cap_limit allocation for ${cat} needs a cap_limit_excess allocation for the rest (else propose the whole line)`);
  }
  const shares = allocs.filter(a => a.basis === 'share');
  if (shares.some(a => a.categoryCode === RELEVANT_CATEGORY) && !shares.some(a => APPORTIONABLE.includes(a.categoryCode))) {
    v.push(`apportionment_not_permitted: a ${RELEVANT_CATEGORY} share is only the complement of an apportioned ${APPORTIONABLE.join(' or ')} share`);
  }
  return v;
}

// ---------- bookings: what post books, and what a reversal backs out ----------

export interface Booking {
  allocationId?: bigint;
  categoryCode: string;
  treatment: string;
  effect: bigint;
  capYear: number;
  capLimit?: bigint;
}

// What posting `item` books, from its (re-validated) proposal: the line amount for RELEVANT and
// EXCLUDED, the signed cap effect for an ADJUSTMENT; one booking per allocation for an allocated item.
export function plannedBookings(ctx: Ctx, item: WorkItem): Booking[] {
  if (isAllocated(item)) return bookingsOf(ctx, item, allocationRowsOf(ctx, item.id));
  return bookingsOf(ctx, item, [
    { categoryCode: item.proposedCategoryCode!, rulebookEntryId: item.proposedRulebookEntryId!, amountUsdMinor: item.amountUsdMinor, capEffectUsdMinor: item.capEffectUsdMinor },
  ]);
}

// Bookings for a list of citations (stored allocation rows carry their id). Citations whose
// rulebook entry does not exist are skipped (validation reports them).
export function bookingsOf(
  ctx: Ctx,
  item: WorkItem,
  cites: { id?: bigint; categoryCode: string; rulebookEntryId: string; amountUsdMinor: bigint; capEffectUsdMinor?: bigint }[]
): Booking[] {
  const year = capYearOf(item.periodKey);
  const out: Booking[] = [];
  for (const c of cites) {
    const entry = ctx.db.rulebookEntry.id.find(c.rulebookEntryId);
    if (!entry) continue;
    const effect = entry.treatment === 'ADJUSTMENT' ? c.capEffectUsdMinor ?? c.amountUsdMinor : c.amountUsdMinor;
    out.push({ allocationId: c.id, categoryCode: c.categoryCode, treatment: entry.treatment, effect, capYear: year, capLimit: entry.capLimitUsdMinor });
  }
  return out;
}

// What a POSTED item actually booked (its posted_* columns, per allocation for an allocated item).
export function bookedBookings(ctx: Ctx, item: WorkItem): Booking[] {
  const year = capYearOf(item.periodKey);
  if (item.postedTreatment === ALLOCATED) {
    return allocationRowsOf(ctx, item.id)
      .filter(a => a.postedTreatment !== undefined && a.postedCapEffectUsdMinor !== undefined)
      .map(a => ({ allocationId: a.id, categoryCode: a.categoryCode, treatment: a.postedTreatment!, effect: a.postedCapEffectUsdMinor!, capYear: year }));
  }
  if (item.postedTreatment === undefined || item.postedCapEffectUsdMinor === undefined) return [];
  return [{ categoryCode: item.proposedCategoryCode ?? '', treatment: item.postedTreatment, effect: item.postedCapEffectUsdMinor, capYear: year }];
}

// limit_ledger deltas of posting `item`: its EXCLUDED bookings, minus what a reversal backs out.
export function ledgerDeltas(
  ctx: Ctx,
  item: WorkItem,
  planned: Booking[] = plannedBookings(ctx, item)
): Map<string, { capYear: number; categoryCode: string; delta: bigint }> {
  const out = new Map<string, { capYear: number; categoryCode: string; delta: bigint }>();
  const add = (b: Booking, sign: bigint) => {
    if (b.treatment !== 'EXCLUDED') return;
    const key = limitKey(b.capYear, b.categoryCode);
    const cur = out.get(key) ?? { capYear: b.capYear, categoryCode: b.categoryCode, delta: 0n };
    cur.delta += sign * b.effect;
    out.set(key, cur);
  };
  for (const b of planned) add(b, 1n);
  const rev = reversedItem(ctx, item);
  if (rev) for (const b of bookedBookings(ctx, rev)) add(b, -1n);
  return out;
}

// The POSTED, not yet superseded item a reversal backs out (undefined otherwise).
export function reversedItem(ctx: Ctx, item: WorkItem): WorkItem | undefined {
  if (item.kind !== 'reversal' || item.reversesItemId === undefined) return undefined;
  const rev = ctx.db.workItem.id.find(item.reversesItemId);
  return rev && rev.state === 'POSTED' && !rev.superseded ? rev : undefined;
}

// A category with a cap limit may not go past it for the cap year (net of what a reversal backs out).
function limitViolations(ctx: Ctx, item: WorkItem, planned: Booking[], verb: 'proposal' | 'post'): string[] {
  const v: string[] = [];
  const deltas = ledgerDeltas(ctx, item, planned);
  const seen = new Set<string>();
  for (const b of planned) {
    const key = limitKey(b.capYear, b.categoryCode);
    if (b.treatment !== 'EXCLUDED' || b.capLimit === undefined || seen.has(key)) continue;
    seen.add(key);
    const delta = deltas.get(key)?.delta ?? 0n;
    const current = ledgerExcluded(ctx, b.capYear, b.categoryCode);
    if (delta > 0n && current + delta > b.capLimit) {
      v.push(
        `cap_limit_exceeded: remaining ${b.capLimit - current} (${b.categoryCode} ${b.capYear}: limit ${b.capLimit}, posted ${current}, this ${verb} adds ${delta}); split the excess with cap_limit + cap_limit_excess allocations`
      );
    }
  }
  return v;
}

// auto_approver approves what an approved rule decided, at any amount: a person is needed only
// where no rule covers the line. Allowed: a deterministic proposal whose every citation (the whole
// line, or each bill-line allocation; a cap_limit_excess split is computed by rule beside its
// sibling) is a policy that is APPROVED, in force and keeps its standing approval (autonomy
// GRANTED, given with approval, withdrawn by revoke, SUSPENDED by a newer version); or a proposal
// built from a person's answer on this very line (human_text with answered_by on record). Never a
// Claude proposal: no rule covered that line, so a person decides it once and may teach the rule.
function standingApprovalViolations(ctx: Ctx, item: WorkItem): string[] {
  const v: string[] = [];
  if (item.proposalSource === HUMAN_TEXT_SOURCE) {
    if (item.answeredBy === undefined) v.push(`standing_approval: work item ${item.id} has a human_text proposal but no answer on record`);
    return v;
  }
  if (item.proposalSource !== DETERMINISTIC_SOURCE) {
    v.push(
      `standing_approval: work item ${item.id} proposal_source is ${JSON.stringify(item.proposalSource)}; no approved rule decided it, so a person does`
    );
    return v;
  }
  const cites: { policyId?: bigint; basis: string; label: string }[] = isAllocated(item)
    ? allocationRowsOf(ctx, item.id).map(a => ({ policyId: a.policyId, basis: a.basis, label: `allocation ${a.lineNo}` }))
    : [{ policyId: item.proposedPolicyId, basis: 'line', label: 'the proposal' }];
  for (const c of cites) {
    if (c.basis === 'cap_limit_excess') continue;
    if (c.policyId === undefined) {
      v.push(`standing_approval: work item ${item.id}: ${c.label} cites no policy; a person decides it`);
      continue;
    }
    const pol = ctx.db.policy.id.find(c.policyId);
    if (!pol) {
      v.push(`standing_approval: cited policy ${c.policyId} does not exist`);
      continue;
    }
    const tag = `policy ${pol.id} (${pol.policyKey} v${pol.version})`;
    if (pol.state !== 'APPROVED') v.push(`standing_approval: ${tag} is ${pol.state}, not APPROVED`);
    if (!windowCoversPeriod(pol.effectiveFrom, pol.effectiveTo, item.periodKey)) {
      v.push(`standing_approval: ${tag} is not in force for period ${item.periodKey}`);
    }
    if (pol.autonomy !== 'GRANTED') v.push(`standing_approval: ${tag} standing approval is ${pol.autonomy}, not GRANTED`);
  }
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
  // An allocated proposal's split goes with it (rows of an open item are never posted).
  for (const a of allocationRowsOf(ctx, item.id)) ctx.db.allocation.id.delete(a.id);
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
