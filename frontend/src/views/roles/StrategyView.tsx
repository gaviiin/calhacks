import { useRace } from '../../lib/race';

// Strategy view: STUB, built in parallel. Reads the scoped weekend through useRace().

export function StrategyView() {
  const race = useRace();
  return <p className="muted">Strategy view: {race.events.length} events this weekend.</p>;
}
