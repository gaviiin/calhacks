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
    pattern: JSON.stringify({ vendor_id: 'ven-017', account_code: '6410', memo_regex: '(?i)canteen' }),
    rationale: 'Grove Catering on GL 6410 is the factory canteen: 214 lines in 2025, all catering',
    evidenceRefs: '["hist-2025-0001","hist-2025-0002"]',
    precedentCount: 214,
    effectiveFrom: '2026-01-01',
    effectiveTo: undefined,
    ...over,
  };
}

// ---------------------------------------------------------------- tests
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
  if (grant) {
    d.as('head', ctx =>
      mod.grantAutonomy(ctx, { policyId: pol.id, evidence: SANDBOX_EVIDENCE, reason: '0 errors over 5 sandboxes' })
    );
  }
  return d.h.db.policy.id.find(pol.id)!;
}

// A NEW item proposed by the analyst citing `policyId`.
function proposedUnder(d: Desk, glId: string, policyId: bigint | undefined, over: Partial<GlArgs> = {}) {
  const it0 = d.sync({ id: glId, rawRef: `gl_line:${glId}:1`, ...over });
  d.proposeAs('analyst', it0.id, { policyId });
  expect(d.item(it0.id).state).toBe('PROPOSED');
  return it0;
}


// ================================================================ RED TEAM
const cap = (d: Desk, pk: string) => {
  const c = d.h.db.capPosition.periodKey.find(pk);
  return c ? { rel: c.relevantUsdMinor, exc: c.excludedUsdMinor, pend: c.pendingUsdMinor, n: c.postedItems } : null;
};
import { appendFileSync } from 'node:fs';
const fmt = (x: unknown): string => typeof x === 'bigint' ? `${x}n` : typeof x === 'object' ? JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? `${v}` : v)) : String(x);
const log = (...a: unknown[]) => appendFileSync('/private/tmp/claude-501/-Users-gavinzhou-Desktop-calhacks/c875d98c-7a47-427a-9e39-fe74fb7781b5/scratchpad/review-redteam/ts/rt.log', ['[RT]', ...a.map(fmt)].join(' ') + '\n');

describe('RT state and races', () => {
  it('RT1 controller-approved $100 line re-synced to 10x materiality stays APPROVED and posts', () => {
    const d = makeDesk();
    const it0 = d.sync({ amountMinor: 8_000n, amountUsdMinor: 10_000n });
    d.proposeAs('analyst', it0.id);
    d.approveAs('controller', it0.id, 'small canteen bill');
    expect(d.item(it0.id).state).toBe('APPROVED');
    d.sync({ amountMinor: 40_000_000n, amountUsdMinor: 50_000_000n, rawRef: 'gl_line:gl-000123:99', memo: 'Grove - anything' });
    const after = d.item(it0.id);
    log('RT1 after resync', { state: after.state, amount: after.amountUsdMinor, decidedByController: after.decidedBy?.isEqual(d.identity('controller')), materiality: MATERIALITY });
    d.postAs('gateway', it0.id);
    log('RT1 post', d.item(it0.id).state, d.lastAudit().allowed, cap(d, '2026-03'));
    expect(d.item(it0.id).state).toBe('POSTED');
  });

  it('RT2 auto_approver approves after a re-sync broke the cited pattern (vendor, memo, max amount)', () => {
    const d = makeDesk();
    const pol = approvedPolicy(d, { pattern: JSON.stringify({ vendor_id: 'ven-017', account_code: '6410', memo_regex: '(?i)canteen', max_amount_usd_minor: 100_000 }) });
    const it0 = proposedUnder(d, 'gl-auto-1', pol.id, { amountUsdMinor: 50_000n });
    d.sync({ id: 'gl-auto-1', rawRef: 'gl_line:gl-auto-1:2', vendorId: 'ven-999', memo: 'Sponsor hospitality - Monaco', amountMinor: 3_000_000n, amountUsdMinor: 4_000_000n });
    d.approveAs('autoApprover', it0.id, 'standing approval');
    log('RT2', { state: d.item(it0.id).state, allowed: d.lastAudit().allowed, reason: d.lastAudit().reason, amount: d.item(it0.id).amountUsdMinor });
    expect(d.item(it0.id).state).toBe('APPROVED');
  });

  it('RT3 auto_approver approves under v1 after v2 of the same policy_key was approved', () => {
    const d = makeDesk();
    const v1 = approvedPolicy(d);
    const it0 = proposedUnder(d, 'gl-auto-2', v1.id);
    // Head narrows the policy: v2 says canteen lines are RELEVANT now (or narrower)
    const v2 = approvedPolicy(d, { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07', rationale: 'v2: canteen is relevant' }, false);
    log('RT3 versions', v1.version, v2.version, v2.state, d.h.db.policy.id.find(v1.id)!.autonomy);
    d.approveAs('autoApprover', it0.id);
    log('RT3', { state: d.item(it0.id).state, allowed: d.lastAudit().allowed, reason: d.lastAudit().reason });
    // a fresh proposal citing v1 is refused as superseded:
    const it1 = d.sync({ id: 'gl-auto-3', rawRef: 'gl_line:gl-auto-3:1' });
    d.proposeAs('analyst', it1.id, { policyId: v1.id });
    log('RT3 fresh propose citing v1', d.item(it1.id).state, d.lastAudit().reason);
  });

  it('RT4 rulebook entry reloaded out of force after propose: approve and post still succeed', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.proposeAs('analyst', it0.id);
    const e = { ...RULEBOOK[0]!, effectiveTo: '2026-02-28' };
    d.as('admin', ctx => mod.loadRulebookEntry(ctx, e));
    d.approveAs('controller', it0.id);
    d.postAs('gateway', it0.id);
    log('RT4', d.item(it0.id).state, 'entry now ends', e.effectiveTo, 'period', it0.periodKey);
    const it1 = d.sync({ id: 'gl-new', rawRef: 'gl_line:gl-new:1' });
    d.proposeAs('analyst', it1.id);
    log('RT4 fresh propose', d.item(it1.id).state, d.lastAudit().reason);
  });

  it('RT5 second correction of the same POSTED line backs the original out twice', () => {
    const d = makeDesk();
    const rel = { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07' };
    const orig = d.sync({ amountMinor: 5_000_000n, amountUsdMinor: 5_000_000n });
    d.proposeAs('analyst', orig.id, rel); d.approveAs('head', orig.id); d.postAs('gateway', orig.id, 'JE-1');
    log('RT5 after orig post', cap(d, '2026-03'));
    d.sync({ amountMinor: 1_000_000n, amountUsdMinor: 1_000_000n, rawRef: 'gl_line:gl-000123:50' });
    const r1 = [...d.h.db.workItem.subjectRef.filter(orig.id.toString())][0]!;
    d.proposeAs('analyst', r1.id, rel); d.approveAs('controller', r1.id); d.postAs('gateway', r1.id, 'JE-2');
    log('RT5 after R1 (line now 1,000,000)', cap(d, '2026-03'));
    d.sync({ amountMinor: 900_000n, amountUsdMinor: 900_000n, rawRef: 'gl_line:gl-000123:60' });
    const revs = [...d.h.db.workItem.subjectRef.filter(orig.id.toString())];
    const r2 = revs.find(r => r.id !== r1.id)!;
    log('RT5 R2 subject_ref', r2.subjectRef, 'kind', r2.kind);
    d.proposeAs('analyst', r2.id, rel); d.approveAs('controller', r2.id); d.postAs('gateway', r2.id, 'JE-3');
    log('RT5 after R2 (line now 900,000; correct relevant = 900,000)', cap(d, '2026-03'));
  });

  it('RT5b two open reversals of one POSTED line both back it out', () => {
    const d = makeDesk();
    const rel = { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07' };
    const orig = d.sync({ amountMinor: 2_000_000n, amountUsdMinor: 2_000_000n });
    d.proposeAs('analyst', orig.id, rel); d.approveAs('controller', orig.id); d.postAs('gateway', orig.id, 'JE-1');
    d.sync({ amountMinor: 2_100_000n, amountUsdMinor: 2_100_000n, rawRef: 'gl_line:gl-000123:50' });
    d.sync({ amountMinor: 2_200_000n, amountUsdMinor: 2_200_000n, rawRef: 'gl_line:gl-000123:51' });
    const revs = [...d.h.db.workItem.subjectRef.filter(orig.id.toString())];
    for (const r of revs) { d.proposeAs('analyst', r.id, rel); d.approveAs('controller', r.id); d.postAs('gateway', r.id, `JE-${r.id}`); }
    log('RT5b reversals', revs.length, revs.map(r => r.amountUsdMinor), cap(d, '2026-03'), '(correct relevant = 2,200,000)');
  });

  it('RT6 correction line arriving while the original is APPROVED (not POSTED) is a separate classification: both post', () => {
    const d = makeDesk();
    const rel = { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07' };
    const orig = d.sync({ amountMinor: 1_000_000n, amountUsdMinor: 1_000_000n });
    d.proposeAs('analyst', orig.id, rel); d.approveAs('controller', orig.id);
    d.as('sync', ctx => mod.upsertGlLine(ctx, glLine({ id: 'gl-000777', rawRef: 'gl_line:gl-000777:1', correctionOf: 'gl-000123', amountMinor: 1_200_000n, amountUsdMinor: 1_200_000n })));
    const c = [...d.h.db.workItem.subjectRef.filter('gl-000777')][0]!;
    log('RT6 correcting item kind', c.kind);
    d.postAs('gateway', orig.id, 'JE-1');
    d.proposeAs('analyst', c.id, rel); d.approveAs('controller', c.id); d.postAs('gateway', c.id, 'JE-2');
    log('RT6 cap', cap(d, '2026-03'), '(correct relevant = 1,200,000 if the correction carries the full amount)');
  });

  it('RT7 re-sync of a POSTED line that only moves period (2026-03 -> 2025-12) creates no reversal', () => {
    const d = makeDesk();
    const orig = d.sync();
    d.proposeAs('analyst', orig.id); d.approveAs('controller', orig.id); d.postAs('gateway', orig.id);
    d.sync({ periodKey: '2025-12', postedDate: '2025-12-31', rawRef: 'gl_line:gl-000123:77' });
    log('RT7 items', d.h.db.workItem.count(), 'golden period', d.h.db.glLine.id.find('gl-000123')!.periodKey, 'item period', d.item(orig.id).periodKey, cap(d, '2026-03'), cap(d, '2025-12'));
  });

  it('RT8 lock while APPROVED: item stuck, pending stays in the locked period; new late line in locked period is NEW forever', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.proposeAs('analyst', it0.id); d.approveAs('controller', it0.id);
    d.as('head', ctx => mod.lockPeriod(ctx, { periodKey: '2026-03' }));
    log('RT8 lock allowed', d.lastAudit().allowed);
    d.postAs('gateway', it0.id);
    log('RT8 post', d.item(it0.id).state, d.lastAudit().reason, cap(d, '2026-03'));
    const late = d.sync({ id: 'gl-late', rawRef: 'gl_line:gl-late:1', postedDate: '2026-03-27' });
    d.proposeAs('analyst', late.id);
    d.proposeAs('analyst', late.id);
    log('RT8 late line', d.item(late.id).state, d.lastAudit().reason, 'denials', d.audit().filter(r => r.subjectId === late.id.toString() && !r.allowed).length);
    // a re-sync can move an open item OUT of the locked period
    d.sync({ id: 'gl-late', rawRef: 'gl_line:gl-late:2', periodKey: '2026-04', postedDate: '2026-04-01' });
    d.proposeAs('analyst', late.id);
    log('RT8 late line after period moved by re-sync', d.item(late.id).state, d.item(late.id).periodKey);
  });

  it('RT9 reversal of a line whose correction lands in a locked period cannot be proposed', () => {
    const d = makeDesk();
    const orig = d.sync();
    d.proposeAs('analyst', orig.id); d.approveAs('controller', orig.id); d.postAs('gateway', orig.id);
    d.as('head', ctx => mod.lockPeriod(ctx, { periodKey: '2026-03' }));
    d.sync({ amountMinor: 0n, amountUsdMinor: 0n, rawRef: 'gl_line:gl-000123:99' });
    const rev = [...d.h.db.workItem.subjectRef.filter(orig.id.toString())][0]!;
    d.proposeAs('analyst', rev.id, { reason: 'credit note' });
    log('RT9 reversal', rev.periodKey, d.item(rev.id).state, d.lastAudit().reason, cap(d, '2026-03'));
  });
});

describe('RT patterns and money', () => {
  it('RT10 pattern {"memo_regex": null} is accepted by the module and matches every line', () => {
    const d = makeDesk();
    d.as('learner', ctx => mod.proposePolicy(ctx, proposePolicyArgs({ policyKey: 'nullish', pattern: '{"memo_regex":null,"vendor_id":null}' })));
    const pol = [...d.h.db.policy.iter()].at(-1)!;
    log('RT10 propose', d.lastAudit().allowed, pol.pattern);
    d.as('head', ctx => mod.approvePolicy(ctx, { policyId: pol.id, reason: 'ok' }));
    const it0 = d.sync({ id: 'gl-any', rawRef: 'gl_line:gl-any:1', vendorId: 'ven-zzz', accountCode: '9999', memo: 'Driver salary', amountUsdMinor: 4_999_999n });
    d.proposeAs('analyst', it0.id, { policyId: pol.id });
    log('RT10 cite on unrelated line', d.item(it0.id).state, d.lastAudit().allowed);
  });

  it('RT11 one order split into three lines just under materiality: controller approves all', () => {
    const d = makeDesk();
    const rel = { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07' };
    for (const k of [1, 2, 3]) {
      const it0 = d.sync({ id: `gl-split-${k}`, rawRef: `gl_line:gl-split-${k}:1`, memo: `Gearbox casing machining - batch ${k} of 3 (PO-26-51877)`, amountUsdMinor: MATERIALITY - 1n });
      d.proposeAs('analyst', it0.id, rel);
      d.approveAs('controller', it0.id);
      log('RT11', k, d.item(it0.id).state, d.lastAudit().actorRole);
    }
  });

  it('RT12 a credit just under materiality is approved by the controller; at -materiality it is not', () => {
    const d = makeDesk();
    const it0 = d.sync({ amountUsdMinor: -(MATERIALITY - 1n) });
    d.proposeAs('analyst', it0.id); d.approveAs('controller', it0.id);
    log('RT12', d.item(it0.id).state);
  });

  it('RT13 any role can append steps into another agent run id', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.as('redTeam', ctx => mod.recordStep(ctx, { runId: 'cap_analyst-2026-03-14-0a1b2c3d', step: 7, kind: 'decision', name: 'propose:policy', input: '{"chosen":"MARKETING"}', outputDigest: 'x', outputExcerpt: 'forged', workItemId: it0.id, model: 'claude-opus-5-5' }));
    const st = [...d.h.db.agentStep.iter()].at(-1)!;
    log('RT13', st.runId, st.actorRole, st.kind, st.workItemId);
  });
});

describe('RT world reversal/repost pairs', () => {
  it('RT14 the world reversal (-A) + repost (+A) pair after the original is POSTED nets the cap to -A', () => {
    const d = makeDesk();
    const rel = { categoryCode: 'RELEVANT', rulebookEntryId: 'RELEVANT@SECD-ISS07' };
    const A = 3_109_376n; // gl-001340
    const orig = d.sync({ id: 'gl-001340', rawRef: 'gl_line:gl-001340:1', periodKey: '2026-05', postedDate: '2026-05-18', amountMinor: A, amountUsdMinor: A });
    d.proposeAs('analyst', orig.id, rel); d.approveAs('controller', orig.id); d.postAs('gateway', orig.id, 'JE-1');
    for (const [id, amt] of [['gl-001477', -A], ['gl-001479', A]] as const) {
      d.as('sync', ctx => mod.upsertGlLine(ctx, glLine({ id, rawRef: `gl_line:${id}:2`, periodKey: '2026-06', postedDate: '2026-06-01', correctionOf: 'gl-001340', amountMinor: amt, amountUsdMinor: amt })));
    }
    const revs = [...d.h.db.workItem.subjectRef.filter(orig.id.toString())];
    log('RT14 items created', revs.map(r => [r.kind, r.amountUsdMinor, r.periodKey]));
    for (const r of revs) { d.proposeAs('analyst', r.id, rel); d.approveAs('controller', r.id); d.postAs('gateway', r.id, `JE-${r.id}`); }
    const may = cap(d, '2026-05')!, jun = cap(d, '2026-06')!;
    log('RT14 cap May', may, 'June', jun, 'total relevant', may.rel + jun.rel, '(correct: A =', A, ')');
  });
});

describe('RT more', () => {
  it('RT15 the controller who answered the question can approve the proposal built from their own answer', () => {
    const d = makeDesk();
    const it0 = d.sync();
    d.as('analyst', ctx => mod.ask(ctx, { workItemId: it0.id, question: 'Where was it served?' }));
    d.as('controller', ctx => mod.answer(ctx, { workItemId: it0.id, answer: 'MARKETING, sponsor dinner' }));
    d.proposeAs('analyst', it0.id, { categoryCode: 'MARKETING', rulebookEntryId: 'MARKETING@SECD-ISS07', reason: 'per controller answer' });
    d.approveAs('controller', it0.id, 'agreed');
    log('RT15', d.item(it0.id).state, d.lastAudit().allowed, d.lastAudit().actorRole);
  });

  it('RT16 a mid-month rule change leaves no entry in force for that period', () => {
    const d = makeDesk();
    d.as('admin', ctx => mod.loadRulebookEntry(ctx, { ...RULEBOOK[0]!, effectiveTo: '2026-07-14' }));
    d.as('admin', ctx => mod.loadRulebookEntry(ctx, { ...RULEBOOK[0]!, id: 'CATERING@SECD-ISS08', ruleVersion: 'SECD-ISS08', effectiveFrom: '2026-07-15' }));
    const it0 = d.sync({ id: 'gl-jul', rawRef: 'gl_line:gl-jul:1', periodKey: '2026-07', postedDate: '2026-07-20' });
    d.proposeAs('analyst', it0.id);
    const r1 = d.lastAudit().reason;
    d.proposeAs('analyst', it0.id, { rulebookEntryId: 'CATERING@SECD-ISS08' });
    log('RT16', d.item(it0.id).state, '|', r1, '|', d.lastAudit().reason);
  });

  it('RT17 postedDate and periodKey are never cross-checked (2025 cost into 2026 rules and cap)', () => {
    const d = makeDesk();
    const it0 = d.sync({ id: 'gl-dec', rawRef: 'gl_line:gl-dec:1', postedDate: '2025-12-31', periodKey: '2026-01' });
    d.proposeAs('analyst', it0.id);
    log('RT17', d.item(it0.id).state, d.item(it0.id).periodKey, d.lastAudit().allowed);
  });
});
