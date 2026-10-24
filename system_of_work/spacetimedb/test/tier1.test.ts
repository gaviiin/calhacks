// Tier 1 (SCHEMA.md section 11): allocations, category limits, and policies as Ripple-Down Rules.
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { parsePattern, patternMismatches } from '../src/util';

// ---------------------------------------------------------------- fixture

let nextConn = 1n;
function principal(sub: string) {
  return TestAuth.fromJwtPayload(JSON.stringify({ iss: 'https://cost-cap-desk.test', sub }), new ConnectionId(nextConn++));
}

const ROLE_OF = {
  sync: 'sync',
  analyst: 'ai_cap_analyst',
  learner: 'ai_policy_learner',
  controller: 'human_controller',
  head: 'human_head_of_cost_cap',
  gateway: 'gateway',
} as const;
type Who = 'admin' | keyof typeof ROLE_OF;

const MATERIALITY = 5_000_000n;

const entry = (categoryCode: string, treatment: string, capLimitUsdMinor?: bigint) => ({
  id: `${categoryCode}@SECD-ISS07`, categoryCode, treatment, ruleVersion: 'SECD-ISS07', article: 'D5.1.1', effectiveFrom: '2026-01-01',
  effectiveTo: undefined, title: categoryCode, text: `${categoryCode} ...`, capLimitUsdMinor,
});
const RULEBOOK = [
  entry('CATERING', 'EXCLUDED'),
  entry('MARKETING', 'EXCLUDED'),
  entry('RELEVANT', 'RELEVANT'),
  entry('NON_F1', 'EXCLUDED'),
  entry('HERITAGE', 'EXCLUDED'),
  entry('STAFF_ENTERTAINMENT', 'EXCLUDED', 120_000_000n),
  entry('ADJ_RELATED_PARTY_FAIR_VALUE', 'ADJUSTMENT'),
  { ...entry('SICK_COVER', 'EXCLUDED'), id: 'SICK_COVER@ISS22', ruleVersion: 'ISS22', effectiveFrom: '2021-01-01', effectiveTo: '2025-12-31' },
];

type GlArgs = Parameters<typeof mod.upsertGlLine>[1];
type AllocArg = Parameters<typeof mod.proposeAllocations>[1]['allocations'][number];

function glLine(over: Partial<GlArgs> = {}): GlArgs {
  return {
    id: 'gl-000001', rawRef: 'gl_line:gl-000001:1', postedDate: '2026-01-20', periodKey: '2026-01', accountId: 'acct-6420',
    accountCode: '6420', departmentId: 'dept-FAC', vendorId: 'ven-001', billId: 'bill-00001', amountMinor: 4_000_000n,
    currency: 'USD', fxRateE6: 1_000_000n, amountUsdMinor: 4_000_000n, memo: 'Paddock Hospitality Ltd - January invoice',
    erpCategoryCode: 'MARKETING', entity: 'RACING', correctionOf: undefined, ...over,
  };
}

// P01: one hospitality invoice, three bill lines in three categories.
const P01_BILL_LINES = [
  { id: 'bl-00001-1', description: 'Factory canteen - January', usd: 1_200_000n },
  { id: 'bl-00001-2', description: 'Sponsor dinner - Silverstone launch', usd: 2_500_000n },
  { id: 'bl-00001-3', description: 'Wind tunnel lunch - aero team', usd: 300_000n },
];

const A = (basis: string, basisRef: string, categoryCode: string, amountUsdMinor: bigint, over: Partial<AllocArg> = {}): AllocArg => ({
  basis, basisRef, categoryCode, rulebookEntryId: `${categoryCode}@SECD-ISS07`, policyId: undefined, amountUsdMinor, capEffectUsdMinor: undefined, ...over,
});
const P01_SPLIT = (over: Partial<AllocArg>[] = []): AllocArg[] => [
  A('bill_line', 'bl-00001-1', 'CATERING', 1_200_000n, over[0]),
  A('bill_line', 'bl-00001-2', 'MARKETING', 2_500_000n, over[1]),
  A('bill_line', 'bl-00001-3', 'RELEVANT', 300_000n, over[2]),
];

function makeDesk() {
  const h = createModuleTestHarness(spacetimedb, mod);
  h.clock.set(new Timestamp(1_773_446_400_000_000n));
  const auth: Record<Who, ReturnType<typeof principal>> = {
    admin: principal('admin'), sync: principal('sync'), analyst: principal('analyst'), learner: principal('learner'),
    controller: principal('controller'), head: principal('head'), gateway: principal('gateway'),
  };
  type C = Parameters<Parameters<typeof h.withReducerTx>[1]>[0];
  const as = <T>(who: Who, fn: (ctx: C) => T): T => h.withReducerTx(auth[who], fn);
  as('admin', ctx => mod.bootstrapAdmin(ctx, {}));
  for (const [who, role] of Object.entries(ROLE_OF) as [Who, string][]) {
    as('admin', ctx => mod.createRoleInvite(ctx, { role, label: who, code: `code-${who}` }));
    as(who, ctx => mod.claimRole(ctx, { code: `code-${who}` }));
  }
  as('admin', ctx => mod.setSetting(ctx, { key: 'materiality_usd_minor', value: MATERIALITY.toString() }));
  for (const e of RULEBOOK) as('admin', ctx => mod.loadRulebookEntry(ctx, e));

  const audit = () => [...h.db.auditLog.iter()].sort((a, b) => Number(a.id - b.id));
  const lastAudit = () => audit().at(-1)!;
  const item = (id: bigint) => h.db.workItem.id.find(id)!;
  const latestFor = (glId: string) => [...h.db.workItem.subjectRef.filter(glId)].sort((a, b) => Number(b.id - a.id))[0]!;
  const sync = (over: Partial<GlArgs> = {}) => {
    as('sync', ctx => mod.upsertGlLine(ctx, glLine(over)));
    return latestFor(over.id ?? 'gl-000001');
  };
  const billLine = (id: string, glLineId: string, lineNo: number, description: string, amountMinor = 0n) =>
    as('sync', ctx =>
      mod.upsertBillLine(ctx, {
        id, rawRef: `bill_line:${id}:1`, billId: `bill-${glLineId}`, glLineId, lineNo, description, amountMinor,
        billText: 'INVOICE', vendorId: 'ven-001', bankIbanOnBill: 'GB00',
      })
    );
  const syncP01 = (over: Partial<GlArgs> = {}) => {
    const it = sync(over);
    const gl = over.id ?? 'gl-000001';
    P01_BILL_LINES.forEach((b, i) => billLine(gl === 'gl-000001' ? b.id : `${b.id}-${gl}`, gl, i + 1, b.description, b.usd));
    return it;
  };
  const allocAs = (who: Who, id: bigint, allocations: AllocArg[], over: Partial<Parameters<typeof mod.proposeAllocations>[1]> = {}) =>
    as(who, ctx =>
      mod.proposeAllocations(ctx, { workItemId: id, allocations, reason: 'P01: split by bill line', evidenceRefs: '["gl-000001","bill-00001"]', proposalSource: 'deterministic', ...over })
    );
  const proposeAs = (who: Who, id: bigint, over: Partial<Parameters<typeof mod.propose>[1]> = {}) =>
    as(who, ctx =>
      mod.propose(ctx, {
        workItemId: id, categoryCode: 'CATERING', rulebookEntryId: 'CATERING@SECD-ISS07', policyId: undefined, reason: 'r',
        evidenceRefs: '[]', capEffectUsdMinor: undefined, proposalSource: 'deterministic', ...over,
      })
    );
  const approveAs = (who: Who, id: bigint) => as(who, ctx => mod.approve(ctx, { workItemId: id, reason: 'ok' }));
  const postAs = (id: bigint, erp = `JE-${id}`) => as('gateway', ctx => mod.post(ctx, { workItemId: id, erpEntryId: erp }));
  const postThrough = (id: bigint, approver: Who = 'controller') => {
    approveAs(approver, id);
    postAs(id);
    expect(item(id).state).toBe('POSTED');
  };
  const proposePolicy = (over: Partial<Parameters<typeof mod.proposePolicy>[1]> = {}) => {
    as('learner', ctx =>
      mod.proposePolicy(ctx, {
        policyKey: 'hospitality-marketing', version: 0, categoryCode: 'MARKETING', rulebookEntryId: 'MARKETING@SECD-ISS07',
        pattern: JSON.stringify({ account_code: '6420' }), rationale: 'r', evidenceRefs: '[]', precedentCount: 1,
        effectiveFrom: '2026-01-01', effectiveTo: undefined, parentPolicyId: undefined, cornerstones: '[]', ...over,
      })
    );
    return [...h.db.policy.iter()].sort((a, b) => Number(b.id - a.id))[0]!;
  };
  const approvePolicy = (id: bigint) => as('head', ctx => mod.approvePolicy(ctx, { policyId: id, reason: 'ok' }));
  const policy = (over: Partial<Parameters<typeof mod.proposePolicy>[1]> = {}) => {
    const p = proposePolicy(over);
    approvePolicy(p.id);
    expect(h.db.policy.id.find(p.id)!.state).toBe('APPROVED');
    return h.db.policy.id.find(p.id)!;
  };
  const cap = (pk: string) => {
    const c = h.db.capPosition.periodKey.find(pk);
    return c ? { rel: c.relevantUsdMinor, exc: c.excludedUsdMinor, pend: c.pendingUsdMinor, n: c.postedItems } : null;
  };
  const ledger = (key: string) => h.db.limitLedger.key.find(key)?.excludedUsdMinor ?? 0n;
  const allocations = (id: bigint) => [...h.db.allocation.workItemId.filter(id)].sort((a, b) => a.lineNo - b.lineNo);
  return {
    h, as, audit, lastAudit, item, latestFor, sync, billLine, syncP01, allocAs, proposeAs, approveAs, postAs, postThrough,
    proposePolicy, approvePolicy, policy, cap, ledger, allocations,
  };
}

// ---------------------------------------------------------------- allocations

describe('allocations (SCHEMA 11.1)', () => {
  it('P01: canteen CATERING, sponsor dinner MARKETING, wind-tunnel lunch RELEVANT posts three cap effects', () => {
    const d = makeDesk();
    const it0 = d.syncP01();
    // Cite an exception policy on the canteen bill line: description_regex is matched per bill line.
    const hosp = d.policy();
    const canteen = d.policy({
      policyKey: 'canteen-in-hospitality', categoryCode: 'CATERING', rulebookEntryId: 'CATERING@SECD-ISS07',
      pattern: JSON.stringify({ description_regex: 'canteen' }), parentPolicyId: hosp.id,
    });
    d.allocAs('analyst', it0.id, P01_SPLIT([{ policyId: canteen.id }, { policyId: hosp.id }]));
    const proposed = d.item(it0.id);
    expect(proposed.state).toBe('PROPOSED');
    expect([proposed.proposedCategoryCode, proposed.proposedRulebookEntryId, proposed.proposedPolicyId]).toEqual(['ALLOCATED', 'ALLOCATED', undefined]);
    const rows = d.allocations(it0.id);
    expect(rows.map(r => [r.lineNo, r.basis, r.basisRef, r.categoryCode, r.amountUsdMinor, r.policyId])).toEqual([
      [1, 'bill_line', 'bl-00001-1', 'CATERING', 1_200_000n, canteen.id],
      [2, 'bill_line', 'bl-00001-2', 'MARKETING', 2_500_000n, hosp.id],
      [3, 'bill_line', 'bl-00001-3', 'RELEVANT', 300_000n, undefined],
    ]);
    const row = d.lastAudit();
    expect([row.action, row.allowed, row.fromState, row.toState]).toEqual(['propose', true, 'NEW', 'PROPOSED']);
    expect(Object.keys(JSON.parse(row.diff)).filter(k => k.startsWith('allocation['))).toHaveLength(3);

    d.postThrough(it0.id); // 4,000,000 < materiality: the controller may approve the line total
    const posted = d.item(it0.id);
    expect([posted.postedTreatment, posted.postedCapEffectUsdMinor]).toEqual(['ALLOCATED', 4_000_000n]);
    expect(d.allocations(it0.id).map(r => [r.postedTreatment, r.postedCapEffectUsdMinor])).toEqual([
      ['EXCLUDED', 1_200_000n],
      ['EXCLUDED', 2_500_000n],
      ['RELEVANT', 300_000n],
    ]);
    expect(d.cap('2026-01')).toEqual({ rel: 300_000n, exc: 3_700_000n, pend: 0n, n: 1 });
    expect([d.ledger('2026|CATERING'), d.ledger('2026|MARKETING')]).toEqual([1_200_000n, 2_500_000n]);
    const postDiff = JSON.parse(d.lastAudit().diff);
    expect(postDiff[`allocation[${rows[2]!.id}].posted_treatment`]).toEqual({ from: null, to: 'RELEVANT' });
  });

  it('materiality is judged on the line total, not on the allocations', () => {
    const d = makeDesk();
    const it0 = d.syncP01({ amountMinor: 6_000_000n, amountUsdMinor: 6_000_000n });
    d.allocAs('analyst', it0.id, P01_SPLIT([{}, { amountUsdMinor: 4_500_000n }]));
    expect(d.item(it0.id).state).toBe('PROPOSED');
    d.approveAs('controller', it0.id);
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toMatch(/^materiality: \|amount_usd_minor\| 6000000/);
    d.approveAs('head', it0.id);
    expect(d.item(it0.id).state).toBe('APPROVED');
  });

  it('every validation failure is a denial: state, rows and cap unchanged, one audit row', () => {
    const d = makeDesk();
    const it0 = d.syncP01();
    d.sync({ id: 'gl-other', rawRef: 'r-other', billId: undefined });
    d.billLine('bl-other-1', 'gl-other', 1, 'Other bill line');
    const hosp = d.policy();
    const child = d.policy({
      policyKey: 'canteen-in-hospitality', categoryCode: 'CATERING', rulebookEntryId: 'CATERING@SECD-ISS07',
      pattern: JSON.stringify({ description_regex: 'canteen' }), parentPolicyId: hosp.id,
    });
    const cases: Array<[string, AllocArg[], string]> = [
      ['one allocation', [A('bill_line', 'bl-00001-1', 'CATERING', 4_000_000n)], 'allocation_invalid: at least two allocations are required, got 1'],
      ['sum short by one', P01_SPLIT([{}, {}, { amountUsdMinor: 299_999n }]), 'allocation_sum_mismatch: allocations sum to 3999999, work item'],
      ['entry of another category', P01_SPLIT([{ rulebookEntryId: 'MARKETING@SECD-ISS07' }]), 'rulebook_invalid: allocation 1: entry MARKETING@SECD-ISS07 is category MARKETING, not CATERING'],
      ['entry not in force', P01_SPLIT([{}, {}, { categoryCode: 'SICK_COVER', rulebookEntryId: 'SICK_COVER@ISS22' }]), 'rulebook_invalid: allocation 3: entry SICK_COVER@ISS22 (in force 2021-01-01..2025-12-31) is not in force for period 2026-01'],
      ['cap effect on EXCLUDED', P01_SPLIT([{ capEffectUsdMinor: 5n }]), 'cap_effect_invalid: allocation 1: entry CATERING@SECD-ISS07 is EXCLUDED'],
      ['ADJUSTMENT without cap effect', P01_SPLIT([{}, {}, { categoryCode: 'ADJ_RELATED_PARTY_FAIR_VALUE', rulebookEntryId: 'ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07' }]), 'cap_effect_invalid: allocation 3: entry ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07 is an ADJUSTMENT'],
      ['bill line of another gl line', P01_SPLIT([{}, {}, { basisRef: 'bl-other-1' }]), 'allocation_invalid: allocation 3: bl-other-1 is not a bill line of gl line gl-000001'],
      ['bill line used twice', P01_SPLIT([{}, {}, { basisRef: 'bl-00001-1' }]), 'allocation_invalid: allocation 3: bill line bl-00001-1 is already used by allocation 1'],
      ['bill lines not all covered', [A('bill_line', 'bl-00001-1', 'CATERING', 1_200_000n), A('bill_line', 'bl-00001-2', 'MARKETING', 2_800_000n)], 'allocation_invalid: bill-line allocations must cover every bill line of gl line gl-000001; missing bl-00001-3'],
      ['MARKETING apportioned by share', [A('share', 'dept-FAC:0.25', 'MARKETING', 1_000_000n), A('share', 'dept-FAC:0.75', 'RELEVANT', 3_000_000n)], 'apportionment_not_permitted: allocation 1: MARKETING must be Directly Attributable'],
      ['RELEVANT share without an apportioned sibling', [A('share', 'dept-FAC:0.75', 'RELEVANT', 3_000_000n), A('bill_line', 'bl-00001-1', 'CATERING', 1_000_000n)], 'apportionment_not_permitted: a RELEVANT share is only the complement'],
      ['share amount is not the share', [A('share', 'dept-FAC:0.25', 'NON_F1', 1_500_000n), A('share', 'dept-FAC:0.75', 'RELEVANT', 2_500_000n)], 'allocation_invalid: allocation 1: amount 1500000 is not 0.25 of 4000000'],
      ['malformed share ref', [A('share', 'dept-FAC', 'NON_F1', 1_000_000n), A('share', 'dept-FAC:0.75', 'RELEVANT', 3_000_000n)], 'allocation_invalid: allocation 1: share basis_ref "dept-FAC" must be'],
      ['cap_limit_excess not RELEVANT', P01_SPLIT([{}, {}, { basis: 'cap_limit_excess', basisRef: 'CATERING', categoryCode: 'MARKETING', rulebookEntryId: 'MARKETING@SECD-ISS07' }]), 'allocation_invalid: allocation 3: a cap_limit_excess allocation is RELEVANT, not MARKETING'],
      ['cap_limit_excess of an unlimited category', P01_SPLIT([{}, {}, { basis: 'cap_limit_excess', basisRef: 'CATERING' }]), 'allocation_invalid: allocation 3: category CATERING has no cap limit in force for period 2026-01'],
      ['cap_limit_excess without a sibling', P01_SPLIT([{}, {}, { basis: 'cap_limit_excess', basisRef: 'STAFF_ENTERTAINMENT' }]), 'allocation_invalid: allocation 3: cap_limit_excess of STAFF_ENTERTAINMENT needs a sibling allocation in STAFF_ENTERTAINMENT'],
      ['cited policy does not match the bill line', P01_SPLIT([{}, { categoryCode: 'CATERING', rulebookEntryId: 'CATERING@SECD-ISS07', policyId: child.id }]), `policy_invalid: allocation 2: policy ${child.id} (canteen-in-hospitality v1) pattern does not match bill line bl-00001-2 of gl line gl-000001 on description_regex`],
      ['parent cited where its exception applies', P01_SPLIT([{ categoryCode: 'MARKETING', rulebookEntryId: 'MARKETING@SECD-ISS07', policyId: hosp.id }]), `exception_applies: pol-${child.id} (allocation 1)`],
    ];
    for (const [label, allocs, reason] of cases) {
      const n = d.audit().length;
      const cap = d.cap('2026-01');
      d.allocAs('analyst', it0.id, allocs);
      expect(d.item(it0.id).state, label).toBe('NEW');
      expect(d.allocations(it0.id), label).toHaveLength(0);
      expect(d.audit().length, label).toBe(n + 1);
      expect(d.lastAudit().allowed, label).toBe(false);
      expect(d.lastAudit().reason, label).toContain(reason);
      expect(d.cap('2026-01'), label).toEqual(cap);
    }
    // Malformed input throws (530), nothing logged.
    const n = d.audit().length;
    expect(() => d.allocAs('analyst', it0.id, P01_SPLIT([{ basis: 'percent' }]))).toThrow('allocations[0].basis must be one of bill_line, share, cap_limit, cap_limit_excess');
    expect(() => d.allocAs('analyst', it0.id, P01_SPLIT(), { proposalSource: 'guess' })).toThrow('proposalSource must be one of');
    expect(d.audit().length).toBe(n);
    // Roles and states are those of propose.
    d.allocAs('controller', it0.id, P01_SPLIT());
    expect(d.lastAudit().reason).toContain("role_not_permitted: role 'human_controller' may not propose");
    // A valid NON_F1 share split goes through.
    const it1 = d.sync({ id: 'gl-share', rawRef: 'r-share', billId: undefined });
    d.allocAs('analyst', it1.id, [A('share', 'dept-FAC:0.25', 'NON_F1', 1_000_000n), A('share', 'dept-FAC:0.75', 'RELEVANT', 3_000_000n)]);
    expect(d.item(it1.id).state).toBe('PROPOSED');
  });

  it('a rejected allocation can be re-proposed as a whole line, and a reopen drops the split', () => {
    const d = makeDesk();
    const it0 = d.syncP01();
    d.allocAs('analyst', it0.id, P01_SPLIT());
    expect(d.allocations(it0.id)).toHaveLength(3);
    d.as('controller', ctx => mod.reject(ctx, { workItemId: it0.id, reason: 'no' }));
    d.proposeAs('analyst', it0.id, { categoryCode: 'MARKETING', rulebookEntryId: 'MARKETING@SECD-ISS07' });
    expect(d.item(it0.id).proposedCategoryCode).toBe('MARKETING');
    expect(d.allocations(it0.id)).toHaveLength(0);
    d.as('controller', ctx => mod.reject(ctx, { workItemId: it0.id, reason: 'no' }));
    d.allocAs('analyst', it0.id, P01_SPLIT());
    d.sync({ memo: 'Paddock Hospitality Ltd - January invoice (corrected)', rawRef: 'gl_line:gl-000001:2' });
    expect(d.item(it0.id).state).toBe('NEW');
    expect(d.allocations(it0.id)).toHaveLength(0);
  });

  it('approve and post re-validate every allocation against the current rows', () => {
    const d = makeDesk();
    const it0 = d.syncP01();
    d.allocAs('analyst', it0.id, P01_SPLIT());
    d.as('admin', ctx => mod.loadRulebookEntry(ctx, { ...entry('MARKETING', 'EXCLUDED'), effectiveTo: '2025-12-31', effectiveFrom: '2025-01-01' }));
    d.approveAs('controller', it0.id);
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toContain('rulebook_invalid: allocation 2: entry MARKETING@SECD-ISS07');
  });

  it('reversing an allocated POSTED item backs each allocation out once: a void nets to zero', () => {
    const d = makeDesk();
    const it0 = d.syncP01();
    d.allocAs('analyst', it0.id, P01_SPLIT());
    d.postThrough(it0.id);
    expect(d.cap('2026-01')).toEqual({ rel: 300_000n, exc: 3_700_000n, pend: 0n, n: 1 });

    d.sync({ amountMinor: 0n, amountUsdMinor: 0n, memo: 'VOID: Paddock Hospitality Ltd - January invoice', rawRef: 'gl_line:gl-000001:9' });
    const rev = d.latestFor(it0.id.toString());
    expect([rev.kind, rev.reversesItemId, rev.amountUsdMinor]).toEqual(['reversal', it0.id, 0n]);
    d.proposeAs('analyst', rev.id, { categoryCode: 'MARKETING', rulebookEntryId: 'MARKETING@SECD-ISS07' });
    d.postThrough(rev.id);
    expect(d.cap('2026-01')).toEqual({ rel: 0n, exc: 0n, pend: 0n, n: 2 });
    expect([d.ledger('2026|CATERING'), d.ledger('2026|MARKETING')]).toEqual([0n, 0n]);
    expect(d.item(it0.id).superseded).toBe(true);
    // The allocation rows still say what was booked; they are never edited after post.
    expect(d.allocations(it0.id).map(r => r.postedCapEffectUsdMinor)).toEqual([1_200_000n, 2_500_000n, 300_000n]);
  });

  it('a reversal can itself be allocated, and backs out an allocated item it reverses', () => {
    const d = makeDesk();
    const it0 = d.syncP01();
    d.allocAs('analyst', it0.id, P01_SPLIT());
    d.postThrough(it0.id);
    d.sync({ amountMinor: 4_100_000n, amountUsdMinor: 4_100_000n, rawRef: 'gl_line:gl-000001:3' });
    const rev = d.latestFor(it0.id.toString());
    d.allocAs('analyst', rev.id, P01_SPLIT([{ amountUsdMinor: 1_300_000n }]));
    expect(d.item(rev.id).state).toBe('PROPOSED');
    d.postThrough(rev.id);
    expect(d.cap('2026-01')).toEqual({ rel: 300_000n, exc: 3_800_000n, pend: 0n, n: 2 });
    expect(d.ledger('2026|CATERING')).toBe(1_300_000n);
  });
});

// ---------------------------------------------------------------- category limits

describe('category limits (limit_ledger)', () => {
  const SE = { categoryCode: 'STAFF_ENTERTAINMENT', rulebookEntryId: 'STAFF_ENTERTAINMENT@SECD-ISS07' };
  const usd = (n: bigint) => ({ amountMinor: n, amountUsdMinor: n });
  // $1.0m of the $1.2m staff entertainment limit already posted.
  function withSummerParty() {
    const d = makeDesk();
    const first = d.sync({ id: 'gl-se-1', rawRef: 'r1', billId: undefined, ...usd(100_000_000n), memo: 'Summer party' });
    d.proposeAs('analyst', first.id, SE);
    d.postThrough(first.id, 'head');
    expect(d.ledger('2026|STAFF_ENTERTAINMENT')).toBe(100_000_000n);
    return d;
  }
  const split = (within: bigint, total: bigint, over: Partial<AllocArg>[] = []): AllocArg[] => [
    A('cap_limit', 'STAFF_ENTERTAINMENT', 'STAFF_ENTERTAINMENT', within, over[0]),
    A('cap_limit_excess', 'STAFF_ENTERTAINMENT', 'RELEVANT', total - within, over[1]),
  ];

  it('an over-limit whole-line proposal is denied up front with the remaining amount', () => {
    const d = withSummerParty();
    const xmas = d.sync({ id: 'gl-se-2', rawRef: 'r2', billId: undefined, ...usd(30_000_000n), memo: 'Christmas party' });
    d.proposeAs('analyst', xmas.id, SE);
    expect(d.item(xmas.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toBe(
      'cap_limit_exceeded: remaining 20000000 (STAFF_ENTERTAINMENT 2026: limit 120000000, posted 100000000, this proposal adds 30000000); split the excess with cap_limit + cap_limit_excess allocations'
    );
  });

  it('cap_limit + cap_limit_excess splits a line with no bill lines at the limit; the reversal gives it back', () => {
    const d = withSummerParty();
    const xmas = d.sync({ id: 'gl-se-2', rawRef: 'r2', billId: undefined, ...usd(30_000_000n), memo: 'Christmas party' });
    const denials: Array<[AllocArg[], string]> = [
      [split(25_000_000n, 30_000_000n), 'cap_limit_exceeded: remaining 20000000 (STAFF_ENTERTAINMENT 2026: limit 120000000, posted 100000000, this proposal adds 25000000)'],
      [[A('cap_limit', 'STAFF_ENTERTAINMENT', 'STAFF_ENTERTAINMENT', 20_000_000n), A('cap_limit', 'STAFF_ENTERTAINMENT', 'STAFF_ENTERTAINMENT', 10_000_000n)], 'allocation_invalid: 2 cap_limit allocations for STAFF_ENTERTAINMENT; a split at a limit has exactly one'],
      [[A('cap_limit', 'STAFF_ENTERTAINMENT', 'STAFF_ENTERTAINMENT', 20_000_000n), A('share', 'dept-FAC:0.3333333', 'RELEVANT', 10_000_000n)], 'allocation_invalid: the cap_limit allocation for STAFF_ENTERTAINMENT needs a cap_limit_excess allocation'],
      [split(20_000_000n, 30_000_000n, [{ ...SE, categoryCode: 'MARKETING', rulebookEntryId: 'MARKETING@SECD-ISS07' }]), 'allocation_invalid: allocation 1: a cap_limit allocation is in its basis_ref category STAFF_ENTERTAINMENT, not MARKETING'],
      [split(20_000_000n, 30_000_000n, [{ basisRef: 'CATERING', categoryCode: 'CATERING', rulebookEntryId: 'CATERING@SECD-ISS07' }, { basisRef: 'CATERING' }]), 'allocation_invalid: allocation 1: category CATERING has no cap limit in force for period 2026-01'],
    ];
    for (const [allocs, reason] of denials) {
      d.allocAs('analyst', xmas.id, allocs);
      expect(d.item(xmas.id).state, reason).toBe('NEW');
      expect(d.lastAudit().reason, reason).toContain(reason);
    }
    d.allocAs('analyst', xmas.id, split(20_000_000n, 30_000_000n));
    expect(d.item(xmas.id).state).toBe('PROPOSED');
    d.postThrough(xmas.id, 'head');
    expect(d.ledger('2026|STAFF_ENTERTAINMENT')).toBe(120_000_000n);
    expect(d.cap('2026-01')).toMatchObject({ rel: 10_000_000n, exc: 120_000_000n });
    expect(JSON.parse(d.lastAudit().diff)['limit_ledger[2026|STAFF_ENTERTAINMENT].excluded_usd_minor']).toEqual({ from: 100_000_000, to: 120_000_000 });

    d.sync({ id: 'gl-se-2', rawRef: 'r2b', billId: undefined, ...usd(0n), memo: 'VOID: Christmas party' });
    const rev = d.latestFor(xmas.id.toString());
    d.proposeAs('analyst', rev.id, SE);
    d.postThrough(rev.id);
    expect(d.ledger('2026|STAFF_ENTERTAINMENT')).toBe(100_000_000n);
    expect(d.cap('2026-01')).toMatchObject({ rel: 0n, exc: 100_000_000n, pend: 0n });
  });

  it('a bill-line allocation in a limited category counts against the limit', () => {
    const d = withSummerParty();
    const it0 = d.sync({ id: 'gl-se-3', rawRef: 'r3', ...usd(30_000_000n), memo: 'Party and sponsor drinks' });
    d.billLine('bl-se-3-1', 'gl-se-3', 1, 'Christmas party - all staff');
    d.billLine('bl-se-3-2', 'gl-se-3', 2, 'Sponsor drinks');
    d.allocAs('analyst', it0.id, [A('bill_line', 'bl-se-3-1', 'STAFF_ENTERTAINMENT', 25_000_000n), A('bill_line', 'bl-se-3-2', 'MARKETING', 5_000_000n)]);
    expect(d.lastAudit().reason).toMatch(/^cap_limit_exceeded: remaining 20000000 /);
    // ...and can be the within-limit sibling of a cap_limit_excess.
    d.allocAs('analyst', it0.id, [
      A('bill_line', 'bl-se-3-1', 'STAFF_ENTERTAINMENT', 20_000_000n),
      A('bill_line', 'bl-se-3-2', 'MARKETING', 5_000_000n),
      A('cap_limit_excess', 'STAFF_ENTERTAINMENT', 'RELEVANT', 5_000_000n),
    ]);
    expect(d.item(it0.id).state).toBe('PROPOSED');
  });

  it('the limit is re-checked at approve and at post, since it can be consumed in between', () => {
    const d = withSummerParty();
    const mk = (id: string, n: bigint) => {
      const it = d.sync({ id, rawRef: `r-${id}`, billId: undefined, ...usd(n), memo: id });
      d.proposeAs('analyst', it.id, SE);
      expect(d.item(it.id).state).toBe('PROPOSED'); // each fits on its own
      return it;
    };
    const a = mk('gl-a', 15_000_000n);
    const b = mk('gl-b', 15_000_000n);
    const c = mk('gl-c', 4_000_000n);
    d.approveAs('head', a.id);
    d.approveAs('head', c.id);
    d.postAs(a.id);
    expect(d.ledger('2026|STAFF_ENTERTAINMENT')).toBe(115_000_000n);
    // b: denied at approve, while still PROPOSED (it can be re-proposed as a split).
    d.approveAs('head', b.id);
    expect(d.item(b.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toMatch(/^cap_limit_exceeded: remaining 5000000 \(STAFF_ENTERTAINMENT 2026: .*this proposal adds 15000000/);
    // c was approved when it fitted; a later line takes the room, so post refuses it.
    const late = mk('gl-late', 3_000_000n);
    d.postThrough(late.id, 'head');
    d.postAs(c.id);
    expect(d.item(c.id).state).toBe('APPROVED');
    expect(d.lastAudit().reason).toMatch(/^cap_limit_exceeded: remaining 2000000 \(.*this post adds 4000000/);
  });
});

// ---------------------------------------------------------------- RDR policies

describe('Ripple-Down Rule policies (SCHEMA 11.2)', () => {
  const WT = { memo: 'Lunch - wind tunnel session' };
  const REL = { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07' };
  const MKT = { categoryCode: 'MARKETING', rulebookEntryId: 'MARKETING@SECD-ISS07' };
  const childArgs = (parentPolicyId: bigint, over: Partial<Parameters<typeof mod.proposePolicy>[1]> = {}) => ({
    policyKey: 'wind-tunnel-lunch', ...REL, pattern: JSON.stringify({ memo_regex: 'wind tunnel' }), parentPolicyId, ...over,
  });

  it('exception_applies: citing the parent where an approved child applies is denied at propose; the child is accepted', () => {
    const d = makeDesk();
    const parent = d.policy();
    const child = d.policy(childArgs(parent.id));
    const it0 = d.sync({ id: 'gl-wt', rawRef: 'r', billId: undefined, ...WT });
    d.proposeAs('analyst', it0.id, { ...MKT, policyId: parent.id });
    expect(d.item(it0.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toBe(`exception_applies: pol-${child.id}`);
    d.proposeAs('analyst', it0.id, { ...REL, policyId: child.id });
    expect(d.item(it0.id).state).toBe('PROPOSED');
    // The parent still concludes where the child does not apply.
    const it1 = d.sync({ id: 'gl-dinner', rawRef: 'r2', billId: undefined, memo: 'Sponsor dinner' });
    d.proposeAs('analyst', it1.id, { ...MKT, policyId: parent.id });
    expect(d.item(it1.id).state).toBe('PROPOSED');
    // A child cited where its parent does not apply is refused.
    const it2 = d.sync({ id: 'gl-wt-6200', rawRef: 'r3', billId: undefined, accountCode: '6200', ...WT });
    d.proposeAs('analyst', it2.id, { ...REL, policyId: child.id });
    expect(d.lastAudit().reason).toContain(`ancestor pol-${parent.id} does not apply to gl line gl-wt-6200`);
  });

  it('policy_conflict: two top-level policies disagree and neither refines the other', () => {
    const d = makeDesk();
    const byAccount = d.policy();
    d.policy({ policyKey: 'ven-001-catering', categoryCode: 'CATERING', rulebookEntryId: 'CATERING@SECD-ISS07', pattern: JSON.stringify({ vendor_id: 'ven-001' }) });
    const it0 = d.sync({ billId: undefined });
    d.proposeAs('analyst', it0.id, { ...MKT, policyId: byAccount.id });
    expect(d.item(it0.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toMatch(/^policy_conflict: resolution for gl line gl-000001 is a conflict between pol-\d+ \(MARKETING\), pol-\d+ \(CATERING\)/);
  });

  it('cornerstones: own must apply; a child must not match its parent\'s same-category cornerstones; history refs are checked by the proposer', () => {
    const d = makeDesk();
    d.sync({ id: 'gl-dinner', rawRef: 'r1', billId: undefined, memo: 'Sponsor dinner - wind tunnel open day' });
    d.sync({ id: 'gl-wt', rawRef: 'r2', billId: undefined, ...WT });
    const parent = d.policy({ cornerstones: JSON.stringify([{ ref: 'gl-dinner', category_code: 'MARKETING' }, { ref: 'hist-2025-0042', category_code: 'MARKETING' }]) });
    const evidence = JSON.parse(d.audit().filter(r => r.action === 'propose_policy').at(-1)!.evidence);
    expect(evidence.cornerstones).toEqual({ checked: ['gl-dinner'], checked_by_proposer: ['hist-2025-0042'], parent: null });
    expect(evidence.evidence_refs).toBe('[]');

    // "wind tunnel" also matches the parent's MARKETING cornerstone gl-dinner: conflicting cornerstone.
    const n = d.h.db.policy.count();
    d.proposePolicy(childArgs(parent.id, { cornerstones: JSON.stringify([{ ref: 'gl-wt', category_code: 'RELEVANT' }]) }));
    expect(d.h.db.policy.count()).toBe(n);
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toBe(`conflicting_cornerstone: the exception matches cornerstones of parent pol-${parent.id} (MARKETING): gl-dinner`);
    const denied = JSON.parse(d.lastAudit().evidence);
    expect(denied.cornerstones.parent).toEqual({ policy_id: Number(parent.id), checked: ['gl-dinner'], checked_by_proposer: ['hist-2025-0042'] });

    // A narrower child passes; its own cornerstone must be one it applies to.
    d.proposePolicy(childArgs(parent.id, { pattern: JSON.stringify({ memo_regex: '^lunch' }), cornerstones: JSON.stringify([{ ref: 'gl-dinner', category_code: 'RELEVANT' }]) }));
    expect(d.lastAudit().reason).toContain('cornerstone_mismatch: the policy does not apply to its own cornerstones gl-dinner');
    d.proposePolicy(childArgs(parent.id, { pattern: JSON.stringify({ memo_regex: '^lunch' }), cornerstones: JSON.stringify([{ ref: 'gl-wt', category_code: 'RELEVANT' }]) }));
    expect(d.lastAudit().allowed).toBe(true);
    const child = [...d.h.db.policy.iter()].sort((a, b) => Number(b.id - a.id))[0]!;
    expect([child.parentPolicyId, child.cornerstones]).toEqual([parent.id, JSON.stringify([{ ref: 'gl-wt', category_code: 'RELEVANT' }])]);

    // Malformed input throws.
    expect(() => d.proposePolicy({ policyKey: 'x', cornerstones: '{"ref":"gl-wt"}' })).toThrow('cornerstones must be a JSON array');
    expect(() => d.proposePolicy({ policyKey: 'x', cornerstones: '[{"ref":"gl-wt"}]' })).toThrow('cornerstone.category_code');
    expect(() => d.proposePolicy({ policyKey: 'x', parentPolicyId: 999n })).toThrow('unknown parent policy 999');
  });

  // A parent, and items on wind-tunnel lines in every state the flip report distinguishes.
  function flipFixture() {
    const d = makeDesk();
    const parent = d.policy();
    const mk = (id: string, period = '2026-01', over: Partial<GlArgs> = {}) =>
      d.sync({ id, rawRef: `gl_line:${id}:1`, billId: undefined, periodKey: period, postedDate: `${period}-10`, amountMinor: 1_000n, amountUsdMinor: 1_000n, ...WT, ...over });
    const proposed = mk('gl-p', '2026-03', { amountUsdMinor: 100n });
    const approved = mk('gl-a', '2026-03', { amountUsdMinor: 200n });
    const postedOpen = mk('gl-o', '2026-03', { amountUsdMinor: 400n });
    const postedLocked = mk('gl-l', '2026-02', { amountUsdMinor: 800n });
    const fresh = mk('gl-n', '2026-03');
    const canteen = mk('gl-c', '2026-03', { memo: 'Canteen' });
    for (const it of [proposed, approved, postedOpen, postedLocked, canteen]) d.proposeAs('analyst', it.id, { ...MKT, policyId: parent.id });
    d.approveAs('controller', approved.id);
    for (const it of [postedOpen, postedLocked, canteen]) d.postThrough(it.id);
    d.as('head', ctx => mod.lockPeriod(ctx, { periodKey: '2026-02' }));
    expect(d.h.db.period.key.find('2026-02')?.locked).toBe(true);
    return { d, parent, proposed, approved, postedOpen, postedLocked, fresh, canteen };
  }

  it('flip report: computed at proposePolicy, stored on the policy and in the audit evidence', () => {
    const { d, parent, proposed, approved, postedOpen, postedLocked } = flipFixture();
    const child = d.proposePolicy(childArgs(parent.id));
    const expected = {
      open: [Number(proposed.id), Number(approved.id)],
      posted_open_period: [Number(postedOpen.id)],
      posted_locked: [Number(postedLocked.id)],
      usd_minor_by_state: { PROPOSED: 100, APPROVED: 200, POSTED: 1200 },
    };
    expect(JSON.parse(child.flipReport)).toEqual(expected);
    expect(JSON.parse(d.lastAudit().evidence).flip_report).toEqual(expected);
    // Nothing moved yet: the head sees the report before approving.
    expect(d.item(proposed.id).state).toBe('PROPOSED');
  });

  it('approving the child reopens open items citing the parent, reverses POSTED items in open periods, leaves locked ones', () => {
    const { d, parent, proposed, approved, postedOpen, postedLocked, fresh, canteen } = flipFixture();
    const child = d.proposePolicy(childArgs(parent.id));
    d.approvePolicy(child.id);
    const row = d.audit().filter(r => r.action === 'approve_policy').at(-1)!;
    expect(row.allowed).toBe(true);

    const reopens = d.audit().filter(r => r.action === 'reopen');
    expect(reopens.map(r => [r.subjectId, r.fromState, r.reason])).toEqual([
      [proposed.id.toString(), 'PROPOSED', `exception approved: pol-${child.id}`],
      [approved.id.toString(), 'APPROVED', `exception approved: pol-${child.id}`],
    ]);
    for (const it of [proposed, approved]) expect(d.item(it.id).state).toBe('NEW');

    const rev = d.latestFor(postedOpen.id.toString());
    expect([rev.kind, rev.state, rev.reversesItemId, rev.periodKey]).toEqual(['reversal', 'NEW', postedOpen.id, '2026-03']);
    expect(rev.reason).toBe(`reversal: exception approved: pol-${child.id} reclassifies gl line gl-o MARKETING -> RELEVANT after work item ${postedOpen.id} was POSTED`);
    // The reversal is re-proposed under the exception and nets the cap.
    d.proposeAs('analyst', rev.id, { ...REL, policyId: child.id });
    d.postThrough(rev.id);
    expect(d.cap('2026-03')).toMatchObject({ rel: 400n, exc: 1_000n });

    // Locked period: untouched, no reversal, still listed in the flip report and the approval diff.
    expect(d.item(postedLocked.id).state).toBe('POSTED');
    expect(d.item(postedLocked.id).superseded).toBe(false);
    expect([...d.h.db.workItem.subjectRef.filter(postedLocked.id.toString())]).toHaveLength(0);
    expect(JSON.parse(d.h.db.policy.id.find(child.id)!.flipReport).posted_locked).toEqual([Number(postedLocked.id)]);
    expect(JSON.parse(row.diff)['flip_report.posted_locked']).toEqual({ from: null, to: [Number(postedLocked.id)] });

    // NEW items and lines the child does not apply to are left alone.
    expect(d.item(fresh.id).state).toBe('NEW');
    expect([...d.h.db.workItem.subjectRef.filter(canteen.id.toString())]).toHaveLength(0);
    // The reopened items can now only be proposed under the exception.
    d.proposeAs('analyst', proposed.id, { ...MKT, policyId: parent.id });
    expect(d.lastAudit().reason).toBe(`exception_applies: pol-${child.id}`);
    d.proposeAs('analyst', proposed.id, { ...REL, policyId: child.id });
    expect(d.item(proposed.id).state).toBe('PROPOSED');
  });

  it('a new version that changes category reverses its POSTED items in open periods', () => {
    const d = makeDesk();
    const v1 = d.policy();
    const it0 = d.sync({ billId: undefined });
    d.proposeAs('analyst', it0.id, { ...MKT, policyId: v1.id });
    d.postThrough(it0.id);
    const v2 = d.proposePolicy({ ...REL });
    expect(JSON.parse(v2.flipReport).posted_open_period).toEqual([Number(it0.id)]);
    d.approvePolicy(v2.id);
    const rev = d.latestFor(it0.id.toString());
    expect([rev.kind, rev.reversesItemId]).toEqual(['reversal', it0.id]);
  });
});

describe('new pattern keys', () => {
  it('entity and erp_category_code match exactly; description_regex needs every bill line (or the one in context)', () => {
    const subject = { accountCode: '6420', departmentId: 'd', memo: 'm', amountUsdMinor: 1n, entity: 'RACING', erpCategoryCode: 'MARKETING' };
    const p = parsePattern(JSON.stringify({ entity: 'RACING', erp_category_code: 'MARKETING' }));
    expect(patternMismatches(p, { ...subject, descriptions: [] })).toEqual([]);
    expect(patternMismatches(p, { ...subject, entity: 'TECHNOLOGY', erpCategoryCode: 'CATERING', descriptions: [] })).toEqual(['entity', 'erp_category_code']);
    const dr = parsePattern(JSON.stringify({ description_regex: 'ｃanteen' })); // NFKC like memo_regex
    expect(patternMismatches(dr, { ...subject, descriptions: ['Factory CANTEEN '] })).toEqual([]);
    expect(patternMismatches(dr, { ...subject, descriptions: ['Factory canteen', 'Sponsor dinner'] })).toEqual(['description_regex']);
    expect(patternMismatches(dr, { ...subject, descriptions: [] })).toEqual(['description_regex']);
    expect(() => parsePattern(JSON.stringify({ description_regex: '(a+)+' }))).toThrow('nested quantifiers');
    expect(() => parsePattern(JSON.stringify({ entity: 1 }))).toThrow('pattern.entity must be a string');
  });
});
