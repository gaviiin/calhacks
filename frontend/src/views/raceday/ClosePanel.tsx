import { useRace, type RaceData } from '../../lib/race';
import { ActButton, parse, roleLabel, type Headline } from './shared';

// Stage 7, close: the sealed weekend, its root hash, and one brief per role. The CFO approves before anything goes out.

export function closeHeadline(race: RaceData): Headline {
  const c = race.closes[0];
  if (!c) return { value: 'open', note: 'seals when the weekend ends', tone: 'muted' };
  return { value: c.status, note: `root ${c.rootHash.slice(0, 10)}… · ${c.leaves} rows`, tone: c.status === 'draft' ? 'hold' : 'ok' };
}

export function ClosePanel() {
  const race = useRace();
  const c = race.closes[0];
  if (!c) return <p className="muted">Nothing sealed yet.</p>;
  const briefs = parse<Record<string, string>>(c.briefsJson, {});
  return (
    <div>
      <p className="mono small">root {c.rootHash}</p>
      {c.status === 'draft' && <ActButton label="Approve and send the briefs" primary run={(by, at) => race.approveClose({ closeKey: c.closeKey, by, at })} />}
      {Object.entries(briefs).map(([role, text]) => (
        <article key={role} className="brief">
          <h3>{roleLabel(role)}</h3>
          <pre className="brief-text">{text}</pre>
        </article>
      ))}
    </div>
  );
}
