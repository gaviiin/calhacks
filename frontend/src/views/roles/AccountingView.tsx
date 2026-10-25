import { useRace } from '../../lib/race';

// Accounting view: STUB, built in parallel. Reads the scoped weekend through useRace().

export function AccountingView() {
  const race = useRace();
  return <p className="muted">Accounting view: {race.events.length} events this weekend.</p>;
}
