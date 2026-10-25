import { useMemo } from 'react';
import { useRace, type RaceData } from '../../lib/race';
import { carLabel, sortTime } from '../../lib/raceModel';
import { usdShort } from '../../lib/format';
import { ActButton, clock, parse, roleLabel, type Headline } from './shared';
import './respond.css';

// Stage 3, respond: what the playbook set off. Internal, reversible actions run on their own; anything
// outward-facing or irreversible waits for the person who owns it. A withdraw decision leads the panel with its
// three priced outcomes; then the spares the weekend has used; then every action, grouped by incident.

type Action = RaceData['actions'][number];
type Incident = RaceData['incidents'][number];

interface Option {
  id: string;
  label: string;
  hours_needed: number[];
  feasible: boolean;
  cost_cents: number[];
  expected_points: number;
  risk: string;
}

interface Decision {
  why?: string;
  car?: number;
  grid?: number | null;
  grid_basis?: string;
  race_start?: string;
  hours_available?: number;
  p_heavy?: number;
  p_tub?: number;
  options?: Option[];
  recommendation?: string;
  recommendation_why?: string;
  standings?: string;
  outcome?: string;
}

interface Reserve {
  part?: string;
  label?: string;
  source?: string;
  manifest_at_track?: number;
}

const KIND_LABEL: Record<string, string> = {
  garage_check: 'garage check',
  spares_reserve: 'spares',
  work_order: 'work order',
  freight: 'freight',
  hand_carry: 'hand carry',
  withdraw_car: 'start or withdraw',
  parc_ferme_list: 'parc fermé list',
  pu_check: 'power unit',
  td017_move: 'inventory',
  fia_notice: 'FIA notice',
  evidence_pack: 'evidence',
};

const KIND_ORDER = Object.keys(KIND_LABEL);

export function statusText(a: Action): string {
  if (a.status === 'awaiting_approval') return `waits for ${roleLabel(a.ownerRole)}`;
  if (a.status === 'auto') return 'running';
  if (a.status === 'approved' || a.status === 'rejected') return a.decidedBy.startsWith('person:') ? `${a.status} by ${a.decidedBy.slice(7)}` : a.status;
  return a.status;
}

const chipTone = (s: string) => (s === 'awaiting_approval' ? 'hold' : s === 'rejected' ? 'alert' : s === 'approved' || s === 'done' ? 'ok' : s === 'cancelled' ? 'off' : 'run');

function StatusChip({ a }: { a: Action }) {
  return <span className={`rd-chip rd-chip--${chipTone(a.status)}`}>{statusText(a)}</span>;
}

export function incidentLabel(inc: Incident | undefined, key: string): string {
  if (!inc) return key;
  const b = parse<{ session_type?: string; impact_kph?: number }>(inc.beliefJson, {});
  const where = b.session_type ? `${b.session_type} ` : '';
  const kph = b.impact_kph ? ` · ${b.impact_kph} km/h` : '';
  return `${carLabel(inc.driverNumber)} · ${where}${clock(inc.firstSeenAt)}${kph}`;
}

export function respondHeadline(race: RaceData): Headline {
  const waiting = race.actions.filter((a) => a.status === 'awaiting_approval');
  const decision = waiting.find((a) => a.kind === 'withdraw_car');
  if (decision) {
    const d = parse<Decision>(decision.detailJson, {});
    const rec = d.options?.find((o) => o.id === d.recommendation);
    return { value: `Car ${d.car ?? ''}: decide`, note: rec ? `desk recommends: ${rec.label.toLowerCase()}` : decision.title, tone: 'hold' };
  }
  if (waiting.length) return { value: `${waiting.length} to decide`, note: waiting[0]!.title, tone: 'hold' };
  const live = race.actions.filter((a) => a.status !== 'cancelled');
  return { value: `${live.length} actions`, note: live.length ? 'running on their own' : 'nothing set off yet', tone: live.length ? 'ok' : 'muted' };
}

const hours = (h: number) => `${h.toFixed(1)} h`;

function DecisionCard({ a }: { a: Action }) {
  const race = useRace();
  const d = parse<Decision>(a.detailJson, {});
  const options = d.options ?? [];
  const available = d.hours_available ?? 0;
  const rec = options.find((o) => o.id === d.recommendation);
  const scale = Math.max(available, ...options.map((o) => o.hours_needed[2] ?? 0), 1);
  const waiting = a.status === 'awaiting_approval';
  return (
    <article className={`rd-decision ${waiting ? 'rd-decision--waiting' : ''}`} aria-labelledby={`dec-${a.actionKey}`}>
      <header className="rd-decision-head">
        <h3 id={`dec-${a.actionKey}`}>
          Car {d.car}: start or withdraw?
        </h3>
        <StatusChip a={a} />
        {a.dueAt && <span className="mono muted">decide by {clock(a.dueAt)} UTC</span>}
      </header>
      <p className="rd-decision-facts mono">
        <span>{hours(available)} from the crash to the start{d.race_start ? ` (${clock(d.race_start)} UTC)` : ''}</span>
        <span>grid {d.grid ? `P${d.grid}` : '?'}{d.grid_basis ? ` (${d.grid_basis})` : ''}</span>
        <span>P(heavy) {(d.p_heavy ?? 0).toFixed(2)}</span>
        <span>P(tub damaged) {(d.p_tub ?? 0).toFixed(2)}</span>
      </p>
      <ol className="rd-options">
        {options.map((o) => {
          const recommended = o.id === d.recommendation;
          const mid = o.hours_needed[1] ?? 0;
          return (
            <li key={o.id} className={`rd-option ${recommended ? 'rd-option--rec' : ''} ${o.feasible ? '' : 'rd-option--out'}`}>
              <div className="rd-option-top">
                <b>{o.label}</b>
                {recommended && <span className="rd-chip rd-chip--ok">recommended</span>}
                <span className={`rd-chip ${o.feasible ? 'rd-chip--run' : 'rd-chip--alert'}`}>{o.feasible ? 'fits the time' : 'does not fit'}</span>
              </div>
              <div className="rd-hours" role="img" aria-label={`${hours(mid)} needed against ${hours(available)} available`}>
                <span className="rd-hours-need" style={{ width: `${Math.min(100, (mid / scale) * 100)}%` }} />
                <span className="rd-hours-avail" style={{ left: `${Math.min(100, (available / scale) * 100)}%` }} />
              </div>
              <dl className="rd-option-figs">
                <div>
                  <dt>hours needed</dt>
                  <dd className="mono">
                    {hours(mid)} <span className="muted">({o.hours_needed[0]}–{o.hours_needed[2]})</span> vs {hours(available)}
                  </dd>
                </div>
                <div>
                  <dt>cost</dt>
                  <dd className="mono">
                    {usdShort(o.cost_cents[1] ?? 0)} <span className="muted">({usdShort(o.cost_cents[0] ?? 0)}–{usdShort(o.cost_cents[2] ?? 0)})</span>
                  </dd>
                </div>
                <div>
                  <dt>expected points</dt>
                  <dd className="mono">{o.expected_points.toFixed(1)}</dd>
                </div>
              </dl>
              <p className="muted rd-risk">{o.risk}</p>
            </li>
          );
        })}
      </ol>
      {d.recommendation_why && (
        <p className="rd-why">
          <b>Why: </b>
          {d.recommendation_why}
        </p>
      )}
      {d.standings && <p className="muted">{d.standings}</p>}
      {d.outcome && <p className="rd-outcome">What happened: {d.outcome}</p>}
      {waiting && (
        <div className="decide-actions">
          <ActButton label={rec ? `Approve: ${rec.label.toLowerCase()}` : 'Approve'} primary run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'approved', by, at })} />
          <ActButton label="Reject" run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'rejected', by, at })} />
        </div>
      )}
    </article>
  );
}

function SparesStrip({ actions }: { actions: readonly Action[] }) {
  const parts = useMemo(() => {
    const by = new Map<string, { label: string; before: number; used: number; grove: number; made: number }>();
    for (const a of actions) {
      if (a.kind !== 'spares_reserve' || a.status === 'cancelled' || a.status === 'rejected') continue;
      const d = parse<Reserve>(a.detailJson, {});
      const part = d.part ?? a.actionKey;
      const row = by.get(part) ?? { label: d.label ?? part, before: d.manifest_at_track ?? 0, used: 0, grove: 0, made: 0 };
      row.before = Math.max(row.before, d.manifest_at_track ?? 0);
      if (d.source === 'factory') row.grove += 1;
      else if (d.source === 'make') row.made += 1;
      else row.used += 1;
      by.set(part, row);
    }
    return [...by.entries()].sort((x, y) => y[1].used + y[1].grove + y[1].made - (x[1].used + x[1].grove + x[1].made) || x[0].localeCompare(y[0]));
  }, [actions]);
  if (!parts.length) return null;
  return (
    <section className="rd-spares" aria-label="Spares at track">
      <h3 className="rd-sub">Spares at track</h3>
      <ul>
        {parts.map(([part, r]) => {
          const after = Math.max(r.before - r.used, 0);
          return (
            <li key={part} className={after === 0 ? 'rd-spare--out' : ''}>
              <span className="rd-spare-name">{r.label}</span>
              <span className="mono">
                {r.before} → {after}
              </span>
              <span className="muted rd-spare-note">
                {after === 0 ? 'none left' : `${after} left`}
                {r.grove ? ` · ${r.grove} from Grove` : ''}
                {r.made ? ` · ${r.made} to make` : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function detailFacts(a: Action): [string, string][] {
  const d = parse<Record<string, unknown>>(a.detailJson, {});
  const out: [string, string][] = [];
  const cost = d.cost_cents as number[] | undefined;
  if (Array.isArray(cost)) out.push(['cost', `${usdShort(cost[1] ?? 0)} (${usdShort(cost[0] ?? 0)}–${usdShort(cost[2] ?? 0)})`]);
  if (typeof d.route === 'string') out.push(['route', d.route]);
  if (typeof d.ready_at === 'string') out.push(['ready', d.ready_at.slice(0, 10)]);
  if (Array.isArray(d.parts)) out.push(['parts', (d.parts as unknown[]).map((p) => (typeof p === 'string' ? p : (p as { label?: string }).label ?? '')).join(', ').replace(/_/g, ' ')]);
  if (typeof d.draft === 'string') out.push(['draft', d.draft]);
  if (typeof d.penalty_risk === 'number' && d.penalty_risk > 0) out.push(['penalty risk', `${Math.round(d.penalty_risk * 100)}%`]);
  if (Array.isArray(d.moves)) out.push(['moves', (d.moves as { label: string; from: string; to: string }[]).map((m) => `${m.label}: ${m.from} → ${m.to}`).join('; ')]);
  if (Array.isArray(d.evidence)) out.push(['evidence', `${(d.evidence as unknown[]).length} items`]);
  return out;
}

function ActionRow({ a }: { a: Action }) {
  const race = useRace();
  const d = parse<{ why?: string }>(a.detailJson, {});
  const facts = detailFacts(a);
  return (
    <li className={`action action--${a.status} rd-action`}>
      <div className="action-top">
        <span className="mono muted rd-kind">{KIND_LABEL[a.kind] ?? a.kind.replace(/_/g, ' ')}</span>
        <b className="rd-title">{a.title}</b>
        <StatusChip a={a} />
        {a.dueAt && <span className="mono muted">due {a.dueAt.slice(5, 10)} {clock(a.dueAt)}</span>}
      </div>
      {(d.why || facts.length > 0) && (
        <details className="rd-details">
          <summary>Why and detail</summary>
          {d.why && <p className="muted">{d.why}</p>}
          {facts.length > 0 && (
            <dl className="rd-facts">
              {facts.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </details>
      )}
      {a.status === 'awaiting_approval' && (
        <div className="decide-actions">
          <ActButton label="Approve" primary run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'approved', by, at })} />
          <ActButton label="Reject" run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'rejected', by, at })} />
        </div>
      )}
    </li>
  );
}

const rank = (a: Action) => (a.status === 'awaiting_approval' ? 0 : a.status === 'cancelled' ? 2 : 1);

export function RespondPanel() {
  const race = useRace();
  const decisions = useMemo(
    () => race.actions.filter((a) => a.kind === 'withdraw_car' && a.status === 'awaiting_approval').sort((x, y) => sortTime(x.dueAt || x.updatedAt) - sortTime(y.dueAt || y.updatedAt)),
    [race.actions]
  );
  const groups = useMemo(() => {
    const incidents = new Map(race.incidents.map((i) => [i.incidentKey, i]));
    const by = new Map<string, Action[]>();
    for (const a of race.actions) {
      if (a.kind === 'withdraw_car' && a.status === 'awaiting_approval') continue;
      const list = by.get(a.incidentKey) ?? [];
      list.push(a);
      by.set(a.incidentKey, list);
    }
    return [...by.entries()]
      .map(([key, list]) => ({
        key,
        incident: incidents.get(key),
        live: list.filter((a) => a.status !== 'cancelled').sort((x, y) => rank(x) - rank(y) || KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || x.actionKey.localeCompare(y.actionKey)),
        cancelled: list.filter((a) => a.status === 'cancelled'),
      }))
      .sort((x, y) => sortTime(x.incident?.firstSeenAt ?? '') - sortTime(y.incident?.firstSeenAt ?? '') || x.key.localeCompare(y.key));
  }, [race.actions, race.incidents]);

  if (!race.actions.length) return <p className="muted">No actions yet.</p>;
  return (
    <div className="rd">
      {decisions.map((a) => (
        <DecisionCard key={a.actionKey} a={a} />
      ))}
      <SparesStrip actions={race.actions} />
      {groups.map((g) => {
        const waiting = g.live.filter((a) => a.status === 'awaiting_approval').length;
        return (
          <details key={g.key} className="rd-group" open={waiting > 0}>
            <summary>
              <span className="rd-group-name">{incidentLabel(g.incident, g.key)}</span>
              <span className="mono muted">
                {g.live.length} action{g.live.length === 1 ? '' : 's'}
                {waiting ? ` · ${waiting} waiting` : ''}
              </span>
            </summary>
            <ul className="actions">
              {g.live.map((a) => (a.kind === 'withdraw_car' ? <li key={a.actionKey} className="rd-decided"><DecisionCard a={a} /></li> : <ActionRow key={a.actionKey} a={a} />))}
            </ul>
            {g.cancelled.length > 0 && (
              <details className="rd-cancelled">
                <summary className="muted">{g.cancelled.length} no longer needed</summary>
                <ul className="actions">
                  {g.cancelled.map((a) => (
                    <ActionRow key={a.actionKey} a={a} />
                  ))}
                </ul>
              </details>
            )}
          </details>
        );
      })}
    </div>
  );
}
