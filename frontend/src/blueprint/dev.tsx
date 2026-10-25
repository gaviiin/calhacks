import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { BlueprintStage, type StageCar } from './CarBlueprint';
import { templateCondition } from './condition';

// Development harness for the blueprint (blueprint-dev.html): the stage with two made-up cars, no
// SpacetimeDB. One car stopped after a heavy crash (the price book's template), one running clean.

const crashed = templateCondition('heavy', 'stopped', '2026-06-14T20:27:59Z');
crashed.label = 'Jev, 214 ms';
crashed.source = 'jev';
crashed.booked = { low: 96_000_000, mid: 142_000_000, high: 281_000_000, n: 1 };
crashed.tyre = { compound: 'SOFT', age: 0 };

const cars: StageCar[] = [
  { number: 23, code: 'ALB', team: 'Williams', position: 21, lap: 12, gap: '+39.347', lastPit: null, condition: crashed },
  {
    number: 55,
    code: 'SAI',
    team: 'Williams',
    position: 14,
    lap: 13,
    gap: '+54.197',
    lastPit: 2,
    condition: { source: 'none', label: 'No incident', at: null, severity: null, parts: {}, expected: null, booked: null, status: 'running', tyre: { compound: 'MEDIUM', age: 8 } },
  },
];

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main className="page">
      <BlueprintStage cars={cars} desk="Race desk · Williams" revision={15} />
    </main>
  </StrictMode>,
);
