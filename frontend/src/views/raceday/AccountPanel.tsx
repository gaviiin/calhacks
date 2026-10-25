import { useMemo } from 'react';
import { useRace, type RaceData } from '../../lib/race';
import { usdShort } from '../../lib/format';
import type { Headline } from './shared';

// Stage 4, account: balanced provisional entries, each saying when the cost cap counts it.

export function accountHeadline(race: RaceData): Headline {
  const relevant = race.entries.filter((e) => e.capRelevant).reduce((s, e) => s + e.amountCents, 0n);
  const all = race.entries.reduce((s, e) => s + e.amountCents, 0n);
  if (!race.entries.length) return { value: '$0', note: 'nothing booked', tone: 'muted' };
  return { value: usdShort(all), note: `${usdShort(relevant)} counts against the cap`, tone: 'hold' };
}

export function AccountPanel() {
  const race = useRace();
  const lines = useMemo(() => new Map(race.entries.map((e) => [e.entryKey, race.entryLines.filter((l) => l.entryKey === e.entryKey).sort((a, b) => a.lineNo - b.lineNo)])), [race.entries, race.entryLines]);
  return (
    <table className="entries">
      <thead>
        <tr>
          <th>Entry</th>
          <th>Counts against the cap</th>
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {race.entries.map((e) => (
          <tr key={e.entryKey}>
            <td>
              {e.memo}
              <div className="mono muted">{(lines.get(e.entryKey) ?? []).map((l) => `${l.debitCents > 0n ? 'Dr' : 'Cr'} ${l.account}`).join(' · ')}</div>
            </td>
            <td className="muted">{e.capRelevant ? e.recognition.replace(/_/g, ' ') : `no (${e.recognition.replace(/_/g, ' ')})`}</td>
            <td className="num mono">{usdShort(e.amountCents)}</td>
          </tr>
        ))}
        {!race.entries.length && (
          <tr>
            <td colSpan={3} className="muted">
              No entries yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
