import { useMemo, useState, type ReactNode } from 'react';
import { IconApproved, IconBolt, IconExternal } from '../../components/icons';
import { usdShort } from '../../lib/format';
import { RaceScope, latestMeeting, useRace, type RaceData } from '../../lib/race';
import { sortTime } from '../../lib/raceModel';
import { ActButton, parse } from '../raceday/shared';
import { useDesk, type Desk, type DeskCar, type PlanView } from './model';
import { HeldRow } from './panels';
import { SideSheet, type SheetTarget } from './Sheet';
import { ReplayStage } from './CrashReplay';
import './desk.css';
import './present.css';

// The home screen, built for a two-minute presentation. Anneal is the hardware module: the agents keep each part of
// the car as an asset and follow what happens to it into every other ledger. So the page is one crash at a time: the
// car, what the crash did to the hardware in five lines (repairs, books, labour, performance, the cost cap), and the
// one call the operator makes. Everything else (the instruments, the role views, the books, the audit) is a click away.

type Inc = RaceData['incidents'][number];

interface Belief {
  impact_kph?: number;
  lap?: number;
  assessed_as?: string;
  severity?: Record<string, number>;
}

export function PresentView({ nav }: { nav: (h: string) => void }) {
  const all = useRace();
  const meeting = useMemo(() => latestMeeting(all), [all]);
  return (
    <RaceScope meeting={meeting}>
      <Present nav={nav} />
    </RaceScope>
  );
}

function Present({ nav }: { nav: (h: string) => void }) {
  const desk = useDesk();
  const race = desk.race;
  const incidents = useMemo(() => race.incidents.slice().sort((a, b) => sortTime(a.firstSeenAt) - sortTime(b.firstSeenAt)), [race.incidents]);
  const [pick, setPick] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);

  // the crash on screen: the one picked, else the latest whose plan waits, else the latest
  const waiting = incidents.filter((i) => desk.plans.some((p) => p.plan.incidentKey === i.incidentKey && p.plan.status === 'draft'));
  const inc = incidents.find((i) => i.incidentKey === pick) ?? waiting[waiting.length - 1] ?? incidents[incidents.length - 1] ?? null;
  const car = (inc && desk.cars.find((c) => c.number === inc.driverNumber)) ?? desk.cars[0] ?? null;

  if (!car) {
    return (
      <div className="pv pv--empty">
        <section className="glass pv-wait">
          <h1>{race.connected ? 'No race loaded yet' : 'Connecting to pit-wall'}</h1>
          <p>Press Replay São Paulo to watch the weekend happen, or Lap 32 to start a few minutes after the last crash.</p>
        </section>
      </div>
    );
  }
  return (
    <div className="pv">
      <div className="pv-top">
        <Crashes incidents={incidents} desk={desk} on={inc?.incidentKey ?? null} pick={setPick} />
        <Weekend desk={desk} nav={nav} />
      </div>
      <div className="pv-grid">
        <ReplayStage race={race} inc={inc} car={car} />
        <aside className="pv-side">
          {inc ? <Story desk={desk} inc={inc} car={car} /> : <NoCrash car={car} />}
          {inc ? <Call desk={desk} inc={inc} openPlan={(k) => setSheet({ kind: 'plan', id: k })} /> : null}
        </aside>
      </div>
      {sheet ? <SideSheet target={sheet} desk={desk} close={() => setSheet(null)} go={(tab) => nav(`/day/${tab}`)} open={setSheet} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ the crashes

function Crashes({ incidents, desk, on, pick }: { incidents: Inc[]; desk: Desk; on: string | null; pick: (k: string) => void }) {
  if (!incidents.length) return <div className="pv-crashes" />;
  return (
    <nav className="pv-crashes" aria-label="Crashes this weekend">
      {incidents.map((i) => {
        const b = parse<Belief>(i.beliefJson, {});
        const car = desk.cars.find((c) => c.number === i.driverNumber);
        const plan = desk.plans.find((p) => p.plan.incidentKey === i.incidentKey);
        const waits = plan?.plan.status === 'draft';
        const sev = b.assessed_as ?? topSeverity(b);
        return (
          <button key={i.incidentKey} type="button" className={`pv-crash ${i.incidentKey === on ? 'is-on' : ''}`} onClick={() => pick(i.incidentKey)} aria-pressed={i.incidentKey === on}>
            <span className="pv-crash-num">{i.driverNumber}</span>
            <span className="pv-crash-what">
              <b>
                {car?.name?.split(' ').slice(-1)[0] ?? car?.code ?? `Car ${i.driverNumber}`} · {i.sessionKey === 9627 ? 'Qualifying' : `Race, lap ${b.lap ?? '?'}`}
              </b>
              <span>
                {b.impact_kph ? `${b.impact_kph} km/h` : 'stopped'}
                {sev ? ` · ${sev}` : ''}
              </span>
            </span>
            {waits ? <span className="pv-crash-dot" title="Its plan waits for you" aria-label="waits for you" /> : null}
          </button>
        );
      })}
    </nav>
  );
}

function topSeverity(b: Belief): string | null {
  const top = b.severity ? Object.entries(b.severity).sort((x, y) => y[1] - x[1])[0] : null;
  return top ? top[0] : null;
}

// ------------------------------------------------------------------------------------------ what the crash did to the hardware

const n = (x: bigint | number) => Number(x);

function incidentBooks(race: RaceData, key: string) {
  const ents = race.entries.filter((e) => e.incidentKey === key);
  const keys = new Set(ents.map((e) => e.entryKey));
  const lines = race.entryLines.filter((l) => keys.has(l.entryKey));
  const net = (acct: string) => lines.filter((l) => l.account === acct).reduce((t, l) => t + n(l.debitCents) - n(l.creditCents), 0);
  const posts = race.postings.filter((p) => keys.has(p.entryKey));
  return {
    entries: ents.length,
    parts: net('6050'),
    labour: net('5200'),
    freight: net('6300'),
    posted: posts.filter((p) => p.status === 'posted'),
    held: posts.filter((p) => p.status === 'held').length,
  };
}

function Story({ desk, inc, car }: { desk: Desk; inc: Inc; car: DeskCar }) {
  const race = desk.race;
  const b = parse<Belief>(inc.beliefJson, {});
  const books = incidentBooks(race, inc.incidentKey);
  const parts = desk.parts.filter((p) => p.car === car.number);
  const hit = parts.filter((p) => p.lifeStatus === 'replaced' || p.lifeStatus === 'damaged' || p.health === 'damaged');
  const s = car.spares;
  const acts = race.actions.filter((a) => a.incidentKey === inc.incidentKey);
  const orders = acts.filter((a) => a.kind === 'work_order').length;
  const penalty = parts.find((p) => p.penalty);
  const pz = desk.finance.prize;
  const cap = desk.finance.cap;
  const spareWords = [s.track ? `${s.track} at the track` : null, s.factory ? `${s.factory} from Grove` : null, s.make ? `${s.make} to make` : null].filter(Boolean).join(', ');

  return (
    <section className="glass pv-story" aria-label="What the crash did to the hardware">
      <header className="pv-story-head">
        <IconBolt size={14} />
        <h2>
          What the crash did to car {car.number}
          <span>{b.impact_kph ? `${b.impact_kph} km/h into the barrier` : 'the car stopped'}</span>
        </h2>
      </header>
      <ol className="pv-rows">
        <Row k="Repairs" v={hit.length ? `${hit.length} parts` : 'none yet'} line={hit.length ? [spareWords, orders ? `${orders} work orders at Grove` : null].filter(Boolean).join(' · ') : 'The garage has not confirmed damage yet'} />
        <Row k="Books" v={books.entries ? usdShort(books.parts + books.freight) : '—'} line={books.entries ? `Parts and freight, accrued · ${books.posted.length ? `${books.posted.length} of ${books.entries} entries in the ERP` : 'waiting for the plan'}` : 'No entries yet'} />
        <Row k="Labour" v={books.labour ? usdShort(books.labour) : '—'} line="Crew overtime on the rebuild" />
        <Row
          k="Performance"
          v={penalty ? 'Grid penalty' : pz ? `P${pz.target} ${pct(pz.pTarget)}` : '—'}
          tone={penalty ? 'bad' : undefined}
          line={[penalty ? `${penalty.short} past its allocation` : null, pz ? `P${pz.target} odds ${pct(pz.pTarget)}, from ${pz.baseline !== null ? pct(pz.baseline) : '—'}` : null].filter(Boolean).join(' · ') || 'The season runs with the first event'}
        />
        <Row k="Cost cap" v={cap ? pct(cap.pOver) : '—'} tone={cap && cap.pOver >= 0.5 ? 'bad' : undefined} line={cap ? `Chance of a ${cap.year} overspend · each part counts when fitted` : 'The cap forecast runs with the season'} />
      </ol>
    </section>
  );
}

function NoCrash({ car }: { car: DeskCar }) {
  return (
    <section className="glass pv-story">
      <header className="pv-story-head">
        <h2>
          Car {car.number}, running
          <span>Every lap uses life; the module keeps each part's books current.</span>
        </h2>
      </header>
    </section>
  );
}

function Row({ k, v, line, tone }: { k: string; v: ReactNode; line: string; tone?: 'bad' }) {
  return (
    <li className="pv-row">
      <span className="pv-row-k">{k}</span>
      <span className={`pv-row-v mono ${tone ? `pv-row-v--${tone}` : ''}`}>{v}</span>
      <span className="pv-row-line">{line}</span>
    </li>
  );
}

const pct = (x: number) => (x < 0.0005 ? '0%' : x > 0.9995 ? '100%' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);

// ------------------------------------------------------------------------------------------ the one call

function Call({ desk, inc, openPlan }: { desk: Desk; inc: Inc; openPlan: (planKey: string) => void }) {
  const race = useRace();
  const plan: PlanView | undefined = desk.plans.find((p) => p.plan.incidentKey === inc.incidentKey);
  const held = desk.held.filter((g) => g.rows.some((r) => r.incidentKey === inc.incidentKey));
  const books = incidentBooks(race, inc.incidentKey);
  const edits = race.planEdits.filter((e) => e.incidentKey === inc.incidentKey).sort((a, b) => a.editKey.localeCompare(b.editKey, 'en', { numeric: true }));
  const lastEdit = edits[edits.length - 1] ?? null;
  const see = plan ? (
    <button type="button" className="btn pv-see" onClick={() => openPlan(plan.plan.planKey)}>
      Open the plan
    </button>
  ) : null;

  if (plan && plan.plan.status === 'draft') {
    return (
      <section className="glass pv-call pv-call--wait" aria-label="Your call">
        <h2>Your call</h2>
        <p>
          {plan.operations} operations and {plan.entries} entries.{' '}
          {plan.plan.novel ? (
            <>
              <b>{plan.plan.precedented} match what the team has done before</b> and run on their own; <b className="pv-novel">{plan.plan.novel} are new</b> and wait for you.
            </>
          ) : (
            <>
              <b>All match what the team has done before</b>: approve once and they run and post on their own.
            </>
          )}{' '}
          Open the plan to read every line or change it in your own words.
        </p>
        <div className="pv-call-act">
          <span className="pv-call-amt mono">{plan.amountCents ? usdShort(plan.amountCents) : ''}</span>
          {see}
          <ActButton label="Approve the plan" busyLabel="Approving…" primary run={(by, at) => race.approvePlan({ planKey: plan.plan.planKey, status: 'approved', by, at })} />
        </div>
      </section>
    );
  }
  if (plan && plan.plan.status === 'revising') {
    return (
      <section className="glass pv-call pv-call--wait" aria-label="Applying your edits">
        <h2>
          <span className="pv-spin" aria-hidden /> Applying your edits
        </h2>
        {lastEdit ? <q className="pv-said">{lastEdit.text}</q> : null}
        <p>The agent is changing the operations and rebuilding the plan against the team's history. Nothing in it posts until it has.</p>
        <div className="pv-call-act">{see}</div>
      </section>
    );
  }
  const changes = lastEdit ? parse<{ applied?: boolean }[]>(lastEdit.changesJson, []) : [];
  const done = changes.filter((c) => c.applied).length;
  const editNote =
    lastEdit && lastEdit.status !== 'pending' ? (
      <p className="pv-edit-note">
        Your edits: <b>{done} applied</b>
        {changes.length > done ? `, ${changes.length - done} not` : ''}, read by {lastEdit.model.startsWith('claude') ? 'Claude' : 'the rules'}. Open the plan to see each one.
      </p>
    ) : null;
  if (held.length) {
    return (
      <section className="glass pv-call pv-call--wait" aria-label="Your call">
        <h2>One more call</h2>
        <p>The plan is approved and everything it could book on its own is booked. {held.length === 1 ? 'This line waits' : 'These lines wait'} for you: {held[0]!.reasons[0] ?? 'it has no precedent'}.</p>
        {editNote}
        <ul className="dk-waits pv-held">
          {held.map((g) => (
            <HeldRow key={g.key} g={g} />
          ))}
        </ul>
        <div className="pv-call-act">{see}</div>
      </section>
    );
  }
  const last = books.posted.map((p) => p.erpEntryId).filter(Boolean).sort().slice(-1)[0];
  return (
    <section className="glass pv-call pv-call--done" aria-label="Done">
      <h2>
        <IconApproved size={14} /> {plan?.plan.status === 'rejected' ? 'Plan rejected' : books.posted.length ? 'Booked' : 'Nothing waits for you'}
      </h2>
      <p>
        {plan?.plan.status === 'approved' ? `Plan approved by ${plan.plan.approvedBy || 'you'}${edits.length ? ' with edits' : ''}. ` : ''}
        {books.posted.length ? `${books.posted.length} entries in the ERP${last ? `, last ${last}` : ''}.` : 'The module keeps watching the car.'}
      </p>
      {editNote}
      <div className="pv-call-act">{see}</div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------ the weekend

function Weekend({ desk, nav }: { desk: Desk; nav: (h: string) => void }) {
  const race = useRace();
  const close = race.closes.reduce<RaceData['closes'][number] | null>((b, c) => (!b || c.closedAt > b.closedAt ? c : b), null);
  const cost = desk.finance.cost;
  const auto = desk.trail.filter((t) => t.actor !== 'person').length;
  // once the weekend is closed, the figure is the sealed one, not the running estimate
  const sealed = close ? parse<{ race_cost?: { mid_cents?: number } }>(close.totalsJson, {}).race_cost?.mid_cents ?? null : null;
  return (
    <section className="pv-weekend" aria-label="The weekend">
      <div className="pv-weekend-fig">
        <span>{sealed !== null ? (close?.status === 'draft' ? 'The weekend, ready to seal' : 'The weekend, sealed') : 'The weekend so far'}</span>
        <b className="mono">{sealed !== null ? usdShort(sealed) : cost.n ? usdShort(cost.mid) : '—'}</b>
      </div>
      {close?.status === 'draft' ? (
        <ActButton label="Seal the weekend and send the briefs" busyLabel="Sealing…" primary run={(by, at) => race.approveClose({ closeKey: close.closeKey, by, at })} />
      ) : close ? (
        <span className="pv-sealed">
          <IconApproved size={12} /> Sealed
        </span>
      ) : null}
      <button type="button" className="pv-link" onClick={() => nav('/instruments')}>
        {auto.toLocaleString('en-US')} things the agents did on their own <IconExternal size={12} />
      </button>
    </section>
  );
}
