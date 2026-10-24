// Policies as Ripple-Down Rules (SCHEMA.md section 11.2).
//
// A policy applies to a line when its own pattern matches and its parent applies (recursively).
// Only APPROVED, in-force, non-superseded policies take part. The conclusions for a line are the
// applicable policies none of whose applicable children apply. Conclusions that agree on category
// resolve to it, citing the deepest (ties: lowest id); conclusions that disagree resolve to the one
// that strictly refines all the others (its effective pattern, its own keys plus its ancestors',
// is a strict superset with equal values), else to `conflict`.
//
// `resolve(ctx, line, period, billLineId?)` is the one implementation; the module's validation
// (propose, proposeAllocations, approve, post), the flip report and the approval side effects all
// go through PolicyForest, and test/rdr_conformance.test.ts runs rulebook/rdr_conformance.json
// through resolve(). The agents' Python resolver runs the same file.
import type { Ctx, GlLine, Policy, WorkItem } from './transition';
import { ALLOCATED } from './rules';
import { parsePattern, patternMismatches, toJson, windowCoversPeriod, type Json, type Pattern, type PatternSubject } from './util';

export interface PolicyNode {
  id: bigint;
  policyKey: string;
  version: number;
  categoryCode: string;
  rulebookEntryId: string;
  pattern: string;
  parentPolicyId?: bigint;
  state: string;
  effectiveFrom: string;
  effectiveTo?: string;
}

export interface LineFacts {
  id: string;
  vendorId?: string;
  accountCode: string;
  departmentId: string;
  memo: string;
  amountUsdMinor: bigint;
  relatedParty?: boolean; // undefined when the vendor row is unknown
  entity: string;
  erpCategoryCode: string;
  billLines: { id: string; description: string }[];
}

export type Resolution =
  | { result: 'none'; applicable: bigint[]; conclusions: bigint[] }
  | { result: 'category'; categoryCode: string; policyId: bigint; applicable: bigint[]; conclusions: bigint[] }
  | { result: 'conflict'; applicable: bigint[]; conclusions: bigint[] };

const byId = (a: { id: bigint }, b: { id: bigint }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The pattern subject for a line: description_regex is matched against the one bill line of an
// allocation context, or against every bill line of the line (none: never matches).
export function subjectOf(f: LineFacts, billLineId?: string): PatternSubject {
  const descriptions =
    billLineId === undefined
      ? f.billLines.map(b => b.description)
      : f.billLines.filter(b => b.id === billLineId).map(b => b.description);
  return {
    vendorId: f.vendorId,
    accountCode: f.accountCode,
    departmentId: f.departmentId,
    memo: f.memo,
    amountUsdMinor: f.amountUsdMinor,
    relatedParty: f.relatedParty,
    entity: f.entity,
    erpCategoryCode: f.erpCategoryCode,
    descriptions,
  };
}

export class PolicyForest {
  readonly nodes: PolicyNode[];
  readonly byId = new Map<bigint, PolicyNode>();
  readonly childrenOf = new Map<bigint, PolicyNode[]>();
  private readonly patterns = new Map<string, Pattern | null>();

  constructor(nodes: PolicyNode[]) {
    this.nodes = [...nodes].sort(byId);
    for (const n of this.nodes) this.byId.set(n.id, n);
    for (const n of this.nodes) {
      if (n.parentPolicyId === undefined) continue;
      const list = this.childrenOf.get(n.parentPolicyId) ?? [];
      list.push(n);
      this.childrenOf.set(n.parentPolicyId, list);
    }
  }

  // null when the stored pattern no longer parses under the current rules (it then applies nowhere).
  pattern(n: PolicyNode): Pattern | null {
    if (!this.patterns.has(n.pattern)) {
      let p: Pattern | null;
      try {
        p = parsePattern(n.pattern);
      } catch {
        p = null;
      }
      this.patterns.set(n.pattern, p);
    }
    return this.patterns.get(n.pattern)!;
  }

  // APPROVED, in force for the whole period, and not superseded by a higher APPROVED version of
  // the same policy_key in force for the period.
  private readonly participating = new Map<string, Map<bigint, boolean>>();

  participates(n: PolicyNode, period: string): boolean {
    let byPeriod = this.participating.get(period);
    if (!byPeriod) {
      byPeriod = new Map();
      this.participating.set(period, byPeriod);
    }
    let yes = byPeriod.get(n.id);
    if (yes === undefined) {
      yes = this.participatesUncached(n, period);
      byPeriod.set(n.id, yes);
    }
    return yes;
  }

  private participatesUncached(n: PolicyNode, period: string): boolean {
    if (n.state !== 'APPROVED' || !windowCoversPeriod(n.effectiveFrom, n.effectiveTo, period)) return false;
    return !this.nodes.some(
      o =>
        o.policyKey === n.policyKey &&
        o.version > n.version &&
        o.state === 'APPROVED' &&
        windowCoversPeriod(o.effectiveFrom, o.effectiveTo, period)
    );
  }

  ownMatches(n: PolicyNode, f: LineFacts, billLineId?: string): boolean {
    const p = this.pattern(n);
    return p !== null && patternMismatches(p, subjectOf(f, billLineId)).length === 0;
  }

  // Own pattern and every ancestor applies, ignoring whether `n` itself takes part (used for a
  // draft policy's cornerstones). Ancestors must take part.
  appliesIgnoringOwnState(n: PolicyNode, f: LineFacts, period: string, billLineId?: string): boolean {
    if (!this.ownMatches(n, f, billLineId)) return false;
    if (n.parentPolicyId === undefined) return true;
    const parent = this.byId.get(n.parentPolicyId);
    return parent !== undefined && this.applies(parent, f, period, billLineId);
  }

  applies(n: PolicyNode, f: LineFacts, period: string, billLineId?: string, seen: Set<bigint> = new Set()): boolean {
    if (seen.has(n.id)) return false; // a cycle cannot be built through the reducers; refuse it anyway
    seen.add(n.id);
    if (!this.participates(n, period) || !this.ownMatches(n, f, billLineId)) return false;
    if (n.parentPolicyId === undefined) return true;
    const parent = this.byId.get(n.parentPolicyId);
    return parent !== undefined && this.applies(parent, f, period, billLineId, seen);
  }

  ancestors(n: PolicyNode): PolicyNode[] {
    const out: PolicyNode[] = [];
    let cur = n.parentPolicyId === undefined ? undefined : this.byId.get(n.parentPolicyId);
    while (cur && out.length < 64 && !out.includes(cur)) {
      out.push(cur);
      cur = cur.parentPolicyId === undefined ? undefined : this.byId.get(cur.parentPolicyId);
    }
    return out;
  }

  depth(n: PolicyNode): number {
    return this.ancestors(n).length;
  }

  // The conjunction of a policy's own and its ancestors' keys, as "key=value" strings.
  effectivePattern(n: PolicyNode): Set<string> {
    const out = new Set<string>();
    for (const m of [n, ...this.ancestors(n)]) {
      const p = this.pattern(m);
      if (!p) continue;
      for (const [k, v] of Object.entries(p)) if (v !== undefined) out.add(`${k}=${JSON.stringify(toJson(v))}`);
    }
    return out;
  }

  refinesStrictly(a: PolicyNode, b: PolicyNode): boolean {
    const ea = this.effectivePattern(a);
    const eb = this.effectivePattern(b);
    if (ea.size <= eb.size) return false;
    for (const k of eb) if (!ea.has(k)) return false;
    return true;
  }

  applicableChildren(n: PolicyNode, f: LineFacts, period: string, billLineId?: string): PolicyNode[] {
    return (this.childrenOf.get(n.id) ?? []).filter(c => this.applies(c, f, period, billLineId));
  }

  resolve(f: LineFacts, period: string, billLineId?: string): Resolution {
    const applicable = this.nodes.filter(n => this.applies(n, f, period, billLineId));
    const appIds = new Set(applicable.map(n => n.id));
    const conclusions = applicable.filter(n => !(this.childrenOf.get(n.id) ?? []).some(c => appIds.has(c.id)));
    const ids = { applicable: applicable.map(n => n.id), conclusions: conclusions.map(n => n.id) };
    if (conclusions.length === 0) return { result: 'none', ...ids };
    const categories = new Set(conclusions.map(n => n.categoryCode));
    if (categories.size === 1) {
      const pick = [...conclusions].sort((a, b) => this.depth(b) - this.depth(a) || byId(a, b))[0]!;
      return { result: 'category', categoryCode: pick.categoryCode, policyId: pick.id, ...ids };
    }
    const refining = conclusions.find(c => conclusions.every(o => o === c || this.refinesStrictly(c, o)));
    if (refining) return { result: 'category', categoryCode: refining.categoryCode, policyId: refining.id, ...ids };
    return { result: 'conflict', ...ids };
  }
}

// ---------- adapters over the module's tables ----------

export function policyNode(p: Policy): PolicyNode {
  return {
    id: p.id,
    policyKey: p.policyKey,
    version: p.version,
    categoryCode: p.categoryCode,
    rulebookEntryId: p.rulebookEntryId,
    pattern: p.pattern,
    parentPolicyId: p.parentPolicyId,
    state: p.state,
    effectiveFrom: p.effectiveFrom,
    effectiveTo: p.effectiveTo,
  };
}

export function policyForest(ctx: Ctx, extra: PolicyNode[] = []): PolicyForest {
  return new PolicyForest([...[...ctx.db.policy.iter()].map(policyNode), ...extra]);
}

export function lineFacts(ctx: Ctx, line: GlLine): LineFacts {
  const vend = line.vendorId !== undefined ? ctx.db.vendor.id.find(line.vendorId) : undefined;
  const billLines = [...ctx.db.billLine.glLineId.filter(line.id)]
    .sort((a, b) => a.lineNo - b.lineNo || (a.id < b.id ? -1 : 1))
    .map(b => ({ id: b.id, description: b.description }));
  return {
    id: line.id,
    vendorId: line.vendorId,
    accountCode: line.accountCode,
    departmentId: line.departmentId,
    memo: line.memo,
    amountUsdMinor: line.amountUsdMinor,
    relatedParty: vend ? vend.relatedParty : undefined,
    entity: line.entity,
    erpCategoryCode: line.erpCategoryCode,
    billLines,
  };
}

// The resolution for a gl line in a period. With billLineId, description_regex is matched against
// that one bill line (allocation context). `opts.forest` reuses a forest across many lines;
// `opts.extra` adds hypothetical policies (the flip report's draft).
export function resolve(
  ctx: Ctx,
  line: GlLine,
  period: string,
  billLineId?: string,
  opts: { forest?: PolicyForest; extra?: PolicyNode[] } = {}
): Resolution {
  const forest = opts.forest ?? policyForest(ctx, opts.extra);
  return forest.resolve(lineFacts(ctx, line), period, billLineId);
}

const pol = (id: bigint) => `pol-${id}`;

// propose / proposeAllocations / approve / post citing policy `cited` (already checked to exist,
// be APPROVED, in force, not superseded and matching on its own pattern): its ancestors must apply,
// no approved child of it may apply (exception_applies), and the resolution for the line must be
// exactly this policy (policy_conflict). `label` prefixes allocation messages.
export function precedenceViolations(
  ctx: Ctx,
  cited: Policy,
  line: GlLine,
  period: string,
  billLineId: string | undefined,
  label: string,
  forest: PolicyForest = policyForest(ctx)
): string[] {
  const node = forest.byId.get(cited.id);
  if (!node) return [];
  const facts = lineFacts(ctx, line);
  const tag = `policy ${cited.id} (${cited.policyKey} v${cited.version})`;
  const where = billLineId === undefined ? `gl line ${line.id}` : `bill line ${billLineId} of gl line ${line.id}`;
  for (const anc of forest.ancestors(node)) {
    if (!forest.applies(anc, facts, period, billLineId)) {
      return [`policy_invalid: ${label}${tag} applies only where its parent does, and ancestor ${pol(anc.id)} does not apply to ${where}`];
    }
  }
  const children = forest.applicableChildren(node, facts, period, billLineId);
  if (children.length > 0) {
    return [`exception_applies: ${children.map(c => pol(c.id)).join(', ')}${label ? ` (${label.replace(/: $/, '')})` : ''}`];
  }
  const res = forest.resolve(facts, period, billLineId);
  const lab = label ? `${label}` : '';
  if (res.result === 'conflict') {
    const list = res.conclusions.map(id => `${pol(id)} (${forest.byId.get(id)!.categoryCode})`).join(', ');
    return [`policy_conflict: ${lab}resolution for ${where} is a conflict between ${list}; ask instead`];
  }
  if (res.result === 'category' && res.policyId !== cited.id) {
    return [`policy_conflict: ${lab}resolution for ${where} cites ${pol(res.policyId)} (${res.categoryCode}), not ${pol(cited.id)}`];
  }
  return [];
}

// ---------- the citations a work item carries ----------

export interface Citation {
  categoryCode: string;
  policyId?: bigint;
  billLineId?: string; // bill_line allocations
  basis?: string; // set for allocations
}

export function citationsOf(ctx: Ctx, item: WorkItem): Citation[] {
  if (item.proposedCategoryCode === undefined) return [];
  if (item.proposedCategoryCode !== ALLOCATED) return [{ categoryCode: item.proposedCategoryCode, policyId: item.proposedPolicyId }];
  return [...ctx.db.allocation.workItemId.filter(item.id)]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map(a => ({
      categoryCode: a.categoryCode,
      policyId: a.policyId,
      billLineId: a.basis === 'bill_line' ? a.basisRef : undefined,
      basis: a.basis,
    }));
}

// ---------- cornerstones and the flip report (proposePolicy) ----------

export interface Cornerstone {
  ref: string;
  category_code: string;
}

// Malformed cornerstones are a caller error (thrown by the reducer), so this returns the reason.
export function parseCornerstones(text: string): Cornerstone[] | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'cornerstones must be a JSON array string';
  }
  if (!Array.isArray(raw)) return 'cornerstones must be a JSON array of {"ref", "category_code"} objects';
  const out: Cornerstone[] = [];
  for (const c of raw) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) return 'each cornerstone must be an object {"ref", "category_code"}';
    const { ref, category_code } = c as Record<string, unknown>;
    if (typeof ref !== 'string' || ref.trim() === '') return 'cornerstone.ref must be a non-empty string';
    if (typeof category_code !== 'string' || category_code.trim() === '') return 'cornerstone.category_code must be a non-empty string';
    out.push({ ref, category_code });
  }
  return out;
}

export interface FlipReport {
  open: bigint[];
  posted_open_period: bigint[];
  posted_locked: bigint[];
  usd_minor_by_state: Record<string, bigint>;
}

export function flipReportJson(r: FlipReport): Json {
  const by: Record<string, Json> = {};
  for (const [k, v] of Object.entries(r.usd_minor_by_state)) by[k] = toJson(v);
  return {
    open: r.open.map(id => toJson(id)),
    posted_open_period: r.posted_open_period.map(id => toJson(id)),
    posted_locked: r.posted_locked.map(id => toJson(id)),
    usd_minor_by_state: by,
  };
}

export interface Flip {
  item: WorkItem;
  line: GlLine;
  from: string;
  to: string;
}

const FLIP_STATES = ['PROPOSED', 'APPROVED', 'POSTED'];

// Work items whose line `forest` resolves to policy `targetId` with a category different from the
// one the item carries (per bill-line allocation for allocated items; share and cap_limit_excess
// allocations are not line-level classifications and are skipped). Items carrying no category
// (NEW, NEEDS_INFO, REJECTED) and superseded POSTED items are not listed.
export function flips(ctx: Ctx, forest: PolicyForest, targetId: bigint, lineOf: (it: WorkItem) => GlLine | undefined): Flip[] {
  const out: Flip[] = [];
  const factsCache = new Map<string, LineFacts>();
  for (const state of FLIP_STATES) {
    for (const item of [...ctx.db.workItem.state.filter(state)].sort(byId)) {
      if (item.superseded) continue;
      const line = lineOf(item);
      if (!line) continue;
      let facts = factsCache.get(line.id);
      if (!facts) {
        facts = lineFacts(ctx, line);
        factsCache.set(line.id, facts);
      }
      for (const c of citationsOf(ctx, item)) {
        if (c.basis !== undefined && c.basis !== 'bill_line') continue;
        const res = forest.resolve(facts, item.periodKey, c.billLineId);
        if (res.result === 'category' && res.policyId === targetId && res.categoryCode !== c.categoryCode) {
          out.push({ item, line, from: c.categoryCode, to: res.categoryCode });
          break;
        }
      }
    }
  }
  return out;
}

export function flipReport(ctx: Ctx, list: Flip[], isLocked: (pk: string) => boolean): FlipReport {
  const r: FlipReport = { open: [], posted_open_period: [], posted_locked: [], usd_minor_by_state: {} };
  for (const { item } of list) {
    if (item.state !== 'POSTED') r.open.push(item.id);
    else if (isLocked(item.periodKey)) r.posted_locked.push(item.id);
    else r.posted_open_period.push(item.id);
    r.usd_minor_by_state[item.state] = (r.usd_minor_by_state[item.state] ?? 0n) + item.amountUsdMinor;
  }
  return r;
}
