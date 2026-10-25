import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables, type DbConnection } from '../module_bindings';
import type {
  CarState,
  RaceActions,
  RaceBeliefs,
  RaceCloses,
  RaceEffects,
  RaceEntries,
  RaceEntryLines,
  RaceEvents,
  RaceForecasts,
  RaceIncidents,
  RaceOptions,
  RacePolicies,
  RacePostings,
  RaceHealth,
  RacePrecedents,
  RaceQuestions,
  RaceSims,
  RaceAudit,
  RaceSeats,
  RaceRules,
  RaceSignoffs,
  RaceOnline,
  RaceLatency,
} from '../module_bindings/types';

// The race desk's six tables live in the pit-wall database, subscribed inside the same provider as
// the evidence bridge and handed down through this context for the same reason: the cost cap
// provider nested below owns the SDK's hook context.
//
// Corrections are written through this browser's own pit-wall identity. The module lets only an
// identity holding the `race_head` writer role correct a band, so the identity is exposed here for
// `scripts/race_grant.py --role race_head --identity <hex>`; until it is granted the module refuses
// and the view says so.

export interface CorrectArgs {
  effectKey: string;
  lowCents: bigint;
  midCents: bigint;
  highCents: bigint;
  reason: string;
  by: string;
  at: string;
}

export interface ConfirmArgs {
  effectKey: string;
  reason: string;
  by: string;
  at: string;
}

export interface RaceData {
  connected: boolean;
  identityHex: string | null;
  events: readonly RaceEvents[];
  cars: readonly CarState[];
  effects: readonly RaceEffects[];
  forecasts: readonly RaceForecasts[];
  policies: readonly RacePolicies[];
  precedents: readonly RacePrecedents[];
  // the race-day flow after the tape
  incidents: readonly RaceIncidents[];
  beliefs: readonly RaceBeliefs[];
  actions: readonly RaceActions[];
  entries: readonly RaceEntries[];
  entryLines: readonly RaceEntryLines[];
  questions: readonly RaceQuestions[];
  sims: readonly RaceSims[];
  closes: readonly RaceCloses[];
  options: readonly RaceOptions[];
  postings: readonly RacePostings[];
  health: readonly RaceHealth[];
  // pit-wall as the backend: every decision's audit row, who holds a seat, who is watching, the rules, the latency
  audit: readonly RaceAudit[];
  seats: readonly RaceSeats[];
  rules: RaceRules | null;
  signoffs: readonly RaceSignoffs[];
  online: readonly RaceOnline[];
  latency: RaceLatency | null;
  /** this browser's seat, when it holds one */
  mySeat: RaceSeats | null;
  /** A person reviews an entry held back from the ERP: approved (the desk posts it) or rejected. */
  decidePosting: (args: { entryKey: string; status: string; by: string; at: string }) => Promise<void>;
  /** A person decides an action that waits for them (approved | rejected | done | cancelled). */
  decideAction: (args: { actionKey: string; status: string; by: string; at: string }) => Promise<void>;
  /** A person answers a question: answerJson is {"option": id} or {"option": "neither", "band": [lo, mid, hi], "note": ...}. */
  answer: (args: { questionKey: string; answerJson: string; by: string; at: string }) => Promise<void>;
  /** A person picks one of a decision's priced options (the desk never picks). */
  chooseOption: (args: { actionKey: string; option: string; by: string; at: string }) => Promise<void>;
  /** A person approves the sealed weekend so its briefs may go out. */
  approveClose: (args: { closeKey: string; by: string; at: string }) => Promise<void>;
  /** Calls the correct_race_effect reducer; rejects with the module's refusal when not permitted. */
  correct: (args: CorrectArgs) => Promise<void>;
  /** Calls confirm_race_effect: the band stands as booked, the precedent records that a person checked it. */
  confirm: (args: ConfirmArgs) => Promise<void>;
}

const Ctx = createContext<RaceData>({
  connected: false,
  identityHex: null,
  events: [],
  cars: [],
  effects: [],
  forecasts: [],
  policies: [],
  precedents: [],
  correct: () => Promise.reject(new Error('not connected to pit-wall')),
  confirm: () => Promise.reject(new Error('not connected to pit-wall')),
  incidents: [],
  beliefs: [],
  actions: [],
  entries: [],
  entryLines: [],
  questions: [],
  sims: [],
  closes: [],
  options: [],
  postings: [],
  health: [],
  audit: [],
  seats: [],
  rules: null,
  signoffs: [],
  online: [],
  latency: null,
  mySeat: null,
  decidePosting: () => Promise.reject(new Error('not connected to pit-wall')),
  decideAction: () => Promise.reject(new Error('not connected to pit-wall')),
  chooseOption: () => Promise.reject(new Error('not connected to pit-wall')),
  answer: () => Promise.reject(new Error('not connected to pit-wall')),
  approveClose: () => Promise.reject(new Error('not connected to pit-wall')),
});

export function RaceBridge({ children }: { children: ReactNode }) {
  const conn = useSpacetimeDB();
  const [events] = useTable(tables.raceEvents);
  const [cars] = useTable(tables.carState);
  const [rawEffects] = useTable(tables.raceEffects);
  const [forecasts] = useTable(tables.raceForecasts);
  const [policies] = useTable(tables.racePolicies);
  const [precedents] = useTable(tables.racePrecedents);
  // A corrected line carries the band the person booked (its latest race_precedents row), so totals follow the
  // correction instead of losing the line.
  const effects = useMemo(() => {
    const latest = new Map<string, RacePrecedents>();
    for (const p of precedents) {
      const cur = latest.get(p.effectKey);
      if (!cur || p.at > cur.at) latest.set(p.effectKey, p);
    }
    return rawEffects.map((e) => {
      const p = e.status === 'corrected' ? latest.get(e.effectKey) : undefined;
      return p ? { ...e, lowCents: p.correctedLowCents, midCents: p.correctedMidCents, highCents: p.correctedHighCents } : e;
    });
  }, [rawEffects, precedents]);
  const [incidents] = useTable(tables.raceIncidents);
  const [beliefs] = useTable(tables.raceBeliefs);
  const [actions] = useTable(tables.raceActions);
  const [entries] = useTable(tables.raceEntries);
  const [entryLines] = useTable(tables.raceEntryLines);
  const [questions] = useTable(tables.raceQuestions);
  const [sims] = useTable(tables.raceSims);
  const [closes] = useTable(tables.raceCloses);
  const [options] = useTable(tables.raceOptions);
  const [postings] = useTable(tables.racePostings);
  const [health] = useTable(tables.raceHealth);
  const [audit] = useTable(tables.raceAudit);
  const [seats] = useTable(tables.raceSeats);
  const [rulesRows] = useTable(tables.raceRules);
  const [signoffs] = useTable(tables.raceSignoffs);
  const [online] = useTable(tables.raceOnline);
  const [latencyRows] = useTable(tables.raceLatency);
  const identityHex = conn.identity?.toHexString() ?? null;
  const getConnection = conn.getConnection;
  const rules = rulesRows[0] ?? null;
  const latency = latencyRows[0] ?? null;
  const mySeat = useMemo(() => seats.find((x) => x.who.toHexString() === identityHex) ?? null, [seats, identityHex]);

  // pit-wall commits a refusal as an audit row instead of throwing (so the attempt is on the record). After a decision,
  // read this browser's newest audit row for the same key and surface a refusal as the button's error.
  const auditRef = useRef(audit);
  auditRef.current = audit;
  const auditMark = useCallback(() => auditRef.current.reduce((m, a) => (a.auditId > m ? a.auditId : m), 0n), []);
  const refusalFor = useCallback(
    async (targetKey: string, since: bigint) => {
      for (let i = 0; i < 20; i++) {
        const mine = auditRef.current.filter((a) => a.who === identityHex && a.targetKey === targetKey && a.auditId > since);
        if (mine.length) {
          const last = mine.reduce((m, a) => (a.auditId > m.auditId ? a : m));
          if (!last.allowed) throw new Error(`pit-wall refused: ${last.reason}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    [identityHex]
  );

  const correct = useCallback(
    async (args: CorrectArgs) => {
      const c = getConnection() as DbConnection | null;
      if (!c) throw new Error('not connected to pit-wall');
      const since = auditMark();
      await c.reducers.correctRaceEffect(args);
      await refusalFor(args.effectKey, since);
    },
    [getConnection, refusalFor, auditMark]
  );

  const confirm = useCallback(
    async (args: ConfirmArgs) => {
      const c = getConnection() as DbConnection | null;
      if (!c) throw new Error('not connected to pit-wall');
      const since = auditMark();
      await c.reducers.confirmRaceEffect(args);
      await refusalFor(args.effectKey, since);
    },
    [getConnection, refusalFor, auditMark]
  );

  const withConn = useCallback(
    <A,>(fn: (c: DbConnection, args: A) => Promise<void>, keyOf: (args: A) => string) =>
      async (args: A) => {
        const c = getConnection() as DbConnection | null;
        if (!c) throw new Error('not connected to pit-wall');
        const since = auditMark();
        await fn(c, args);
        await refusalFor(keyOf(args), since);
      },
    [getConnection, refusalFor, auditMark]
  );
  const decideAction = useMemo(() => withConn((c, a: { actionKey: string; status: string; by: string; at: string }) => c.reducers.setRaceActionStatus(a), (a) => a.actionKey), [withConn]);
  const decidePosting = useMemo(() => withConn((c, a: { entryKey: string; status: string; by: string; at: string }) => c.reducers.decideRacePosting(a), (a) => a.entryKey), [withConn]);
  const chooseOption = useMemo(() => withConn((c, a: { actionKey: string; option: string; by: string; at: string }) => c.reducers.chooseRaceActionOption(a), (a) => a.actionKey), [withConn]);
  const answer = useMemo(() => withConn((c, a: { questionKey: string; answerJson: string; by: string; at: string }) => c.reducers.answerRaceQuestion(a), (a) => a.questionKey), [withConn]);
  const approveClose = useMemo(() => withConn((c, a: { closeKey: string; by: string; at: string }) => c.reducers.approveRaceClose(a), (a) => a.closeKey), [withConn]);

  const value = useMemo<RaceData>(
    () => ({
      connected: conn.isActive, identityHex, events, cars, effects, forecasts, policies, precedents, correct, confirm,
      incidents, beliefs, actions, entries, entryLines, questions, sims, closes, options, postings, health, decidePosting, decideAction, chooseOption, answer, approveClose,
      audit, seats, rules, signoffs, online, latency, mySeat,
    }),
    [conn.isActive, identityHex, events, cars, effects, forecasts, policies, precedents, correct, confirm,
      incidents, beliefs, actions, entries, entryLines, questions, sims, closes, options, postings, health, decidePosting, decideAction, chooseOption, answer, approveClose,
      audit, seats, rules, signoffs, online, latency, mySeat]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRace(): RaceData {
  return useContext(Ctx);
}

/** The same race data narrowed to one meeting (a race weekend), for pages that tell one weekend's story. Rows are
 *  matched by their event's meeting; incidents, sims and closes carry the meeting themselves. */
export function scopeToMeeting(race: RaceData, meeting: number | null): RaceData {
  if (meeting === null) return race;
  const events = race.events.filter((e) => e.meetingKey === meeting);
  const keys = new Set(events.map((e) => e.eventKey));
  const incidents = race.incidents.filter((i) => i.meetingKey === meeting);
  const incKeys = new Set(incidents.map((i) => i.incidentKey));
  // An entry with no incident (an FIA fine) belongs to the weekend its evidence events are from.
  const ofWeekend = (e: { incidentKey: string; evidenceJson: string }) =>
    incKeys.has(e.incidentKey) || (e.incidentKey === '' && [...keys].some((k) => e.evidenceJson.includes(k)));
  const entries = race.entries.filter(ofWeekend);
  const entryKeys = new Set(entries.map((e) => e.entryKey));
  const cars = new Set(events.map((e) => e.driverNumber));
  return {
    ...race,
    events,
    cars: race.cars.filter((c) => cars.has(c.driverNumber)),
    effects: race.effects.filter((e) => keys.has(e.eventKey)),
    forecasts: race.forecasts.filter((f) => keys.has(f.eventKey)),
    incidents,
    beliefs: race.beliefs.filter((b) => incKeys.has(b.incidentKey)),
    actions: race.actions.filter((a) => incKeys.has(a.incidentKey)),
    entries,
    entryLines: race.entryLines.filter((l) => entryKeys.has(l.entryKey)),
    questions: race.questions.filter((q) => incKeys.has(q.incidentKey)),
    sims: race.sims.filter((x) => x.meetingKey === meeting),
    closes: race.closes.filter((c) => c.meetingKey === meeting),
    options: race.options.filter((o) => o.meetingKey === meeting),
    postings: race.postings.filter((p) => entryKeys.has(p.entryKey)),
  };
}

/** The latest weekend the desk wrote to: the meeting of the most recently ingested event. */
export function latestMeeting(race: Pick<RaceData, 'events'>): number | null {
  let best: { at: string; m: number } | null = null;
  for (const e of race.events) if (!best || e.ingestedAt > best.at) best = { at: e.ingestedAt, m: e.meetingKey };
  return best ? best.m : null;
}

export function RaceScope({ meeting, children }: { meeting: number | null; children: ReactNode }) {
  const race = useRace();
  const scoped = useMemo(() => scopeToMeeting(race, meeting), [race, meeting]);
  return <Ctx.Provider value={scoped}>{children}</Ctx.Provider>;
}
