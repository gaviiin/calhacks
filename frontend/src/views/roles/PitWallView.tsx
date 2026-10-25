import { useRace } from '../../lib/race';

// PitWall view: STUB, built in parallel. Reads the scoped weekend through useRace().

export function PitWallView() {
  const race = useRace();
  return <p className="muted">PitWall view: {race.events.length} events this weekend.</p>;
}
