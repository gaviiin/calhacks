import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables, type DbConnection } from '../module_bindings';
import type { CarState, RaceEffects, RaceEvents, RaceForecasts, RacePolicies, RacePrecedents } from '../module_bindings/types';

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

export interface RaceData {
  connected: boolean;
  identityHex: string | null;
  events: readonly RaceEvents[];
  cars: readonly CarState[];
  effects: readonly RaceEffects[];
  forecasts: readonly RaceForecasts[];
  policies: readonly RacePolicies[];
  precedents: readonly RacePrecedents[];
  /** Calls the correct_race_effect reducer; rejects with the module's refusal when not permitted. */
  correct: (args: CorrectArgs) => Promise<void>;
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
});

export function RaceBridge({ children }: { children: ReactNode }) {
  const conn = useSpacetimeDB();
  const [events] = useTable(tables.raceEvents);
  const [cars] = useTable(tables.carState);
  const [effects] = useTable(tables.raceEffects);
  const [forecasts] = useTable(tables.raceForecasts);
  const [policies] = useTable(tables.racePolicies);
  const [precedents] = useTable(tables.racePrecedents);
  const identityHex = conn.identity?.toHexString() ?? null;
  const getConnection = conn.getConnection;

  const correct = useCallback(
    async (args: CorrectArgs) => {
      const c = getConnection() as DbConnection | null;
      if (!c) throw new Error('not connected to pit-wall');
      await c.reducers.correctRaceEffect(args);
    },
    [getConnection]
  );

  const value = useMemo<RaceData>(
    () => ({ connected: conn.isActive, identityHex, events, cars, effects, forecasts, policies, precedents, correct }),
    [conn.isActive, identityHex, events, cars, effects, forecasts, policies, precedents, correct]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRace(): RaceData {
  return useContext(Ctx);
}
