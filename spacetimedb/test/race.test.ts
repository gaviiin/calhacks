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
    expect(() => d.as('race', ctx => mod.recordRaceEffects(ctx, { eventKey: KEY_A, effects: [d.effect(0, { status: 'corrected' })] }))).toThrow(/proposed or autonomous/);
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
      effectTemplate: '{"severity":"heavy"}', precedentCount: 12, createdBy: 'learner', createdAt: AT,
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
  it('a proposed policy is always a shadow; only the head grants autonomy', () => {
    const d = makeDesk();
    const policy = { policyId: 'p1', parentPolicyId: '', title: 'SC pit stop is free', pattern: '{"kind":"pit_stop","under":"safety_car"}',
      effectTemplate: '{"cost":0}', precedentCount: 20, createdBy: 'learner', createdAt: AT };
    d.as('race', ctx => mod.proposeRacePolicy(ctx, { policy }));
    expect(d.h.db.racePolicies.policyId.find('p1')?.autonomy).toBe('SHADOW');
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
      policyId: 'p1', parentPolicyId: '', title: 't', pattern: '{}', effectTemplate: '{}', precedentCount: 3, createdBy: 'learner', createdAt: AT,
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
