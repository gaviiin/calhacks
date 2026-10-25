import { useMemo } from 'react';
import { COST_LABELS, type CostId } from '../../blueprint/catalog';
import { usdShort } from '../../lib/format';
import { useRace } from '../../lib/race';
import type { RacePartLife } from '../../module_bindings/types';
import { parse } from '../raceday/shared';
import { Figure, Meter, Panel, Pill, type Tone } from './kit';
import './life.css';

// The hardware: each part's life on each car, from the laps it ran, the stress events Jev classified and the crashes
// (race/life.py). Wear is never booked; it says when each replacement is due, which is when its cost counts against
// the cap, and when a power unit or gearbox past the season's allocation means a grid penalty.

interface Stress { at: string; lap?: number; kind: string; note: string; severity?: string; p?: number; taken: number; by?: string }

const STATUS: Record<string, { tone: Tone; rank: number }> = {
  damaged: { tone: 'bad', rank: 0 },
  due: { tone: 'bad', rank: 1 },
  watch: { tone: 'wait', rank: 2 },
  ok: { tone: 'info', rank: 3 },
  replaced: { tone: 'ok', rank: 4 },
};
const KIND: Record<string, string> = { off_track: 'off track', contact: 'contact', crash: 'crash', replaced: 'replaced' };
const short = (event: string) => event.replace(/ Grand Prix$/, '');
const label = (part: string) => COST_LABELS[part as CostId] ?? part.replace(/_/g, ' ');
const penalty = (r: RacePartLife) => /grid penalty/.test(r.capNote);

function dueWord(r: RacePartLife): string {
  if (r.status === 'damaged') return 'Damaged';
  if (r.status === 'replaced') return 'New';
  return r.dueEvent === '2025' ? 'Lasts 2024' : `Due ${short(r.dueEvent)}`;
}

function StressDots({ r }: { r: RacePartLife }) {
  const xs = parse<Stress[]>(r.stressJson, []).filter((s) => s.kind !== 'replaced');
  if (!xs.length) return <span className="pl-dots" />;
  return (
    <span
      className="pl-dots"
      title={xs.map((s) => `${s.lap ? `L${s.lap} ` : ''}${KIND[s.kind] ?? s.kind}: ${s.by ?? 'Jev'} read ${s.severity ?? '?'}${s.p ? ` (P ${s.p.toFixed(2)})` : ''}, −${s.taken}% life`).join('\n')}
    >
      {xs.slice(-6).map((s, i) => (
        <i key={`${s.at}-${i}`} className={`pl-dot pl-dot--${s.severity ?? 'none'}`} aria-hidden />
      ))}
      <span className="fl-sr">{xs.length} stress events</span>
    </span>
  );
}

/** One car's parts by how soon they need replacing; parts new after a crash fold into one line. */
export function PartLifePanel({ car }: { car: number }) {
  const race = useRace();
  const rows = useMemo(
    () => race.partLife.filter((r) => r.driverNumber === car).sort((a, b) => (STATUS[a.status]?.rank ?? 9) - (STATUS[b.status]?.rank ?? 9) || b.usedPct - a.usedPct),
    [race.partLife, car],
  );
  if (!rows.length) return null;
  const fresh = rows.filter((r) => r.status === 'replaced');
  const shown = rows.filter((r) => r.status !== 'replaced');
  const due = rows.filter((r) => r.status !== 'replaced' && r.status !== 'damaged' && r.dueEvent && r.dueEvent !== '2025').length;
  const pens = rows.filter(penalty);
  return (
    <section className="pl" aria-label={`Part life, car ${car}`}>
      <h3 className="pw-h" title="From the laps each part ran, the stress events Jev classified and the crashes. Wear is not booked: it sets when each replacement counts against the cap.">
        Part life
        <span className="pw-h-aside">
          {due} due this season{pens.length ? ` · ${pens.length} grid penalty` : ''}
        </span>
      </h3>
      <ul className="pl-rows">
        {shown.map((r) => {
          const st = STATUS[r.status] ?? STATUS.ok;
          return (
            <li key={r.partKey} className={`pl-row pl-row--${r.status}`} title={`${label(r.part)}: ${r.capNote}${r.remainingKm > 0 ? ` (${r.remainingKm.toLocaleString('en-US')} km left of ${r.lifeKm.toLocaleString('en-US')})` : ''}`}>
              <span className="pl-name">{label(r.part)}</span>
              <span className="pl-bar">
                <Meter value={Math.min(r.usedPct, 120)} max={120} limit={100} tone={st.tone} />
              </span>
              <span className="pl-pct">{Math.round(r.usedPct)}%</span>
              <span className="pl-due">
                <Pill tone={penalty(r) ? 'bad' : st.tone === 'info' ? 'neutral' : st.tone}>{penalty(r) ? `Penalty ${short(r.dueEvent)}` : dueWord(r)}</Pill>
              </span>
              <StressDots r={r} />
            </li>
          );
        })}
      </ul>
      {fresh.length ? (
        <p className="pl-new" title={fresh.map((r) => label(r.part)).join(', ')}>
          <Pill tone="ok">{fresh.length} new</Pill>
          <span>replaced after the crash · each counts against the 2024 cap when fitted</span>
        </p>
      ) : null}
    </section>
  );
}

/** The CFO's view of the hardware: what the cars' running and crashes bring into this year's cap. */
export function HardwarePanel() {
  const race = useRace();
  const h = useMemo(() => {
    const rows = race.partLife;
    const replaced = rows.filter((r) => r.status === 'replaced' || r.status === 'damaged');
    const due = rows.filter((r) => r.status !== 'replaced' && r.status !== 'damaged' && r.dueEvent && r.dueEvent !== '2025');
    return {
      rows,
      replaced,
      due,
      dueCents: due.reduce((t, r) => t + Number(r.costCents), 0),
      forward: rows.reduce((t, r) => t + Number(r.broughtForwardCents), 0),
      stress: new Set(rows.flatMap((r) => parse<Stress[]>(r.stressJson, []).filter((x) => x.kind !== 'replaced').map((x) => `${r.driverNumber}|${x.at}|${x.kind}`))).size,
      pens: rows.filter(penalty),
    };
  }, [race.partLife]);
  if (!h.rows.length) return null;
  return (
    <Panel title="Hardware" aside="from the cars' running" className="pl-cfo">
      <div className="pl-figs">
        <Figure label="Parts replaced" value={String(h.replaced.length)} sub="booked · count when fitted" />
        <Figure label="Due this season by wear" value={usdShort(h.dueCents)} sub={`${h.due.length} parts before Abu Dhabi`} />
        {h.forward > 0 ? (
          <Figure label="Brought into 2024" value={usdShort(h.forward)} sub="by this weekend's running" />
        ) : (
          <Figure label="Stress events" value={String(h.stress)} sub="classified by Jev, part by part" />
        )}
        <Figure label="Grid penalty risk" value={String(h.pens.length)} deltaTone={h.pens.length ? 'bad' : 'neutral'} delta={h.pens.length ? 'past allocation' : undefined} />
      </div>
      {h.pens.length ? (
        <ul className="pl-pens">
          {h.pens.map((r) => (
            <li key={r.partKey}>
              <Pill tone="bad">Car {r.driverNumber}</Pill>
              <span>
                {label(r.part)} runs out by the {short(r.dueEvent)}: a new one is past the season's allocation
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
