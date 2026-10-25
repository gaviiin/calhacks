import { useMemo, useRef } from 'react';
import { useRace } from '../lib/race';
import { DRIVERS, TEAM, isTeamCar } from '../lib/raceModel';
import { BlueprintStage, type StageCar } from './CarBlueprint';
import { liveCondition, type CarCondition } from './condition';

// The blueprint on the live race desk: the team's cars from car_state, each read through the effects and
// forecasts written about it. Readings are kept by value, so a new event that changes nothing about a
// car does not touch the drawing.

export function RaceBlueprint() {
  const race = useRace();
  const memo = useRef(new Map<number, { key: string; c: CarCondition }>());
  const cars = useMemo<StageCar[]>(() => {
    return race.cars
      .filter((c) => c.teamName === TEAM || isTeamCar(c.driverNumber))
      .sort((a, b) => a.driverNumber - b.driverNumber)
      .map((c) => {
        const fresh = liveCondition(c, race.effects, race.forecasts);
        const key = JSON.stringify(fresh);
        const prev = memo.current.get(c.driverNumber);
        const condition = prev && prev.key === key ? prev.c : fresh;
        memo.current.set(c.driverNumber, { key, c: condition });
        return {
          number: c.driverNumber,
          code: DRIVERS[c.driverNumber] ?? `#${c.driverNumber}`,
          team: c.teamName || TEAM,
          position: c.position || null,
          lap: c.lap || null,
          gap: c.gapToLeader || null,
          lastPit: c.lastPitLap || null,
          condition,
        };
      });
  }, [race.cars, race.effects, race.forecasts]);
  const lap = useMemo(() => race.cars.reduce((m, c) => Math.max(m, c.lap), 0) || null, [race.cars]);
  return <BlueprintStage cars={cars} desk={`Race desk · ${TEAM}`} revision={lap} />;
}
