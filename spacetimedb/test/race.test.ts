import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';

// ---------------------------------------------------------------- fixture

let nextConn = 1n;
function principal(sub: string) {
  return TestAuth.fromJwtPayload(JSON.stringify({ iss: 'https://pit-wall.test', sub }), new ConnectionId(nextConn++));
}
type Who = 'owner' | 'race' | 'head' | 'stranger';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const AT = '2026-05-24T16:25:37Z';

function makeDesk() {
  const h = createModuleTestHarness(spacetimedb, mod);
  h.clock.set(new Timestamp(1_779_640_000_000_000n));
  const auth: Record<Who, ReturnType<typeof principal>> = {
    owner: principal('owner'),
    race: principal('race'),
    head: principal('head'),
    stranger: principal('stranger'),
  };
  type C = Parameters<Parameters<typeof h.withReducerTx>[1]>[0];
  const as = <T>(who: Who, fn: (ctx: C) => T): T => h.withReducerTx(auth[who], fn);
  // The owner is whoever ran init; in the harness we seed config directly as the publisher would.
  as('owner', ctx => mod.init(ctx));
  const raceId = as('race', ctx => ctx.sender);
  const headId = as('head', ctx => ctx.sender);
  as('owner', ctx => mod.setWriter(ctx, { who: raceId, role: 'race' }));
  as('owner', ctx => mod.setWriter(ctx, { who: headId, role: 'race_head' }));

  const event = (over: Partial<Parameters<typeof mod.recordRaceEvent>[1]['event']> = {}) => ({
    eventKey: KEY_A, sessionKey: 11291, meetingKey: 1300, at: AT, lap: 12, driverNumber: 23, teamName: 'Williams',
    kind: 'incident', payloadJson: '{"cars":[81,23],"reason":"CAUSING A COLLISION"}', source: 'test_fixture',
    ingestedAt: AT, ...over,
  });
  const state = (over: Partial<NonNullable<Parameters<typeof mod.recordRaceEvent>[1]['state']>> = {}) => ({
    driverNumber: 23, teamName: 'Williams', position: 14, lap: 12, compound: 'MEDIUM', tyreAge: 11, gapToLeader: '+18.2',
    lastPitLap: 0, status: 'running', updatedAt: AT, ...over,
  });
  const effect = (n: number, over: Partial<Parameters<typeof mod.recordRaceEffects>[1]['effects'][number]> = {}) => ({
    effectKey: `${KEY_A}:${n}`, driverNumber: 23, kind: 'cost', bucket: '6050', lowCents: 100n, midCents: 200n, highCents: 300n,
    currency: 'USD', memo: 'Crash damage - floor', basis: 'assumption', decidedBy: 'jev', jevJson: '{}', why: 'heavy collision',
    status: 'proposed', at: AT, ...over,
  });
  return { h, as, event, state, effect };
}

// ---------------------------------------------------------------- tests

describe('race_events', () => {
  it('denies a caller without the race role', () => {
    const d = makeDesk();
    expect(() => d.as('stranger', ctx => mod.recordRaceEvent(ctx, { event: d.event(), state: undefined }))).toThrow(/unauthorized/);
    expect(() => d.as('head', ctx => mod.recordRaceEvent(ctx, { event: d.event(), state: undefined }))).toThrow(/unauthorized/);
    expect(d.h.db.raceEvents.count()).toBe(0n);
  });

  it('is idempotent on eventKey and updates car_state', () => {
    const d = makeDesk();
    d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event(), state: d.state() }));
    d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event(), state: d.state({ position: 15, updatedAt: '2026-05-24T16:25:40Z' }) }));
    expect(d.h.db.raceEvents.count()).toBe(1n);
    expect(d.h.db.carState.driverNumber.find(23)?.position).toBe(15);
  });

  it('never moves a car back from retired, and ignores stale states', () => {
    const d = makeDesk();
    d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event(), state: d.state() }));
    d.as('race', ctx => mod.recordRaceEvent(ctx, {
      event: d.event({ eventKey: KEY_B, kind: 'retirement_confirmed', at: '2026-05-24T18:00:00Z' }),
      state: d.state({ status: 'retired', updatedAt: '2026-05-24T18:00:00Z' }),
    }));
    d.as('race', ctx => mod.recordRaceEvent(ctx, {
      event: d.event({ eventKey: 'c'.repeat(64), kind: 'position', at: '2026-05-24T16:30:00Z' }),
      state: d.state({ position: 9, updatedAt: '2026-05-24T16:30:00Z' }),
    }));
    const cs = d.h.db.carState.driverNumber.find(23)!;
    expect(cs.status).toBe('retired');
    expect(cs.position).toBe(14);
  });

  it('rejects unknown kinds, sources and malformed keys', () => {
    const d = makeDesk();
    expect(() => d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event({ kind: 'teleport' }), state: undefined }))).toThrow(/unknown kind/);
    expect(() => d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event({ source: 'twitter' }), state: undefined }))).toThrow(/unknown source/);
    expect(() => d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event({ eventKey: 'short' }), state: undefined }))).toThrow(/64 hex/);
    expect(() => d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event({ at: 'yesterday' }), state: undefined }))).toThrow(/ISO-8601/);
  });
});

describe('race_effects', () => {
  it('requires the event, an ordered band and a known kind; replays once', () => {
    const d = makeDesk();
    expect(() => d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0)] }))).toThrow(/no such event/);
    d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event(), state: undefined }));
    expect(() => d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { lowCents: 500n })] }))).toThrow(/low <= mid <= high/);
    expect(() => d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { kind: 'tip' })] }))).toThrow(/unknown kind/);
    expect(() => d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { status: 'corrected' })] }))).toThrow(/status must be proposed, needs_person or autonomous/);
    expect(() => d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { effectKey: `${KEY_B}:0` })] }))).toThrow(/start with eventKey/);
    d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0), d.effect(1, { kind: 'cap_headroom', bucket: 'cap_headroom' })] }));
    d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0)] }));
    expect(d.h.db.raceEffects.count()).toBe(2n);
  });

  it('counts a hit on the policy that decided it', () => {
    const d = makeDesk();
    d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event(), state: undefined }));
    d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy: {
      policyId: 'collision-heavy', parentPolicyId: '', title: 'Heavy collision', pattern: '{"kind":"incident"}',
      effectTemplate: '{"severity":"heavy"}', precedentCount: 12, consistencyPct: 100, createdBy: 'learner', createdAt: AT,
    } }));
    d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [
      d.effect(0, { decidedBy: 'policy:collision-heavy', status: 'autonomous' }),
      d.effect(1, { bucket: '5200', decidedBy: 'policy:collision-heavy', status: 'autonomous' }),
    ] }));
    expect(d.h.db.racePolicies.policyId.find('collision-heavy')?.hits).toBe(1); // one event, one hit
  });
});

describe('race_forecasts', () => {
  it('upserts until ready, then is final', () => {
    const d = makeDesk();
    d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event(), state: undefined }));
    const f = { forecastKey: 'f1', eventKey: KEY_A, driverNumber: 23, teamName: 'Williams', createdAt: AT, status: 'running', summary: '', payloadJson: '{}', model: 'claude' };
    d.as('race', ctx => mod.recordForecast(ctx, { forecast: f }));
    d.as('race', ctx => mod.recordForecast(ctx, { forecast: { ...f, status: 'ready', summary: 'Floor and front wing; 1.1m mid.' } }));
    expect(() => d.as('race', ctx => mod.recordForecast(ctx, { forecast: { ...f, status: 'failed' } }))).toThrow(/final/);
    expect(d.h.db.raceForecasts.forecastKey.find('f1')?.status).toBe('ready');
  });
});

describe('race policies and corrections', () => {
  it('a weakly supported policy is a shadow; the head may grant it', () => {
    const d = makeDesk();
    const policy = { policyId: 'p1', parentPolicyId: '', title: 'SC pit stop is free', pattern: '{"kind":"pit_stop","under":"safety_car"}',
      effectTemplate: '{"cost":0}', precedentCount: 3, consistencyPct: 100, createdBy: 'learner', createdAt: AT };
    d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy }));
    expect(d.h.db.racePolicies.policyId.find('p1')?.autonomy).toBe('SHADOW');
    expect(d.h.db.racePolicies.policyId.find('p1')?.licence).toBe('');
    expect(() => d.as('race', ctx => mod.setRacePolicyAutonomy(ctx, { policyId: 'p1', autonomy: 'GRANTED', by: 'learner', at: AT }))).toThrow(/unauthorized/);
    d.as('head', ctx => mod.setRacePolicyAutonomy(ctx, { policyId: 'p1', autonomy: 'GRANTED', by: 'head', at: AT }));
    expect(d.h.db.racePolicies.policyId.find('p1')?.autonomy).toBe('GRANTED');
    expect(() => d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy }))).toThrow(/already decided/);
    expect(() => d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy: { ...policy, policyId: 'p2', parentPolicyId: 'nope' } }))).toThrow(/parent/);
  });

  it('a correction keeps the row, writes a precedent and counts a contradiction', () => {
    const d = makeDesk();
    d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event(), state: undefined }));
    d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy: {
      policyId: 'p1', parentPolicyId: '', title: 't', pattern: '{}', effectTemplate: '{}', precedentCount: 3, consistencyPct: 100, createdBy: 'learner', createdAt: AT,
    } }));
    d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { decidedBy: 'policy:p1', status: 'autonomous' })] }));
    const args = { effectKey: `${KEY_A}:0`, lowCents: 150n, midCents: 250n, highCents: 350n, reason: 'floor was replaced, not repaired', by: 'head', at: '2026-05-25T09:00:00Z' };
    expect(() => d.as('race', ctx => mod.correctRaceEffect(ctx, args))).toThrow(/unauthorized/);
    d.as('head', ctx => mod.correctRaceEffect(ctx, args));
    d.as('head', ctx => mod.correctRaceEffect(ctx, args)); // same correction twice: one precedent
    expect(d.h.db.raceEffects.effectKey.find(`${KEY_A}:0`)?.status).toBe('corrected');
    expect(d.h.db.racePrecedents.count()).toBe(1n);
    expect(d.h.db.racePolicies.policyId.find('p1')?.contradictions).toBe(1);
    expect(() => d.as('head', ctx => mod.correctRaceEffect(ctx, { ...args, at: '2026-05-25T10:00:00Z', midCents: 50n }))).toThrow(/low <= mid <= high/);
  });
});

describe('the licence', () => {
  it('grants autonomy from evidence: 12 of 12 passes, 3 of 3 and 4 of 5 do not, and a person can still revoke', () => {
    const d = makeDesk();
    const base = { parentPolicyId: '', title: 't', pattern: '{"kind":"pit_stop"}', effectTemplate: '{"cost":0}', createdBy: 'learner', createdAt: AT };
    d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy: { ...base, policyId: 'strong', precedentCount: 12, consistencyPct: 100 } }));
    d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy: { ...base, policyId: 'few', precedentCount: 3, consistencyPct: 100 } }));
    d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy: { ...base, policyId: 'mixed', precedentCount: 5, consistencyPct: 80 } }));
    expect(d.h.db.racePolicies.policyId.find('strong')?.autonomy).toBe('GRANTED');
    expect(d.h.db.racePolicies.policyId.find('strong')?.licence).toMatch(/^licence\(n=12, lb=0\.8/);
    expect(d.h.db.racePolicies.policyId.find('few')?.autonomy).toBe('SHADOW');
    expect(d.h.db.racePolicies.policyId.find('mixed')?.autonomy).toBe('SHADOW');
    // more evidence later grows the licence; a revoke by a person is final for the learner
    d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy: { ...base, policyId: 'few', precedentCount: 9, consistencyPct: 100 } }));
    expect(d.h.db.racePolicies.policyId.find('few')?.autonomy).toBe('GRANTED');
    d.as('head', ctx => mod.setRacePolicyAutonomy(ctx, { policyId: 'strong', autonomy: 'REVOKED', by: 'head', at: AT }));
    expect(() => d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy: { ...base, policyId: 'strong', precedentCount: 40, consistencyPct: 100 } }))).toThrow(/already decided/);
    expect(() => d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy: { ...base, policyId: 'x', precedentCount: 5, consistencyPct: 101 } }))).toThrow(/0-100/);
  });
});

describe('asking a person when Jev is unsure', () => {
  it('records needs_person, and a confirmation by race_head keeps the band and writes a precedent', () => {
    const d = makeDesk();
    d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event(), state: undefined }));
    d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { status: 'needs_person' }), d.effect(1, { decidedBy: 'policy:p1', status: 'autonomous' })] }));
    expect(d.h.db.raceEffects.effectKey.find(`${KEY_A}:0`)?.status).toBe('needs_person');
    expect(() => d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(2, { status: 'confirmed' })] }))).toThrow(/status must be/);
    const args = { effectKey: `${KEY_A}:0`, reason: 'garage confirms the floor', by: 'head', at: '2026-05-25T09:00:00Z' };
    expect(() => d.as('race', ctx => mod.confirmRaceEffect(ctx, args))).toThrow(/unauthorized/);
    d.as('head', ctx => mod.confirmRaceEffect(ctx, args));
    d.as('head', ctx => mod.confirmRaceEffect(ctx, args)); // the same confirmation twice: one precedent
    const row = d.h.db.raceEffects.effectKey.find(`${KEY_A}:0`);
    expect(row?.status).toBe('confirmed');
    expect(d.h.db.racePrecedents.count()).toBe(1n);
    const p = d.h.db.racePrecedents.precedentKey.find(`${KEY_A}:0@2026-05-25T09:00:00Z`);
    expect([p?.correctedLowCents, p?.correctedMidCents, p?.correctedHighCents]).toEqual([100n, 200n, 300n]);
    expect(() => d.as('head', ctx => mod.confirmRaceEffect(ctx, { ...args, effectKey: `${KEY_A}:1`, at: '2026-05-25T09:01:00Z' }))).toThrow(/not waiting/);
  });
});

describe('the race-day flow tables', () => {
  const inc = (over: Partial<Parameters<typeof mod.upsertRaceIncident>[1]['incident']> = {}) => ({
    incidentKey: '1249-9627-23-1', meetingKey: 1249, sessionKey: 9627, driverNumber: 23, teamName: 'Williams', firstSeenAt: AT,
    status: 'suspected', version: 1, beliefJson: '{}', evidenceJson: '[]', updatedAt: AT, cause: 'telemetry stop', ...over,
  });
  it('versions an incident: newer replaces and is appended, older is ignored', () => {
    const d = makeDesk();
    expect(() => d.as('head', ctx => mod.upsertRaceIncident(ctx, { incident: inc() }))).toThrow(/unauthorized/);
    d.as('race', ctx => mod.upsertRaceIncident(ctx, { incident: inc() }));
    d.as('race', ctx => mod.upsertRaceIncident(ctx, { incident: inc({ version: 2, status: 'corroborated', cause: 'red flag' }) }));
    d.as('race', ctx => mod.upsertRaceIncident(ctx, { incident: inc({ version: 1, status: 'suspected' }) }));
    expect(d.h.db.raceIncidents.incidentKey.find('1249-9627-23-1')?.status).toBe('corroborated');
    expect(d.h.db.raceBeliefs.count()).toBe(2n);
  });
  it('never records an outward action as done, and only a person approves it', () => {
    const d = makeDesk();
    const a = { actionKey: 'a1', incidentKey: 'i', kind: 'withdraw_car', title: 'Withdraw car 23', detailJson: '{}', dueAt: '', status: 'auto',
      ownerRole: 'team_principal', reversible: false, outward: true, decidedBy: 'code', updatedAt: AT };
    expect(() => d.as('race', ctx => mod.recordRaceActions(ctx, { actions: [a] }))).toThrow(/must wait for approval/);
    d.as('race', ctx => mod.recordRaceActions(ctx, { actions: [{ ...a, status: 'awaiting_approval' }] }));
    expect(() => d.as('race', ctx => mod.setRaceActionStatus(ctx, { actionKey: 'a1', status: 'approved', by: 'tp', at: AT }))).toThrow(/unauthorized/);
    d.as('head', ctx => mod.setRaceActionStatus(ctx, { actionKey: 'a1', status: 'approved', by: 'tp', at: AT }));
    d.as('race', ctx => mod.recordRaceActions(ctx, { actions: [{ ...a, status: 'awaiting_approval', title: 'replayed' }] }));
    expect(d.h.db.raceActions.actionKey.find('a1')?.status).toBe('approved');
    expect(d.h.db.raceActions.actionKey.find('a1')?.decidedBy).toBe('person:tp');
  });
  it('posts only balanced entries', () => {
    const d = makeDesk();
    const e = { entryKey: 'e1', incidentKey: 'i', effectKey: '', memo: 'front wing from spares', effectiveDate: '2024-11-03', recognition: 'first_use',
      capRelevant: true, amountCents: 100n, status: 'proposed', evidenceJson: '[]', at: AT };
    const lines = [{ account: '6050', debitCents: 100n, creditCents: 0n, memo: '' }, { account: '1400', debitCents: 0n, creditCents: 100n, memo: '' }];
    expect(() => d.as('race', ctx => mod.postRaceEntry(ctx, { entry: e, lines: [lines[0]!] }))).toThrow(/debits/);
    d.as('race', ctx => mod.postRaceEntry(ctx, { entry: e, lines }));
    expect(d.h.db.raceEntryLines.count()).toBe(2n);
  });
  it('asks once, takes one answer, and seals a close only after a person approves', () => {
    const d = makeDesk();
    const q = { questionKey: 'q1', incidentKey: 'i', kind: 'damage', prompt: 'More like A or B?', optionsJson: '[]', routeRole: 'chief_mechanic',
      expectedLossCents: 5n, deadlineAt: '', effectKeys: '', defaultOption: 'a', status: 'open', answerJson: '', answeredBy: '', createdAt: AT };
    d.as('race', ctx => mod.askRaceQuestion(ctx, { question: q }));
    d.as('race', ctx => mod.askRaceQuestion(ctx, { question: { ...q, prompt: 'again' } }));
    d.as('head', ctx => mod.answerRaceQuestion(ctx, { questionKey: 'q1', answerJson: '{"option":"b"}', by: 'cm', at: AT }));
    expect(() => d.as('head', ctx => mod.answerRaceQuestion(ctx, { questionKey: 'q1', answerJson: '{"option":"a"}', by: 'cm', at: AT }))).toThrow(/no longer open/);
    expect(d.h.db.raceQuestions.questionKey.find('q1')?.prompt).toBe('More like A or B?');
    const c = { closeKey: 'c1', meetingKey: 1249, closedAt: AT, rootHash: 'c'.repeat(64), totalsJson: '{}', briefsJson: '{}', status: 'draft', approvedBy: '', leaves: 3 };
    d.as('race', ctx => mod.recordRaceClose(ctx, { close: c }));
    expect(() => d.as('race', ctx => mod.markRaceCloseSent(ctx, { closeKey: 'c1', at: AT }))).toThrow(/approve the close first/);
    d.as('head', ctx => mod.approveRaceClose(ctx, { closeKey: 'c1', by: 'cfo', at: AT }));
    expect(() => d.as('race', ctx => mod.recordRaceClose(ctx, { close: c }))).toThrow(/already approved/);
    d.as('race', ctx => mod.markRaceCloseSent(ctx, { closeKey: 'c1', at: AT }));
    expect(d.h.db.raceCloses.closeKey.find('c1')?.status).toBe('sent');
  });
});
