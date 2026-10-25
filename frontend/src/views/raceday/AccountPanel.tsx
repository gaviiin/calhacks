import { useMemo, useState } from 'react';
import { useRace, type RaceData } from '../../lib/race';
import { sortTime } from '../../lib/raceModel';
import { usdShort } from '../../lib/format';
import type { Headline } from './shared';
import { incidentLabel } from './RespondPanel';
import './respond.css';

// Stage 4, account: balanced provisional entries, each saying in plain words when the cost cap counts it.
// A spare counts when it is fitted, labour and freight when incurred, an FIA fine never; the destroyed part was
// already counted when it was first used, so it is named in the memo and not booked twice.

type Entry = RaceData['entries'][number];
type Line = RaceData['entryLines'][number];

const ACCOUNT_NAME: Record<string, string> = {
  '6050': 'Crash damage repairs & race spares',
  '5200': 'Contract & agency staff',
  '6300': 'Freight & logistics',
  '6910': 'FIA fines & penalties',
  '1400': 'Inventory: race spares',
  '2100': 'Accrued liabilities: race costs',
};

export const RECOGNITION_WORDS: Record<string, string> = {
  first_use: 'counts when fitted',
  incurred: 'counts as incurred',
  excluded: 'outside the cap: FIA fine',
  already_expensed: 'already counted when first used',
};

const isExpense = (account: string) => /^[5-9]/.test(account);

/** Entries are positive; a reversal debits the balance-sheet side. Signed so a downward revision subtracts. */
export function signedCents(e: Entry, lines: readonly Line[] | undefined): bigint {
  const first = lines?.find((l) => l.debitCents > 0n);
  const reversal = first ? !isExpense(first.account) : /reversal/i.test(e.memo);
  return reversal ? -e.amountCents : e.amountCents;
}

function linesByEntry(race: RaceData): Map<string, Line[]> {
  const m = new Map<string, Line[]>();
  for (const l of race.entryLines) {
    const list = m.get(l.entryKey) ?? [];
    list.push(l);
    m.set(l.entryKey, list);
  }
  for (const list of m.values()) list.sort((a, b) => a.lineNo - b.lineNo);
  return m;
}

function totals(entries: readonly Entry[], lines: Map<string, Line[]>) {
  let relevant = 0n;
  let excluded = 0n;
  for (const e of entries) {
    const v = signedCents(e, lines.get(e.entryKey));
    if (e.capRelevant) relevant += v;
    else excluded += v;
  }
  return { relevant, excluded };
}

export function accountHeadline(race: RaceData): Headline {
  if (!race.entries.length) return { value: '$0', note: 'nothing booked', tone: 'muted' };
  const { relevant, excluded } = totals(race.entries, linesByEntry(race));
  return { value: usdShort(relevant + excluded), note: `${usdShort(relevant)} counts against the cap`, tone: 'hold' };
}

const firstSentence = (memo: string) => {
  const m = /^(.*?[.:])\s/.exec(memo);
  return m ? m[1]! : memo;
};

function EntryRow({ e, lines }: { e: Entry; lines: Line[] | undefined }) {
  const [open, setOpen] = useState(false);
  const signed = signedCents(e, lines);
  const destroyed = /expensed when first used/i.test(e.memo);
  const waits = /waits for a person/i.test(e.memo);
  return (
    <li className="rd-entry">
      <div className="rd-entry-top">
        <span className="rd-entry-memo">{firstSentence(e.memo.split(' - counts')[0] ?? e.memo)}</span>
        <span className={`rd-chip ${e.capRelevant ? 'rd-chip--hold' : 'rd-chip--off'}`}>{RECOGNITION_WORDS[e.recognition] ?? e.recognition.replace(/_/g, ' ')}</span>
        {waits && <span className="rd-chip rd-chip--hold">waits for a person</span>}
        <span className="mono rd-entry-amount">{signed < 0n ? `${usdShort(signed)} reversal` : usdShort(signed)}</span>
      </div>
      {destroyed && <p className="muted rd-entry-note">The destroyed part: already counted when first used, not booked again.</p>}
      <button type="button" className="rd-link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide lines' : 'Dr / Cr lines'}
      </button>
      {open && (
        <table className="entries rd-lines">
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Dr</th>
              <th className="num">Cr</th>
            </tr>
          </thead>
          <tbody>
            {(lines ?? []).map((l) => (
              <tr key={l.lineKey}>
                <td>
                  <span className="mono">{l.account}</span> {ACCOUNT_NAME[l.account] ?? ''}
                  {l.memo && <div className="muted">{l.memo}</div>}
                </td>
                <td className="num mono">{l.debitCents > 0n ? usdShort(l.debitCents) : ''}</td>
                <td className="num mono">{l.creditCents > 0n ? usdShort(l.creditCents) : ''}</td>
              </tr>
            ))}
            {!lines?.length && (
              <tr>
                <td colSpan={3} className="muted">
                  Lines not loaded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {open && <p className="muted rd-entry-full">{e.memo}</p>}
    </li>
  );
}

export function AccountPanel() {
  const race = useRace();
  const lines = useMemo(() => linesByEntry(race), [race]);
  const groups = useMemo(() => {
    const incidents = new Map(race.incidents.map((i) => [i.incidentKey, i]));
    const by = new Map<string, Entry[]>();
    for (const e of race.entries) {
      const list = by.get(e.incidentKey) ?? [];
      list.push(e);
      by.set(e.incidentKey, list);
    }
    return [...by.entries()]
      .map(([key, list]) => ({ key, incident: incidents.get(key), entries: list.sort((a, b) => sortTime(a.at) - sortTime(b.at) || a.entryKey.localeCompare(b.entryKey)) }))
      .sort((a, b) => sortTime(a.incident?.firstSeenAt ?? '') - sortTime(b.incident?.firstSeenAt ?? '') || a.key.localeCompare(b.key));
  }, [race.entries, race.incidents]);

  if (!race.entries.length) return <p className="muted">No entries yet.</p>;
  const all = totals(race.entries, lines);
  return (
    <div className="rd">
      <dl className="rd-account-totals">
        <div>
          <dt>Counts against the cap</dt>
          <dd className="mono">{usdShort(all.relevant)}</dd>
        </div>
        <div>
          <dt>Outside the cap</dt>
          <dd className="mono">{usdShort(all.excluded)}</dd>
        </div>
        <div>
          <dt>Entries</dt>
          <dd className="mono">{race.entries.length} proposed</dd>
        </div>
      </dl>
      <p className="muted rd-legend">
        A spare counts when it is fitted; a new part, labour and freight count as incurred; an FIA fine is outside the cap; the part the crash destroyed was already counted when it was first used.
      </p>
      {groups.map((g) => {
        const t = totals(g.entries, lines);
        return (
          <details key={g.key} className="rd-group" open>
            <summary>
              <span className="rd-group-name">{g.key ? incidentLabel(g.incident, g.key) : 'Not tied to an incident'}</span>
              <span className="mono muted">
                {usdShort(t.relevant)} in the cap{t.excluded ? ` · ${usdShort(t.excluded)} outside` : ''}
              </span>
            </summary>
            <ul className="rd-entries">
              {g.entries.map((e) => (
                <EntryRow key={e.entryKey} e={e} lines={lines.get(e.entryKey)} />
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
