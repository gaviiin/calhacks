// Red-team reproductions RT1-RT17 (research/review/03-red-team.md), inverted: each test now
// asserts the behaviour SCHEMA.md section 10 requires. Cases the review found but Tier 0 does
// not change (aggregate materiality, step forging, mid-month rule changes, posted_date vs
// period_key) are kept as documentation of the current contract and say so.
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp, type Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';

// ---------------------------------------------------------------- fixture

let nextConn = 1n;
function principal(sub: string) {
  return TestAuth.fromJwtPayload(
    JSON.stringify({ iss: 'https://cost-cap-desk.test', sub }),
    new ConnectionId(nextConn++)
  );
}

const ROLE_OF = {
  sync: 'sync',
  analyst: 'ai_cap_analyst',
  learner: 'ai_policy_learner',
  controller: 'human_controller',
  head: 'human_head_of_cost_cap',
  gateway: 'gateway',
  autoApprover: 'auto_approver',
  redTeam: 'red_team',
} as const;
type Who = 'admin' | keyof typeof ROLE_OF | 'stranger';

const MATERIALITY = 5_000_000n; // $50,000.00

const RULEBOOK = [
  {
    id: 'CATERING@SECD-ISS07', categoryCode: 'CATERING', treatment: 'EXCLUDED', ruleVersion: 'SECD-ISS07',
    article: 'D5.1.1.z', effectiveFrom: '2026-01-01', effectiveTo: undefined, title: 'Catering', text: 'catering ...',
    capLimitUsdMinor: undefined,
  },
  {
    id: 'SICK_COVER@ISS22', categoryCode: 'SICK_COVER', treatment: 'EXCLUDED', ruleVersion: 'ISS22',
    article: '3.1(m)', effectiveFrom: '2021-01-01', effectiveTo: '2025-12-31', title: 'Sick cover', text: 'sick ...',
    capLimitUsdMinor: undefined,
  },
  {
    id: 'RELEVANT@SECD-ISS07', categoryCode: 'RELEVANT', treatment: 'RELEVANT', ruleVersion: 'SECD-ISS07',
    article: 'Definitions', effectiveFrom: '2026-01-01', effectiveTo: undefined, title: 'Relevant', text: 'relevant ...',
    capLimitUsdMinor: undefined,
  },
  {
    id: 'MARKETING@SECD-ISS07', categoryCode: 'MARKETING', treatment: 'EXCLUDED', ruleVersion: 'SECD-ISS07',
    article: 'D5.1.1.a', effectiveFrom: '2026-01-01', effectiveTo: undefined, title: 'Marketing', text: 'marketing ...',
    capLimitUsdMinor: undefined,
  },
  {
    id: 'ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07', categoryCode: 'ADJ_RELATED_PARTY_FAIR_VALUE', treatment: 'ADJUSTMENT',
    ruleVersion: 'SECD-ISS07', article: 'D6.1.1.a', effectiveFrom: '2026-01-01', effectiveTo: undefined,
    title: 'Related party fair value', text: 'fair value ...', capLimitUsdMinor: undefined,
  },
];

type GlArgs = Parameters<typeof mod.upsertGlLine>[1];
function glLine(over: Partial<GlArgs> = {}): GlArgs {
  return {
    id: 'gl-000123',
    rawRef: 'gl_line:gl-000123:17',
    postedDate: '2026-03-14',
    periodKey: '2026-03',
    accountId: 'acct-6410',
    accountCode: '6410',
    departmentId: 'dept-AERO',
    vendorId: 'ven-017',
    billId: undefined,
    amountMinor: 720_000n,
    currency: 'GBP',
    fxRateE6: 1_270_000n,
    amountUsdMinor: 914_400n,
    memo: 'Grove Catering - factory canteen March',
    erpCategoryCode: 'MARKETING',
    entity: 'RACING',
    correctionOf: undefined,
    ...over,
  };
}

function makeDesk() {
  const h = createModuleTestHarness(spacetimedb, mod);
  h.clock.set(new Timestamp(1_773_446_400_000_000n)); // 2026-03-14T00:00:00Z
  const auth: Record<Who, ReturnType<typeof principal>> = {
    admin: principal('admin'),
    sync: principal('sync'),
    analyst: principal('analyst'),
    learner: principal('learner'),
    controller: principal('controller'),
    head: principal('head'),
    gateway: principal('gateway'),
    autoApprover: principal('auto-approver'),
    redTeam: principal('red-team'),
    stranger: principal('stranger'),
  };
  type C = Parameters<Parameters<typeof h.withReducerTx>[1]>[0];
  const as = <T>(who: Who, fn: (ctx: C) => T): T => h.withReducerTx(auth[who], fn);
  const identity = (who: Who): Identity => as(who, ctx => ctx.sender);

  as('admin', ctx => mod.bootstrapAdmin(ctx, {}));
  for (const [who, role] of Object.entries(ROLE_OF) as [Who, string][]) {
    as('admin', ctx => mod.createRoleInvite(ctx, { role, label: who, code: `code-${who}` }));
    as(who, ctx => mod.claimRole(ctx, { code: `code-${who}` }));
  }
  as('admin', ctx => mod.setSetting(ctx, { key: 'materiality_usd_minor', value: MATERIALITY.toString() }));
  for (const entry of RULEBOOK) as('admin', ctx => mod.loadRulebookEntry(ctx, entry));

  const audit = () => [...h.db.auditLog.iter()].sort((a, b) => Number(a.id - b.id));
  const item = (id: bigint) => {
    const row = h.db.workItem.id.find(id);
    if (!row) throw new Error(`no work item ${id}`);
    return row;
  };
  const itemFor = (glId: string) => {
    const rows = [...h.db.workItem.subjectRef.filter(glId)];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };
  const sync = (over: Partial<GlArgs> = {}) => {
    as('sync', ctx => mod.upsertGlLine(ctx, glLine(over)));
    return itemFor(over.id ?? 'gl-000123');
  };
  const proposeAs = (who: Who, id: bigint, over: Partial<Parameters<typeof mod.propose>[1]> = {}) =>
    as(who, ctx =>
      mod.propose(ctx, {
        workItemId: id,
        categoryCode: 'CATERING',
        rulebookEntryId: 'CATERING@SECD-ISS07',
        policyId: undefined,
        reason: 'factory canteen: catering at team premises, D5.1.1.z',
        evidenceRefs: '["gl-000123","bill-00042"]',
        capEffectUsdMinor: undefined,
        proposalSource: 'deterministic',
        ...over,
      })
    );
  const approveAs = (who: Who, id: bigint, reason = 'agreed') => as(who, ctx => mod.approve(ctx, { workItemId: id, reason }));
  const rejectAs = (who: Who, id: bigint, reason: string) => as(who, ctx => mod.reject(ctx, { workItemId: id, reason }));
  const postAs = (who: Who, id: bigint, erpEntryId = 'JE-2026-000417') => as(who, ctx => mod.post(ctx, { workItemId: id, erpEntryId }));
  const lastAudit = () => audit().at(-1)!;
  const reopens = () => audit().filter(r => r.action === 'reopen');
  const reversalsOf = (itemId: bigint) => [...h.db.workItem.subjectRef.filter(itemId.toString())].filter(r => r.kind === 'reversal');
  const cap = (pk: string) => {
    const c = h.db.capPosition.periodKey.find(pk);
    return c ? { rel: c.relevantUsdMinor, exc: c.excludedUsdMinor, pend: c.pendingUsdMinor, n: c.postedItems } : null;
  };

  return { h, as, identity, audit, item, itemFor, sync, proposeAs, approveAs, rejectAs, postAs, lastAudit, reopens, reversalsOf, cap };
}

function proposePolicyArgs(over: Partial<Parameters<typeof mod.proposePolicy>[1]> = {}) {
  return {
    policyKey: 'grove-canteen-catering',
    version: 0,
    categoryCode: 'CATERING',
    rulebookEntryId: 'CATERING@SECD-ISS07',
    pattern: JSON.stringify({ vendor_id: 'ven-017', account_code: '6410', memo_regex: 'canteen' }),
    rationale: 'Grove Catering on GL 6410 is the factory canteen: 214 lines in 2025, all catering',
    evidenceRefs: '["hist-2025-0001","hist-2025-0002"]',
    precedentCount: 214,
    effectiveFrom: '2026-01-01',
    effectiveTo: undefined,
    parentPolicyId: undefined,
    cornerstones: '[]',
    ...over,
  };
}

const SANDBOX_EVIDENCE = JSON.stringify({
  sandbox_run_id: 'sbx-2026-03-01-a1b2c3d4',
  sandboxes: 5,
  lines: 1200,
  errors: 0,
  missed_plants: 0,
});

type Desk = ReturnType<typeof makeDesk>;

// A policy the learner proposed and the head approved; autonomy optionally granted.
function approvedPolicy(d: Desk, over: Partial<Parameters<typeof mod.proposePolicy>[1]> = {}, grant = true) {
  d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs(over)));
  const pol = [...d.h.db.policy.iter()].sort((a, b) => Number(b.id - a.id))[0]!;
  d.as('head', ctx => mod.approvePolicy(ctx, { policyId: pol.id, reason: 'matches 2025 practice' }));
  // Approval gives a policy standing approval; `grant = false` is a policy the head then took it back from.
  if (!grant) d.as('head', ctx => mod.revokeAutonomy(ctx, { policyId: pol.id, reason: 'review its lines first' }));
  return d.h.db.policy.id.find(pol.id)!;
}

// A NEW item proposed by the analyst citing `policyId`.
function proposedUnder(d: Desk, glId: string, policyId: bigint | undefined, over: Partial<GlArgs> = {}) {
  const it0 = d.sync({ id: glId, rawRef: `gl_line:${glId}:1`, ...over });
  d.proposeAs('analyst', it0.id, { policyId });
  expect(d.item(it0.id).state).toBe('PROPOSED');
  return it0;
}

const REL = { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07' };

// Everything propose, ask, answer, approve wrote is gone after a reopen.
function expectCleared(it: ReturnType<Desk['item']>) {
  expect(it.state).toBe('NEW');
  expect(it.proposedBy).toBeUndefined();
  expect(it.proposedCategoryCode).toBeUndefined();
  expect(it.proposedRulebookEntryId).toBeUndefined();
  expect(it.proposedPolicyId).toBeUndefined();
  expect(it.capEffectUsdMinor).toBeUndefined();
  expect(it.proposalSource).toBe('');
  expect(it.reason).toBe('');
  expect(it.question).toBeUndefined();
  expect(it.answer).toBeUndefined();
  expect(it.decidedBy).toBeUndefined();
  expect(it.decidedReason).toBeUndefined();
}

// ================================================================ RT state and races

describe('RT state and races (defects 2, 3)', () => {
  it('RT1 a controller-approved $100 line re-synced to 10x materiality is reopened to NEW and cannot post', () => {
    const d = makeDesk();
    const it0 = d.sync({ amountMinor: 8_000n, amountUsdMinor: 10_000n });
    d.proposeAs('analyst', it0.id);
    d.approveAs('controller', it0.id, 'small canteen bill');
    expect(d.item(it0.id).state).toBe('APPROVED');

    d.sync({ amountMinor: 40_000_000n, amountUsdMinor: 50_000_000n, rawRef: 'gl_line:gl-000123:99', memo: 'Grove - anything' });
    const after = d.item(it0.id);
    expectCleared(after);
    expect(after.amountUsdMinor).toBe(50_000_000n);
    expect(JSON.parse(after.evidenceRefs)).toEqual(['gl_line:gl-000123:99']);
    const [reopen] = d.reopens();
    expect(d.reopens()).toHaveLength(1);
    expect([reopen!.actorRole, reopen!.allowed, reopen!.fromState, reopen!.toState, reopen!.subjectId]).toEqual([
      'sync', true, 'APPROVED', 'NEW', it0.id.toString(),
    ]);
    expect(reopen!.reason).toBe('reopened by correction: amount_usd_minor, amount_minor, memo');
    expect(JSON.parse(reopen!.diff).decided_by.to).toBeNull();
    // The sync row that caused it says so, and its diff carries the state change.
    expect(d.lastAudit().action).toBe('sync_upsert');
    expect(d.lastAudit().reason).toContain(`reopened work_item ${it0.id} (APPROVED -> NEW`);
    expect(JSON.parse(d.lastAudit().diff)[`work_item[${it0.id}].state`]).toEqual({ from: 'APPROVED', to: 'NEW' });
    expect(d.cap('2026-03')!.pend).toBe(50_000_000n);

    d.postAs('gateway', it0.id);
    expect(d.item(it0.id).state).toBe('NEW');
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toMatch(/^invalid_transition/);

    // Re-proposed, it is now material: the controller is refused, the head decides.
    d.proposeAs('analyst', it0.id);
    d.approveAs('controller', it0.id);
    expect(d.lastAudit().reason).toMatch(/^materiality: /);
    expect(d.item(it0.id).state).toBe('PROPOSED');
    d.approveAs('head', it0.id);
    expect(d.item(it0.id).state).toBe('APPROVED');
  });

  it('RT1b a re-sync that changes nothing relevant leaves a PROPOSED item alone; NEEDS_INFO is reopened too', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.proposeAs('analyst', it0.id);
    d.sync({ rawRef: 'gl_line:gl-000123:18', erpCategoryCode: 'CATERING', entity: 'HOLDCO' });
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.reopens()).toHaveLength(0);
    expect(d.lastAudit().reason).toContain(`work_item ${it0.id} unchanged`);

    d.as('analyst', ctx => mod.ask(ctx, { workItemId: it0.id, question: 'offsite?' }));
    d.sync({ rawRef: 'gl_line:gl-000123:19', departmentId: 'dept-MKT' });
    expectCleared(d.item(it0.id));
    expect(d.reopens().at(-1)!.reason).toBe('reopened by correction: department_id');
    expect(d.reopens().at(-1)!.fromState).toBe('NEEDS_INFO');

    // NEW and REJECTED items are refreshed in place, never "reopened".
    d.sync({ rawRef: 'gl_line:gl-000123:20', amountUsdMinor: 1n, amountMinor: 1n });
    expect(d.item(it0.id).amountUsdMinor).toBe(1n);
    expect(d.reopens()).toHaveLength(1);
    d.proposeAs('analyst', it0.id);
    d.rejectAs('controller', it0.id, 'no');
    d.sync({ rawRef: 'gl_line:gl-000123:21', amountUsdMinor: 2n, amountMinor: 2n });
    expect(d.item(it0.id).state).toBe('REJECTED');
    expect(d.item(it0.id).amountUsdMinor).toBe(2n);
    expect(d.reopens()).toHaveLength(1);
  });

  it('RT2 a re-sync that breaks the cited pattern reopens the item; the auto_approver finds nothing to approve', () => {
    const d = makeDesk();
    const pol = approvedPolicy(d, {
      pattern: JSON.stringify({ vendor_id: 'ven-017', account_code: '6410', memo_regex: 'canteen', max_amount_usd_minor: 100_000 }),
    });
    const it0 = proposedUnder(d, 'gl-auto-1', pol.id, { amountUsdMinor: 50_000n });
    d.sync({ id: 'gl-auto-1', rawRef: 'gl_line:gl-auto-1:2', vendorId: 'ven-999', memo: 'Sponsor hospitality - Monaco', amountMinor: 3_000_000n, amountUsdMinor: 4_000_000n });
    expectCleared(d.item(it0.id));
    expect(d.reopens().at(-1)!.reason).toBe('reopened by correction: amount_usd_minor, amount_minor, vendor_id, memo');
    expect(d.reopens().at(-1)!.policyId).toBe(pol.id);

    d.approveAs('autoApprover', it0.id, 'standing approval');
    expect(d.item(it0.id).state).toBe('NEW');
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toMatch(/^invalid_transition/);

    // Citing the policy again against the corrected line is refused on the pattern.
    d.proposeAs('analyst', it0.id, { policyId: pol.id });
    expect(d.item(it0.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toContain('pattern does not match gl line gl-auto-1 on vendor_id, memo_regex, max_amount_usd_minor');
  });

  it('RT3 approving v2 suspends autonomy on v1 and reopens its open items; nothing is approved under v1 again', () => {
    const d = makeDesk();
    const v1 = approvedPolicy(d);
    const it0 = proposedUnder(d, 'gl-auto-2', v1.id);
    const approved = proposedUnder(d, 'gl-auto-2b', v1.id);
    d.approveAs('controller', approved.id);
    expect(d.item(approved.id).state).toBe('APPROVED');

    const v2 = approvedPolicy(d, { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07', rationale: 'v2: canteen is relevant' }, false);
    expect([v2.version, v2.state]).toEqual([2, 'APPROVED']);
    const v1now = d.h.db.policy.id.find(v1.id)!;
    expect(v1now.autonomy).toBe('SUSPENDED');
    expect(v1now.autonomyBy?.isEqual(d.identity('head'))).toBe(true);
    expect(v1now.autonomyReason).toBe(`superseded by grove-canteen-catering v2 (policy ${v2.id})`);
    expect(v1now.autonomyEvidence).toBe('');
    expect(v1now.state).toBe('APPROVED');

    for (const it of [it0, approved]) expectCleared(d.item(it.id));
    const reopens = d.reopens();
    expect(reopens.map(r => [r.subjectId, r.fromState, r.toState, r.reason, r.actorRole, r.policyId])).toEqual([
      [it0.id.toString(), 'PROPOSED', 'NEW', 'policy superseded', 'human_head_of_cost_cap', v1.id],
      [approved.id.toString(), 'APPROVED', 'NEW', 'policy superseded', 'human_head_of_cost_cap', v1.id],
    ]);
    const approveRow = d.audit().filter(r => r.action === 'approve_policy').at(-1)!;
    const diff = JSON.parse(approveRow.diff);
    expect(diff[`policy[${v1.id}].autonomy`]).toEqual({ from: 'GRANTED', to: 'SUSPENDED' });
    expect(diff[`work_item[${it0.id}].state`]).toEqual({ from: 'PROPOSED', to: 'NEW' });

    d.approveAs('autoApprover', it0.id);
    expect(d.item(it0.id).state).toBe('NEW');
    expect(d.lastAudit().allowed).toBe(false);

    // A fresh proposal citing v1 is refused as superseded; one citing v2 goes through, but the
    // head took v2's standing approval back, so the auto_approver is still refused.
    const it1 = d.sync({ id: 'gl-auto-3', rawRef: 'gl_line:gl-auto-3:1' });
    d.proposeAs('analyst', it1.id, { policyId: v1.id });
    expect(d.item(it1.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toContain(`superseded by policy ${v2.id} v2`);
    d.proposeAs('analyst', it1.id, { ...REL, policyId: v2.id });
    expect(d.item(it1.id).state).toBe('PROPOSED');
    d.approveAs('autoApprover', it1.id);
    expect(d.lastAudit().reason).toContain('standing approval is REVOKED, not GRANTED');

    // The head may re-grant a suspended version (SUSPENDED -> GRANTED), or revoke it.
    d.as('head', ctx => mod.grantAutonomy(ctx, { policyId: v1.id, evidence: SANDBOX_EVIDENCE, reason: 'v1 still wanted for 2025 lines' }));
    expect(d.h.db.policy.id.find(v1.id)!.autonomy).toBe('GRANTED');
    expect(d.lastAudit().fromState).toBe('SUSPENDED');
  });

  it('RT3b a new version in force only from July leaves March items under v1 alone (but still suspends autonomy)', () => {
    const d = makeDesk();
    const v1 = approvedPolicy(d);
    const march = proposedUnder(d, 'gl-mar', v1.id);
    approvedPolicy(d, { effectiveFrom: '2026-07-01', rationale: 'v2 from July' }, false);
    expect(d.item(march.id).state).toBe('PROPOSED');
    expect(d.reopens()).toHaveLength(0);
    expect(d.h.db.policy.id.find(v1.id)!.autonomy).toBe('SUSPENDED');
    d.approveAs('controller', march.id);
    expect(d.item(march.id).state).toBe('APPROVED');
    d.approveAs('autoApprover', proposedUnder(d, 'gl-mar2', v1.id).id);
    expect(d.lastAudit().reason).toContain('standing approval is SUSPENDED, not GRANTED');
  });

  it('RT4 a rulebook entry reloaded out of force after propose blocks approve and post', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.proposeAs('analyst', it0.id);
    const narrowed = { ...RULEBOOK[0]!, effectiveTo: '2026-02-28' };
    d.as('admin', ctx => mod.loadRulebookEntry(ctx, narrowed));

    d.approveAs('controller', it0.id);
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toBe(
      'rulebook_invalid: entry CATERING@SECD-ISS07 (in force 2026-01-01..2026-02-28) is not in force for period 2026-03'
    );
    d.approveAs('head', it0.id);
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toContain('rulebook_invalid');

    // Restored, the approval goes through; narrowed again before post, post is refused.
    d.as('admin', ctx => mod.loadRulebookEntry(ctx, RULEBOOK[0]!));
    d.approveAs('controller', it0.id);
    expect(d.item(it0.id).state).toBe('APPROVED');
    d.as('admin', ctx => mod.loadRulebookEntry(ctx, narrowed));
    d.postAs('gateway', it0.id);
    expect(d.item(it0.id).state).toBe('APPROVED');
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toContain('not in force for period 2026-03');
    expect(d.cap('2026-03')).toEqual({ rel: 0n, exc: 0n, pend: 914_400n, n: 0 });

    const it1 = d.sync({ id: 'gl-new', rawRef: 'gl_line:gl-new:1' });
    d.proposeAs('analyst', it1.id);
    expect(d.item(it1.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toContain('rulebook_invalid');
  });

  it('RT15 the controller who answered the question may neither approve nor reject the item', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.as('analyst', ctx => mod.ask(ctx, { workItemId: it0.id, question: 'Where was it served?' }));
    d.as('controller', ctx => mod.answer(ctx, { workItemId: it0.id, answer: 'MARKETING, sponsor dinner' }));
    expect(d.item(it0.id).answeredBy?.isEqual(d.identity('controller'))).toBe(true);
    d.proposeAs('analyst', it0.id, { categoryCode: 'MARKETING', rulebookEntryId: 'MARKETING@SECD-ISS07', reason: 'per controller answer', proposalSource: 'human_text' });

    d.approveAs('controller', it0.id, 'agreed');
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toBe(`separation_of_duties: caller answered the question on work item ${it0.id} and may not approve it`);
    d.rejectAs('controller', it0.id, 'changed my mind');
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toContain('separation_of_duties: caller answered');

    d.approveAs('head', it0.id, 'agreed');
    expect(d.item(it0.id).state).toBe('APPROVED');
    expect(d.lastAudit().allowed).toBe(true);
  });
});

// ================================================================ RT corrections and reversals

describe('RT corrections and reversals (defect 1)', () => {
  it('RT5 a second correction reverses the latest POSTED state, never the original, and the cap ends at the line amount', () => {
    const d = makeDesk();
    const orig = d.sync({ amountMinor: 5_000_000n, amountUsdMinor: 5_000_000n });
    d.proposeAs('analyst', orig.id, REL); d.approveAs('head', orig.id); d.postAs('gateway', orig.id, 'JE-1');
    expect(d.cap('2026-03')).toEqual({ rel: 5_000_000n, exc: 0n, pend: 0n, n: 1 });

    d.sync({ amountMinor: 1_000_000n, amountUsdMinor: 1_000_000n, rawRef: 'gl_line:gl-000123:50' });
    const [r1] = d.reversalsOf(orig.id);
    expect(d.reversalsOf(orig.id)).toHaveLength(1);
    expect([r1!.kind, r1!.reversesItemId, r1!.amountUsdMinor, r1!.periodKey]).toEqual(['reversal', orig.id, 1_000_000n, '2026-03']);
    d.proposeAs('analyst', r1!.id, REL); d.approveAs('controller', r1!.id); d.postAs('gateway', r1!.id, 'JE-2');
    expect(d.cap('2026-03')).toEqual({ rel: 1_000_000n, exc: 0n, pend: 0n, n: 2 });
    expect(d.item(orig.id).superseded).toBe(true);
    expect(d.item(r1!.id).superseded).toBe(false);

    d.sync({ amountMinor: 900_000n, amountUsdMinor: 900_000n, rawRef: 'gl_line:gl-000123:60' });
    expect(d.reversalsOf(orig.id)).toHaveLength(1); // nothing new points at the original
    const [r2] = d.reversalsOf(r1!.id);
    expect(d.reversalsOf(r1!.id)).toHaveLength(1);
    expect([r2!.reversesItemId, r2!.subjectRef, r2!.amountUsdMinor]).toEqual([r1!.id, r1!.id.toString(), 900_000n]);
    d.proposeAs('analyst', r2!.id, REL); d.approveAs('controller', r2!.id); d.postAs('gateway', r2!.id, 'JE-3');
    expect(d.cap('2026-03')).toEqual({ rel: 900_000n, exc: 0n, pend: 0n, n: 3 });
    expect(d.item(r1!.id).superseded).toBe(true);
    expect(d.item(r2!.id).superseded).toBe(false);
    expect([d.item(r2!.id).postedTreatment, d.item(r2!.id).postedCapEffectUsdMinor]).toEqual(['RELEVANT', 900_000n]);
  });

  it('RT5b two corrections before the reversal posts leave one open reversal, refreshed (and reopened if proposed)', () => {
    const d = makeDesk();
    const orig = d.sync({ amountMinor: 2_000_000n, amountUsdMinor: 2_000_000n });
    d.proposeAs('analyst', orig.id, REL); d.approveAs('controller', orig.id); d.postAs('gateway', orig.id, 'JE-1');
    d.sync({ amountMinor: 2_100_000n, amountUsdMinor: 2_100_000n, rawRef: 'gl_line:gl-000123:50' });
    const [r1] = d.reversalsOf(orig.id);
    d.proposeAs('analyst', r1!.id, REL);
    expect(d.item(r1!.id).state).toBe('PROPOSED');

    d.sync({ amountMinor: 2_200_000n, amountUsdMinor: 2_200_000n, rawRef: 'gl_line:gl-000123:51' });
    const revs = d.reversalsOf(orig.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.id).toBe(r1!.id);
    expectCleared(d.item(r1!.id));
    expect(d.item(r1!.id).amountUsdMinor).toBe(2_200_000n);
    expect(d.reopens().at(-1)!.reason).toBe('reopened by correction: amount_usd_minor, amount_minor');
    expect(d.cap('2026-03')!.pend).toBe(2_200_000n);

    d.proposeAs('analyst', r1!.id, REL); d.approveAs('controller', r1!.id); d.postAs('gateway', r1!.id, 'JE-2');
    expect(d.cap('2026-03')).toEqual({ rel: 2_200_000n, exc: 0n, pend: 0n, n: 2 });
  });

  it('RT6 a correction_of line arriving while the original is APPROVED is a plain classification; both post', () => {
    const d = makeDesk();
    const orig = d.sync({ amountMinor: 1_000_000n, amountUsdMinor: 1_000_000n });
    d.proposeAs('analyst', orig.id, REL); d.approveAs('controller', orig.id);
    d.as('sync', ctx => mod.upsertGlLine(ctx, glLine({ id: 'gl-000777', rawRef: 'gl_line:gl-000777:1', correctionOf: 'gl-000123', amountMinor: 1_200_000n, amountUsdMinor: 1_200_000n })));
    const c = d.itemFor('gl-000777');
    expect([c.kind, c.reversesItemId]).toEqual(['classification', undefined]);
    expect(d.item(orig.id).state).toBe('APPROVED'); // untouched
    d.postAs('gateway', orig.id, 'JE-1');
    d.proposeAs('analyst', c.id, REL); d.approveAs('controller', c.id); d.postAs('gateway', c.id, 'JE-2');
    // The world sends deltas; a line that is a full re-statement is the world's convention to fix.
    expect(d.cap('2026-03')).toEqual({ rel: 2_200_000n, exc: 0n, pend: 0n, n: 2 });
  });

  it('RT7 a POSTED line that only moves period gets a reversal in the new period', () => {
    const d = makeDesk();
    const orig = d.sync();
    d.proposeAs('analyst', orig.id); d.approveAs('controller', orig.id); d.postAs('gateway', orig.id);
    d.sync({ periodKey: '2025-12', postedDate: '2025-12-31', rawRef: 'gl_line:gl-000123:77' });
    expect(d.h.db.workItem.count()).toBe(2n);
    const [rev] = d.reversalsOf(orig.id);
    expect([rev!.periodKey, rev!.amountUsdMinor, rev!.state]).toEqual(['2025-12', 914_400n, 'NEW']);
    expect(rev!.reason).toContain('changed period_key after');
    expect(d.item(orig.id).periodKey).toBe('2026-03'); // POSTED rows are never edited
    expect(d.cap('2025-12')).toEqual({ rel: 0n, exc: 0n, pend: 914_400n, n: 0 });

    // The back-out lands in the reversal's period (the original's may be locked).
    d.proposeAs('analyst', rev!.id, { categoryCode: 'SICK_COVER', rulebookEntryId: 'SICK_COVER@ISS22' });
    d.approveAs('controller', rev!.id); d.postAs('gateway', rev!.id, 'JE-2');
    expect(d.cap('2025-12')).toEqual({ rel: 0n, exc: 0n, pend: 0n, n: 1 });
    expect(d.cap('2026-03')).toEqual({ rel: 0n, exc: 914_400n, pend: 0n, n: 1 });
    expect(d.item(orig.id).superseded).toBe(true);
  });

  it('RT14 the world reversal (-A) + repost (+A) pair after the original is POSTED nets the cap to +A', () => {
    const d = makeDesk();
    const A = 3_109_376n; // gl-001340
    const orig = d.sync({ id: 'gl-001340', rawRef: 'gl_line:gl-001340:1', periodKey: '2026-05', postedDate: '2026-05-18', amountMinor: A, amountUsdMinor: A });
    d.proposeAs('analyst', orig.id, REL); d.approveAs('controller', orig.id); d.postAs('gateway', orig.id, 'JE-1');
    for (const [id, amt] of [['gl-001477', -A], ['gl-001479', A]] as const) {
      d.as('sync', ctx => mod.upsertGlLine(ctx, glLine({ id, rawRef: `gl_line:${id}:2`, periodKey: '2026-06', postedDate: '2026-06-01', correctionOf: 'gl-001340', amountMinor: amt, amountUsdMinor: amt })));
    }
    expect(d.reversalsOf(orig.id)).toHaveLength(0);
    for (const id of ['gl-001477', 'gl-001479']) {
      const c = d.itemFor(id);
      expect(c.kind).toBe('classification');
      d.proposeAs('analyst', c.id, REL); d.approveAs('controller', c.id); d.postAs('gateway', c.id, `JE-${c.id}`);
    }
    const may = d.cap('2026-05')!, jun = d.cap('2026-06')!;
    expect(may.rel).toBe(A);
    expect(jun.rel).toBe(0n);
    expect(may.rel + jun.rel).toBe(A);
    expect(d.item(orig.id).superseded).toBe(false);
  });

  it('T0 a reversal whose reversed item was already superseded cannot post, and a reversal subtracts only once', () => {
    const d = makeDesk();
    const orig = d.sync({ amountUsdMinor: 1_000n });
    d.proposeAs('analyst', orig.id, REL); d.approveAs('controller', orig.id); d.postAs('gateway', orig.id, 'JE-1');
    d.sync({ amountUsdMinor: 900n, rawRef: 'r2' });
    const [rev] = d.reversalsOf(orig.id);
    d.proposeAs('analyst', rev!.id, REL); d.approveAs('controller', rev!.id);
    // Tamper: mark the original superseded before the reversal posts.
    d.h.withReducerTx(TestAuth.internal(), ctx => ctx.db.workItem.id.update({ ...ctx.db.workItem.id.find(orig.id)!, superseded: true }));
    d.postAs('gateway', rev!.id, 'JE-2');
    expect(d.item(rev!.id).state).toBe('APPROVED');
    expect(d.lastAudit().reason).toBe(`reversal_invalid: reversed work item ${orig.id} is already superseded`);
    expect(d.cap('2026-03')!.rel).toBe(1_000n);
  });
});

// ================================================================ RT locks

describe('RT locks (defect 8)', () => {
  it('RT8 a period cannot lock while an item is APPROVED; once posted it locks; a late line is refused, not lost', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.proposeAs('analyst', it0.id); d.approveAs('controller', it0.id);
    d.as('head', ctx => mod.lockPeriod(ctx, { periodKey: '2026-03' }));
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toBe(`period_not_ready: 1 work item in period 2026-03 is not POSTED: ${it0.id}`);
    expect(d.h.db.period.key.find('2026-03')).toBeNull();

    d.postAs('gateway', it0.id);
    expect(d.item(it0.id).state).toBe('POSTED');
    expect(d.cap('2026-03')!.pend).toBe(0n);
    d.as('head', ctx => mod.lockPeriod(ctx, { periodKey: '2026-03' }));
    expect(d.lastAudit().allowed).toBe(true);
    expect(d.h.db.period.key.find('2026-03')!.locked).toBe(true);

    // A late line into the locked period stays NEW and every propose is a logged denial; the
    // analyst's back-off is its own rule (SCHEMA section 10). The sync is never blocked.
    const late = d.sync({ id: 'gl-late', rawRef: 'gl_line:gl-late:1', postedDate: '2026-03-27' });
    d.proposeAs('analyst', late.id);
    d.proposeAs('analyst', late.id);
    expect(d.item(late.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toBe('period_locked: period 2026-03 is locked');
    expect(d.audit().filter(r => r.subjectId === late.id.toString() && !r.allowed)).toHaveLength(2);
    // Re-dated into an open period by the sync, it moves on.
    d.sync({ id: 'gl-late', rawRef: 'gl_line:gl-late:2', periodKey: '2026-04', postedDate: '2026-04-01' });
    expect(d.cap('2026-03')!.pend).toBe(0n);
    expect(d.cap('2026-04')!.pend).toBe(914_400n);
    d.proposeAs('analyst', late.id);
    expect([d.item(late.id).state, d.item(late.id).periodKey]).toEqual(['PROPOSED', '2026-04']);
  });

  it('RT8b the lock denial names the count and the first ten ids', () => {
    const d = makeDesk();
    const ids: bigint[] = [];
    for (let k = 0; k < 12; k++) ids.push(d.sync({ id: `gl-${k}`, rawRef: `r${k}` }).id);
    d.as('head', ctx => mod.lockPeriod(ctx, { periodKey: '2026-03' }));
    expect(d.lastAudit().reason).toBe(`period_not_ready: 12 work items in period 2026-03 are not POSTED: ${ids.slice(0, 10).join(', ')}, …`);
  });

  it('RT9 a reversal created in a locked period cannot be proposed; the cap is untouched', () => {
    const d = makeDesk();
    const orig = d.sync();
    d.proposeAs('analyst', orig.id); d.approveAs('controller', orig.id); d.postAs('gateway', orig.id);
    d.as('head', ctx => mod.lockPeriod(ctx, { periodKey: '2026-03' }));
    expect(d.lastAudit().allowed).toBe(true);
    d.sync({ amountMinor: 0n, amountUsdMinor: 0n, rawRef: 'gl_line:gl-000123:99' });
    const [rev] = d.reversalsOf(orig.id);
    expect(rev!.periodKey).toBe('2026-03');
    d.proposeAs('analyst', rev!.id, { reason: 'credit note' });
    expect(d.item(rev!.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toBe('period_locked: period 2026-03 is locked');
    expect(d.cap('2026-03')).toEqual({ rel: 0n, exc: 914_400n, pend: 0n, n: 1 });
  });
});

// ================================================================ RT patterns and money

describe('RT patterns and money', () => {
  it('RT10 an empty or all-null pattern is refused at proposePolicy', () => {
    const d = makeDesk();
    for (const pattern of ['{}', '{"memo_regex":null,"vendor_id":null}']) {
      expect(() => d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs({ policyKey: 'nullish', pattern })))).toThrow(
        'pattern must have at least one non-null key'
      );
    }
    expect(d.h.db.policy.count()).toBe(0n);
    // Patterns the two matchers would read differently are refused with the rule they break.
    for (const [memo_regex, why] of [
      ['(?i)canteen', 'inline flags are not allowed'],
      ['(a+)+', 'nested quantifiers are not allowed'],
      ['(?<=a)b', 'lookbehind and named groups are not allowed'],
      ['x'.repeat(201), 'longer than 200 characters'],
      ['😀', 'outside the Basic Multilingual Plane'],
      ['(', 'does not compile'],
    ] as const) {
      expect(() => d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs({ pattern: JSON.stringify({ memo_regex }) })))).toThrow(why);
    }
    expect(d.h.db.policy.count()).toBe(0n);
  });

  it('RT10b memo matching is NFKC-normalised, stripped, case-insensitive and ASCII-only', () => {
    const d = makeDesk();
    const pol = approvedPolicy(d, { pattern: JSON.stringify({ memo_regex: '\\bcanteen\\b' }) }, false);
    const cases: Array<[string, boolean]> = [
      ['  Grove ｃANTEEN March\n', true], // fullwidth c, upper case, surrounding whitespace
      ['Hotel - İmola canteen', true],
      ['canteens', false],
      ['Grove canteen 😀', false], // astral character: matches nothing
    ];
    cases.forEach(([memo, ok], k) => {
      const it0 = d.sync({ id: `gl-m${k}`, rawRef: `r${k}`, memo });
      d.proposeAs('analyst', it0.id, { policyId: pol.id });
      expect(d.item(it0.id).state, memo).toBe(ok ? 'PROPOSED' : 'NEW');
      if (!ok) expect(d.lastAudit().reason).toContain('memo_regex');
    });
  });

  it('RT11 (Tier 1, unchanged) three lines just under materiality from one order are each approved by the controller', () => {
    const d = makeDesk();
    for (const k of [1, 2, 3]) {
      const it0 = d.sync({ id: `gl-split-${k}`, rawRef: `gl_line:gl-split-${k}:1`, memo: `Gearbox casing machining - batch ${k} of 3 (PO-26-51877)`, amountUsdMinor: MATERIALITY - 1n });
      d.proposeAs('analyst', it0.id, REL);
      d.approveAs('controller', it0.id);
      expect(d.item(it0.id).state).toBe('APPROVED'); // aggregate materiality is Tier 1 (SCHEMA section 10, defect 7)
    }
  });

  it('RT12 a credit just under materiality is approved by the controller; at -materiality it is not', () => {
    const d = makeDesk();
    const it0 = d.sync({ amountUsdMinor: -(MATERIALITY - 1n) });
    d.proposeAs('analyst', it0.id); d.approveAs('controller', it0.id);
    expect(d.item(it0.id).state).toBe('APPROVED');
    const big = d.sync({ id: 'gl-big', rawRef: 'r', amountUsdMinor: -MATERIALITY });
    d.proposeAs('analyst', big.id); d.approveAs('controller', big.id);
    expect(d.item(big.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toMatch(/^materiality: /);
  });

  it('RT13 (Low, unchanged) any role can append a step under another run id; the row names the real actor', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.as('redTeam', ctx => mod.recordStep(ctx, { runId: 'cap_analyst-2026-03-14-0a1b2c3d', step: 7, kind: 'decision', name: 'propose:policy', input: '{"chosen":"MARKETING"}', outputDigest: 'x', outputExcerpt: 'forged', workItemId: it0.id, model: 'claude-opus-5-5' }));
    const st = [...d.h.db.agentStep.iter()].at(-1)!;
    expect(st.actorRole).toBe('red_team');
    expect(st.actor.isEqual(d.identity('redTeam'))).toBe(true);
  });

  it('T0 the auto_approver is denied for a Claude proposal even under a granted, matching policy', () => {
    const d = makeDesk();
    const pol = approvedPolicy(d);
    const it0 = d.sync({ id: 'gl-llm', rawRef: 'r' });
    d.proposeAs('analyst', it0.id, { policyId: pol.id, proposalSource: 'llm' });
    expect(d.item(it0.id).state).toBe('PROPOSED');
    d.approveAs('autoApprover', it0.id);
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toBe(`standing_approval: work item ${it0.id} proposal_source is "llm"; no approved rule decided it, so a person does`);
    expect(JSON.parse(d.lastAudit().evidence).proposal_source).toBe('llm');
    d.approveAs('controller', it0.id);
    expect(d.item(it0.id).state).toBe('APPROVED');
  });
});

// ================================================================ RT more

describe('RT more', () => {
  it('RT16 (Tier 1, unchanged) a mid-month rule change leaves no entry in force for that period', () => {
    const d = makeDesk();
    d.as('admin', ctx => mod.loadRulebookEntry(ctx, { ...RULEBOOK[0]!, effectiveTo: '2026-07-14' }));
    d.as('admin', ctx => mod.loadRulebookEntry(ctx, { ...RULEBOOK[0]!, id: 'CATERING@SECD-ISS08', ruleVersion: 'SECD-ISS08', effectiveFrom: '2026-07-15' }));
    const it0 = d.sync({ id: 'gl-jul', rawRef: 'gl_line:gl-jul:1', periodKey: '2026-07', postedDate: '2026-07-20' });
    d.proposeAs('analyst', it0.id);
    expect(d.lastAudit().reason).toContain('not in force for period 2026-07');
    d.proposeAs('analyst', it0.id, { rulebookEntryId: 'CATERING@SECD-ISS08' });
    expect(d.lastAudit().reason).toContain('not in force for period 2026-07');
    expect(d.item(it0.id).state).toBe('NEW');
  });

  it('RT17 (Tier 1, unchanged) postedDate and periodKey are not cross-checked by the module', () => {
    const d = makeDesk();
    const it0 = d.sync({ id: 'gl-dec', rawRef: 'gl_line:gl-dec:1', postedDate: '2025-12-31', periodKey: '2026-01' });
    d.proposeAs('analyst', it0.id);
    expect([d.item(it0.id).state, d.item(it0.id).periodKey]).toEqual(['PROPOSED', '2026-01']);
  });
});
