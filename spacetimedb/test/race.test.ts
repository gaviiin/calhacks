import { describe, expect, it } from 'vitest';
import { ConnectionId, Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';

// ---------------------------------------------------------------- fixture

let nextConn = 1n;
function principal(sub: string) {
  return TestAuth.fromJwtPayload(JSON.stringify({ iss: 'https://pit-wall.test', sub }), new ConnectionId(nextConn++));
}
type Who = 'owner' | 'race' | 'head' | 'stranger' | 'cos';

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
    cos: principal('cos'),
  };
  type C = Parameters<Parameters<typeof h.withReducerTx>[1]>[0];
  const as = <T>(who: Who, fn: (ctx: C) => T): T => h.withReducerTx(auth[who], fn);
  // The owner is whoever ran init; in the harness we seed config directly as the publisher would.
  as('owner', ctx => mod.init(ctx));
  const raceId = as('race', ctx => ctx.sender);
  const headId = as('head', ctx => ctx.sender);
  const cosId = as('cos', ctx => ctx.sender);
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
  // The refusal is committed, not thrown: the newest audit row says what happened.
  const lastAudit = () => [...h.db.raceAudit.iter()].sort((a, b) => Number(a.auditId - b.auditId)).at(-1)!;
  return { h, as, event, state, effect, lastAudit, ids: { raceId, headId, cosId } };
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
    d.as('race', ctx => mod.setRacePolicyAutonomy(ctx, { policyId: 'p1', autonomy: 'GRANTED', by: 'learner', at: AT }));
    expect(d.h.db.racePolicies.policyId.find('p1')?.autonomy).toBe('SHADOW');
    expect(d.lastAudit()).toMatchObject({ action: 'set_policy_autonomy', allowed: false, role: 'race' });
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
    d.as('race', ctx => mod.correctRaceEffect(ctx, args));
    expect(d.h.db.raceEffects.effectKey.find(`${KEY_A}:0`)?.status).toBe('autonomous');
    expect(d.lastAudit()).toMatchObject({ action: 'correct_effect', allowed: false });
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
    d.as('race', ctx => mod.confirmRaceEffect(ctx, args));
    expect(d.h.db.raceEffects.effectKey.find(`${KEY_A}:0`)?.status).toBe('needs_person');
    expect(d.lastAudit()).toMatchObject({ action: 'confirm_effect', allowed: false });
    d.as('head', ctx => mod.confirmRaceEffect(ctx, args));
    d.as('head', ctx => mod.confirmRaceEffect(ctx, args)); // the same confirmation twice: one precedent
    const row = d.h.db.raceEffects.effectKey.find(`${KEY_A}:0`);
    expect(row?.status).toBe('confirmed');
    expect(d.h.db.racePrecedents.count()).toBe(1n);
    const p = d.h.db.racePrecedents.precedentKey.find(`${KEY_A}:0@2026-05-25T09:00:00Z`);
    expect([p?.correctedLowCents, p?.correctedMidCents, p?.correctedHighCents]).toEqual([100n, 200n, 300n]);
    expect(d.h.db.raceSignoffs.effectKey.find(`${KEY_A}:0`)?.name).toBe('race_head');
    d.as('head', ctx => mod.confirmRaceEffect(ctx, { ...args, at: '2026-05-25T09:01:00Z' }));
    expect(d.lastAudit()).toMatchObject({ action: 'confirm_effect', allowed: false, reason: 'effect is confirmed, not waiting for a person' });
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
    d.as('race', ctx => mod.setRaceActionStatus(ctx, { actionKey: 'a1', status: 'approved', by: 'tp', at: AT }));
    expect(d.h.db.raceActions.actionKey.find('a1')?.status).toBe('awaiting_approval');
    d.as('head', ctx => mod.setRaceActionStatus(ctx, { actionKey: 'a1', status: 'approved', by: 'claimed name', at: AT }));
    d.as('race', ctx => mod.recordRaceActions(ctx, { actions: [{ ...a, status: 'awaiting_approval', title: 'replayed' }] }));
    expect(d.h.db.raceActions.actionKey.find('a1')?.status).toBe('approved');
    expect(d.h.db.raceActions.actionKey.find('a1')?.decidedBy).toBe('person:race_head'); // the seat, not the name the client sent
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
    d.as('head', ctx => mod.answerRaceQuestion(ctx, { questionKey: 'q1', answerJson: '{"option":"a"}', by: 'cm', at: AT }));
    expect(d.lastAudit()).toMatchObject({ action: 'answer_question', allowed: false, reason: 'question is answered' });
    expect(JSON.parse(d.h.db.raceQuestions.questionKey.find('q1')!.answerJson).option).toBe('b');
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

describe('a decision with priced options', () => {
  it('records the option a person chose, and only one of the priced options', () => {
    const d = makeDesk();
    const detail = JSON.stringify({ options: [{ id: 'repair' }, { id: 'spare_tub' }, { id: 'withdraw' }], summary: 's' });
    const a = { actionKey: 'w1', incidentKey: 'i', kind: 'withdraw_car', title: 'Car 23: repair, spare tub or withdraw?', detailJson: detail, dueAt: '',
      status: 'awaiting_approval', ownerRole: 'team_principal', reversible: false, outward: true, decidedBy: 'code', updatedAt: AT };
    d.as('race', ctx => mod.recordRaceActions(ctx, { actions: [a] }));
    d.as('race', ctx => mod.chooseRaceActionOption(ctx, { actionKey: 'w1', option: 'withdraw', by: 'tp', at: AT }));
    expect(d.lastAudit()).toMatchObject({ allowed: false, reason: 'only a person decides this; an agent identity is refused' });
    d.as('head', ctx => mod.chooseRaceActionOption(ctx, { actionKey: 'w1', option: 'retire', by: 'tp', at: AT }));
    expect(d.lastAudit()).toMatchObject({ allowed: false, reason: 'not one of the priced options' });
    d.as('head', ctx => mod.chooseRaceActionOption(ctx, { actionKey: 'w1', option: 'withdraw', by: 'tp', at: AT }));
    const row = d.h.db.raceActions.actionKey.find('w1');
    expect(row?.status).toBe('approved');
    expect(JSON.parse(row!.detailJson).chosen).toBe('withdraw');
    d.as('head', ctx => mod.chooseRaceActionOption(ctx, { actionKey: 'w1', option: 'repair', by: 'tp', at: AT }));
    expect(JSON.parse(d.h.db.raceActions.actionKey.find('w1')!.detailJson).chosen).toBe('withdraw');
  });
});

describe('options and postings', () => {
  it('never stores a recommendation, and a held entry needs a person before it posts', () => {
    const d = makeDesk();
    const o = { optionKey: '9636-43-L30-safety_car', sessionKey: 9636, meetingKey: 1249, driverNumber: 43, lap: 30, at: AT, condition: 'sc', trigger: 'safety_car',
      optionsJson: JSON.stringify([{ id: 'stay_out' }, { id: 'pit_now' }]) };
    d.as('race', ctx => mod.recordRaceOptions(ctx, { options: o }));
    expect(() => d.as('race', ctx => mod.recordRaceOptions(ctx, { options: { ...o, optionsJson: '{"recommended":"pit_now"}' } }))).toThrow(/does not recommend/);
    const e = { entryKey: 'e1', incidentKey: 'i', effectKey: '', memo: 'm', effectiveDate: '2024-11-03', recognition: 'incurred', capRelevant: true,
      amountCents: 100n, status: 'proposed', evidenceJson: '[]', at: AT };
    d.as('race', ctx => mod.postRaceEntry(ctx, { entry: e, lines: [{ account: '6050', debitCents: 100n, creditCents: 0n, memo: '' }, { account: '2100', debitCents: 0n, creditCents: 100n, memo: '' }] }));
    const p = { entryKey: 'e1', incidentKey: 'i', status: 'held', erpEntryId: '', costCapRef: '', reviewRole: 'controller', reason: 'held by the desk', amountCents: 100n, by: 'desk', at: AT };
    d.as('race', ctx => mod.recordRacePosting(ctx, { posting: p }));
    d.as('race', ctx => mod.recordRacePosting(ctx, { posting: { ...p, status: 'posted', erpEntryId: 'JE-1' } }));
    expect(d.lastAudit()).toMatchObject({ action: 'record_posted', allowed: false });
    expect(d.h.db.racePostings.entryKey.find('e1')?.status).toBe('held');
    d.as('head', ctx => mod.decideRacePosting(ctx, { entryKey: 'e1', status: 'approved', by: 'cfo', at: AT }));
    d.as('race', ctx => mod.recordRacePosting(ctx, { posting: { ...p, status: 'posted', erpEntryId: 'JE-1', by: 'desk' } }));
    expect(d.h.db.racePostings.entryKey.find('e1')?.erpEntryId).toBe('JE-1');
  });
});


// ---------------------------------------------------------------- the money gate

describe('the money gate', () => {
  const T2 = '2026-05-25T09:00:00Z';
  function desk() {
    const d = makeDesk();
    const ccId = d.as('stranger', ctx => ctx.sender); // a second person: the head of cost cap
    d.as('owner', ctx => mod.grantSeat(ctx, { who: d.ids.headId, role: 'race_head', name: 'Morgan Hale' }));
    d.as('owner', ctx => mod.grantSeat(ctx, { who: ccId, role: 'head_of_cost_cap', name: 'Priya Shah' }));
    d.as('owner', ctx => mod.grantSeat(ctx, { who: d.ids.cosId, role: 'chief_of_staff', name: 'Sam Reyes' }));
    d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event(), state: undefined }));
    const entry = (key: string, effectKey: string, amountCents: bigint, recognition = 'incurred') => {
      const e = { entryKey: key, incidentKey: 'i', effectKey, memo: 'crash parts', effectiveDate: '2024-11-03', recognition, capRelevant: true,
        amountCents, status: 'proposed', evidenceJson: '[]', at: AT };
      d.as('race', ctx => mod.postRaceEntry(ctx, { entry: e, lines: [{ account: '6050', debitCents: amountCents, creditCents: 0n, memo: '' }, { account: '2100', debitCents: 0n, creditCents: amountCents, memo: '' }] }));
    };
    const posting = (key: string) => d.h.db.racePostings.entryKey.find(key)!;
    d.as('race', ctx => mod.upsertRaceIncident(ctx, { incident: { incidentKey: 'i', meetingKey: 1249, sessionKey: 9636, driverNumber: 43, teamName: 'Williams', firstSeenAt: AT,
      status: 'confirmed', version: 1, beliefJson: '{}', evidenceJson: '[]', updatedAt: AT, cause: 'stop' } }));
    // the desk's response plan: each entry line names its closest case in the team's history, or none
    const plan = (lines: { ref: string; status: 'precedent' | 'novel'; similarity?: number; why?: string }[], status = 'draft') =>
      d.as('race', ctx => mod.recordRacePlan(ctx, { plan: { planKey: 'i', incidentKey: 'i', version: 1, status, summary: 'the plan', precedented: lines.filter(l => l.status === 'precedent').length,
        novel: lines.filter(l => l.status === 'novel').length, approvedBy: '', approvedAt: '', updatedAt: AT,
        linesJson: JSON.stringify(lines.map(l => ({ ref: l.ref, kind: 'entry', label: l.ref, amountCents: 0, status: l.status, why: l.why ?? '',
          precedent: l.status === 'precedent' ? { case_id: 'history-1', similarity: l.similarity ?? 0.93 } : null }))) } }));
    const approve = (by = 'x', who: Who = 'cos') => d.as(who, ctx => mod.approveRacePlan(ctx, { planKey: 'i', status: 'approved', by, at: AT }));
    return { ...d, entry, posting, plan, approve };
  }

  it('posts on precedent once the chief of staff approves the plan; holds a novel line for the head of cost cap, whatever the amounts', () => {
    const d = desk();
    d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [
      d.effect(0, { decidedBy: 'policy:p1', status: 'autonomous' }),
      d.effect(1, { decidedBy: 'jev', status: 'autonomous' }),
    ] }));
    d.entry('wing', `${KEY_A}:0`, 9_000_000n);
    d.entry('tub', `${KEY_A}:1`, 120_000_000n); // $1.2m: no threshold, only the history decides
    d.entry('jevline', `${KEY_A}:1`, 300_000_000n); // $3m on Jev's own estimate, with a precedent
    d.as('race', ctx => mod.requestRacePosting(ctx, { entryKey: 'wing', at: AT }));
    expect(d.posting('wing')).toMatchObject({ status: 'held', reviewRole: 'chief_of_staff' });
    expect(d.posting('wing').reason).toMatch(/no response plan for this incident yet/);
    d.plan([{ ref: 'wing', status: 'precedent' }, { ref: 'tub', status: 'novel', why: 'the team has never built a monocoque mid-season' }, { ref: 'jevline', status: 'precedent', similarity: 0.91 }]);
    d.as('race', ctx => mod.requestRacePosting(ctx, { entryKey: 'tub', at: AT }));
    d.as('race', ctx => mod.requestRacePosting(ctx, { entryKey: 'jevline', at: AT }));
    expect(d.posting('wing')).toMatchObject({ status: 'held', reviewRole: 'chief_of_staff' });
    expect(d.posting('wing').reason).toMatch(/waits for the chief of staff/);
    // a seat that is not the chief of staff is refused; an agent is refused
    d.as('stranger', ctx => mod.approveRacePlan(ctx, { planKey: 'i', status: 'approved', by: 'x', at: AT }));
    expect(d.lastAudit()).toMatchObject({ action: 'plan_approved', allowed: false });
    expect(d.lastAudit().reason).toMatch(/head of cost cap does not approve a response plan/);
    d.as('race', ctx => mod.approveRacePlan(ctx, { planKey: 'i', status: 'approved', by: 'agent', at: AT }));
    expect(d.lastAudit()).toMatchObject({ action: 'plan_approved', allowed: false });
    d.approve();
    expect(d.lastAudit()).toMatchObject({ action: 'plan_approved', allowed: true, name: 'Sam Reyes' });
    // the precedented lines are released in the same transaction, the novel one waits for the head of cost cap
    expect(d.posting('wing')).toMatchObject({ status: 'authorized', reviewRole: '' });
    expect(d.posting('wing').reason).toMatch(/on precedent history-1 \(similarity 0.93\)/);
    expect(d.posting('jevline')).toMatchObject({ status: 'authorized' });
    expect(d.posting('tub')).toMatchObject({ status: 'held', reviewRole: 'head_of_cost_cap' });
    expect(d.posting('tub').reason).toMatch(/no entry like it in the team's history: the team has never built a monocoque/);
    // the desk cannot post the held one, whatever it claims
    const held = d.posting('tub');
    d.as('race', ctx => mod.recordRacePosting(ctx, { posting: { ...held, status: 'posted', erpEntryId: 'JE-9', by: 'desk', at: AT } }));
    expect(d.posting('tub').status).toBe('held');
    expect(d.lastAudit()).toMatchObject({ action: 'record_posted', allowed: false });
    const ok = d.posting('wing');
    d.as('race', ctx => mod.recordRacePosting(ctx, { posting: { ...ok, status: 'posted', erpEntryId: 'JE-1', by: 'desk', at: AT } }));
    expect(d.posting('wing')).toMatchObject({ status: 'posted', erpEntryId: 'JE-1' });
  });

  it('a plan the desk sends as approved is a draft; an approval stands across versions; the desk never approves', () => {
    const d = desk();
    d.plan([{ ref: 'e', status: 'precedent' }], 'approved');
    expect(d.h.db.racePlans.planKey.find('i')).toMatchObject({ status: 'draft', approvedBy: '' });
    d.approve();
    expect(d.h.db.racePlans.planKey.find('i')).toMatchObject({ status: 'approved', approvedBy: 'Sam Reyes' });
    d.plan([{ ref: 'e', status: 'precedent' }, { ref: 'f', status: 'novel' }]);
    expect(d.h.db.racePlans.planKey.find('i')).toMatchObject({ status: 'approved', approvedBy: 'Sam Reyes', novel: 1 });
    d.approve();
    expect(d.lastAudit()).toMatchObject({ action: 'plan_approved', allowed: false, reason: 'the plan is approved, not a draft' });
  });

  it('approving with edits holds the plan until the desk applies them; then the approval releases what has a precedent', () => {
    const d = desk();
    const planRow = () => d.h.db.racePlans.planKey.find('i')!;
    d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { decidedBy: 'policy:p1', status: 'autonomous' })] }));
    d.entry('wing', `${KEY_A}:0`, 9_000_000n);
    d.plan([{ ref: 'wing', status: 'precedent' }]);
    d.as('race', ctx => mod.requestRacePosting(ctx, { entryKey: 'wing', at: AT }));
    // empty words are not an edit; an agent may not edit for a person; a seat that does not approve plans is refused
    expect(() => d.as('cos', ctx => mod.approveRacePlanWithEdits(ctx, { planKey: 'i', edits: '   ', by: 'x', at: AT }))).toThrow(/empty/);
    d.as('race', ctx => mod.approveRacePlanWithEdits(ctx, { planKey: 'i', edits: 'cancel the air freight', by: 'agent', at: AT }));
    expect(d.lastAudit()).toMatchObject({ action: 'plan_edited', allowed: false });
    d.as('stranger', ctx => mod.approveRacePlanWithEdits(ctx, { planKey: 'i', edits: 'cancel the air freight', by: 'x', at: AT }));
    expect(d.lastAudit().reason).toMatch(/head of cost cap does not approve a response plan/);
    expect(planRow().status).toBe('draft');
    // the chief of staff approves with edits: recorded at once, the plan held as revising
    d.as('cos', ctx => mod.approveRacePlanWithEdits(ctx, { planKey: 'i', edits: 'Hand carry the floor; cancel the air freight.', by: 'x', at: AT }));
    expect(d.lastAudit()).toMatchObject({ action: 'plan_edited', allowed: true, name: 'Sam Reyes' });
    expect(planRow()).toMatchObject({ status: 'revising', approvedBy: 'Sam Reyes', approvedAt: AT });
    expect(d.h.db.racePlanEdits.editKey.find('i:1')).toMatchObject({ planKey: 'i', status: 'pending', by: 'Sam Reyes', text: 'Hand carry the floor; cancel the air freight.' });
    // nothing posts while the desk applies the edits, precedent or not
    expect(d.posting('wing')).toMatchObject({ status: 'held', reviewRole: 'chief_of_staff' });
    expect(d.posting('wing').reason).toMatch(/approved with edits: the agent is applying them/);
    // a second edit waits for the first; the desk re-recording the plan keeps it revising
    d.as('cos', ctx => mod.approveRacePlanWithEdits(ctx, { planKey: 'i', edits: 'and a PU check', by: 'x', at: AT }));
    expect(d.lastAudit()).toMatchObject({ allowed: false });
    expect(d.lastAudit().reason).toMatch(/edits wait until the agent has applied the last ones/);
    d.plan([{ ref: 'wing', status: 'precedent', similarity: 0.95 }]);
    expect(planRow().status).toBe('revising');
    // only the desk applies an edit
    d.as('cos', ctx => mod.applyRacePlanEdit(ctx, { editKey: 'i:1', status: 'applied', changesJson: '[]', note: '', model: 'x', at: T2 }));
    expect(d.lastAudit()).toMatchObject({ action: 'plan_edit_applied', allowed: false, reason: 'only the race desk applies a plan edit' });
    const changes = JSON.stringify([{ op: 'reroute', ref: 'i:freight', label: 'floor by hand carry', applied: true, why: 'as asked' }]);
    d.as('race', ctx => mod.applyRacePlanEdit(ctx, { editKey: 'i:1', status: 'applied', changesJson: changes, note: '1 change applied', model: 'offline-rules', at: T2 }));
    expect(d.lastAudit()).toMatchObject({ action: 'plan_edit_applied', allowed: true });
    expect(d.h.db.racePlanEdits.editKey.find('i:1')).toMatchObject({ status: 'applied', changesJson: changes, model: 'offline-rules', appliedAt: T2 });
    // the approval takes effect: the plan is approved, the precedented line is released in the same transaction
    expect(planRow()).toMatchObject({ status: 'approved', approvedBy: 'Sam Reyes' });
    expect(d.posting('wing')).toMatchObject({ status: 'authorized', reviewRole: '' });
    // an edit is applied once
    d.as('race', ctx => mod.applyRacePlanEdit(ctx, { editKey: 'i:1', status: 'applied', changesJson: '[]', note: '', model: 'x', at: T2 }));
    expect(d.lastAudit()).toMatchObject({ allowed: false, reason: 'the edit is applied' });
    // an approved plan can be edited again, and is held again
    d.as('cos', ctx => mod.approveRacePlanWithEdits(ctx, { planKey: 'i', edits: 'add a power unit check on car 43', by: 'x', at: T2 }));
    expect(planRow().status).toBe('revising');
    expect(d.h.db.racePlanEdits.editKey.find('i:2')).toMatchObject({ status: 'pending' });
    // a failed reading keeps the words on the record and releases the plan as it stood
    d.as('race', ctx => mod.applyRacePlanEdit(ctx, { editKey: 'i:2', status: 'failed', changesJson: '[]', note: 'could not read the edits', model: 'offline-rules', at: T2 }));
    expect(planRow().status).toBe('approved');
    expect(d.h.db.racePlanEdits.editKey.find('i:2')).toMatchObject({ status: 'failed', text: 'add a power unit check on car 43' });
  });

  it('holds an estimate that is only Jev\'s when nothing like it is on the record; the signer cannot also approve its posting', () => {
    const d = desk();
    d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { decidedBy: 'jev', status: 'needs_person' })] }));
    d.entry('big', `${KEY_A}:0`, 40_000_000n);
    d.plan([{ ref: 'big', status: 'novel', why: 'no case like it' }]);
    d.approve();
    d.as('race', ctx => mod.requestRacePosting(ctx, { entryKey: 'big', at: AT }));
    expect(d.posting('big')).toMatchObject({ status: 'held', reviewRole: 'head_of_cost_cap' });
    expect(d.posting('big').reason).toMatch(/Jev was unsure/);
    d.as('race', ctx => mod.decideRacePosting(ctx, { entryKey: 'big', status: 'approved', by: 'agent', at: AT }));
    expect(d.lastAudit()).toMatchObject({ allowed: false, reason: 'only a person decides this; an agent identity is refused' });
    d.as('owner', ctx => mod.decideRacePosting(ctx, { entryKey: 'big', status: 'approved', by: 'publisher', at: AT }));
    expect(d.lastAudit()).toMatchObject({ allowed: false, role: 'owner' });
    d.as('head', ctx => mod.decideRacePosting(ctx, { entryKey: 'big', status: 'approved', by: 'x', at: AT }));
    expect(d.lastAudit().reason).toMatch(/held for the head of cost cap; a race head cannot decide it/);
    // Priya signs off the estimate, so Priya may not also approve its posting
    d.as('stranger', ctx => mod.confirmRaceEffect(ctx, { effectKey: `${KEY_A}:0`, reason: 'seen the floor', by: 'x', at: T2 }));
    expect(d.posting('big').status).toBe('held'); // still novel
    expect(d.posting('big').reason).toMatch(/no entry like it/);
    d.as('stranger', ctx => mod.decideRacePosting(ctx, { entryKey: 'big', status: 'approved', by: 'x', at: T2 }));
    expect(d.lastAudit().reason).toMatch(/Priya Shah signed off the estimate behind this entry; a second person must approve/);
    expect(d.posting('big').status).toBe('held');
  });

  it('in a demo replay, the desk records the team\'s documented plan approval and held-books approval, tagged replayed', () => {
    const d = desk();
    d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { decidedBy: 'policy:p1', status: 'autonomous' })] }));
    d.entry('big', `${KEY_A}:0`, 40_000_000n);
    d.plan([{ ref: 'big', status: 'novel' }]);
    d.as('race', ctx => mod.approveRacePlan(ctx, { planKey: 'i', status: 'approved', by: 'Chief of Staff (replayed)', at: AT }));
    expect(d.h.db.racePlans.planKey.find('i')?.status).toBe('draft'); // replay mode is off
    d.as('owner', ctx => mod.setReplayDecisions(ctx, { allowed: true }));
    d.as('race', ctx => mod.approveRacePlan(ctx, { planKey: 'i', status: 'approved', by: 'Chief of Staff', at: AT }));
    expect(d.h.db.racePlans.planKey.find('i')?.status).toBe('draft'); // not tagged replayed
    d.as('race', ctx => mod.approveRacePlan(ctx, { planKey: 'i', status: 'approved', by: 'Chief of Staff (replayed)', at: AT }));
    expect(d.h.db.racePlans.planKey.find('i')).toMatchObject({ status: 'approved', approvedBy: 'Chief of Staff (replayed)' });
    d.as('race', ctx => mod.requestRacePosting(ctx, { entryKey: 'big', at: AT }));
    expect(d.posting('big')).toMatchObject({ status: 'held', reviewRole: 'head_of_cost_cap' });
    d.as('race', ctx => mod.decideRacePosting(ctx, { entryKey: 'big', status: 'approved', by: 'CFO (replayed)', at: AT }));
    expect(d.posting('big')).toMatchObject({ status: 'approved', by: 'CFO (replayed)' });
  });

  it('holds an adjustment until the entry it adjusts is in the ERP, for the same person', () => {
    const d = desk();
    d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { decidedBy: 'policy:p1', status: 'autonomous' })] }));
    d.entry('big', `${KEY_A}:0`, 40_000_000n);
    d.entry('big:adj', `${KEY_A}:0`, 9_000_000n);
    d.entry('small', `${KEY_A}:0`, 9_000_000n);
    d.entry('small:adj', `${KEY_A}:0`, 1_000_000n);
    d.plan([{ ref: 'big', status: 'novel' }, { ref: 'big:adj', status: 'precedent' }, { ref: 'small', status: 'precedent' }, { ref: 'small:adj', status: 'precedent' }]);
    d.approve();
    d.as('race', ctx => mod.requestRacePosting(ctx, { entryKey: 'big', at: AT }));
    d.as('race', ctx => mod.requestRacePosting(ctx, { entryKey: 'big:adj', at: AT }));
    expect(d.posting('big')).toMatchObject({ status: 'held', reviewRole: 'head_of_cost_cap' });
    expect(d.posting('big:adj')).toMatchObject({ status: 'held', reviewRole: 'head_of_cost_cap' });
    expect(d.posting('big:adj').reason).toMatch(/adjusts an entry not in the ERP yet \(held, for the head of cost cap\)/);
    d.as('race', ctx => mod.requestRacePosting(ctx, { entryKey: 'small', at: AT }));
    const ok = d.posting('small');
    d.as('race', ctx => mod.recordRacePosting(ctx, { posting: { ...ok, status: 'posted', erpEntryId: 'JE-1', by: 'desk', at: AT } }));
    d.as('race', ctx => mod.requestRacePosting(ctx, { entryKey: 'small:adj', at: AT }));
    expect(d.posting('small:adj')).toMatchObject({ status: 'authorized' });
  });

  it('a person\'s answer signs off the lines it covers; a deadline default does not', () => {
    const d = desk();
    d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { status: 'needs_person' }), d.effect(1, { status: 'needs_person' })] }));
    d.entry('e0', `${KEY_A}:0`, 9_000_000n);
    d.plan([{ ref: 'e0', status: 'precedent' }]);
    d.approve();
    d.as('race', ctx => mod.requestRacePosting(ctx, { entryKey: 'e0', at: AT }));
    const q = { questionKey: 'q1', incidentKey: 'i', kind: 'damage', prompt: 'A or B?', optionsJson: '[]', routeRole: 'chief_mechanic', expectedLossCents: 5n,
      deadlineAt: '', effectKeys: `${KEY_A}:0`, defaultOption: 'a', status: 'open', answerJson: '', answeredBy: '', createdAt: AT };
    d.as('race', ctx => mod.askRaceQuestion(ctx, { question: q }));
    d.as('race', ctx => mod.applyRaceAnswer(ctx, { questionKey: 'q1', effectKey: `${KEY_A}:0`, corrected: false, lowCents: 0n, midCents: 0n, highCents: 0n, at: T2 }));
    expect(d.lastAudit()).toMatchObject({ action: 'apply_answer', allowed: false, reason: 'the question has no answer yet' });
    d.as('head', ctx => mod.answerRaceQuestion(ctx, { questionKey: 'q1', answerJson: '{"option":"a"}', by: 'x', at: T2 }));
    d.as('race', ctx => mod.applyRaceAnswer(ctx, { questionKey: 'q1', effectKey: `${KEY_A}:1`, corrected: false, lowCents: 0n, midCents: 0n, highCents: 0n, at: T2 }));
    expect(d.lastAudit().reason).toBe('the question does not cover this effect');
    d.as('race', ctx => mod.applyRaceAnswer(ctx, { questionKey: 'q1', effectKey: `${KEY_A}:0`, corrected: false, lowCents: 0n, midCents: 0n, highCents: 0n, at: T2 }));
    expect(d.h.db.raceSignoffs.effectKey.find(`${KEY_A}:0`)).toMatchObject({ name: 'Morgan Hale', via: 'question:q1' });
    expect(d.posting('e0').status).toBe('authorized');
    // a defaulted question applies the conservative option but signs nothing off
    d.as('race', ctx => mod.askRaceQuestion(ctx, { question: { ...q, questionKey: 'q2', effectKeys: `${KEY_A}:1`, deadlineAt: AT } }));
    d.as('race', ctx => mod.defaultRaceQuestion(ctx, { questionKey: 'q2', at: T2 }));
    d.as('race', ctx => mod.applyRaceAnswer(ctx, { questionKey: 'q2', effectKey: `${KEY_A}:1`, corrected: false, lowCents: 0n, midCents: 0n, highCents: 0n, at: T2 }));
    expect(d.h.db.raceEffects.effectKey.find(`${KEY_A}:1`)?.status).toBe('confirmed');
    expect(d.h.db.raceSignoffs.effectKey.find(`${KEY_A}:1`)).toBeNull();
  });

  it('keeps question deadlines itself, scaled by the replay pace', () => {
    const d = desk();
    d.as('race', ctx => mod.setRaceClock(ctx, { pace: 60 }));
    const q = { questionKey: 'q9', incidentKey: 'i', kind: 'damage', prompt: '?', optionsJson: '[]', routeRole: 'cm', expectedLossCents: 1n,
      deadlineAt: '2026-05-24T16:35:37Z', effectKeys: '', defaultOption: 'a', status: 'open', answerJson: '', answeredBy: '', createdAt: AT };
    d.as('race', ctx => mod.askRaceQuestion(ctx, { question: q }));
    const timers = [...d.h.db.raceQuestionTimers.iter()];
    expect(timers).toHaveLength(1);
    const at = timers[0]!.scheduledAt as { tag: string; value: { microsSinceUnixEpoch: bigint } };
    expect(at.tag).toBe('Time');
    // ten race minutes at 60x is ten wall seconds
    expect(at.value.microsSinceUnixEpoch - 1_779_640_000_000_000n).toBe(10_000_000n);
    expect(() => d.as('race', ctx => mod.questionDeadlineDue(ctx, { timer: timers[0]! }))).toThrow(/only the database/);
  });

  it('only the owner seats people, never itself, and only the CFO changes the rules', () => {
    const d = desk();
    expect(() => d.as('head', ctx => mod.grantSeat(ctx, { who: d.ids.headId, role: 'cfo', name: 'me' }))).toThrow(/only the module owner/);
    const ownerId = d.as('owner', ctx => ctx.sender);
    expect(() => d.as('owner', ctx => mod.grantSeat(ctx, { who: ownerId, role: 'cfo', name: 'me' }))).toThrow(/publisher identity runs the agents/);
    d.as('head', ctx => mod.setRaceRules(ctx, { autoPostMaxCents: 1n, cfoCents: 2n, modelMayPostAlone: true }));
    expect(d.lastAudit()).toMatchObject({ action: 'set_rules', allowed: false });
    expect(d.h.db.raceRules.id.find(0)).toBeNull();
  });

  it('records the team\'s documented decisions only in replay mode, labelled replayed', () => {
    const d = desk();
    const q = { questionKey: 'qr', incidentKey: 'i', kind: 'damage', prompt: '?', optionsJson: '[]', routeRole: 'cm', expectedLossCents: 1n,
      deadlineAt: '', effectKeys: '', defaultOption: 'a', status: 'open', answerJson: '', answeredBy: '', createdAt: AT };
    d.as('race', ctx => mod.askRaceQuestion(ctx, { question: q }));
    d.as('race', ctx => mod.answerRaceQuestion(ctx, { questionKey: 'qr', answerJson: '{"option":"b"}', by: 'Chief mechanic (replayed)', at: AT }));
    expect(d.lastAudit()).toMatchObject({ action: 'answer_question', allowed: false });
    d.as('race', ctx => mod.setReplayDecisions(ctx, { allowed: true }));
    expect(d.lastAudit()).toMatchObject({ action: 'set_replay_decisions', allowed: false }); // the desk cannot turn it on
    d.as('owner', ctx => mod.setReplayDecisions(ctx, { allowed: true }));
    d.as('race', ctx => mod.answerRaceQuestion(ctx, { questionKey: 'qr', answerJson: '{"option":"b"}', by: 'Chief mechanic', at: AT }));
    expect(d.lastAudit()).toMatchObject({ allowed: false }); // untagged: still refused
    d.as('race', ctx => mod.answerRaceQuestion(ctx, { questionKey: 'qr', answerJson: '{"option":"b"}', by: 'Chief mechanic (replayed)', at: AT }));
    expect(d.lastAudit()).toMatchObject({ allowed: true, reason: 'replayed historical decision: Chief mechanic (replayed)' });
    expect(d.h.db.raceQuestions.questionKey.find('qr')?.answeredBy).toBe('Chief mechanic (replayed)');
  });

  it('measures each event from the desk reading it to the commit, and lists seats but not agents', () => {
    const d = desk();
    d.as('race', ctx => mod.recordRaceEvent(ctx, { event: d.event({ eventKey: KEY_B, ingestedAt: '2026-05-24T16:25:37Z' }), state: undefined }));
    const lat = d.h.db.raceLatency.id.find(0)!;
    expect(lat.events).toBe(2n);
    expect(lat.lastEventKey).toBe(KEY_B);
    d.as('head', ctx => mod.onConnect(ctx));
    d.as('race', ctx => mod.onConnect(ctx));
    const online = [...d.h.db.raceOnline.iter()];
    expect(online.map((o) => o.name)).toEqual(['Morgan Hale']);
  });
});
