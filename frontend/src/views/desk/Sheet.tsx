import { useEffect, useMemo, type ReactNode } from 'react';
import { IconApproved, IconDenied, IconExternal, IconPerson, IconWaiting } from '../../components/icons';
import { pct, usdShort } from '../../lib/format';
import { carLabel, sortTime } from '../../lib/raceModel';
import { HEALTH_WORDS } from '../../blueprint/condition';
import { PRICES, priceCents } from '../../blueprint/catalog';
import { ActButton, clock, parse, roleLabel } from '../raceday/shared';
import { flowSteps } from '../roles/IncidentFlow';
import { readBelief, SEVERITIES } from '../roles/incidentCondition';
import { Pill, type Tone } from '../roles/kit';
import { Bullet, LifeBar, Shares } from './charts';
import { AlertRow, PartRow, PartsHead } from './panels';
import type { Desk, DeskPart, PlanLine } from './model';

// The side sheet: the second level of detail. One target at a time; the footer opens the full role view.

export type SheetTarget =
  | { kind: 'part'; id: string }
  | { kind: 'parts'; id: string }
  | { kind: 'incident'; id: string }
  | { kind: 'decision'; id: string }
  | { kind: 'logistics'; id: string }
  | { kind: 'alerts'; id: string }
  | { kind: 'plan'; id: string };

interface Props {
  target: SheetTarget;
  desk: Desk;
  close: () => void;
  go: (tab: string, anchor?: string) => void;
  open: (t: SheetTarget) => void;
}

export function SideSheet({ target, desk, close, go, open }: Props) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [close]);
  const body = target.kind === 'part' ? <PartSheet desk={desk} id={target.id} go={go} /> : target.kind === 'parts' ? <PartsSheet desk={desk} car={Number(target.id)} go={go} open={open} /> : target.kind === 'incident' ? <IncidentSheet desk={desk} id={target.id} go={go} /> : target.kind === 'decision' ? <DecisionSheet desk={desk} id={target.id} go={go} /> : target.kind === 'logistics' ? <LogisticsSheet desk={desk} go={go} /> : target.kind === 'plan' ? <PlanSheet desk={desk} id={target.id} go={go} open={open} /> : <AlertsSheet desk={desk} kind={target.id} go={go} />;
  return (
    <>
      <div className="g-scrim is-open" onClick={close} />
      <aside className="g-sheet glass--raised is-open" role="dialog" aria-modal="true">
        {body}
      </aside>
    </>
  );
}

function Frame({ title, id, tone, children, foot, close }: { title: string; id?: string; tone?: Tone; children: ReactNode; foot?: ReactNode; close?: () => void }) {
  return (
    <>
      <header className="g-sheet-head">
        <h2 className="g-title">{title}</h2>
        {id ? <span className="mono muted sheet-id">{id}</span> : null}
        {tone ? <span className={`lamp lamp--${tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : tone === 'wait' ? 'wait' : 'auto'}`} /> : null}
        <span className="sheet-fill" />
        <button type="button" className="g-open" onClick={close} aria-label="Close" form="x">
          <IconDenied size={14} />
        </button>
      </header>
      <div className="g-sheet-body">{children}</div>
      <footer className="g-sheet-foot">{foot}</footer>
    </>
  );
}

const Row = ({ k, v, title }: { k: string; v: ReactNode; title?: string }) => (
  <div className="sheet-row" title={title}>
    <span className="fig-label">{k}</span>
    <span className="sheet-v">{v}</span>
  </div>
);

// ------------------------------------------------------------------------------------------ one part

function PartSheet({ desk, id, go }: { desk: Desk; id: string; go: (tab: string, anchor?: string) => void }) {
  const p = desk.parts.find((x) => x.key === id);
  if (!p) return <Frame title="Part">Not found</Frame>;
  const price = priceCents(p.cost);
  const basis = PRICES[p.cost].basis;
  const entries = desk.race.entries.filter((e) => e.memo.toLowerCase().includes(p.label.toLowerCase().split(' ')[0]!) && desk.race.incidents.find((i) => i.incidentKey === e.incidentKey)?.driverNumber === p.car);
  const posting = new Map(desk.race.postings.map((x) => [x.entryKey, x]));
  return (
    <Frame title={p.label} id={`car ${p.car}`} tone={p.lifeStatus === 'damaged' || p.penalty ? 'bad' : p.lifeStatus === 'watch' || p.lifeStatus === 'due' ? 'wait' : 'neutral'} foot={<button type="button" className="g-btn" onClick={() => go('garage')}>Open in Garage <IconExternal size={12} /></button>}>
      <section className="sheet-sec">
        <div className="sheet-life">
          <LifeBar used={p.usedPct} size="lg" />
          <span className="g-fig-lg">{p.life ? `${Math.round(p.usedPct)}%` : '—'}</span>
        </div>
        <Row k="Left" v={<span className="mono">{p.life ? `${p.remainingKm.toLocaleString('en-US')} km of ${p.lifeKm.toLocaleString('en-US')}` : 'not followed'}</span>} />
        <Row k="Status" v={<Pill tone={p.penalty ? 'bad' : p.lifeStatus === 'damaged' || p.lifeStatus === 'due' ? 'bad' : p.lifeStatus === 'watch' ? 'wait' : p.lifeStatus === 'replaced' ? 'ok' : 'neutral'}>{p.lifeStatus === 'replaced' ? 'New' : p.penalty ? `Grid penalty · ${p.dueShort}` : p.lifeStatus === 'none' ? '—' : p.lifeStatus.charAt(0).toUpperCase() + p.lifeStatus.slice(1)}</Pill>} />
        <Row k="Due" v={<span className="mono">{p.lastsSeason ? 'lasts the season' : p.dueEvent}</span>} title={p.capNote} />
        {p.p !== null ? <Row k="Damage" v={<span className="mono">{p.health === 'unknown' ? 'not read yet' : `${HEALTH_WORDS[p.health]} · ${pct(p.p, 0)}`}</span>} /> : null}
      </section>
      <section className="sheet-sec">
        <h3 className="g-label">Stress events</h3>
        {p.stress.length ? (
          <ol className="sheet-stress">
            {p.stress.map((s, i) => (
              <li key={i}>
                <span className={`lamp lamp--${s.severity === 'heavy' ? 'bad' : s.severity === 'moderate' ? 'wait' : s.severity === 'light' ? 'live' : 'auto'}`} />
                <span className="mono">{s.lap ? `L${s.lap}` : clock(s.at).slice(0, 5)}</span>
                <span>{s.kind.replace(/_/g, ' ')}</span>
                <span className="muted">{s.severity ?? ''}{s.p ? ` · P ${s.p.toFixed(2)}` : ''}</span>
                <span className="mono">−{s.taken}%</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted small">None on this part</p>
        )}
      </section>
      <section className="sheet-sec">
        <h3 className="g-label">Replacement</h3>
        <Row k="Price" v={<span className="mono">{usdShort(price.mid)} <span className="muted">{usdShort(price.low)}–{usdShort(price.high)} · {basis === 'press' ? 'press' : 'assumption'}</span></span>} />
        <Row k="Spare" v={p.spare && !p.spare.released ? <Pill tone={p.spare.source === 'at_track' ? 'info' : p.spare.source === 'factory' ? 'wait' : 'bad'}>{p.spare.source === 'at_track' ? `At the track${p.spare.atTrackAfter !== null ? ` · ${p.spare.atTrackAfter} left` : ''}` : p.spare.source === 'factory' ? `Grove${p.spare.factoryAfter !== null ? ` · ${p.spare.factoryAfter} left` : ''}` : 'To be made'}</Pill> : <span className="muted">none reserved</span>} />
        <Row k="Cap" v={<Pill tone={p.capYear === 'booked' ? 'bad' : p.capYear === 'this' ? 'wait' : 'neutral'}>{p.capYear === 'booked' ? 'Counted 2024 · fitted' : p.capYear === 'this' ? 'Counts in 2024' : p.capYear === 'next' ? 'Falls in 2025' : '—'}</Pill>} title={p.capNote} />
        {p.broughtForwardCents ? <Row k="Pulled in" v={<span className="mono tone-hold">+{usdShort(p.broughtForwardCents)}</span>} /> : null}
      </section>
      {entries.length ? (
        <section className="sheet-sec">
          <h3 className="g-label">Entries</h3>
          <ul className="sheet-entries">
            {entries.map((e) => {
              const s = posting.get(e.entryKey);
              return (
                <li key={e.entryKey} title={e.memo}>
                  <Pill tone={s?.status === 'posted' ? 'ok' : s?.status === 'held' ? 'wait' : 'neutral'}>{s?.status ?? 'booked'}</Pill>
                  <span className="sheet-ellipsis">{e.memo.split(/ - counts| - retirement|\. /)[0]}</span>
                  <span className="mono">{usdShort(e.amountCents)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </Frame>
  );
}

// ------------------------------------------------------------------------------------------ all parts of a car

function PartsSheet({ desk, car, go, open }: { desk: Desk; car: number; go: (tab: string) => void; open: (t: SheetTarget) => void }) {
  const c = desk.cars.find((x) => x.number === car);
  if (!c) return <Frame title="Parts">Not found</Frame>;
  return (
    <Frame title={`Parts · car ${car}`} id={c.code} foot={<button type="button" className="g-btn" onClick={() => go('garage')}>Open in Garage <IconExternal size={12} /></button>}>
      <ul className="dk-parts dk-parts--sheet">
        <PartsHead />
        {c.parts.map((p) => (
          <span key={p.key} onClick={() => open({ kind: 'part', id: p.key })} role="presentation">
            <PartRow p={p} on={false} onHover={() => undefined} />
          </span>
        ))}
      </ul>
    </Frame>
  );
}

// ------------------------------------------------------------------------------------------ one incident

const STEP_TONE: Record<string, Tone> = { done: 'ok', wait: 'wait', open: 'neutral', none: 'neutral' };

function IncidentSheet({ desk, id, go }: { desk: Desk; id: string; go: (tab: string, anchor?: string) => void }) {
  const inc = desk.race.incidents.find((i) => i.incidentKey === id);
  const steps = useMemo(() => (inc ? flowSteps(desk.race, inc) : []), [desk.race, inc]);
  if (!inc) return <Frame title="Incident">Not found</Frame>;
  const b = readBelief(inc.beliefJson);
  const history = desk.race.beliefs.filter((x) => x.incidentKey === inc.incidentKey).sort((x, y) => x.version - y.version);
  const sev = b.severity ?? {};
  return (
    <Frame title={`${carLabel(inc.driverNumber)} · ${inc.sessionKey === 9627 ? 'qualifying' : `lap ${b.lap ?? '?'}`}`} id={clock(inc.firstSeenAt)} tone={b.assessed_as === 'heavy' ? 'bad' : 'wait'} foot={<button type="button" className="g-btn" onClick={() => go('garage')}>Open in Garage <IconExternal size={12} /></button>}>
      <section className="sheet-sec">
        <div className="sheet-figs">
          <div className="fig"><span className="fig-label">Impact</span><span className="fig-value mono">{b.impact_kph ? `${b.impact_kph} km/h` : '—'}</span>{b.decel_g ? <span className="fig-sub">{b.decel_g} g</span> : null}</div>
          <div className="fig"><span className="fig-label">{b.assessed_as ? 'Assessed' : 'Likeliest'}</span><span className="fig-value mono">{b.assessed_as ?? Object.entries(sev).sort((x, y) => y[1] - x[1])[0]?.[0] ?? '—'}</span>{b.assessed_by ? <span className="fig-sub">by {b.assessed_by}</span> : null}</div>
          <div className="fig"><span className="fig-label">Belief</span><span className="fig-value mono">v{inc.version}</span><span className="fig-sub">{inc.status}</span></div>
        </div>
        <Shares parts={SEVERITIES.map((k) => ({ tone: k === 'heavy' ? 'bad' : k === 'moderate' ? 'wait' : k === 'light' ? 'sky' : 'gray', value: sev[k] ?? 0, label: k }))} height={8} />
        <p className="muted small">{inc.cause}</p>
      </section>
      <section className="sheet-sec">
        <h3 className="g-label">Through the team</h3>
        <ol className="sheet-steps">
          {steps.map((s) => (
            <li key={s.id} className={`sheet-step sheet-step--${s.state}`}>
              <button type="button" onClick={() => go(s.tab, s.id === 'next' ? 'next-steps' : undefined)} title={s.title}>
                <span className={`lamp lamp--${s.state === 'done' ? 'ok' : s.state === 'wait' ? 'wait' : 'off'}`} />
                <span className="sheet-step-label">{s.label}</span>
                <span className="sheet-step-value">{s.value}</span>
                <span className="sheet-step-sub">{s.sub}</span>
                <Pill tone={STEP_TONE[s.state] ?? 'neutral'}>{s.state === 'done' ? 'Done' : s.state === 'wait' ? 'Waiting' : s.state === 'none' ? 'n/a' : 'Open'}</Pill>
              </button>
            </li>
          ))}
        </ol>
      </section>
      {history.length > 1 ? (
        <section className="sheet-sec">
          <h3 className="g-label">Belief versions</h3>
          <ol className="sheet-versions">
            {history.map((h) => {
              const hb = readBelief(h.beliefJson);
              const top = Object.entries(hb.severity ?? {}).sort((x, y) => y[1] - x[1])[0];
              return (
                <li key={h.beliefKey} title={h.cause}>
                  <span className="mono">v{h.version}</span>
                  <span className="mono muted">{clock(h.at)}</span>
                  <span>{hb.assessed_as ? `assessed ${hb.assessed_as}` : top ? `${top[0]} ${pct(top[1], 0)}` : h.status}</span>
                  <span className="sheet-ellipsis muted">{h.cause}</span>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </Frame>
  );
}

// ------------------------------------------------------------------------------------------ one posting

function DecisionSheet({ desk, id, go }: { desk: Desk; id: string; go: (tab: string) => void }) {
  const r = desk.race;
  const posting = r.postings.find((p) => p.entryKey === id || p.erpEntryId === id);
  const entry = posting ? r.entries.find((e) => e.entryKey === posting.entryKey) : r.entries.find((e) => e.entryKey === id);
  if (!entry) return <Frame title="Entry">Not found</Frame>;
  const lines = r.entryLines.filter((l) => l.entryKey === entry.entryKey);
  const audit = r.audit.filter((a) => a.targetKey === entry.entryKey).sort((a, b) => Number(a.auditId - b.auditId));
  const s = posting?.status ?? 'booked';
  const rules = r.rules;
  const amt = Number(entry.amountCents);
  const rule = rules ? (amt >= Number(rules.cfoCents) ? `≥ ${usdShort(rules.cfoCents)} · CFO` : amt >= Number(rules.autoPostMaxCents) ? `≥ ${usdShort(rules.autoPostMaxCents)} · Head of Cost Cap` : `< ${usdShort(rules.autoPostMaxCents)} · auto`) : '';
  return (
    <Frame title={entry.memo.split(/ - counts| - retirement|\. /)[0]!.slice(0, 48)} id={posting?.erpEntryId || entry.entryKey.slice(0, 18)} tone={s === 'posted' ? 'ok' : s === 'held' ? 'wait' : s === 'rejected' ? 'bad' : 'neutral'} foot={<button type="button" className="g-btn" onClick={() => go('accounting')}>Open in Books <IconExternal size={12} /></button>}>
      <section className="sheet-sec">
        <Row k="Status" v={<Pill tone={s === 'posted' ? 'ok' : s === 'held' ? 'wait' : s === 'rejected' ? 'bad' : 'neutral'}>{s}</Pill>} />
        <Row k="Amount" v={<span className="mono">{usdShort(entry.amountCents)}</span>} />
        <Row k="Rule" v={<span className="mono">{rule}</span>} />
        <Row k="Cap" v={entry.capRelevant ? <Pill tone="info">Relevant · {entry.recognition.replace(/_/g, ' ')}</Pill> : <Pill tone="neutral">Not cap-relevant</Pill>} />
        {posting?.reviewRole ? <Row k="Review" v={roleLabel(posting.reviewRole)} /> : null}
        {posting?.reason ? <Row k="Why" v={<span className="small">{posting.reason}</span>} /> : null}
      </section>
      <section className="sheet-sec">
        <h3 className="g-label">Lines</h3>
        <table className="sheet-table">
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="mono">{l.account}</td>
                <td>{l.memo}</td>
                <td className="mono num">{l.debitCents ? usdShort(l.debitCents) : ''}</td>
                <td className="mono num">{l.creditCents ? usdShort(l.creditCents) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {audit.length ? (
        <section className="sheet-sec">
          <h3 className="g-label">On the record</h3>
          <ol className="sheet-audit">
            {audit.map((a) => (
              <li key={String(a.auditId)} className={a.allowed ? '' : 'is-refused'}>
                {a.allowed ? <IconApproved size={11} /> : <IconDenied size={11} />}
                <span className="mono muted">{clock(a.at)}</span>
                <span><b>{a.name}</b> {a.action.replace(/_/g, ' ')}</span>
                <span className="muted sheet-ellipsis">{a.reason}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </Frame>
  );
}

// ------------------------------------------------------------------------------------------ logistics

function LogisticsSheet({ desk, go }: { desk: Desk; go: (tab: string, anchor?: string) => void }) {
  const race = desk.race;
  const acts = [...desk.actions.waiting, ...desk.actions.done, ...desk.actions.desk].sort((a, b) => sortTime(b.updatedAt) - sortTime(a.updatedAt));
  return (
    <Frame title="Next steps" id={`${desk.actions.waiting.length} waiting`} foot={<button type="button" className="g-btn" onClick={() => go('garage', 'next-steps')}>Open in Garage <IconExternal size={12} /></button>}>
      <ol className="sheet-acts">
        {acts.map((a) => {
          const d = parse<{ why?: string }>(a.detailJson, {});
          const wait = a.status === 'awaiting_approval';
          return (
            <li key={a.actionKey} className={wait ? 'is-wait' : ''} title={d.why}>
              <span className="sheet-act-top">
                {wait ? <IconWaiting size={12} /> : a.status === 'auto' ? <IconApproved size={12} /> : <IconPerson size={12} />}
                <b>{a.title}</b>
                {a.outward ? <IconExternal size={11} title="Leaves the team" /> : null}
              </span>
              <span className="sheet-act-sub">
                <Pill tone={wait ? 'wait' : a.status === 'rejected' ? 'bad' : a.status === 'auto' ? 'neutral' : 'ok'}>{a.status === 'auto' ? 'By the desk' : a.status.replace(/_/g, ' ')}</Pill>
                <span className="muted">{roleLabel(a.ownerRole)}</span>
                {a.dueAt ? <span className="mono muted">by {clock(a.dueAt).slice(0, 5)}</span> : null}
                {wait ? (
                  <span className="sheet-act-btns">
                    <ActButton primary label={a.kind === 'fia_notice' ? 'Send' : 'Approve'} run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'approved', by, at })} />
                    <ActButton label="Reject" run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'rejected', by, at })} />
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </Frame>
  );
}

// ------------------------------------------------------------------------------------------ the response plan

const LINE_KIND: Record<string, string> = {
  entry: 'Entry', spares_reserve: 'Spare', work_order: 'Work order', td017_move: 'Inventory', evidence_pack: 'Evidence', parc_ferme_list: 'Parc fermé',
  pu_check: 'PU check', hand_carry: 'Hand-carry', freight: 'Freight', fia_notice: 'FIA notice',
};

function PlanLineRow({ l, open }: { l: PlanLine; open: (t: SheetTarget) => void }) {
  const sim = l.precedent?.similarity ?? Math.max(0, ...(l.components ?? []).map((c) => c.similarity ?? 0));
  const novel = l.status === 'novel';
  const title = [l.why, l.precedent ? `${l.precedent.case_id}: ${l.precedent.summary ?? ''}` : null, ...(l.components ?? []).map((c) => `${c.label}: ${c.status} ${c.similarity ?? ''}${c.nearest ? ` (closest ${c.nearest.summary})` : ''}`)].filter(Boolean).join('\n');
  return (
    <li className={`plan-line plan-line--${l.status}`} title={title} onClick={() => (l.kind === 'entry' ? open({ kind: 'decision', id: l.ref }) : null)} role={l.kind === 'entry' ? 'button' : undefined}>
      <span className="plan-line-kind">{LINE_KIND[l.kind] ?? l.kind}</span>
      <span className="plan-line-label">
        <b>{l.label}</b>
        {novel && l.why ? <span className="plan-line-why">{l.why}</span> : null}
      </span>
      <span className="plan-line-sim">
        <Bullet value={sim} max={1} limit={0.8} tone={novel ? 'bad' : 'navy'} height={6} label={`similarity ${sim.toFixed(2)}`} />
        <span className="mono">{sim ? sim.toFixed(2) : '—'}</span>
      </span>
      <span className="mono plan-line-amt">{l.amount_cents ? usdShort(l.amount_cents) : ''}</span>
      <Pill tone={novel ? 'bad' : 'ok'}>{novel ? 'Novel' : 'Precedent'}</Pill>
    </li>
  );
}

function PlanSheet({ desk, id, go, open }: { desk: Desk; id: string; go: (tab: string, anchor?: string) => void; open: (t: SheetTarget) => void }) {
  const race = desk.race;
  const p = desk.plans.find((x) => x.plan.planKey === id);
  if (!p) return <Frame title="Response plan">Not found</Frame>;
  const draft = p.plan.status === 'draft';
  const ops = p.lines.filter((l) => l.kind !== 'entry');
  const ents = p.lines.filter((l) => l.kind === 'entry');
  return (
    <Frame
      title={`Response plan · ${p.label}`}
      id={`v${p.plan.version}`}
      tone={draft ? 'wait' : p.plan.status === 'approved' ? 'ok' : 'bad'}
      foot={
        draft ? (
          <>
            <ActButton label="Reject" run={(by, at) => race.approvePlan({ planKey: p.plan.planKey, status: 'rejected', by, at })} />
            <ActButton label="Approve the plan" primary busyLabel="Approving…" run={(by, at) => race.approvePlan({ planKey: p.plan.planKey, status: 'approved', by, at })} />
          </>
        ) : (
          <button type="button" className="g-btn" onClick={() => go('cfo')}>
            Open the CFO view <IconExternal size={12} />
          </button>
        )
      }
    >
      <section className="sheet-sec">
        <div className="sheet-figs">
          <div className="fig"><span className="fig-label">On precedent</span><span className="fig-value mono">{p.plan.precedented}</span><span className="fig-sub">post alone once approved</span></div>
          <div className="fig"><span className="fig-label">Novel</span><span className={`fig-value mono ${p.plan.novel ? 'tone-alert' : ''}`}>{p.plan.novel}</span><span className="fig-sub">wait for the Head of Cost Cap</span></div>
          <div className="fig"><span className="fig-label">Entries</span><span className="fig-value mono">{usdShort(p.amountCents)}</span><span className="fig-sub">{p.entries} lines</span></div>
        </div>
        <Shares parts={[{ tone: 'navy', value: p.plan.precedented, label: 'precedent' }, { tone: 'bad', value: p.plan.novel, label: 'novel' }]} height={8} />
        <Row k="Status" v={<Pill tone={draft ? 'wait' : p.plan.status === 'approved' ? 'ok' : 'bad'}>{draft ? 'Waiting for the Chief of Staff' : `${p.plan.status} by ${p.plan.approvedBy}`}</Pill>} />
      </section>
      <section className="sheet-sec">
        <h3 className="g-label">Entries · each matched part by part against the team's history</h3>
        <ol className="plan-lines">
          {ents.map((l) => (
            <PlanLineRow key={l.ref} l={l} open={open} />
          ))}
        </ol>
      </section>
      <section className="sheet-sec">
        <h3 className="g-label">Operations · reversible ones run ahead of the approval</h3>
        <ol className="plan-lines">
          {ops.map((l) => (
            <PlanLineRow key={l.ref} l={l} open={open} />
          ))}
        </ol>
      </section>
    </Frame>
  );
}

// ------------------------------------------------------------------------------------------ alerts of one kind

function AlertsSheet({ desk, kind, go }: { desk: Desk; kind: string; go: (tab: string, anchor?: string) => void }) {
  const items = desk.alerts.filter((a) => a.kind === kind);
  return (
    <Frame title={`${items.length} ${kind.replace(/_/g, ' ')}`} foot={<button type="button" className="g-btn" onClick={() => go(items[0]?.go.tab ?? 'garage')}>Open the role view <IconExternal size={12} /></button>}>
      <ul className="dk-alerts">
        {items.map((a) => (
          <AlertRow key={a.key} a={a} go={go} />
        ))}
      </ul>
    </Frame>
  );
}

export type { DeskPart };
