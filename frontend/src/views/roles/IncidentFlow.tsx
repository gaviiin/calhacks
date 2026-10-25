import { useContext, useMemo, type ReactNode } from 'react';
import { IconApproved, IconPerson } from '../../components/icons';
import { usdShort } from '../../lib/format';
import { useRace, type RaceData } from '../../lib/race';
import { sortTime } from '../../lib/raceModel';
import type { RaceIncidents } from '../../module_bindings/types';
import { signedCents } from '../raceday/AccountPanel';
import { clock, parse, roleLabel } from '../raceday/shared';
import { FocusCtx } from './focus';
import { readBelief } from './incidentCondition';
import './flow.css';

// One incident, followed from the second the car stopped to what it does to the season. Two calls follow the crash:
// engineering's (repair, spare tub or withdraw) and the strategist's (what to do with the car on track). Execution
// follows the call, the books follow execution, and the season picture follows the books. Each step links to the
// view of the person who owns it; the desk takes no step that is a person's.

type StepState = 'done' | 'wait' | 'open' | 'none';
interface Step { id: string; label: string; tab: string; value: ReactNode; sub: ReactNode; state: StepState; title?: string }

const SESSION_SHORT: Record<number, string> = { 9627: 'Q', 9636: 'R', 11291: 'R', 9693: 'R' };
const CORROBORATION: Record<string, string> = { red_flag: 'red flag', safety_car: 'Safety Car', vsc: 'VSC', incident: 'race control', retirement_suspected: 'timing gap', retirement_confirmed: 'retirement', yellow_flag: 'yellow' };
const OPTION_WORD: Record<string, string> = { repair: 'Repair', spare_tub: 'Spare tub', withdraw: 'Withdraw' };
const DESK_ONLY = new Set(['garage_check', 'withdraw_car']);

// ------------------------------------------------------------------------------------------ which incident

/** The incident every view is following: the one picked, else the costliest on the books (ties: the hardest hit). */
export function useFocusIncident(): RaceIncidents | null {
  const race = useRace();
  const { incidentKey } = useContext(FocusCtx);
  return useMemo(() => {
    const picked = race.incidents.find((i) => i.incidentKey === incidentKey);
    if (picked) return picked;
    return mostMaterial(race);
  }, [race, incidentKey]);
}

function bookedOf(race: RaceData, key: string): number {
  const lines = race.entryLines;
  return race.entries.filter((e) => e.incidentKey === key).reduce((t, e) => t + Number(signedCents(e, lines.filter((l) => l.entryKey === e.entryKey))), 0);
}

function mostMaterial(race: RaceData): RaceIncidents | null {
  let best: { i: RaceIncidents; booked: number; kph: number } | null = null;
  for (const i of race.incidents) {
    const booked = bookedOf(race, i.incidentKey);
    const kph = readBelief(i.beliefJson).impact_kph ?? 0;
    if (!best || booked > best.booked || (booked === best.booked && kph > best.kph)) best = { i, booked, kph };
  }
  return best?.i ?? null;
}

// ------------------------------------------------------------------------------------------ the six steps

interface Evidence { kind: string; at: string; source: string }
interface WithdrawDetail { chosen?: string; chosen_by?: string; options?: unknown[] }
interface SimPayload { p_target?: number; target_position?: number; prize?: { delta_cents?: number } | string; cap?: { p_overspend?: number } | string }

const dueWord = (iso: string, day: string) => (iso.slice(0, 10) === day ? clock(iso).slice(0, 5) : new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const obj = <T,>(v: T | string | undefined): T | undefined => (typeof v === 'string' ? undefined : v);

export function flowSteps(race: RaceData, inc: RaceIncidents): Step[] {
  const b = readBelief(inc.beliefJson);
  const day = inc.firstSeenAt.slice(0, 10);
  const seenAt = sortTime(inc.firstSeenAt);
  const ev = parse<Evidence[]>(inc.evidenceJson, []);
  const confirm = ev.filter((e) => e.source !== 'car_data' && sortTime(e.at) >= seenAt).sort((x, y) => sortTime(x.at) - sortTime(y.at))[0];
  const fromTelemetry = ev.some((e) => e.source === 'car_data');
  const lead = confirm ? Math.round((sortTime(confirm.at) - seenAt) / 1000) : null;

  const actions = race.actions.filter((a) => a.incidentKey === inc.incidentKey);
  const withdraw = actions.find((a) => a.kind === 'withdraw_car' && a.status !== 'cancelled');
  const wd = withdraw ? parse<WithdrawDetail>(withdraw.detailJson, {}) : null;
  const question = race.questions.find((q) => q.incidentKey === inc.incidentKey && q.kind === 'damage' && q.status === 'open');

  // 1 seen
  const seen: Step = {
    id: 'seen', label: 'Seen', tab: 'garage', state: 'done',
    value: clock(inc.firstSeenAt),
    sub: [b.impact_kph ? `${b.impact_kph} km/h` : null, lead !== null && fromTelemetry ? `${lead} s before ${CORROBORATION[confirm!.kind] ?? confirm!.kind.replace(/_/g, ' ')}` : null].filter(Boolean).join(' · ') || 'race control',
    title: fromTelemetry ? 'First seen in the car’s telemetry, before race control or timing said anything' : 'First seen in race control or timing',
  };

  // 2 engineering's call: the garage's assessment, and when the car must start soon, the Team Principal's choice
  let damage: Step;
  if (wd?.chosen) damage = { id: 'damage', label: 'Engineering call', tab: 'garage', state: 'done', value: OPTION_WORD[wd.chosen] ?? wd.chosen, sub: wd.chosen_by ?? 'Team Principal' };
  else if (withdraw?.status === 'awaiting_approval') damage = { id: 'damage', label: 'Engineering call', tab: 'garage', state: 'wait', value: `${wd?.options?.length ?? 3} options`, sub: `Team Principal · by ${clock(withdraw.dueAt).slice(0, 5)}` };
  else if (b.assessed_as) damage = { id: 'damage', label: 'Engineering call', tab: 'garage', state: 'done', value: cap(b.assessed_as), sub: b.assessed_by ?? 'garage' };
  else if (question) damage = { id: 'damage', label: 'Engineering call', tab: 'garage', state: 'wait', value: 'Asked', sub: roleLabel(question.routeRole) };
  else {
    const top = Object.entries(b.severity ?? {}).sort((x, y) => y[1] - x[1])[0];
    damage = { id: 'damage', label: 'Engineering call', tab: 'garage', state: 'open', value: top ? cap(top[0]) : '—', sub: top ? `machine read ${pct(top[1])}` : 'no read yet' };
  }

  // the hardware: which parts this incident used up, and what of the car runs out before the season ends
  const parts = race.partLife.filter((r) => r.driverNumber === inc.driverNumber);
  let replaced = 0;
  let worn = 0;
  let taken = 0;
  for (const r of parts) {
    const xs = parse<{ at: string; kind: string; note: string; taken: number }[]>(r.stressJson, []);
    if (xs.some((x) => x.kind === 'replaced' && x.note.includes(inc.incidentKey))) replaced++;
    const near = xs.filter((x) => x.kind !== 'replaced' && Math.abs(sortTime(x.at) - seenAt) < 120_000);
    if (near.length) {
      worn++;
      taken += near.reduce((t, x) => t + x.taken, 0);
    }
  }
  const pen = parts.find((r) => /grid penalty/.test(r.capNote));
  const damaged = parts.filter((r) => r.status === 'damaged').length;
  const hardware: Step = {
    id: 'hardware', label: 'Hardware', tab: 'garage',
    state: damaged ? 'wait' : replaced || worn ? 'done' : 'open',
    value: replaced ? `${replaced} replaced` : damaged ? `${damaged} damaged` : worn ? `${worn} parts worn` : '—',
    sub: pen ? `${pen.part === 'power_unit' ? 'PU' : pen.part} penalty ${pen.dueEvent.replace(/ Grand Prix$/, '')}` : worn ? `−${taken.toFixed(taken < 10 ? 1 : 0)}% life` : 'no part hit',
    title: 'Parts the incident used up (Jev classifies how hard it hit each one), and any part that now runs out before the season ends',
  };

  // 3 the strategist's call: priced options for the car after the incident (none if the car is out)
  const out = !!b.dns || !!b.out_of_session || b.assessed_as === 'heavy' || ev.some((e) => e.kind.startsWith('retirement')) || /did not start|never ran again|retir/i.test(inc.cause);
  const sets = race.options.filter((o) => o.driverNumber === inc.driverNumber && o.sessionKey === inc.sessionKey && sortTime(o.at) >= seenAt);
  const isQ = SESSION_SHORT[inc.sessionKey] === 'Q';
  const raceCall: Step = isQ
    ? { id: 'race', label: 'Race call', tab: 'strategy', state: 'none', value: '—', sub: b.dns ? 'car did not start' : 'qualifying' }
    : out && !sets.length
      ? { id: 'race', label: 'Race call', tab: 'strategy', state: 'none', value: 'Car out', sub: 'no race call' }
      : { id: 'race', label: 'Race call', tab: 'strategy', state: sets.length ? 'done' : 'open', value: sets.length ? `${sets.length} sets` : '—', sub: sets.length ? `priced from L${Math.min(...sets.map((s) => s.lap))} · no pick` : 'waiting for a lap' };

  // 4 execution: what follows the calls
  const next = actions.filter((a) => !DESK_ONLY.has(a.kind) && a.status !== 'cancelled');
  const waiting = next.filter((a) => a.status === 'awaiting_approval');
  const due = waiting.map((a) => a.dueAt).filter(Boolean).sort()[0];
  const steps: Step = {
    id: 'next', label: 'Next steps', tab: 'garage', state: !next.length ? 'open' : waiting.length ? 'wait' : 'done',
    value: next.length ? `${next.length - waiting.length}/${next.length}` : '—',
    sub: waiting.length ? `${waiting.length} wait${due ? ` · first by ${dueWord(due, day)}` : ''}` : next.length ? 'all under way' : 'none yet',
    title: 'Under way out of all next steps; the rest wait for the person who owns them',
  };

  // 5 the books
  const entries = race.entries.filter((e) => e.incidentKey === inc.incidentKey);
  const posting = new Map(race.postings.map((p) => [p.entryKey, p]));
  const booked = bookedOf(race, inc.incidentKey);
  const held = entries.filter((e) => posting.get(e.entryKey)?.status === 'held').length;
  const posted = entries.filter((e) => posting.get(e.entryKey)?.status === 'posted').length;
  const books: Step = {
    id: 'books', label: 'Books', tab: 'accounting', state: !entries.length ? 'open' : held ? 'wait' : 'done',
    value: entries.length ? usdShort(booked) : '—',
    sub: entries.length ? `${posted} posted · ${held} held` : 'nothing booked',
  };

  // 6 the season: the latest season run this incident (or an answer about it) triggered, against the run before it
  const runs = race.sims.filter((s) => !s.trigger.startsWith('trueup:')).sort((x, y) => sortTime(x.at) - sortTime(y.at) || x.trigger.localeCompare(y.trigger));
  const mine = runs.filter((s) => s.trigger.includes(inc.incidentKey));
  const firstIdx = mine.length ? runs.indexOf(mine[0]) : -1;
  const before = firstIdx > 0 ? parse<SimPayload>(runs[firstIdx - 1].payloadJson, {}) : null;
  const after = mine.length ? parse<SimPayload>(mine[mine.length - 1].payloadJson, {}) : null;
  let season: Step = { id: 'season', label: 'Season', tab: 'cfo', state: 'open', value: '—', sub: 'not run yet' };
  if (after?.p_target !== undefined) {
    const d = before?.p_target !== undefined ? after.p_target - before.p_target : 0;
    const prize = obj(after.prize)?.delta_cents ?? 0;
    const prizeBefore = obj(before?.prize)?.delta_cents ?? 0;
    const capOver = obj(after.cap)?.p_overspend;
    season = {
      id: 'season', label: 'Season', tab: 'cfo', state: 'done',
      value: (
        <>
          P{after.target_position ?? 8} {pct(after.p_target)}
          {Math.abs(d) >= 0.005 ? <small className={d < 0 ? 'fl-down' : 'fl-up'}>{d < 0 ? '▼' : '▲'}{Math.round(Math.abs(d) * 100)}</small> : null}
        </>
      ),
      sub: [Math.abs(prize - prizeBefore) >= 5e6 ? `prize ${prize - prizeBefore < 0 ? '−' : '+'}${usdShort(Math.abs(prize - prizeBefore))}` : 'prize unchanged', capOver !== undefined ? `cap over ${pct(capOver)}` : null].filter(Boolean).join(' · '),
      title: `Chance of P${after.target_position ?? 8} or better in the constructors’ championship, from the season run before this incident to the latest run it triggered`,
    };
  }
  return [seen, hardware, damage, raceCall, steps, books, season];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------------------------------ the strip

function incidentChip(i: RaceIncidents): string {
  const b = readBelief(i.beliefJson);
  const s = SESSION_SHORT[i.sessionKey] ?? 'S';
  return `#${i.driverNumber} ${s}${b.lap && s === 'R' ? ` L${b.lap}` : ''}`;
}

const NODE: Record<StepState, ReactNode> = {
  done: <IconApproved size={12} />,
  wait: <IconPerson size={12} />,
  open: null,
  none: null,
};

export function IncidentFlow({ tab, go }: { tab: string; go: (tab: string, anchor?: string) => void }) {
  const race = useRace();
  const focus = useFocusIncident();
  const { setIncidentKey } = useContext(FocusCtx);
  const incidents = useMemo(() => [...race.incidents].sort((a, b) => sortTime(a.firstSeenAt) - sortTime(b.firstSeenAt)), [race.incidents]);
  const steps = useMemo(() => (focus ? flowSteps(race, focus) : []), [race, focus]);
  if (!focus) return null;
  const b = readBelief(focus.beliefJson);
  return (
    <section className="fl" aria-label="The incident, step by step">
      <div className="fl-pick" role="radiogroup" aria-label="Incident">
        {incidents.map((i) => {
          const on = i.incidentKey === focus.incidentKey;
          const kph = readBelief(i.beliefJson).impact_kph;
          return (
            <button key={i.incidentKey} type="button" role="radio" aria-checked={on} className={`fl-chip ${on ? 'fl-chip--on' : ''}`}
                    onClick={() => setIncidentKey(i.incidentKey)} title={`${i.cause || i.status} (${clock(i.firstSeenAt)} UTC)`}>
              <b>{incidentChip(i)}</b>
              {kph ? <span>{kph}</span> : null}
            </button>
          );
        })}
      </div>
      <ol className="fl-steps">
        {steps.map((s, n) => (
          <li key={s.id} className={`fl-step fl-step--${s.state} ${s.tab === tab ? 'fl-step--here' : ''}`}>
            <a href={`#/day/${s.tab}`} onClick={(e) => (e.preventDefault(), go(s.tab, s.id === 'next' ? 'next-steps' : undefined))} title={s.title}>
              <span className="fl-node" aria-hidden>{NODE[s.state] ?? n + 1}</span>
              <span className="fl-label">{s.label}</span>
              <span className="fl-value">{s.value}</span>
              <span className="fl-sub">{s.sub}</span>
              <span className="fl-sr">{s.state === 'wait' ? ' (waiting for a person)' : s.state === 'none' ? ' (does not apply)' : ''}</span>
            </a>
          </li>
        ))}
      </ol>
      <span className="fl-sr">Following car {focus.driverNumber}{b.impact_kph ? `, ${b.impact_kph} km/h` : ''}.</span>
    </section>
  );
}
