import { useState, type ReactNode } from 'react';
import type { CostId } from '../../blueprint/catalog';
import { HEALTH_WORDS } from '../../blueprint/condition';
import { IconApproved, IconDenied, IconPerson, IconQuestion, IconWaiting } from '../../components/icons';
import { pct, usdShort } from '../../lib/format';
import { useRace } from '../../lib/race';
import { carLabel } from '../../lib/raceModel';
import { ActButton, clock, roleLabel } from '../raceday/shared';
import { Pill, type Tone } from '../roles/kit';
import { Dots, LifeBar } from './charts';
import { type Alert, type DeskCar, type DeskPart, type HeldGroup, type PlanView, type TrailItem } from './model';

// The desk's panels: each draws one reading of the model. Words are labels; the sentence lives in the title.

// ------------------------------------------------------------------------------------------ the parts list

const LIFE_PILL: Record<DeskPart['lifeStatus'], { tone: Tone; word: string }> = {
  damaged: { tone: 'bad', word: 'Damaged' },
  due: { tone: 'bad', word: 'Due' },
  watch: { tone: 'wait', word: 'Watch' },
  ok: { tone: 'neutral', word: 'OK' },
  replaced: { tone: 'ok', word: 'New' },
  none: { tone: 'neutral', word: '—' },
};

function spareWord(p: DeskPart): { word: string; tone: Tone; title: string } {
  const s = p.spare;
  if (!s || s.released) return { word: '·', tone: 'neutral', title: 'No spare reserved for this part' };
  if (s.source === 'at_track') return { word: s.atTrackAfter !== null ? `Track ${s.atTrackAfter}` : 'Track', tone: 'info', title: `Spare at the track${s.atTrackAfter !== null ? `, ${s.atTrackAfter} left after this one` : ''}` };
  if (s.source === 'factory') return { word: s.factoryAfter !== null ? `Grove ${s.factoryAfter}` : 'Grove', tone: 'wait', title: `From the factory at Grove${s.factoryAfter !== null ? `, ${s.factoryAfter} left there` : ''}` };
  return { word: 'Make', tone: 'bad', title: 'No spare: the part has to be made' };
}

export function PartRow({ p, onHover, on, showCar }: { p: DeskPart; onHover: (c: CostId | null) => void; on: boolean; showCar?: boolean }) {
  const life = LIFE_PILL[p.lifeStatus];
  const sp = spareWord(p);
  const title = [
    p.label,
    p.life ? `${Math.round(p.usedPct)}% of life used, ${p.remainingKm.toLocaleString('en-US')} km left of ${p.lifeKm.toLocaleString('en-US')}` : 'not followed by the life model',
    p.p !== null ? `P(damaged) ${pct(p.p, 0)}: ${p.health === 'unknown' ? 'not read yet' : HEALTH_WORDS[p.health]}` : null,
    p.capNote,
    sp.title,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <li className={`dk-part dk-part--${p.lifeStatus} dk-part--h-${p.health} ${on ? 'is-on' : ''}`} onMouseEnter={() => onHover(p.cost)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(p.cost)} tabIndex={0} title={title}>
      {showCar ? <span className="dk-part-car mono">{p.car}</span> : null}
      <span className="dk-part-name">
        {p.short}
        {p.penalty ? <IconDenied size={11} className="dk-part-pen" /> : null}
      </span>
      <span className="dk-part-life">
        {p.lifeStatus === 'replaced' ? <span className="life-bar life-bar--new"><i /></span> : <LifeBar used={p.usedPct} />}
      </span>
      <span className="dk-part-pct mono">{p.life ? `${Math.round(p.usedPct)}%` : '—'}</span>
      <span className="dk-part-due">
        <Pill tone={p.penalty ? 'bad' : life.tone}>{p.lifeStatus === 'replaced' ? 'New' : p.lifeStatus === 'damaged' ? 'Damaged' : p.penalty ? `Penalty ${p.dueShort}` : p.lastsSeason ? '2025' : p.dueShort}</Pill>
      </span>
      <span className={`dk-part-spare dk-part-spare--${sp.tone}`}>{sp.word}</span>
      <span className="dk-part-cost mono">{usdShort(p.replacementCents)}</span>
      <span className="dk-part-stress">
        <Dots items={p.stress.map((s) => ({ tone: s.severity ?? 'none', title: `${s.lap ? `L${s.lap} ` : ''}${s.kind.replace(/_/g, ' ')}: ${s.severity ?? '?'}${s.p ? ` P ${s.p.toFixed(2)}` : ''}, −${s.taken}%` }))} max={5} />
      </span>
    </li>
  );
}

export function PartsHead({ showCar }: { showCar?: boolean }) {
  return (
    <li className="dk-part dk-part--head" aria-hidden>
      {showCar ? <span className="dk-part-car">Car</span> : null}
      <span className="dk-part-name">Part</span>
      <span className="dk-part-life">Life used</span>
      <span className="dk-part-pct" />
      <span className="dk-part-due">Due</span>
      <span className="dk-part-spare">Spare</span>
      <span className="dk-part-cost">Repl.</span>
      <span className="dk-part-stress">Stress</span>
    </li>
  );
}

// ------------------------------------------------------------------------------------------ alerts

const ALERT_ICON: Record<Alert['kind'], ReactNode> = {
  plan: <IconPerson size={13} />,
  penalty: <IconDenied size={13} />,
  damaged: <IconDenied size={13} />,
  nospare: <IconWaiting size={13} />,
  held: <IconPerson size={13} />,
  question: <IconQuestion size={13} />,
  decision: <IconPerson size={13} />,
  unsure: <IconQuestion size={13} />,
  due: <IconWaiting size={13} />,
  close: <IconPerson size={13} />,
  refused: <IconDenied size={13} />,
};

export function AlertRow({ a, go }: { a: Alert; go: (tab: string, anchor?: string) => void }) {
  return (
    <li className={`dk-alert dk-alert--${a.tone} ${a.action ? 'dk-alert--act' : ''}`}>
      <button type="button" onClick={() => go(a.go.tab, a.go.anchor)} title={[a.detail, a.who ? `for the ${a.who}` : null].filter(Boolean).join(' · ')}>
        <span className="dk-alert-ic" aria-hidden>
          {ALERT_ICON[a.kind]}
        </span>
        <span className="dk-alert-text">
          <b>{a.title}</b>
          <span>{a.detail}</span>
        </span>
        <span className="dk-alert-side">
          {a.amountCents !== null ? <span className="mono">{usdShort(a.amountCents)}</span> : null}
          {a.who ? <span className="dk-alert-who">{a.who}</span> : null}
        </span>
      </button>
    </li>
  );
}

// ------------------------------------------------------------------------------------------ waiting for a person

export function HeldRow({ g }: { g: HeldGroup }) {
  const race = useRace();
  const decideAll = (status: string) => async (by: string, at: string) => {
    for (const h of g.rows) await race.decidePosting({ entryKey: h.entryKey, status, by, at });
  };
  return (
    <li className="dk-wait">
      <Pill tone="wait">Held</Pill>
      <span className="dk-wait-what" title={g.reasons.join(' · ')}>
        <b>{g.label}</b>
        <span>
          {g.rows.length} {g.rows.length === 1 ? 'entry' : 'entries'} · {g.who.join(', ')}
        </span>
      </span>
      <span className="dk-wait-amt mono">{usdShort(g.net)}</span>
      <span className="dk-wait-act">
        <ActButton label={g.rows.length > 1 ? 'Approve all' : 'Approve'} busyLabel="Approving…" primary title="Approve the incident's books: the desk posts every entry to the ERP" run={decideAll('approved')} />
        <ActButton label="Reject" busyLabel="Rejecting…" title="Keep them out of the ERP" run={decideAll('rejected')} />
      </span>
    </li>
  );
}

/** The response plan, one card: the chief of staff approves the team's reaction to an incident as a whole. */
export function PlanCard({ p, onOpen }: { p: PlanView; onOpen?: () => void }) {
  const race = useRace();
  const draft = p.plan.status === 'draft';
  return (
    <li className={`dk-wait dk-plan ${draft ? '' : 'dk-plan--done'}`}>
      <Pill tone={draft ? 'wait' : p.plan.status === 'approved' ? 'ok' : 'bad'}>{draft ? 'Plan' : p.plan.status === 'approved' ? 'Approved' : 'Rejected'}</Pill>
      <span className="dk-wait-what" role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined} onClick={onOpen} onKeyDown={(e) => (e.key === 'Enter' && onOpen ? onOpen() : null)} title={p.plan.summary}>
        <b>Response plan · {p.label}</b>
        <span>
          {p.operations} ops · {p.entries} entries · <span className="dk-plan-prec">{p.plan.precedented} on precedent</span>
          {p.plan.novel ? <span className="dk-plan-novel"> · {p.plan.novel} novel</span> : null} · Chief of Staff
        </span>
      </span>
      <span className="dk-wait-amt mono">{p.amountCents ? usdShort(p.amountCents) : ''}</span>
      <span className="dk-wait-act">
        {draft ? (
          <>
            <ActButton label="Approve plan" busyLabel="Approving…" primary title="Approve the reaction as a whole: every line with a precedent then executes and posts on its own; novel lines wait for the Head of Cost Cap" run={(by, at) => race.approvePlan({ planKey: p.plan.planKey, status: 'approved', by, at })} />
            <ActButton label="Reject" busyLabel="Rejecting…" title="Nothing executes or posts" run={(by, at) => race.approvePlan({ planKey: p.plan.planKey, status: 'rejected', by, at })} />
          </>
        ) : (
          <span className="mono muted small">{p.plan.approvedBy}</span>
        )}
      </span>
    </li>
  );
}

export function WaitingRows({ held, plans = [], onOpenPlan }: { held: HeldGroup[]; plans?: PlanView[]; onOpenPlan?: (key: string) => void }) {
  const race = useRace();
  const unsure = race.effects.filter((e) => e.status === 'needs_person');
  const close = race.closes.reduce<(typeof race.closes)[number] | null>((b, c) => (!b || c.closedAt > b.closedAt ? c : b), null);
  const decisions = race.actions.filter((a) => a.status === 'awaiting_approval' && (a.kind === 'withdraw_car' || a.outward));
  const openQs = race.questions.filter((q) => q.status === 'open');
  const drafts = plans.filter((p) => p.plan.status === 'draft');
  const mine = held.length + unsure.length + drafts.length + (close?.status === 'draft' ? 1 : 0);
  return (
    <ul className="dk-waits">
      {drafts.map((p) => (
        <PlanCard key={p.plan.planKey} p={p} onOpen={onOpenPlan ? () => onOpenPlan(p.plan.planKey) : undefined} />
      ))}
      {close?.status === 'draft' && (
        <li className="dk-wait">
          <Pill tone="wait">Draft</Pill>
          <span className="dk-wait-what">
            <b>Weekend close and briefs</b>
            <span>{close.leaves} rows sealed · CFO</span>
          </span>
          <span className="dk-wait-amt mono" />
          <span className="dk-wait-act">
            <ActButton label="Approve and send" busyLabel="Approving…" primary run={(by, at) => race.approveClose({ closeKey: close.closeKey, by, at })} />
          </span>
        </li>
      )}
      {held.map((g) => (
        <HeldRow key={g.key} g={g} />
      ))}
      {unsure.map((e) => (
        <li key={e.effectKey} className="dk-wait">
          <Pill tone="wait">Unsure</Pill>
          <span className="dk-wait-what" title={`${e.memo}\n\nJev was unsure; the chief mechanic's answer settles it.`}>
            <b>{e.memo.split(/ - counts| - retirement|\. /)[0]!.trim()}</b>
            <span>{carLabel(e.driverNumber)} · Chief Mechanic</span>
          </span>
          <span className="dk-wait-amt mono">{usdShort(e.midCents)}</span>
          <span className="dk-wait-act">
            <ActButton label="Confirm" busyLabel="Confirming…" title="The band stands as booked" run={(by, at) => race.confirm({ effectKey: e.effectKey, reason: 'Confirmed from the desk', by, at })} />
          </span>
        </li>
      ))}
      {decisions.map((a) => (
        <li key={a.actionKey} className="dk-wait dk-wait--other">
          <Pill tone="neutral">Decision</Pill>
          <span className="dk-wait-what" title={a.title}>
            <b>{a.title}</b>
            <span>{roleLabel(a.ownerRole)}</span>
          </span>
          <span className="dk-wait-amt mono muted">{a.dueAt ? `${clock(a.dueAt).slice(0, 5)} UTC` : ''}</span>
          <span className="dk-wait-act" />
        </li>
      ))}
      {openQs.map((q) => (
        <li key={q.questionKey} className="dk-wait dk-wait--other">
          <Pill tone="info">Question</Pill>
          <span className="dk-wait-what" title={q.prompt}>
            <b>{q.prompt}</b>
            <span>{roleLabel(q.routeRole)}</span>
          </span>
          <span className="dk-wait-amt mono">{q.expectedLossCents > 0n ? usdShort(q.expectedLossCents) : ''}</span>
          <span className="dk-wait-act" />
        </li>
      ))}
      {!mine && !decisions.length && !openQs.length && (
        <li className="dk-wait dk-wait--empty">
          <Pill tone="ok">Clear</Pill>
          <span className="dk-wait-what">
            <b>Nothing waits for a person</b>
          </span>
        </li>
      )}
    </ul>
  );
}

// ------------------------------------------------------------------------------------------ the agent's trail

const OUTCOME: Record<TrailItem['outcome'], { tone: Tone; word: string; icon: ReactNode }> = {
  allowed: { tone: 'ok', word: 'Allowed', icon: <IconApproved size={11} /> },
  refused: { tone: 'bad', word: 'Refused', icon: <IconDenied size={11} /> },
  held: { tone: 'wait', word: 'Held', icon: <IconWaiting size={11} /> },
  posted: { tone: 'ok', word: 'Posted', icon: <IconApproved size={11} /> },
  asked: { tone: 'wait', word: 'Asked', icon: <IconQuestion size={11} /> },
  auto: { tone: 'info', word: 'Done', icon: null },
  decided: { tone: 'ok', word: 'Decided', icon: <IconPerson size={11} /> },
};

const ACTOR_WORD: Record<TrailItem['actor'], string> = { agent: 'Agent', jev: 'Jev', claude: 'Claude', policy: 'Policy', person: 'Person', system: 'Timer' };

export function TrailRow({ it }: { it: TrailItem }) {
  const o = OUTCOME[it.outcome];
  const t = new Date(it.t);
  const when = Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return (
    <li className={`dk-trail dk-trail--${it.actor} dk-trail--${it.outcome}`} title={[it.detail, it.car ? `car ${it.car}` : null, it.ms ? `${Math.round(it.ms)} ms` : null].filter(Boolean).join(' · ')}>
      <span className="dk-trail-when mono">{when}</span>
      <span className={`dk-trail-actor dk-trail-actor--${it.actor}`}>{ACTOR_WORD[it.actor]}</span>
      <span className="dk-trail-what">
        <b>{it.who}</b> {it.action}
        {it.detail ? <span className="dk-trail-detail"> · {it.detail}</span> : null}
      </span>
      <span className="dk-trail-amt mono">{it.amountCents ? usdShort(it.amountCents) : it.ms ? `${Math.round(it.ms)} ms` : ''}</span>
      <span className={`dk-trail-out dk-trail-out--${o.tone}`}>
        {o.icon}
        {o.word}
      </span>
    </li>
  );
}

// ------------------------------------------------------------------------------------------ cars on the switcher

export function CarTab({ car, on, onPick }: { car: DeskCar; on: boolean; onPick: () => void }) {
  const [hover, setHover] = useState(false);
  const tone: Tone = car.damaged && !car.replaced ? 'bad' : car.read.words === 'dns' || car.read.words === 'out' ? 'bad' : car.read.words === 'running' ? 'info' : 'wait';
  return (
    <button type="button" className={`dk-cartab ${on ? 'is-on' : ''} dk-cartab--${tone}`} onClick={onPick} aria-pressed={on} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} title={car.name ?? `Car ${car.number}`}>
      <span className="dk-cartab-num">{car.number}</span>
      <span className="dk-cartab-id">
        <b>{car.code}</b>
        <span>{hover && car.name ? car.name.split(' ').slice(-1)[0] : car.read.words === 'dns' ? 'Did not start' : car.read.position ? `P${car.read.position}` : car.read.words === 'running' ? 'Running' : car.read.words}</span>
      </span>
      <span className="dk-cartab-figs mono">
        <span title="parts replaced this weekend">{car.replaced ? `${car.replaced} new` : ''}</span>
        <span title="parts likely damaged">{car.damaged ? `${car.damaged} dmg` : ''}</span>
        <span title="grid penalty risk">{car.penalties ? `${car.penalties} pen` : ''}</span>
      </span>
    </button>
  );
}
