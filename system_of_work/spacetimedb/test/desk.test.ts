import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp, type Identity } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { sha256Hex } from '../src/util';

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
  const auditCount = () => Number(h.db.auditLog.count());
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

  // Every table except audit_log, for "nothing else changed" assertions.
  const stateSnapshot = () =>
    JSON.stringify(
      {
        role: [...h.db.role.iter()],
        roleInvite: [...h.db.roleInvite.iter()],
        setting: [...h.db.setting.iter()],
        period: [...h.db.period.iter()],
        rulebookEntry: [...h.db.rulebookEntry.iter()],
        glLine: [...h.db.glLine.iter()],
        billLine: [...h.db.billLine.iter()],
        vendor: [...h.db.vendor.iter()],
        fairValue: [...h.db.fairValue.iter()],
        workItem: [...h.db.workItem.iter()],
        policy: [...h.db.policy.iter()],
        precedent: [...h.db.precedent.iter()],
        capPosition: [...h.db.capPosition.iter()],
        agentStep: [...h.db.agentStep.iter()],
      },
      (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)
    );

  return {
    h, as, identity, audit, auditCount, item, itemFor, sync, proposeAs, approveAs, rejectAs, postAs, lastAudit,
    stateSnapshot,
  };
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

// ---------------------------------------------------------------- tests

describe('happy path', () => {
  it('NEW -> PROPOSED -> APPROVED -> POSTED writes exactly 4 audit rows and updates the cap', () => {
    const d = makeDesk();
    const before = d.auditCount();

    const created = d.sync();
    expect(created.kind).toBe('classification');
    expect(created.state).toBe('NEW');
    expect(created.subjectRef).toBe('gl-000123');
    expect(created.amountUsdMinor).toBe(914_400n);
    expect(created.periodKey).toBe('2026-03');
    expect(d.h.db.capPosition.periodKey.find('2026-03')?.pendingUsdMinor).toBe(914_400n);

    d.proposeAs('analyst', created.id);
    expect(d.item(created.id).state).toBe('PROPOSED');
    expect(d.item(created.id).proposedBy?.isEqual(d.identity('analyst'))).toBe(true);
    d.approveAs('controller', created.id, 'canteen is excluded under z');
    expect(d.item(created.id).state).toBe('APPROVED');
    d.postAs('gateway', created.id);
    const posted = d.item(created.id);
    expect(posted.state).toBe('POSTED');
    expect(posted.erpEntryId).toBe('JE-2026-000417');

    const rows = d.audit().slice(before);
    expect(rows).toHaveLength(4);
    expect(rows.map(r => [r.action, r.actorRole, r.fromState, r.toState, r.allowed])).toEqual([
      ['sync_upsert', 'sync', 'ABSENT', 'SYNCED', true],
      ['propose', 'ai_cap_analyst', 'NEW', 'PROPOSED', true],
      ['approve', 'human_controller', 'PROPOSED', 'APPROVED', true],
      ['post', 'gateway', 'APPROVED', 'POSTED', true],
    ]);
    // The sync row records the work item it created; the propose row diffs the item.
    expect(JSON.parse(rows[0]!.diff)[`work_item[${created.id}]`].to.state).toBe('NEW');
    const proposeDiff = JSON.parse(rows[1]!.diff);
    expect(proposeDiff.state).toEqual({ from: 'NEW', to: 'PROPOSED' });
    expect(proposeDiff.proposed_category_code).toEqual({ from: null, to: 'CATERING' });
    expect(rows[1]!.evidence).toBe('["gl-000123","bill-00042"]');
    expect(rows[3]!.subjectId).toBe(created.id.toString());

    const cap = d.h.db.capPosition.periodKey.find('2026-03')!;
    expect(cap.excludedUsdMinor).toBe(914_400n);
    expect(cap.relevantUsdMinor).toBe(0n);
    expect(cap.pendingUsdMinor).toBe(0n);
    expect(cap.postedItems).toBe(1);

    const precedents = [...d.h.db.precedent.iter()];
    expect(precedents).toHaveLength(1);
    expect(precedents[0]!.reason).toBe('approve: canteen is excluded under z');
    expect(precedents[0]!.categoryCode).toBe('CATERING');
    const summary = JSON.parse(precedents[0]!.patternSummary);
    expect(summary).toMatchObject({ vendor_id: 'ven-017', account_code: '6410', memo: 'Grove Catering - factory canteen March' });
  });

  it('RELEVANT posts the line amount; ADJUSTMENT posts its cap effect, both to relevant_usd_minor', () => {
    const d = makeDesk();
    const a = d.sync({ id: 'gl-1', rawRef: 'gl_line:gl-1:1', amountUsdMinor: 100n });
    const b = d.sync({ id: 'gl-2', rawRef: 'gl_line:gl-2:2', amountUsdMinor: 250n });
    d.proposeAs('analyst', a.id, { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07' });
    d.proposeAs('analyst', b.id, {
      categoryCode: 'ADJ_RELATED_PARTY_FAIR_VALUE',
      rulebookEntryId: 'ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07',
      capEffectUsdMinor: 310n, // amount + uplift
    });
    for (const it of [a, b]) {
      d.approveAs('controller', it.id);
      d.postAs('gateway', it.id, `JE-${it.id}`);
    }
    const cap = d.h.db.capPosition.periodKey.find('2026-03')!;
    expect(cap.relevantUsdMinor).toBe(410n);
    expect(cap.excludedUsdMinor).toBe(0n);
    expect(cap.pendingUsdMinor).toBe(0n);
    expect(cap.postedItems).toBe(2);
    expect([d.item(a.id).postedTreatment, d.item(a.id).postedCapEffectUsdMinor]).toEqual(['RELEVANT', 100n]);
    expect([d.item(b.id).postedTreatment, d.item(b.id).postedCapEffectUsdMinor]).toEqual(['ADJUSTMENT', 310n]);
  });

  it('capEffectUsdMinor is required for ADJUSTMENT and must be absent otherwise; proposalSource is validated', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.proposeAs('analyst', it0.id, {
      categoryCode: 'ADJ_RELATED_PARTY_FAIR_VALUE',
      rulebookEntryId: 'ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07',
    });
    expect(d.item(it0.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toBe('cap_effect_invalid: entry ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07 is an ADJUSTMENT; capEffectUsdMinor is required');
    d.proposeAs('analyst', it0.id, { capEffectUsdMinor: 5n });
    expect(d.item(it0.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toContain('cap_effect_invalid: entry CATERING@SECD-ISS07 is EXCLUDED; capEffectUsdMinor must be absent');
    // A gross-up on a credit note is a zero cap effect, and zero is a value, not an absence.
    d.proposeAs('analyst', it0.id, {
      categoryCode: 'ADJ_RELATED_PARTY_FAIR_VALUE',
      rulebookEntryId: 'ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07',
      capEffectUsdMinor: 0n,
      proposalSource: 'llm',
    });
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.item(it0.id).capEffectUsdMinor).toBe(0n);
    expect(d.item(it0.id).proposalSource).toBe('llm');
    const n = d.auditCount();
    expect(() => d.proposeAs('analyst', d.sync({ id: 'gl-x', rawRef: 'r' }).id, { proposalSource: 'guess' })).toThrow('proposalSource must be one of');
    expect(d.auditCount()).toBe(n + 1); // the sync row only
  });
});

describe('denials are committed, not thrown', () => {
  it('analyst approving its own proposal is denied, logged allowed=false, state unchanged', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.proposeAs('analyst', it0.id);
    const n = d.auditCount();
    const snapshot = d.stateSnapshot();

    expect(() => d.approveAs('analyst', it0.id, 'looks right to me')).not.toThrow();

    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.auditCount()).toBe(n + 1);
    expect(d.stateSnapshot()).toBe(snapshot);
    const row = d.lastAudit();
    expect(row.allowed).toBe(false);
    expect(row.action).toBe('approve');
    expect(row.actorRole).toBe('ai_cap_analyst');
    expect(row.actor.isEqual(d.identity('analyst'))).toBe(true);
    expect(row.fromState).toBe('PROPOSED');
    expect(row.toState).toBe('APPROVED'); // the attempted target
    expect(row.reason).toContain('role_not_permitted');
    expect(row.reason).toContain('separation_of_duties');
    expect(row.diff).toBe('{}');
  });

  it('controller approving at/above materiality is denied; head of cost cap approves it', () => {
    const d = makeDesk();
    const big = d.sync({ amountUsdMinor: MATERIALITY }); // exactly at the threshold
    d.proposeAs('analyst', big.id);

    d.approveAs('controller', big.id);
    expect(d.item(big.id).state).toBe('PROPOSED');
    const denied = d.lastAudit();
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/^materiality: /);
    expect(denied.reason).not.toContain('role_not_permitted');

    d.approveAs('head', big.id, 'material, reviewed by head');
    expect(d.item(big.id).state).toBe('APPROVED');
    expect(d.lastAudit().allowed).toBe(true);
    expect(d.lastAudit().actorRole).toBe('human_head_of_cost_cap');
    expect(d.item(big.id).decidedBy?.isEqual(d.identity('head'))).toBe(true);
  });

  it('a large credit is as material as a large charge', () => {
    const d = makeDesk();
    const credit = d.sync({ amountUsdMinor: -MATERIALITY });
    d.proposeAs('analyst', credit.id);
    d.approveAs('controller', credit.id);
    expect(d.item(credit.id).state).toBe('PROPOSED');
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toMatch(/^materiality: /);
    d.approveAs('head', credit.id, 'material credit, reviewed by head');
    expect(d.item(credit.id).state).toBe('APPROVED');
  });

  it('controller approves below materiality', () => {
    const d = makeDesk();
    const small = d.sync({ amountUsdMinor: MATERIALITY - 1n });
    d.proposeAs('analyst', small.id);
    d.approveAs('controller', small.id);
    expect(d.item(small.id).state).toBe('APPROVED');
  });

  it('post by anyone but the gateway is denied; the gateway cannot post an unapproved item', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.proposeAs('analyst', it0.id);

    d.postAs('gateway', it0.id);
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toMatch(/^invalid_transition: /);

    d.approveAs('controller', it0.id);
    for (const who of ['analyst', 'controller', 'head', 'redTeam', 'admin', 'stranger'] as const) {
      const n = d.auditCount();
      d.postAs(who, it0.id);
      expect(d.item(it0.id).state).toBe('APPROVED');
      expect(d.auditCount()).toBe(n + 1);
      expect(d.lastAudit().allowed).toBe(false);
      expect(d.lastAudit().reason).toContain('role_not_permitted');
    }
    expect(d.item(it0.id).erpEntryId).toBeUndefined();
  });

  it('propose with a rulebook entry not in force for the period is denied', () => {
    const d = makeDesk();
    const it0 = d.sync();

    d.proposeAs('analyst', it0.id, { categoryCode: 'SICK_COVER', rulebookEntryId: 'SICK_COVER@ISS22' });
    expect(d.item(it0.id).state).toBe('NEW');
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toContain('rulebook_invalid: entry SICK_COVER@ISS22');
    expect(d.lastAudit().reason).toContain('not in force for period 2026-03');

    d.proposeAs('analyst', it0.id, { categoryCode: 'MARKETING', rulebookEntryId: 'CATERING@SECD-ISS07' });
    expect(d.lastAudit().reason).toContain('is category CATERING, not MARKETING');
    d.proposeAs('analyst', it0.id, { categoryCode: 'CATERING', rulebookEntryId: 'CATERING@MADE-UP' });
    expect(d.lastAudit().reason).toContain('does not exist');
    expect(d.item(it0.id).state).toBe('NEW');

    d.proposeAs('analyst', it0.id); // CATERING@SECD-ISS07 is in force for 2026-03
    expect(d.item(it0.id).state).toBe('PROPOSED');
  });

  it('a 2025 item may cite the ISS22 entry but not the 2026 one', () => {
    const d = makeDesk();
    const old = d.sync({ id: 'gl-2025-1', rawRef: 'r', postedDate: '2025-11-03', periodKey: '2025-11' });
    d.proposeAs('analyst', old.id);
    expect(d.lastAudit().reason).toContain('not in force for period 2025-11');
    d.proposeAs('analyst', old.id, { categoryCode: 'SICK_COVER', rulebookEntryId: 'SICK_COVER@ISS22' });
    expect(d.item(old.id).state).toBe('PROPOSED');
  });

  it('a period locks only once everything in it is POSTED; a locked period refuses propose, approve and post', () => {
    const d = makeDesk();
    const posted = d.sync({ id: 'gl-feb0', rawRef: 'r0', postedDate: '2026-02-09', periodKey: '2026-02' });
    d.proposeAs('analyst', posted.id);
    d.approveAs('controller', posted.id);
    d.postAs('gateway', posted.id, 'JE-feb0');
    const feb = d.sync({ id: 'gl-feb', rawRef: 'r1', postedDate: '2026-02-10', periodKey: '2026-02' });
    const feb2 = d.sync({ id: 'gl-feb2', rawRef: 'r2', postedDate: '2026-02-11', periodKey: '2026-02' });
    const feb3 = d.sync({ id: 'gl-feb3', rawRef: 'r3', postedDate: '2026-02-12', periodKey: '2026-02' });
    d.proposeAs('analyst', feb2.id);
    d.proposeAs('analyst', feb3.id);
    d.approveAs('controller', feb3.id);

    d.as('controller', ctx => mod.lockPeriod(ctx, { periodKey: '2026-02' }));
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toContain('role_not_permitted');
    expect(d.h.db.period.key.find('2026-02')).toBeNull();

    // Defect 8: NEW, PROPOSED and APPROVED items in the period block the lock, and are named.
    d.as('head', ctx => mod.lockPeriod(ctx, { periodKey: '2026-02' }));
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toBe(`period_not_ready: 3 work items in period 2026-02 are not POSTED: ${feb.id}, ${feb2.id}, ${feb3.id}`);
    expect(d.h.db.period.key.find('2026-02')).toBeNull();

    // Lock a clean period, then see what a late line and (tampered) open items run into.
    d.as('head', ctx => mod.lockPeriod(ctx, { periodKey: '2026-01' }));
    const p = d.h.db.period.key.find('2026-01')!;
    expect(p.locked).toBe(true);
    expect(p.lockedBy?.isEqual(d.identity('head'))).toBe(true);
    expect(d.lastAudit().toState).toBe('LOCKED');

    const late = d.sync({ id: 'gl-jan-late', rawRef: 'r4', postedDate: '2026-01-30', periodKey: '2026-01' });
    d.proposeAs('analyst', late.id);
    expect(d.item(late.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toBe('period_locked: period 2026-01 is locked');
    // A re-sync moving a PROPOSED/APPROVED item into a locked period reopens it to NEW, so these
    // states can only be reached in a locked period by a direct write; the guard still holds.
    d.h.withReducerTx(TestAuth.internal(), ctx => {
      ctx.db.workItem.id.update({ ...ctx.db.workItem.id.find(feb2.id)!, periodKey: '2026-01' });
      ctx.db.workItem.id.update({ ...ctx.db.workItem.id.find(feb3.id)!, periodKey: '2026-01' });
    });
    d.approveAs('head', feb2.id);
    expect(d.item(feb2.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toContain('period_locked');
    d.postAs('gateway', feb3.id);
    expect(d.item(feb3.id).state).toBe('APPROVED');
    expect(d.lastAudit().reason).toContain('period_locked');

    // Locking again is an invalid transition, also logged.
    d.as('head', ctx => mod.lockPeriod(ctx, { periodKey: '2026-01' }));
    expect(d.lastAudit().reason).toMatch(/^invalid_transition/);
  });

  it('every denial leaves exactly one audit row and changes nothing else', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs()));
    const pol = [...d.h.db.policy.iter()][0]!;

    const attempts: Array<[string, () => void]> = [
      ['red team proposes', () => d.proposeAs('redTeam', it0.id)],
      ['red team approves', () => d.approveAs('redTeam', it0.id)],
      ['red team posts', () => d.postAs('redTeam', it0.id)],
      ['red team asks', () => d.as('redTeam', ctx => mod.ask(ctx, { workItemId: it0.id, question: 'why?' }))],
      ['red team answers', () => d.as('redTeam', ctx => mod.answer(ctx, { workItemId: it0.id, answer: 'because' }))],
      ['red team locks', () => d.as('redTeam', ctx => mod.lockPeriod(ctx, { periodKey: '2026-03' }))],
      ['red team syncs', () => d.as('redTeam', ctx => mod.upsertGlLine(ctx, glLine({ amountUsdMinor: 1n })))],
      ['red team sets materiality', () => d.as('redTeam', ctx => mod.setSetting(ctx, { key: 'materiality_usd_minor', value: '999999999999' }))],
      ['red team invites itself', () => d.as('redTeam', ctx => mod.createRoleInvite(ctx, { role: 'human_head_of_cost_cap', label: 'x', code: 'evil' }))],
      ['red team re-bootstraps', () => d.as('redTeam', ctx => mod.bootstrapAdmin(ctx, {}))],
      ['red team approves policy', () => d.as('redTeam', ctx => mod.approvePolicy(ctx, { policyId: pol.id, reason: 'ok' }))],
      ['red team proposes policy', () => d.as('redTeam', ctx => mod.proposePolicy(ctx, proposePolicyArgs()))],
      ['red team claims a used code', () => d.as('redTeam', ctx => mod.claimRole(ctx, { code: 'code-head' }))],
      ['stranger claims a guessed code', () => d.as('stranger', ctx => mod.claimRole(ctx, { code: 'guess-1234' }))],
      ['stranger claims a used code', () => d.as('stranger', ctx => mod.claimRole(ctx, { code: 'code-head' }))],
      ['analyst approves', () => d.approveAs('analyst', it0.id)],
      ['analyst posts', () => d.postAs('analyst', it0.id)],
      ['analyst answers', () => d.as('analyst', ctx => mod.answer(ctx, { workItemId: it0.id, answer: 'me' }))],
      ['controller proposes', () => d.proposeAs('controller', it0.id)],
      ['gateway approves', () => d.approveAs('gateway', it0.id)],
      ['sync proposes', () => d.proposeAs('sync', it0.id)],
      ['learner approves own policy', () => d.as('learner', ctx => mod.approvePolicy(ctx, { policyId: pol.id, reason: 'mine' }))],
      ['controller approves policy', () => d.as('controller', ctx => mod.approvePolicy(ctx, { policyId: pol.id, reason: 'ok' }))],
      ['analyst proposes policy', () => d.as('analyst', ctx => mod.proposePolicy(ctx, proposePolicyArgs()))],
      ['admin proposes', () => d.proposeAs('admin', it0.id)],
      ['head approves a NEW item', () => d.approveAs('head', it0.id)],
      ['analyst cites an unapproved policy', () => d.proposeAs('analyst', it0.id, { policyId: pol.id })],
    ];
    for (const [label, attempt] of attempts) {
      const n = d.auditCount();
      const snapshot = d.stateSnapshot();
      expect(attempt, label).not.toThrow();
      expect(d.auditCount(), label).toBe(n + 1);
      expect(d.lastAudit().allowed, label).toBe(false);
      expect(d.lastAudit().reason, label).not.toBe('');
      expect(d.stateSnapshot(), label).toBe(snapshot);
    }
  });
});

describe('ask, answer, reject, re-propose', () => {
  it('ask -> answer -> NEW writes a precedent, then the item can be proposed', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.as('analyst', ctx => mod.ask(ctx, { workItemId: it0.id, question: 'Is ven-017 the canteen or the sponsor caterer?' }));
    expect(d.item(it0.id).state).toBe('NEEDS_INFO');
    expect(d.item(it0.id).question).toBe('Is ven-017 the canteen or the sponsor caterer?');
    expect(d.lastAudit().toState).toBe('NEEDS_INFO');

    d.as('controller', ctx => mod.answer(ctx, { workItemId: it0.id, answer: 'Factory canteen.' }));
    const answered = d.item(it0.id);
    expect(answered.state).toBe('NEW');
    expect(answered.answer).toBe('Factory canteen.');
    expect(d.lastAudit().action).toBe('answer');
    expect(d.lastAudit().allowed).toBe(true);

    const precedents = [...d.h.db.precedent.workItemId.filter(it0.id)];
    expect(precedents).toHaveLength(1);
    expect(precedents[0]!.reason).toBe('answer: Q: Is ven-017 the canteen or the sponsor caterer? A: Factory canteen.');
    expect(precedents[0]!.decidedBy.isEqual(d.identity('controller'))).toBe(true);
    expect(JSON.parse(precedents[0]!.patternSummary)).toMatchObject({ vendor_id: 'ven-017', account_code: '6410' });

    d.proposeAs('analyst', it0.id);
    expect(d.item(it0.id).state).toBe('PROPOSED');
  });

  it('ask from PROPOSED, answer only from NEEDS_INFO', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.as('controller', ctx => mod.answer(ctx, { workItemId: it0.id, answer: 'unprompted' }));
    expect(d.lastAudit().reason).toMatch(/^invalid_transition/);
    d.proposeAs('analyst', it0.id);
    d.as('analyst', ctx => mod.ask(ctx, { workItemId: it0.id, question: 'second thoughts: is this offsite?' }));
    expect(d.item(it0.id).state).toBe('NEEDS_INFO');
  });

  it('reject writes a precedent; the analyst can propose again and decided_* is cleared', () => {
    const d = makeDesk();
    const it0 = d.sync({ memo: 'Offsite lunch at wind tunnel session' });
    d.proposeAs('analyst', it0.id);
    d.rejectAs('head', it0.id, 'not at a Competition or team premises: Relevant');
    const rejected = d.item(it0.id);
    expect(rejected.state).toBe('REJECTED');
    expect(rejected.decidedReason).toBe('not at a Competition or team premises: Relevant');
    const prec = [...d.h.db.precedent.iter()];
    expect(prec).toHaveLength(1);
    expect(prec[0]!.reason).toBe('reject: not at a Competition or team premises: Relevant');
    expect(prec[0]!.categoryCode).toBe('CATERING');
    expect(JSON.parse(prec[0]!.patternSummary).memo).toBe('Offsite lunch at wind tunnel session');

    d.proposeAs('analyst', it0.id, {
      categoryCode: 'RELEVANT',
      rulebookEntryId: 'RELEVANT@SECD-ISS07',
      reason: 'per head of cost cap ruling: offsite lunch is Relevant',
    });
    const again = d.item(it0.id);
    expect(again.state).toBe('PROPOSED');
    expect(again.proposedCategoryCode).toBe('RELEVANT');
    expect(again.decidedBy).toBeUndefined();
    expect(again.decidedReason).toBeUndefined();
    const diff = JSON.parse(d.lastAudit().diff);
    expect(diff.state).toEqual({ from: 'REJECTED', to: 'PROPOSED' });
    expect(diff.decided_reason.to).toBeNull();
  });

  it('controller may not reject or answer a material item (SCHEMA roles table)', () => {
    const d = makeDesk();
    const big = d.sync({ amountUsdMinor: MATERIALITY * 3n });
    d.proposeAs('analyst', big.id);
    d.rejectAs('controller', big.id, 'no');
    expect(d.item(big.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toMatch(/^materiality/);
    d.rejectAs('head', big.id, 'no, Relevant');
    expect(d.item(big.id).state).toBe('REJECTED');
  });
});

describe('policies', () => {
  it('learner proposes, learner approve denied, head approves, analyst cites it', () => {
    const d = makeDesk();
    d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs()));
    const pol = [...d.h.db.policy.iter()][0]!;
    expect(pol.state).toBe('PROPOSED');
    expect(pol.version).toBe(1);
    expect(pol.proposedBy.isEqual(d.identity('learner'))).toBe(true);
    const proposed = d.lastAudit();
    expect([proposed.action, proposed.allowed, proposed.policyId, proposed.policyVersion]).toEqual([
      'propose_policy', true, pol.id, 1,
    ]);
    expect(proposed.subjectId).toBe('grove-canteen-catering');

    d.as('learner', ctx => mod.approvePolicy(ctx, { policyId: pol.id, reason: 'I am confident' }));
    expect(d.h.db.policy.id.find(pol.id)!.state).toBe('PROPOSED');
    const denied = d.lastAudit();
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('role_not_permitted');
    expect(denied.reason).toContain('separation_of_duties');
    expect(denied.policyId).toBe(pol.id);

    d.as('head', ctx => mod.approvePolicy(ctx, { policyId: pol.id, reason: 'matches 2025 practice' }));
    const approved = d.h.db.policy.id.find(pol.id)!;
    expect(approved.state).toBe('APPROVED');
    expect(approved.decidedBy?.isEqual(d.identity('head'))).toBe(true);
    expect(approved.decidedAt).toBeDefined();

    const it0 = d.sync();
    d.proposeAs('analyst', it0.id, { policyId: pol.id });
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.item(it0.id).proposedPolicyId).toBe(pol.id);
    expect([d.lastAudit().policyId, d.lastAudit().policyVersion]).toEqual([pol.id, 1]);

    d.approveAs('controller', it0.id);
    expect([d.lastAudit().policyId, d.lastAudit().policyVersion]).toEqual([pol.id, 1]);
  });

  it('a cited policy must be approved, in force, same category, matching, and not superseded', () => {
    const d = makeDesk();
    d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs()));
    const v1 = [...d.h.db.policy.iter()][0]!;
    const it0 = d.sync();

    d.proposeAs('analyst', it0.id, { policyId: v1.id });
    expect(d.lastAudit().reason).toContain('is PROPOSED, not APPROVED');
    d.as('head', ctx => mod.approvePolicy(ctx, { policyId: v1.id, reason: 'ok' }));

    d.proposeAs('analyst', it0.id, { policyId: v1.id, categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07' });
    expect(d.lastAudit().reason).toContain('is category CATERING, not RELEVANT');

    const other = d.sync({ id: 'gl-other', rawRef: 'r', vendorId: 'ven-099', memo: 'Sponsor dinner' });
    d.proposeAs('analyst', other.id, { policyId: v1.id });
    expect(d.lastAudit().reason).toContain('pattern does not match gl line gl-other on vendor_id, memo_regex');

    d.proposeAs('analyst', it0.id, { policyId: 999n });
    expect(d.lastAudit().reason).toBe('policy_invalid: policy 999 does not exist');

    // v2 approved and in force supersedes v1 for the period.
    d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs({ rationale: 'v2: same pattern, new evidence' })));
    const v2 = [...d.h.db.policy.policyKey.filter('grove-canteen-catering')].find(p => p.version === 2)!;
    d.as('head', ctx => mod.approvePolicy(ctx, { policyId: v2.id, reason: 'ok' }));
    d.proposeAs('analyst', it0.id, { policyId: v1.id });
    expect(d.lastAudit().reason).toContain(`superseded by policy ${v2.id} v2`);
    expect(d.item(it0.id).state).toBe('NEW');
    d.proposeAs('analyst', it0.id, { policyId: v2.id });
    expect(d.item(it0.id).state).toBe('PROPOSED');
  });

  it('a policy must cite a rulebook entry of its category in force on its effective date', () => {
    const d = makeDesk();
    d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs({ rulebookEntryId: 'SICK_COVER@ISS22' })));
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toContain('is category SICK_COVER, not CATERING');
    expect(d.lastAudit().reason).toContain('not in force on 2026-01-01');
    expect(d.h.db.policy.count()).toBe(0n);
  });

  it('malformed policy input throws', () => {
    const d = makeDesk();
    expect(() => d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs({ pattern: 'vendor=ven-017' })))).toThrow(
      'pattern must be a JSON object string'
    );
    expect(() => d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs({ pattern: '{"vendor":"x"}' })))).toThrow(
      'unknown key'
    );
    d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs()));
    expect(() => d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs({ version: 1 })))).toThrow('already exists');
  });
});

describe('sync, corrections, reversals', () => {
  it('re-sync of an open item refreshes amount and pending; no new work item', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.sync({ amountMinor: 800_000n, amountUsdMinor: 1_016_000n, rawRef: 'gl_line:gl-000123:40' });
    expect(d.item(it0.id).amountUsdMinor).toBe(1_016_000n);
    expect(d.h.db.workItem.count()).toBe(1n);
    expect(d.h.db.capPosition.periodKey.find('2026-03')!.pendingUsdMinor).toBe(1_016_000n);
    const row = d.lastAudit();
    expect(row.action).toBe('sync_upsert');
    expect(row.fromState).toBe('SYNCED');
    expect(JSON.parse(row.diff).amount_usd_minor).toEqual({ from: 914_400, to: 1_016_000 });
  });

  it('re-sync of a POSTED line with a changed amount creates a reversal; posting it nets the cap', () => {
    const d = makeDesk();
    const orig = d.sync();
    d.proposeAs('analyst', orig.id);
    d.approveAs('controller', orig.id);
    d.postAs('gateway', orig.id);

    d.sync({ amountMinor: 0n, amountUsdMinor: 0n, rawRef: 'gl_line:gl-000123:99', memo: 'Grove Catering - factory canteen March (credited)' });
    const reversals = [...d.h.db.workItem.subjectRef.filter(orig.id.toString())];
    expect(reversals).toHaveLength(1);
    const rev = reversals[0]!;
    expect(rev.kind).toBe('reversal');
    expect(rev.state).toBe('NEW');
    expect(rev.reversesItemId).toBe(orig.id);
    expect(rev.reason).toContain('changed amount_usd_minor, memo');
    expect(JSON.parse(rev.evidenceRefs)).toEqual(['gl-000123', 'gl_line:gl-000123:99']);
    expect(d.item(orig.id).state).toBe('POSTED'); // never edited
    expect(d.item(orig.id).superseded).toBe(false);
    expect([d.item(orig.id).postedTreatment, d.item(orig.id).postedCapEffectUsdMinor]).toEqual(['EXCLUDED', 914_400n]);

    d.proposeAs('analyst', rev.id, { reason: 'credit note: catering reversed' });
    d.approveAs('controller', rev.id);
    // The precedent pattern comes from the (re-synced) line.
    expect(JSON.parse([...d.h.db.precedent.workItemId.filter(rev.id)][0]!.patternSummary).gl_line_id).toBe('gl-000123');
    d.postAs('gateway', rev.id, 'JE-2026-000500');
    const cap = d.h.db.capPosition.periodKey.find('2026-03')!;
    expect(cap.excludedUsdMinor).toBe(0n);
    expect(cap.pendingUsdMinor).toBe(0n);
    expect(cap.postedItems).toBe(2);
    expect(d.item(orig.id).superseded).toBe(true);
    expect(JSON.parse(d.lastAudit().diff)[`work_item[${orig.id}].superseded`]).toEqual({ from: false, to: true });
  });

  it('a new line with correction_of is an ordinary classification: the ledger nets delta pairs itself', () => {
    const d = makeDesk();
    const orig = d.sync();
    d.proposeAs('analyst', orig.id);
    d.approveAs('controller', orig.id);
    d.postAs('gateway', orig.id);

    d.as('sync', ctx =>
      mod.upsertGlLine(ctx, glLine({ id: 'gl-000777', rawRef: 'gl_line:gl-000777:120', postedDate: '2026-04-02', periodKey: '2026-04', correctionOf: 'gl-000123', amountUsdMinor: 500_000n }))
    );
    expect([...d.h.db.workItem.subjectRef.filter(orig.id.toString())]).toHaveLength(0);
    const c = [...d.h.db.workItem.subjectRef.filter('gl-000777')][0]!;
    expect(c.kind).toBe('classification');
    expect(c.reversesItemId).toBeUndefined();
    expect(c.periodKey).toBe('2026-04');
    expect(d.h.db.glLine.id.find('gl-000777')!.correctionOf).toBe('gl-000123'); // kept as evidence

    d.proposeAs('analyst', c.id, { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07' });
    d.approveAs('controller', c.id);
    d.postAs('gateway', c.id, 'JE-2026-000600');
    const apr = d.h.db.capPosition.periodKey.find('2026-04')!;
    expect(apr.excludedUsdMinor).toBe(0n); // nothing backed out
    expect(apr.relevantUsdMinor).toBe(500_000n);
    expect(d.h.db.capPosition.periodKey.find('2026-03')!.excludedUsdMinor).toBe(914_400n);
    expect(d.item(orig.id).superseded).toBe(false);
  });

  it('upserts of bill lines, vendors and fair values are sync-only and audited', () => {
    const d = makeDesk();
    d.as('sync', ctx =>
      mod.upsertVendor(ctx, {
        id: 'ven-017', rawRef: 'vendor:ven-017:3', name: 'Grove Catering', country: 'GB', relatedParty: false,
        relatedPartyEntity: undefined, bankIban: 'GB00GROVE1', categoryHint: 'CATERING',
      })
    );
    d.as('sync', ctx =>
      mod.upsertVendor(ctx, {
        id: 'ven-017', rawRef: 'vendor:ven-017:9', name: 'Grove Catering', country: 'GB', relatedParty: false,
        relatedPartyEntity: undefined, bankIban: 'GB99CHANGED', categoryHint: 'CATERING',
      })
    );
    expect(JSON.parse(d.lastAudit().diff).bank_iban).toEqual({ from: 'GB00GROVE1', to: 'GB99CHANGED' });
    d.as('sync', ctx =>
      mod.upsertBillLine(ctx, {
        id: 'bl-00042-1', rawRef: 'bill_line:bl-00042-1:5', billId: 'bill-00042', glLineId: 'gl-000123', lineNo: 1,
        description: 'Canteen services March', amountMinor: 720_000n, billText: 'INVOICE ...', vendorId: 'ven-017',
        bankIbanOnBill: 'GB99CHANGED',
      })
    );
    d.as('sync', ctx =>
      mod.upsertFairValue(ctx, {
        id: 'fv-005', rawRef: 'fair_value:fv-005:1', counterpartyVendorId: 'ven-030', item: 'PU lease',
        contractValueMinor: 1_000n, fairValueMinor: 1_500n, currency: 'GBP', effectiveFrom: '2026-01-01', basis: 'benchmark',
      })
    );
    expect([...d.h.db.billLine.glLineId.filter('gl-000123')]).toHaveLength(1);
    expect(d.h.db.fairValue.id.find('fv-005')?.fairValueMinor).toBe(1_500n);
    expect(d.audit().filter(r => r.action === 'sync_upsert' && r.allowed)).toHaveLength(4);

    d.as('analyst', ctx =>
      mod.upsertFairValue(ctx, {
        id: 'fv-005', rawRef: 'x', counterpartyVendorId: 'ven-030', item: 'PU lease',
        contractValueMinor: 1_000n, fairValueMinor: 1n, currency: 'GBP', effectiveFrom: '2026-01-01', basis: 'forged',
      })
    );
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.h.db.fairValue.id.find('fv-005')?.fairValueMinor).toBe(1_500n);
  });
});

describe('roles and bootstrap', () => {
  it('bootstrapAdmin works once; a second call is denied and logged', () => {
    const d = makeDesk();
    const n = d.auditCount();
    d.as('stranger', ctx => mod.bootstrapAdmin(ctx, {}));
    expect(d.auditCount()).toBe(n + 1);
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toMatch(/^already_bootstrapped/);
    expect(d.h.db.role.identity.find(d.identity('stranger'))).toBeNull();
    expect(d.audit()[0]!.action).toBe('bootstrap_admin');
    expect(d.audit()[0]!.allowed).toBe(true);
  });

  it('invite codes are stored hashed and burn on use; one identity holds one role', () => {
    const d = makeDesk();
    const invites = [...d.h.db.roleInvite.iter()];
    expect(invites.every(i => i.used)).toBe(true);
    expect(invites.some(i => i.code === 'code-analyst')).toBe(false);
    expect(d.h.db.roleInvite.code.find(sha256Hex('code-analyst'))?.role).toBe('ai_cap_analyst');

    d.as('admin', ctx => mod.createRoleInvite(ctx, { role: 'human_controller', label: 'second controller', code: 'code-2' }));
    d.as('analyst', ctx => mod.claimRole(ctx, { code: 'code-2' }));
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.h.db.role.identity.find(d.identity('analyst'))?.role).toBe('ai_cap_analyst');
    d.as('stranger', ctx => mod.claimRole(ctx, { code: 'code-2' }));
    expect(d.h.db.role.identity.find(d.identity('stranger'))?.role).toBe('human_controller');

    d.as('admin', ctx => mod.createRoleInvite(ctx, { role: 'human_controller', label: 'dup', code: 'code-2' }));
    expect(d.lastAudit().reason).toMatch(/^invalid_transition/);
    expect(() => d.as('admin', ctx => mod.createRoleInvite(ctx, { role: 'god', label: 'x', code: 'c' }))).toThrow('unknown role');
  });

  it('unknown identities get role "none" and are denied', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.proposeAs('stranger', it0.id);
    expect(d.lastAudit().actorRole).toBe('none');
    expect(d.lastAudit().allowed).toBe(false);
  });

  it('unset materiality fails closed: only the head may approve', () => {
    const h = createModuleTestHarness(spacetimedb, mod);
    const admin = principal('a');
    const sync = principal('s');
    const analyst = principal('an');
    const controller = principal('c');
    h.withReducerTx(admin, ctx => mod.bootstrapAdmin(ctx, {}));
    for (const [auth, role] of [[sync, 'sync'], [analyst, 'ai_cap_analyst'], [controller, 'human_controller']] as const) {
      h.withReducerTx(admin, ctx => mod.createRoleInvite(ctx, { role, label: role, code: role }));
      h.withReducerTx(auth, ctx => mod.claimRole(ctx, { code: role }));
    }
    h.withReducerTx(admin, ctx => mod.loadRulebookEntry(ctx, RULEBOOK[0]!));
    h.withReducerTx(sync, ctx => mod.upsertGlLine(ctx, glLine({ amountUsdMinor: 1n })));
    const id = [...h.db.workItem.iter()][0]!.id;
    h.withReducerTx(analyst, ctx =>
      mod.propose(ctx, {
        workItemId: id, categoryCode: 'CATERING', rulebookEntryId: 'CATERING@SECD-ISS07', policyId: undefined, reason: 'r', evidenceRefs: '[]',
        capEffectUsdMinor: undefined, proposalSource: 'deterministic',
      })
    );
    h.withReducerTx(controller, ctx => mod.approve(ctx, { workItemId: id, reason: 'ok' }));
    expect(h.db.workItem.id.find(id)!.state).toBe('PROPOSED');
  });
});

describe('malformed input throws and rolls back', () => {
  it('an unknown work item id throws SenderError and leaves no audit row', () => {
    const d = makeDesk();
    const n = d.auditCount();
    expect(() => d.approveAs('controller', 424242n)).toThrow('unknown work item 424242');
    expect(() => d.proposeAs('analyst', 424242n)).toThrow('unknown work item');
    expect(() => d.as('head', ctx => mod.approvePolicy(ctx, { policyId: 77n, reason: 'x' }))).toThrow('unknown policy 77');
    expect(() => d.as('sync', ctx => mod.upsertGlLine(ctx, glLine({ periodKey: 'March' })))).toThrow('period key');
    expect(() => d.as('head', ctx => mod.lockPeriod(ctx, { periodKey: '2026-13' }))).toThrow('period key');
    expect(() => d.as('admin', ctx => mod.setSetting(ctx, { key: 'materiality_usd_minor', value: 'fifty grand' }))).toThrow('integer');
    expect(d.auditCount()).toBe(n);
  });

  it('a throw rolls back the whole reducer transaction, including an earlier audit row', () => {
    const d = makeDesk();
    const it0 = d.sync();
    const n = d.auditCount();
    const analyst = (ctx: Parameters<Parameters<typeof d.h.withReducerTx>[1]>[0], id: bigint) =>
      mod.propose(ctx, {
        workItemId: id, categoryCode: 'CATERING', rulebookEntryId: 'CATERING@SECD-ISS07', policyId: undefined,
        reason: 'r', evidenceRefs: '[]', capEffectUsdMinor: undefined, proposalSource: 'deterministic',
      });
    expect(() =>
      d.as('analyst', ctx => {
        analyst(ctx, it0.id); // would commit an allowed audit row and move the item
        analyst(ctx, 999n); // throws: unknown id
      })
    ).toThrow('unknown work item 999');
    expect(d.auditCount()).toBe(n);
    expect(d.item(it0.id).state).toBe('NEW');
  });
});

describe('helpers and contract checks', () => {
  it('sha256Hex matches node:crypto', () => {
    for (const s of ['', 'abc', 'code-analyst', 'x'.repeat(55), 'y'.repeat(64), 'ünïcode ✓'.repeat(20)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  it('loads every entry of rulebook/rulebook.json', () => {
    const path = fileURLToPath(new URL('../../../rulebook/rulebook.json', import.meta.url));
    if (!existsSync(path)) return;
    const entries = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
    const h = createModuleTestHarness(spacetimedb, mod);
    const admin = principal('admin');
    h.withReducerTx(admin, ctx => mod.bootstrapAdmin(ctx, {}));
    for (const e of entries) {
      h.withReducerTx(admin, ctx =>
        mod.loadRulebookEntry(ctx, {
          id: e.id as string,
          categoryCode: e.category_code as string,
          treatment: e.treatment as string,
          ruleVersion: e.rule_version as string,
          article: e.article as string,
          effectiveFrom: e.effective_from as string,
          effectiveTo: (e.effective_to as string | null) ?? undefined,
          title: e.title as string,
          text: e.text as string,
          capLimitUsdMinor: e.cap_limit_usd_minor == null ? undefined : BigInt(e.cap_limit_usd_minor as number),
        })
      );
    }
    expect(Number(h.db.rulebookEntry.count())).toBe(entries.length);
    expect([...h.db.auditLog.iter()].filter(r => !r.allowed)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- earned autonomy

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

describe('earned autonomy (standing approvals)', () => {
  it('approving a policy gives it standing approval; re-granting after a revoke records who and the evidence', () => {
    const d = makeDesk();
    const pol = approvedPolicy(d);
    expect(pol.autonomy).toBe('GRANTED');
    expect(pol.autonomyBy?.isEqual(d.identity('head'))).toBe(true);
    expect(pol.autonomyReason).toBe('standing approval comes with approval');
    expect(pol.autonomyEvidence).toBe('');
    const approveRow = d.audit().filter(r => r.action === 'approve_policy').at(-1)!;
    expect(JSON.parse(approveRow.diff).autonomy).toEqual({ from: 'NONE', to: 'GRANTED' });

    d.as('head', ctx => mod.revokeAutonomy(ctx, { policyId: pol.id, reason: 'review the catering lines' }));
    d.as('head', ctx => mod.grantAutonomy(ctx, { policyId: pol.id, evidence: SANDBOX_EVIDENCE, reason: 'clean sandbox record' }));
    const granted = d.h.db.policy.id.find(pol.id)!;
    expect(granted.autonomy).toBe('GRANTED');
    expect(granted.autonomyEvidence).toBe(SANDBOX_EVIDENCE);
    expect(granted.autonomyReason).toBe('clean sandbox record');
    const row = d.lastAudit();
    expect([row.action, row.resourceKind, row.subjectId, row.allowed, row.fromState, row.toState]).toEqual([
      'grant_autonomy', 'policy', 'grove-canteen-catering', true, 'REVOKED', 'GRANTED',
    ]);
    expect([row.policyId, row.policyVersion]).toEqual([pol.id, 1]);
    expect(row.evidence).toBe(SANDBOX_EVIDENCE);
    expect(JSON.parse(row.diff).autonomy).toEqual({ from: 'REVOKED', to: 'GRANTED' });
  });
  it('auto_approver approves under a granted policy; the audit row names the policy and the granter', () => {
    const d = makeDesk();
    const pol = approvedPolicy(d);
    const it0 = proposedUnder(d, 'gl-auto-1', pol.id);

    d.approveAs('autoApprover', it0.id, 'standing approval: grove-canteen-catering v1');
    const done = d.item(it0.id);
    expect(done.state).toBe('APPROVED');
    expect(done.decidedBy?.isEqual(d.identity('autoApprover'))).toBe(true);
    const row = d.lastAudit();
    expect([row.action, row.actorRole, row.allowed, row.policyId, row.policyVersion]).toEqual([
      'approve', 'auto_approver', true, pol.id, 1,
    ]);
    const evidence = JSON.parse(row.evidence);
    expect(evidence.standing_approval).toMatchObject({
      policy_id: Number(pol.id),
      policy_key: 'grove-canteen-catering',
      policy_version: 1,
      autonomy: 'GRANTED',
      autonomy_granted_by: d.identity('head').toHexString(),
    });
    expect(evidence.evidence_refs).toBe(done.evidenceRefs);
    // A precedent is still written, decided by the auto_approver.
    const prec = [...d.h.db.precedent.workItemId.filter(it0.id)];
    expect(prec).toHaveLength(1);
    expect(prec[0]!.decidedBy.isEqual(d.identity('autoApprover'))).toBe(true);
  });

  it("auto_approver is denied when the head revoked the policy's standing approval", () => {
    const d = makeDesk();
    const pol = approvedPolicy(d, {}, false);
    const it0 = proposedUnder(d, 'gl-auto-2', pol.id);
    d.approveAs('autoApprover', it0.id);
    expect(d.item(it0.id).state).toBe('PROPOSED');
    const row = d.lastAudit();
    expect(row.allowed).toBe(false);
    expect(row.reason).toBe(`standing_approval: policy ${pol.id} (grove-canteen-catering v1) standing approval is REVOKED, not GRANTED`);
    expect(row.policyId).toBe(pol.id);
    expect(JSON.parse(row.evidence).standing_approval.autonomy_granted_by).toBeNull();
  });
  it('revocation takes effect for every later approve; earlier approvals stay', () => {
    const d = makeDesk();
    const pol = approvedPolicy(d);
    const first = proposedUnder(d, 'gl-auto-3', pol.id);
    const second = proposedUnder(d, 'gl-auto-4', pol.id);
    d.approveAs('autoApprover', first.id);
    expect(d.item(first.id).state).toBe('APPROVED');

    d.as('head', ctx => mod.revokeAutonomy(ctx, { policyId: pol.id, reason: 'catering rule change pending' }));
    const revoked = d.h.db.policy.id.find(pol.id)!;
    expect(revoked.autonomy).toBe('REVOKED');
    expect(revoked.autonomyReason).toBe('catering rule change pending');
    expect(revoked.autonomyEvidence).toBe('');
    expect(d.lastAudit().toState).toBe('REVOKED');

    d.approveAs('autoApprover', second.id);
    expect(d.item(second.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toContain('standing approval is REVOKED, not GRANTED');
    expect(d.item(first.id).state).toBe('APPROVED');
    // Back to human review.
    d.approveAs('controller', second.id);
    expect(d.item(second.id).state).toBe('APPROVED');

    // Revoking twice is an invalid transition; granting again with fresh evidence works.
    d.as('head', ctx => mod.revokeAutonomy(ctx, { policyId: pol.id, reason: 'again' }));
    expect(d.lastAudit().reason).toMatch(/^invalid_transition: autonomy in state REVOKED/);
    d.as('head', ctx => mod.grantAutonomy(ctx, { policyId: pol.id, evidence: '{"sandbox_run_id":"sbx-2"}', reason: 're-earned' }));
    expect(d.h.db.policy.id.find(pol.id)!.autonomy).toBe('GRANTED');
  });

  it('auto_approver approves under an approved rule at any amount; materiality only picks which person decides', () => {
    const d = makeDesk();
    const pol = approvedPolicy(d);
    const atLimit = proposedUnder(d, 'gl-auto-5', pol.id, { amountUsdMinor: MATERIALITY });
    const credit = proposedUnder(d, 'gl-auto-6', pol.id, { amountUsdMinor: -MATERIALITY });
    for (const it0 of [atLimit, credit]) {
      d.approveAs('autoApprover', it0.id);
      expect(d.item(it0.id).state).toBe('APPROVED');
    }
    // When no rule decided it, a person does, and materiality still routes it to the head.
    const byHand = proposedUnder(d, 'gl-auto-7', undefined, { amountUsdMinor: MATERIALITY });
    d.approveAs('autoApprover', byHand.id);
    expect(d.lastAudit().reason).toMatch(/cites no policy; a person decides it$/);
    d.approveAs('controller', byHand.id);
    expect(d.item(byHand.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toMatch(/^materiality: /);
    d.approveAs('head', byHand.id);
    expect(d.item(byHand.id).state).toBe('APPROVED');
  });
  it('materiality does not bind the auto_approver, even unset', () => {
    const d = makeDesk();
    const pol = approvedPolicy(d);
    const it0 = proposedUnder(d, 'gl-auto-8', pol.id, { amountUsdMinor: 1n });
    d.h.withReducerTx(TestAuth.internal(), ctx => ctx.db.setting.key.delete('materiality_usd_minor'));
    d.approveAs('autoApprover', it0.id);
    expect(d.item(it0.id).state).toBe('APPROVED');
  });
  it('autonomy on one policy does not cover an item citing another policy, or none', () => {
    const d = makeDesk();
    const withAutonomy = approvedPolicy(d);
    const other = approvedPolicy(
      d,
      { policyKey: 'grove-staff-lunch-catering', pattern: JSON.stringify({ vendor_id: 'ven-017', memo_regex: 'staff lunch' }) },
      false
    );
    // Tier 1: the two policies must not overlap on the line, or resolution cites the lowest id and
    // citing the other is policy_conflict (SCHEMA section 11.2).
    const citesOther = proposedUnder(d, 'gl-auto-9', other.id, { memo: 'Grove Catering - staff lunch' });
    const citesNone = proposedUnder(d, 'gl-auto-10', undefined);

    d.approveAs('autoApprover', citesOther.id);
    expect(d.item(citesOther.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toContain(`policy ${other.id} (grove-staff-lunch-catering v1) standing approval is REVOKED`);
    expect(d.lastAudit().policyId).toBe(other.id);

    d.approveAs('autoApprover', citesNone.id);
    expect(d.item(citesNone.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toMatch(/^standing_approval: work item \d+: the proposal cites no policy/);
    expect(withAutonomy.autonomy).toBe('GRANTED');
  });

  it('auto_approver may not approve its own proposal, and may not propose', () => {
    const d = makeDesk();
    const pol = approvedPolicy(d);
    const it0 = d.sync({ id: 'gl-auto-11', rawRef: 'r' });
    d.proposeAs('autoApprover', it0.id, { policyId: pol.id });
    expect(d.item(it0.id).state).toBe('NEW');
    expect(d.lastAudit().reason).toContain("role_not_permitted: role 'auto_approver' may not propose");

    // One identity holds one role, so this can only arise from a tampered or legacy row:
    // even then the auto_approver cannot approve an item it proposed.
    d.proposeAs('analyst', it0.id, { policyId: pol.id });
    const me = d.identity('autoApprover');
    d.h.withReducerTx(TestAuth.internal(), ctx =>
      ctx.db.workItem.id.update({ ...ctx.db.workItem.id.find(it0.id)!, proposedBy: me })
    );
    d.approveAs('autoApprover', it0.id);
    expect(d.item(it0.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toBe(`separation_of_duties: caller proposed work item ${it0.id} and may not approve it`);
  });

  it('auto_approver can only approve: reject, answer, post, grant are denied', () => {
    const d = makeDesk();
    const pol = approvedPolicy(d);
    const it0 = proposedUnder(d, 'gl-auto-12', pol.id);
    for (const attempt of [
      () => d.rejectAs('autoApprover', it0.id, 'no'),
      () => d.postAs('autoApprover', it0.id),
      () => d.as('autoApprover', ctx => mod.grantAutonomy(ctx, { policyId: pol.id, evidence: SANDBOX_EVIDENCE, reason: 'me' })),
      () => d.as('autoApprover', ctx => mod.approvePolicy(ctx, { policyId: pol.id, reason: 'me' })),
    ]) {
      const n = d.auditCount();
      attempt();
      expect(d.auditCount()).toBe(n + 1);
      expect(d.lastAudit().allowed).toBe(false);
      expect(d.lastAudit().reason).toContain("role_not_permitted: role 'auto_approver'");
    }
    expect(d.item(it0.id).state).toBe('PROPOSED');
  });

  it('only the head of cost cap can grant or revoke; grant needs an APPROVED policy and evidence', () => {
    const d = makeDesk();
    d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs()));
    const proposed = [...d.h.db.policy.iter()][0]!;

    d.as('head', ctx => mod.grantAutonomy(ctx, { policyId: proposed.id, evidence: SANDBOX_EVIDENCE, reason: 'early' }));
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toBe(`autonomy_invalid: policy ${proposed.id} is PROPOSED, not APPROVED`);
    expect(d.h.db.policy.id.find(proposed.id)!.autonomy).toBe('NONE');

    d.as('head', ctx => mod.approvePolicy(ctx, { policyId: proposed.id, reason: 'ok' }));
    expect(d.h.db.policy.id.find(proposed.id)!.autonomy).toBe('GRANTED');
    for (const who of ['controller', 'learner', 'analyst', 'redTeam', 'admin'] as const) {
      d.as(who, ctx => mod.revokeAutonomy(ctx, { policyId: proposed.id, reason: 'x' }));
      expect(d.lastAudit().allowed).toBe(false);
      expect(d.lastAudit().reason).toContain('role_not_permitted');
      expect(d.lastAudit().resourceKind).toBe('policy');
    }
    expect(d.h.db.policy.id.find(proposed.id)!.autonomy).toBe('GRANTED');
    d.as('head', ctx => mod.revokeAutonomy(ctx, { policyId: proposed.id, reason: 'review first' }));
    for (const who of ['controller', 'learner', 'analyst', 'redTeam', 'admin'] as const) {
      d.as(who, ctx => mod.grantAutonomy(ctx, { policyId: proposed.id, evidence: SANDBOX_EVIDENCE, reason: 'x' }));
      expect(d.lastAudit().allowed).toBe(false);
      expect(d.lastAudit().reason).toContain('role_not_permitted');
    }
    expect(d.h.db.policy.id.find(proposed.id)!.autonomy).toBe('REVOKED');

    const n = d.auditCount();
    for (const evidence of ['', 'not json', '{}', '[]', 'null', '"sandbox"']) {
      expect(() => d.as('head', ctx => mod.grantAutonomy(ctx, { policyId: proposed.id, evidence, reason: 'x' }))).toThrow(
        /evidence must be/
      );
    }
    expect(() => d.as('head', ctx => mod.grantAutonomy(ctx, { policyId: 999n, evidence: SANDBOX_EVIDENCE, reason: 'x' }))).toThrow(
      'unknown policy 999'
    );
    expect(d.auditCount()).toBe(n);

    d.as('head', ctx => mod.grantAutonomy(ctx, { policyId: proposed.id, evidence: SANDBOX_EVIDENCE, reason: 'earned' }));
    d.as('controller', ctx => mod.revokeAutonomy(ctx, { policyId: proposed.id, reason: 'x' }));
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.h.db.policy.id.find(proposed.id)!.autonomy).toBe('GRANTED');
    d.as('head', ctx => mod.grantAutonomy(ctx, { policyId: proposed.id, evidence: SANDBOX_EVIDENCE, reason: 'twice' }));
    expect(d.lastAudit().reason).toMatch(/^invalid_transition: autonomy in state GRANTED/);
  });
});

// ---------------------------------------------------------------- teaching

// A person's decision on a line no rule covered becomes a rule from then on (teachPolicy).
const NARROW = { account_code: '6410', vendor_id: 'ven-017' };
const WITHIN = { min_amount_usd_minor: -(Number(MATERIALITY) - 1), max_amount_usd_minor: Number(MATERIALITY) - 1 };
function teachArgs(workItemId: bigint, pattern: object, over: Partial<Parameters<typeof mod.teachPolicy>[1]> = {}) {
  return {
    workItemId,
    categoryCode: 'RELEVANT',
    rulebookEntryId: 'RELEVANT@SECD-ISS07',
    pattern: JSON.stringify(pattern),
    reason: 'build-shift meals for the race team are F1 cost, not canteen catering',
    ...over,
  };
}

describe('teaching: one decision becomes a rule', () => {
  it('a controller teaches a narrow rule within their authority; it is born APPROVED with standing approval', () => {
    const d = makeDesk();
    const it0 = d.sync({ id: 'gl-t1', rawRef: 'r1' });
    d.proposeAs('analyst', it0.id, { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07', proposalSource: 'llm' });
    d.approveAs('controller', it0.id);
    d.as('controller', ctx => mod.teachPolicy(ctx, teachArgs(it0.id, { ...NARROW, ...WITHIN })));
    const row = d.lastAudit();
    expect([row.action, row.resourceKind, row.allowed, row.fromState, row.toState, row.actorRole]).toEqual([
      'teach_policy', 'policy', true, 'ABSENT', 'APPROVED', 'human_controller',
    ]);
    const pol = [...d.h.db.policy.iter()].at(-1)!;
    expect([pol.policyKey, pol.version, pol.state, pol.autonomy, pol.precedentCount]).toEqual(['taught:6410|ven-017', 1, 'APPROVED', 'GRANTED', 1]);
    expect(pol.proposedBy.isEqual(d.identity('controller'))).toBe(true);
    expect(pol.decidedBy?.isEqual(d.identity('controller'))).toBe(true);
    expect(pol.rationale).toMatch(/^Taught by controller on work item \d+ \(gl-t1\): build-shift meals/);
    expect(JSON.parse(pol.cornerstones)).toEqual([{ ref: 'gl-t1', category_code: 'RELEVANT' }]);

    // The next such line is decided by the rule, and approved without a person.
    const it1 = d.sync({ id: 'gl-t2', rawRef: 'r2' });
    d.proposeAs('analyst', it1.id, { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07', policyId: pol.id });
    d.approveAs('autoApprover', it1.id);
    expect(d.item(it1.id).state).toBe('APPROVED');
    expect(JSON.parse(d.lastAudit().evidence).standing_approval.autonomy_granted_by).toBe(d.identity('controller').toHexString());
  });

  it('one example earns a narrow rule only, and a controller cannot teach beyond materiality', () => {
    const d = makeDesk();
    const it0 = d.sync({ id: 'gl-t3', rawRef: 'r3' });
    const n = [...d.h.db.policy.iter()].length;
    d.as('controller', ctx => mod.teachPolicy(ctx, teachArgs(it0.id, { account_code: '6410', ...WITHIN })));
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toContain('teach_too_broad: a taught rule must also pin the vendor, department or memo');
    d.as('controller', ctx => mod.teachPolicy(ctx, teachArgs(it0.id, NARROW)));
    expect(d.lastAudit().allowed).toBe(false);
    expect(d.lastAudit().reason).toContain("teach_beyond_authority: a controller's rule must stay within ±materiality");
    expect([...d.h.db.policy.iter()].length).toBe(n);
    // The head may teach at any amount.
    d.as('head', ctx => mod.teachPolicy(ctx, teachArgs(it0.id, NARROW)));
    expect(d.lastAudit().allowed).toBe(true);
    // Agents and systems may not teach.
    for (const who of ['analyst', 'learner', 'autoApprover', 'gateway', 'redTeam'] as const) {
      d.as(who, ctx => mod.teachPolicy(ctx, teachArgs(it0.id, NARROW)));
      expect(d.lastAudit().allowed).toBe(false);
      expect(d.lastAudit().reason).toContain('role_not_permitted');
    }
  });

  it("a taught rule takes over queued lines it covers: Claude's open proposals and open questions go back to NEW", () => {
    const d = makeDesk();
    const taught = d.sync({ id: 'gl-t4', rawRef: 'r4' });
    const claude = d.sync({ id: 'gl-t5', rawRef: 'r5', memo: 'Grove Catering - build shift meals' });
    const asked = d.sync({ id: 'gl-t6', rawRef: 'r6', memo: 'Grove Catering - January' });
    const elsewhere = d.sync({ id: 'gl-t7', rawRef: 'r7', vendorId: 'ven-099' });
    d.proposeAs('analyst', claude.id, { proposalSource: 'llm' });
    d.as('analyst', ctx => mod.ask(ctx, { workItemId: asked.id, question: 'canteen or partner hospitality?' }));
    d.proposeAs('analyst', elsewhere.id, { proposalSource: 'llm' });
    d.as('head', ctx => mod.teachPolicy(ctx, teachArgs(taught.id, NARROW)));
    const reopened = d.audit().filter(r => r.action === 'reopen').map(r => [r.subjectId, r.fromState, r.toState]);
    expect(reopened).toEqual([
      [claude.id.toString(), 'PROPOSED', 'NEW'],
      [asked.id.toString(), 'NEEDS_INFO', 'NEW'],
    ]);
    for (const r of d.audit().filter(r => r.action === 'reopen')) expect(r.reason).toMatch(/^rule now covers it: pol-\d+$/);
    expect(d.lastAudit().action).toBe('teach_policy');
    expect(d.item(elsewhere.id).state).toBe('PROPOSED');
  });

  it("a correction of a policy's decision becomes an exception under that policy", () => {
    const d = makeDesk();
    const parent = approvedPolicy(d, { pattern: JSON.stringify({ account_code: '6410' }) });
    const it0 = d.sync({ id: 'gl-t8', rawRef: 'r8', memo: 'Grove Catering - engineering offsite lunch' });
    d.proposeAs('analyst', it0.id, { policyId: parent.id });
    d.rejectAs('head', it0.id, 'an engineering offsite lunch is F1 cost, not catering');
    d.as('head', ctx => mod.teachPolicy(ctx, teachArgs(it0.id, { account_code: '6410', memo_regex: 'offsite' })));
    const child = [...d.h.db.policy.iter()].at(-1)!;
    expect(child.parentPolicyId).toBe(parent.id);
    expect(d.lastAudit().reason).toContain(`(exception to pol-${parent.id})`);
  });

  it("a proposal built from a person's answer is approved without a person; without an answer it is not", () => {
    const d = makeDesk();
    const it0 = d.sync({ id: 'gl-t9', rawRef: 'r9' });
    d.as('analyst', ctx => mod.ask(ctx, { workItemId: it0.id, question: 'canteen or partner hospitality?' }));
    d.as('controller', ctx => mod.answer(ctx, { workItemId: it0.id, answer: 'CATERING: the factory canteen' }));
    d.proposeAs('analyst', it0.id, { proposalSource: 'human_text' });
    d.approveAs('autoApprover', it0.id);
    expect(d.item(it0.id).state).toBe('APPROVED');
    expect(JSON.parse(d.lastAudit().evidence).answered_by).toBe(d.identity('controller').toHexString());

    const it1 = d.sync({ id: 'gl-t10', rawRef: 'r10' });
    d.proposeAs('analyst', it1.id, { proposalSource: 'human_text' });
    d.approveAs('autoApprover', it1.id);
    expect(d.item(it1.id).state).toBe('PROPOSED');
    expect(d.lastAudit().reason).toBe(`standing_approval: work item ${it1.id} has a human_text proposal but no answer on record`);
  });
});

// ---------------------------------------------------------------- agent steps

function stepArgs(over: Partial<Parameters<typeof mod.recordStep>[1]> = {}): Parameters<typeof mod.recordStep>[1] {
  return {
    runId: 'cap_analyst-2026-03-14-0a1b2c3d',
    step: 1,
    kind: 'tool_call',
    name: 'read_item',
    input: '{"work_item_id":1}',
    outputDigest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    outputExcerpt: '{"state":"NEW"}',
    workItemId: undefined,
    model: undefined,
    ...over,
  };
}

describe('agent steps', () => {
  it('every known role can record a step; no audit row is written', () => {
    const d = makeDesk();
    const n = d.auditCount();
    const roles = ['admin', ...Object.keys(ROLE_OF)] as Who[];
    roles.forEach((who, i) => {
      d.as(who, ctx => mod.recordStep(ctx, stepArgs({ runId: `${who}-run`, step: i + 1, kind: 'note', name: who })));
    });
    expect(d.auditCount()).toBe(n);
    const steps = [...d.h.db.agentStep.iter()];
    expect(steps).toHaveLength(roles.length);
    for (const who of roles) {
      const row = [...d.h.db.agentStep.runId.filter(`${who}-run`)];
      expect(row).toHaveLength(1);
      expect(row[0]!.actor.isEqual(d.identity(who))).toBe(true);
      expect(row[0]!.actorRole).toBe(who === 'admin' ? 'admin' : ROLE_OF[who as keyof typeof ROLE_OF]);
    }
  });

  it('an identity with no role throws and nothing is recorded', () => {
    const d = makeDesk();
    const n = d.auditCount();
    expect(() => d.as('stranger', ctx => mod.recordStep(ctx, stepArgs()))).toThrow('recordStep requires a role');
    expect(d.h.db.agentStep.count()).toBe(0n);
    expect(d.auditCount()).toBe(n);
  });

  it('oversize fields are truncated with the marker, within the byte limits', () => {
    const d = makeDesk();
    const marker = '…[truncated]';
    const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
    d.as('analyst', ctx =>
      mod.recordStep(
        ctx,
        stepArgs({
          kind: 'model_call',
          name: 'classify',
          input: 'é'.repeat(10_000), // 20,000 bytes, 2 bytes per char
          outputExcerpt: 'x'.repeat(5_000) + '🏎'.repeat(10),
          model: 'claude-opus-5-5',
        })
      )
    );
    d.as('analyst', ctx => mod.recordStep(ctx, stepArgs({ step: 2, input: 'a'.repeat(8 * 1024), outputExcerpt: 'b'.repeat(2048) })));
    const [big, exact] = [...d.h.db.agentStep.iter()].sort((a, b) => a.step - b.step);
    expect(big!.input.endsWith(marker)).toBe(true);
    expect(bytes(big!.input)).toBeLessThanOrEqual(8 * 1024);
    expect(bytes(big!.input)).toBeGreaterThan(8 * 1024 - 4);
    expect(big!.input.startsWith('éé')).toBe(true);
    expect(big!.input.replace(marker, '')).toMatch(/^é+$/); // no split code point
    expect(big!.outputExcerpt.endsWith(marker)).toBe(true);
    expect(bytes(big!.outputExcerpt)).toBeLessThanOrEqual(2 * 1024);
    expect(big!.model).toBe('claude-opus-5-5');
    // Exactly at the limit is kept whole.
    expect(exact!.input).toBe('a'.repeat(8 * 1024));
    expect(exact!.outputExcerpt).toBe('b'.repeat(2048));
  });

  it('steps link to work_item_id; unknown ids and kinds throw', () => {
    const d = makeDesk();
    const it0 = d.sync();
    const run = 'cap_analyst-2026-03-14-deadbeef';
    const kinds = ['run_start', 'read', 'model_call', 'decision', 'tool_call', 'run_end'];
    kinds.forEach((kind, i) =>
      d.as('analyst', ctx =>
        mod.recordStep(ctx, stepArgs({ runId: run, step: i + 1, kind, workItemId: kind === 'run_start' || kind === 'run_end' ? undefined : it0.id }))
      )
    );
    const linked = [...d.h.db.agentStep.workItemId.filter(it0.id)];
    expect(linked.map(s => s.kind).sort()).toEqual(['decision', 'model_call', 'read', 'tool_call']);
    expect([...d.h.db.agentStep.runId.filter(run)].map(s => s.step).sort()).toEqual([1, 2, 3, 4, 5, 6]);

    expect(() => d.as('analyst', ctx => mod.recordStep(ctx, stepArgs({ workItemId: 999n })))).toThrow('unknown work item 999');
    expect(() => d.as('analyst', ctx => mod.recordStep(ctx, stepArgs({ kind: 'thought' })))).toThrow('kind must be one of');
    expect(() => d.as('analyst', ctx => mod.recordStep(ctx, stepArgs({ runId: '' })))).toThrow('runId must not be empty');
    expect(d.h.db.agentStep.count()).toBe(BigInt(kinds.length));
  });

  it('the red team can record steps even though every action it takes is denied', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.as('redTeam', ctx => mod.recordStep(ctx, stepArgs({ runId: 'red_team-run', kind: 'decision', workItemId: it0.id })));
    d.approveAs('redTeam', it0.id);
    expect(d.lastAudit().allowed).toBe(false);
    expect([...d.h.db.agentStep.runId.filter('red_team-run')]).toHaveLength(1);
  });
});

