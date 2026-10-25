import { useMemo } from 'react';
import { useRace, type RaceData } from '../../lib/race';
import { parse, type Headline } from './shared';

// Stage 6, re-plan: the season and the cap re-run after every change in the evidence.

export function latestSim(race: Pick<RaceData, 'sims'>) {
  return race.sims.reduce<RaceData['sims'][number] | null>((b, s) => (!b || s.at > b.at || (s.at === b.at && s.simKey > b.simKey) ? s : b), null);
}

export function replanHeadline(race: RaceData): Headline {
  const s = latestSim(race);
  if (!s) return { value: '—', note: 'season not simulated yet', tone: 'muted' };
  const p = parse<Record<string, unknown>>(s.payloadJson, {});
  return { value: String(p.headline_value ?? '—'), note: String(p.headline ?? ''), tone: (p.tone as Headline['tone']) ?? '' };
}

export function ReplanPanel() {
  const race = useRace();
  const s = useMemo(() => latestSim(race), [race]);
  if (!s) return <p className="muted">The season runs as soon as the weekend starts.</p>;
  const p = parse<Record<string, unknown>>(s.payloadJson, {});
  return <pre className="mono small">{JSON.stringify(p, null, 1).slice(0, 2000)}</pre>;
}
