import { useRace } from '../../lib/race';

// CFO view: STUB, built in parallel. Reads the scoped weekend through useRace().

export function CFOView() {
  const race = useRace();
  return <p className="muted">CFO view: {race.events.length} events this weekend.</p>;
}
