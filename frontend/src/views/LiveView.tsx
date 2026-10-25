import { useMemo, useState, type ReactNode } from 'react';
import { Figure } from '../components/Figure';
import { ExposureTally, FeedStrip, PlanCard, StrategyCards, usePlansNow } from '../components/StrategyDesk';
import { IconAgent, IconApproved, IconChart, IconDenied, IconDoc, IconExternal, IconFlag, IconLive, IconPlay, IconQuestion, IconStop, IconWaiting } from '../components/icons';
import {
  BRAZIL,
  SPA,
  useLive,
  type DriverState,
  type FinanceImpactUpdate,
  type FinancialImpact,
  type Handoff,
  type IncidentSignal,
  type JevDecision,
  type JevDecisionRecord,
  type Published,
  type RaceStateUpdate,
  type ReplayStatus,
  type ResultChangeSignal,
} from '../lib/live';

// The live race: what the race just did to the money, as the feed publishes it. Everything on this
// page is a sporting fact or a calculation; nothing here is booked, approved or classified. Lime is
// kept for the person's primary action (starting and resuming a replay); amber is waiting; the race
// flags, the sporting confirmations and Jev's decisions are neutral chips with an icon and a word.

const PAUSE_LAP = 32;
const CAR_NAMES: Record<number, string> = { 63: 'Russell', 44: 'Hamilton' };
const RACE_NAMES: Record<string, string> = { [BRAZIL]: '2024 São Paulo Grand Prix', [SPA]: '2024 Belgian Grand Prix' };

/** The feed's own compact form: $2.74M, $260k, $4,352. */
function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const d = cents / 100;
  const a = Math.abs(d);
  const sign = d < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}
const delta = (c: number | null | undefined) => (c === null || c === undefined ? '—' : c > 0 ? `+${money(c)}` : c < 0 ? money(c) : '±$0');
const utcClock = (iso: string | null | undefined) => (iso && iso.length >= 19 ? iso.slice(11, 19) : '—');
const utcDay = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
const words = (s: string | null | undefined) => (s ?? '—').replace(/_/g, ' ');
const sentence = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

const FLAG_WORDS: Record<string, string> = {
  GREEN: 'Green flag',
  CLEAR: 'Green flag',
  YELLOW: 'Yellow flag',
  DOUBLE_YELLOW: 'Double yellow',
  SAFETY_CAR: 'Safety car',
  VIRTUAL_SAFETY_CAR: 'Virtual safety car',
  VSC: 'Virtual safety car',
  RED_FLAG: 'Red flag',
  RED: 'Red flag',
  CHEQUERED: 'Chequered flag',
  FINISHED: 'Chequered flag',
};
const flagWord = (f: string | null | undefined) => (f ? FLAG_WORDS[f] ?? sentence(words(f).toLowerCase()) : 'No flag yet');
const COMPOUND: Record<string, string> = { SOFT: 'Softs', MEDIUM: 'Mediums', HARD: 'Hards', INTERMEDIATE: 'Intermediates', WET: 'Wets' };
const compound = (c: string | null | undefined) => (c ? COMPOUND[c] ?? sentence(words(c).toLowerCase()) : 'tyre unknown');
const DRIVER_STATUS: Record<DriverState['status'], string> = { running: 'Running', in_pit: 'In the pits', stopped_candidate: 'Stopped?', dns: 'Did not start', retired: 'Out', unknown: 'Unknown' };

const TYPE_WORDS: Record<IncidentSignal['type'], string> = {
  potential_crash: 'Potential crash',
  red_flag_unattributed: 'Red flag, no driver named',
  incident_noted: 'Incident noted by race control',
};
const ATTRIBUTION: Record<IncidentSignal['driver_attribution'], string> = {
  none: 'no driver attributed',
  provisionally_correlated: 'provisionally correlated from car data',
  named_by_race_control: 'named by race control',
  confirmed: 'confirmed by a public source',
};
const CONFIRMATION: Record<IncidentSignal['sporting_confirmation'], string> = {
  incident_candidate: 'Incident candidate',
  needs_confirmation: 'Needs confirmation',
  retired_per_timing: 'Retired, per the timing feed',
  verified_historical_incident: 'Verified historical incident',
};
const DAMAGE: Record<IncidentSignal['damage_confirmation'], string> = {
  none: 'no garage report',
  awaiting_synthetic_garage_report: 'awaiting the synthetic garage report',
  synthetic_garage_report_received: 'synthetic garage report received',
};
const ROUTE: Record<string, string> = {
  crash_finance: 'crash finance',
  revenue_change: 'revenue change',
  race_forecast: 'race forecast',
  human_review: 'a person',
  no_action: 'no action',
};
const HANDOFF_TARGET: Record<string, string> = { cost_cap_agent: 'the cost cap desk', revenue_desk: 'the revenue desk', human_review: 'a person', none: 'nobody' };
const JEV_STATUS: Record<JevDecision['status'], string> = {
  ok: 'decided',
  low_confidence: 'low confidence, sent to a person',
  overridden: 'overridden by code',
  unavailable: 'unavailable',
  disabled: 'not called',
  invalid_response: 'answered in an odd shape',
  budget_exhausted: 'budget exhausted',
  cached: 'answered from cache',
};

type Tone = 'neutral' | 'hold' | 'ok' | 'alert';

/** A status, always with its icon and its word (never a colour alone). */
function Chip({ tone = 'neutral', icon, title, children }: { tone?: Tone; icon?: ReactNode; title?: string; children: ReactNode }) {
  return (
    <span className={`flag ${tone === 'neutral' ? 'flag--neutral' : `flag--${tone}`}`} title={title}>
      {icon}
      <span>{children}</span>
    </span>
  );
}

function JevChip({ j }: { j: JevDecision }) {
  const chosen = ROUTE[j.chosen_route] ?? words(j.chosen_route);
  const said = j.route ? ROUTE[j.route] ?? words(j.route) : null;
  const conf = j.route_confidence !== null ? `${(j.route_confidence * 100).toFixed(0)}%` : null;
  const tail = [j.urgency ? `urgency ${j.urgency}` : null, j.latency_ms !== null ? `${j.latency_ms} ms` : null].filter(Boolean).join(' · ');
  let label: string;
  if (!j.used) {
    label =
      j.status === 'disabled'
        ? `Jev not called · route by rule: ${chosen}`
        : `Jev ${JEV_STATUS[j.status] ?? words(j.status)} · deterministic fallback: ${chosen}`;
  } else if (j.status === 'low_confidence') {
    label = `Jev said ${said ?? chosen}${conf ? ` at ${conf}` : ''}, below the gate · a person decides`;
  } else if (j.status === 'overridden') {
    label = `Jev said ${said ?? 'no action'}${conf ? ` at ${conf}` : ''} · overridden by code to ${chosen}`;
  } else {
    label = `Jev routed to ${chosen}${conf ? ` · confidence ${conf}` : ''}${j.status === 'cached' ? ' · from cache' : ''}`;
  }
  return (
    <Chip icon={<IconAgent size={12} />} title={j.reason}>
      {label}
      {tail ? ` · ${tail}` : ''}
    </Chip>
  );
}

function HandoffChip({ h }: { h: Handoff }) {
  const target = HANDOFF_TARGET[h.target] ?? words(h.target);
  switch (h.status) {
    case 'requested':
      return (
        <Chip tone="hold" icon={<IconWaiting size={12} />}>
          Hand-off to {target} requested{h.requested_at_utc ? ` · ${utcClock(h.requested_at_utc)}` : ''}
        </Chip>
      );
    case 'acknowledged':
      return (
        <Chip tone="hold" icon={<IconWaiting size={12} />}>
          Acknowledged by {target}, assessment pending
        </Chip>
      );
    case 'pending':
      return (
        <Chip tone="hold" icon={<IconWaiting size={12} />}>
          Hand-off to {target} pending
        </Chip>
      );
    case 'assessed':
      return (
        <Chip icon={<IconApproved size={12} />}>
          Assessed by {target}
          {h.finance_impact_ref ? ` · ${h.finance_impact_ref}` : ''}
        </Chip>
      );
    default:
      return <span className="muted small">No hand-off requested</span>;
  }
}

function ImpactChip({ fi }: { fi: FinancialImpact }) {
  if (fi.status === 'synthetic_projected_not_booked') {
    return (
      <Chip icon={<IconChart size={12} />}>
        Financial impact {money(fi.amount_cents)}, projected, not booked
      </Chip>
    );
  }
  if (fi.status === 'pending') {
    return (
      <Chip tone="hold" icon={<IconWaiting size={12} />}>
        Financial impact pending
      </Chip>
    );
  }
  return <Chip icon={<IconQuestion size={12} />}>Financial impact unknown</Chip>;
}

function StateChip({ state }: { state: ReplayStatus['state'] }) {
  switch (state) {
    case 'fast_forward':
      return <Chip icon={<IconPlay size={12} />}>Fast-forwarding to the window</Chip>;
    case 'running':
      return <Chip icon={<IconLive size={12} />}>Running</Chip>;
    case 'paused':
      return (
        <Chip tone="hold" icon={<IconWaiting size={12} />}>
          Paused, waiting for a person to resume
        </Chip>
      );
    case 'finished':
      return <Chip icon={<IconApproved size={12} />}>Finished</Chip>;
    case 'stopped':
      return <Chip icon={<IconStop size={12} />}>Stopped</Chip>;
    case 'error':
      return (
        <Chip tone="alert" icon={<IconDenied size={12} />}>
          Error
        </Chip>
      );
    default:
      return <Chip>Idle</Chip>;
  }
}

function ResultStatusChip({ status }: { status: ResultChangeSignal['status'] }) {
  switch (status) {
    case 'at_risk':
      return (
        <Chip tone="hold" icon={<IconWaiting size={12} />}>
          Result at risk: a Meridian car is summoned
        </Chip>
      );
    case 'provisional_expected_bonus_corrected_awaiting_recognized_revenue_policy_gate':
      return (
        <Chip tone="hold" icon={<IconWaiting size={12} />}>
          Provisional expected bonus corrected; awaiting recognized-revenue policy gate
        </Chip>
      );
    case 'final':
      return <Chip icon={<IconApproved size={12} />}>Final classification: the revenue desk books from it</Chip>;
    default:
      return <Chip icon={<IconDoc size={12} />}>Provisional classification: memos only</Chip>;
  }
}

// ---------------------------------------------------------------- panels

function Controls() {
  const live = useLive();
  const [pause, setPause] = useState(true);
  const rp = live.replay;
  const active = rp !== null && (rp.state === 'fast_forward' || rp.state === 'running' || rp.state === 'paused');
  const wait = live.busy !== null;
  return (
    <div className="run-actions">
      <button className="btn btn--primary" onClick={() => void live.startBrazil(pause ? PAUSE_LAP : null)} disabled={wait || active}>
        <IconPlay size={14} /> {live.busy === 'Starting the São Paulo replay' ? live.busy : 'Start São Paulo, laps 28 to 34 at 20×'}
      </button>
      <label className="replay-option">
        <input type="checkbox" checked={pause} onChange={(e) => setPause(e.target.checked)} disabled={active} /> pause at lap {PAUSE_LAP}
      </label>
      <button className="btn" onClick={() => void live.startSpa()} disabled={wait || active}>
        <IconDoc size={14} /> {live.busy === 'Starting the Spa replay' ? live.busy : 'Replay Spa from the FIA documents'}
      </button>
      {rp?.state === 'paused' && (
        <button className="btn btn--primary" onClick={() => void live.resume()} disabled={wait}>
          <IconPlay size={14} /> Resume
        </button>
      )}
      {active && (
        <button className="btn" onClick={() => void live.stop()} disabled={wait}>
          <IconStop size={14} /> Stop
        </button>
      )}
    </div>
  );
}

function ReplayPanel() {
  const live = useLive();
  const rp = live.replay;
  const m = live.metrics;
  const pct = rp && rp.events_total ? Math.min(100, (rp.events_done / rp.events_total) * 100) : 0;
  const noKey = (mode: string | undefined) => /no TYPESAFE_API_KEY|deterministic_fallback/.test(mode ?? '');
  const jevLatency = !m ? '—' : m.jev.p50_ms !== null ? `${m.jev.p50_ms} ms p50 · ${m.jev.p95_ms} ms p95` : noKey(m.jev.mode) ? 'not measured: no key' : 'not measured yet';
  const pub = m?.publish;
  const publishLatency =
    pub && pub.adapter_received_to_published_p95_ms !== null && pub.adapter_received_to_published_p95_ms !== undefined
      ? `${pub.adapter_received_to_published_p50_ms ?? '—'} ms p50 · ${pub.adapter_received_to_published_p95_ms} ms p95`
      : 'not measured';
  const byKind = m ? Object.entries(m.jev.calls_by_candidate_kind ?? {}) : [];
  return (
    <section aria-labelledby="replay-h" className="replay-panel">
      <div className="replay-status">
        <div className="sec-head">
          <h2 id="replay-h">Replay</h2>
          <p className="muted">
            Real 2024 OpenF1 records and FIA documents, replayed with the source's own times. Nothing is booked from here: the feed tells the desks what
            the race did to the money and hands incidents over with evidence.
          </p>
        </div>
        {rp ? (
          <>
            <div className="chip-row">
              <StateChip state={rp.state} />
              <Chip icon={<IconLive size={12} />}>{rp.mode === 'live' ? 'Live' : 'Replay'}</Chip>
            </div>
            <p className="mono small replay-line">
              {RACE_NAMES[rp.race_id] ?? words(rp.race_id)} · {rp.replay_id} · {rp.events_done.toLocaleString('en-US')} of {rp.events_total.toLocaleString('en-US')} events ·{' '}
              {rp.speed === null ? 'as fast as possible' : `${rp.speed}×`}
              {rp.lap !== null ? ` · lap ${rp.lap}` : ''}
              {rp.clock_utc ? ` · ${utcClock(rp.clock_utc)} UTC` : ''}
            </p>
            <span className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="replay progress">
              <span className="progress-fill progress-fill--steel" style={{ width: `${pct}%` }} />
            </span>
            <p className="muted small">
              Jev (TypeSafe System One): {rp.jev_mode} · <span className="mono">{rp.jev_requests}</span> requests, <span className="mono">{rp.jev_errors}</span> errors ·{' '}
              <span className="mono">{rp.incidents}</span> incidents · <span className="mono">{rp.duplicates_suppressed}</span> duplicates suppressed · sinks: {rp.sinks.join(', ')}
            </p>
            {rp.error && (
              <p className="outcome outcome--alert">
                <IconDenied size={14} />
                <span>{rp.error}</span>
              </p>
            )}
          </>
        ) : (
          <p className="muted small">No replay has run in this API process yet. Start one above.</p>
        )}
        <p className="muted small">
          Feed: {live.online ? 'live API reachable' : 'live API not reachable'} · {live.streaming ? 'event stream open' : 'event stream closed, polling only'}
        </p>
      </div>
      <div className="metrics">
        <h3>
          <IconChart size={14} /> Measured on this machine
        </h3>
        {m ? (
          <dl className="kv">
            <div>
              <dt>Jev latency</dt>
              <dd className="mono">{jevLatency}</dd>
            </div>
            <div>
              <dt>Jev requests</dt>
              <dd className="mono">
                {m.jev.requests} · {m.jev.errors} errors · {m.jev.cache_hits} cached
              </dd>
            </div>
            <div>
              <dt>Jev calls on telemetry ticks</dt>
              <dd className="mono">{m.jev.calls_on_telemetry_ticks ?? 'n/a: document replay'}</dd>
            </div>
            <div>
              <dt>Calls by candidate kind</dt>
              <dd className="mono">{byKind.length ? byKind.map(([k, v]) => `${words(k)} ${v}`).join(' · ') : 'none'}</dd>
            </div>
            <div>
              <dt>Adapter received to published</dt>
              <dd className="mono">{publishLatency}</dd>
            </div>
            <div>
              <dt>Duplicates suppressed</dt>
              <dd className="mono">{m.duplicates_suppressed ?? 'n/a: document replay'}</dd>
            </div>
            <div>
              <dt>Published records</dt>
              <dd className="mono">
                {m.publish.count}
                {m.state_updates !== undefined ? ` · ${m.state_updates} state updates` : ''}
                {m.incidents !== undefined ? ` · ${m.incidents} incidents` : ''}
                {m.signals !== undefined ? ` · ${m.signals} result signals` : ''}
              </dd>
            </div>
            <div>
              <dt>Sinks</dt>
              <dd className="mono">{m.sinks.join(', ')}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted small">No metrics until a replay runs. Latencies are measured, never forged: absent means not measured.</p>
        )}
      </div>
    </section>
  );
}

function RaceClock({ race, replay }: { race: RaceStateUpdate | null; replay: ReplayStatus | null }) {
  const t = [replay?.clock_utc ?? '', race?.event_time_utc ?? ''].sort().at(-1) || null;
  const w = race?.weather;
  const documentsOnly = !race && replay?.race_id === SPA;
  return (
    <section aria-labelledby="clock-h">
      <div className="sec-head">
        <h2 id="clock-h">Race clock</h2>
        <p className="muted">The source's time (OpenF1, UTC), never the replay's wall clock dressed up as the race's.</p>
      </div>
      <div className="race-line">
        <span className="race-clock" aria-label="race time">
          {utcClock(t)}
        </span>
        <span className="muted mono">UTC · {utcDay(t)}</span>
        <span className="race-lap">Lap {(replay?.race_id === race?.race_id ? replay?.lap : null) ?? race?.lap ?? '—'}</span>
        <Chip icon={<IconFlag size={12} />}>{flagWord(race?.flag_status)}</Chip>
        <Chip icon={<IconLive size={12} />}>{(race?.mode ?? replay?.mode) === 'live' ? 'Live' : 'Replay'}</Chip>
      </div>
      {w ? (
        <p className="weather">
          Weather measured at <span className="mono">{utcClock(w.observed_at_utc)}</span>: {w.rainfall ? 'rain observed' : 'no rain'} · track <b className="mono">{w.track_temperature_c ?? '—'} °C</b> ·
          air <b className="mono">{w.air_temperature_c ?? '—'} °C</b> · humidity <b className="mono">{w.humidity ?? '—'}%</b> · wind <b className="mono">{w.wind_speed ?? '—'} m/s</b> from{' '}
          <b className="mono">{w.wind_direction ?? '—'}°</b>
        </p>
      ) : (
        <p className="muted small">
          {documentsOnly ? 'No telemetry on this replay: the Belgian Grand Prix is replayed from the FIA documents alone.' : 'No weather measurement yet.'}
        </p>
      )}
      {race?.note && <p className="muted small">{race.note}</p>}
    </section>
  );
}

function Cars({ race, moves }: { race: RaceStateUpdate | null; moves: Published<RaceStateUpdate>[] }) {
  const cars = race?.team_cars?.length ? race.team_cars : [63, 44];
  const fc = race?.forecast;
  const field = race ? [...race.driver_states].sort((a, b) => (a.position ?? 99) - (b.position ?? 99)) : [];
  return (
    <section aria-labelledby="cars-h">
      <div className="sec-head">
        <h2 id="cars-h">The two cars and the money on them</h2>
        <p className="muted">
          Meridian Racing mirrors Mercedes' real 2024 results: cars 63 and 44. The exposure is what the sponsor contracts would pay if the race ended
          now. It is indicative and unbooked, and every dollar is synthetic.
        </p>
      </div>
      <div className="table-wrap">
        <table className="data data--tight cars">
          <thead>
            <tr>
              <th className="num">Car</th>
              <th>Driver</th>
              <th className="num">Position</th>
              <th>Tyres</th>
              <th className="num">Tyre age</th>
              <th>Status</th>
              <th className="num">Last stop</th>
            </tr>
          </thead>
          <tbody>
            {cars.map((n) => {
              const d = race?.driver_states.find((x) => x.driver_number === n);
              return (
                <tr key={n}>
                  <td className="num mono">{n}</td>
                  <td>
                    {CAR_NAMES[n] ?? d?.name_acronym ?? '—'}
                    {d?.name_acronym && <span className="muted mono"> {d.name_acronym}</span>}
                  </td>
                  <td className="num mono">{d?.position ? `P${d.position}` : '—'}</td>
                  <td>{d ? compound(d.compound) : '—'}</td>
                  <td className="num mono">{d?.tyre_age_laps ?? '—'}</td>
                  <td>{d ? DRIVER_STATUS[d.status] : 'No state yet'}</td>
                  <td className="num mono">{d?.last_pit_lap ? `lap ${d.last_pit_lap}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="exposure">
        <span>If the race ended now, sponsor bonuses of</span>
        {fc && fc.amount_cents !== null ? <Figure value={fc.amount_cents} format={money} /> : <b>—</b>}
        <span className="chip-row">
          <span className="treat">{words(fc?.status ?? 'indicative')}</span>
          <span className="treat">unbooked</span>
          <span className="treat">synthetic</span>
        </span>
      </p>
      {fc?.basis && (
        <p className="muted small">
          {sentence(fc.basis)}
          {fc.as_of_utc ? ` · as of ${utcClock(fc.as_of_utc)} UTC` : ''}
        </p>
      )}
      {fc && fc.lines.length > 0 && (
        <ul className="lines-list">
          {fc.lines.map((l, i) => (
            <li key={`${l.sponsor_id}:${l.clause_id}:${l.car}:${i}`}>
              <span className="mono">{money(l.amount_usd_cents)}</span>
              <span>
                {l.sponsor_name} clause {l.clause_id}, {words(l.clause_type)}, car {l.car}
                {l.position ? ` P${l.position}` : ''}
                {l.currency !== 'USD' ? ` (${l.currency} at ${l.fx_rate})` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {fc?.prize && <p className="muted small">{fc.prize.note}</p>}
      <h3>What every lever costs</h3>
      <StrategyCards fmt={money} names={CAR_NAMES} />
      <h3>Every time the exposure moved</h3>
      {moves.length === 0 ? (
        <p className="muted small">No move yet in this replay.</p>
      ) : (
        <ol className="moves">
          {moves.map((m) => {
            const ch = m.payload.forecast_change!;
            const tone = (ch.delta_cents ?? 0) < 0 ? 'down' : (ch.delta_cents ?? 0) > 0 ? 'up' : 'flat';
            return (
              <li key={m.payload.event_id} className={`move move--${tone}`}>
                <span className="mono muted">
                  {utcClock(m.payload.event_time_utc)} · lap {m.payload.lap ?? '—'}
                </span>
                <span>
                  <b className="mono">
                    {money(ch.before_cents)} → {money(ch.after_cents)}
                  </b>{' '}
                  <span className="mono muted">({delta(ch.delta_cents)})</span>
                  <span className="block small">{ch.text}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {field.length > cars.length && (
        <details className="classification">
          <summary>Full running order, {field.length} cars</summary>
          <div className="table-wrap">
            <table className="data data--tight">
              <thead>
                <tr>
                  <th className="num">Pos</th>
                  <th className="num">Car</th>
                  <th>Driver</th>
                  <th>Team</th>
                  <th>Tyres</th>
                  <th className="num">Age</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {field.map((d) => (
                  <tr key={d.driver_number} className={cars.includes(d.driver_number) ? 'row--team' : undefined}>
                    <td className="num mono">{d.position ?? '—'}</td>
                    <td className="num mono">{d.driver_number}</td>
                    <td>{d.name_acronym ?? '—'}</td>
                    <td>{d.team ?? '—'}</td>
                    <td>{compound(d.compound)}</td>
                    <td className="num mono">{d.tyre_age_laps ?? '—'}</td>
                    <td>{DRIVER_STATUS[d.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function ImpactUpdate({ u }: { u: FinanceImpactUpdate }) {
  return (
    <div className="impact">
      <h3>
        <IconChart size={14} /> Finance impact update{u.received_at_utc ? ` · received ${utcClock(u.received_at_utc)} UTC` : ''}
      </h3>
      <dl className="kv">
        <div>
          <dt>Status</dt>
          <dd>{u.financial_status === 'pending' ? 'pending' : 'synthetic, projected, not booked'}</dd>
        </div>
        <div>
          <dt>Initial exposure</dt>
          <dd className="mono">{money(u.initial_exposure_cents)}</dd>
        </div>
        <div>
          <dt>Selected recovery cost</dt>
          <dd className="mono">{money(u.selected_recovery_cost_cents)}</dd>
        </div>
        <div>
          <dt>Forecast headroom after</dt>
          <dd className="mono">{money(u.forecast_headroom_after_cents)}</dd>
        </div>
        <div>
          <dt>Approvals needed</dt>
          <dd>
            {[u.requires_engineering_approval ? 'engineering' : null, u.requires_finance_approval ? 'finance' : null].filter(Boolean).join(' and ') || 'none stated'}
            {u.accounting_rule_version ? ` · rule ${u.accounting_rule_version}` : ''}
          </dd>
        </div>
        {u.evidence_refs.length > 0 && (
          <div>
            <dt>Evidence</dt>
            <dd className="mono">{u.evidence_refs.join(', ')}</dd>
          </div>
        )}
        {u.note && (
          <div>
            <dt>Note</dt>
            <dd>{u.note}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** The API's memory bus keeps every replay's records; this replay's come first, the rest fold away. */
function splitByReplay<T>(list: Published<T>[], startedAt: string): [Published<T>[], Published<T>[]] {
  if (!startedAt) return [list, []];
  return [list.filter((r) => r.published_at_utc >= startedAt), list.filter((r) => r.published_at_utc < startedAt)];
}

function Earlier({ count, children }: { count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <details className="earlier">
      <summary className="log-summary">From earlier replays in this API process · {count}</summary>
      {children}
    </details>
  );
}

function IncidentCards({ groups, impacts }: { groups: Published<IncidentSignal>[][]; impacts: Published<FinanceImpactUpdate>[] }) {
  const plans = usePlansNow();
  return (
    <div className="incidents">
      {groups.map((versions) => {
        const latest = versions[versions.length - 1].payload;
        const updates = impacts.filter((i) => i.payload.incident_id === latest.incident_id);
        const plan = plans.find((p) => p.incident_id === latest.incident_id) ?? null;
        return (
          <article className="incident" key={latest.incident_id} aria-label={latest.incident_id}>
            <div className="incident-head">
              <h3 className="incident-title">
                {TYPE_WORDS[latest.type]} · lap {latest.lap ?? '—'}
                {latest.driver_number ? ` · car ${latest.driver_number}` : ' · no car named'}
                {latest.driver_name ? `, ${latest.driver_name}` : ''}
                {latest.historical_team ? ` (${latest.historical_team}, the real team)` : ''}
              </h3>
              <span className="mono muted">{latest.incident_id}</span>
            </div>
            <p className="muted small">
              {RACE_NAMES[latest.race_id] ?? words(latest.race_id)} · sporting source date {latest.sporting_source_date} · financial world: {latest.synthetic_financial_world}
            </p>
            <ol className="versions">
              {versions.map((v) => {
                const p = v.payload;
                const waiting = p.handoff.status === 'requested' || p.handoff.status === 'acknowledged' || p.handoff.status === 'pending';
                return (
                  <li key={v.version} className={`version ${waiting ? 'version--hold' : ''}`}>
                    <div className="version-head">
                      <b className="mono">v{p.version}</b>
                      <span className="mono muted">
                        {utcClock(p.event_time_utc)} UTC at source · observed {utcClock(p.observed_at_utc)}
                      </span>
                      <span>
                        {TYPE_WORDS[p.type]}; driver {ATTRIBUTION[p.driver_attribution]}
                        {p.urgency ? `; urgency ${p.urgency}` : ''}
                      </span>
                    </div>
                    <div className="chip-row">
                      <Chip icon={p.sporting_confirmation === 'verified_historical_incident' ? <IconApproved size={12} /> : <IconQuestion size={12} />}>
                        {CONFIRMATION[p.sporting_confirmation]}
                      </Chip>
                      <JevChip j={p.jev} />
                      <ImpactChip fi={p.financial_impact} />
                      <HandoffChip h={p.handoff} />
                    </div>
                    <p className="version-message">{p.message}</p>
                    <p className="muted small">
                      Damage: {DAMAGE[p.damage_confirmation]}.{p.jev.reason ? ` Jev: ${p.jev.reason}.` : ''}
                      {p.jev.error ? ` Error: ${p.jev.error}.` : ''}
                    </p>
                    <ul className="evidence-list" aria-label="source evidence">
                      {p.source_evidence.map((e, i) => (
                        <li key={`${e.endpoint}:${e.event_time_utc ?? ''}:${i}`}>
                          <span className="mono">{utcClock(e.event_time_utc)}</span>
                          <span className="mono">
                            {e.system}/{e.endpoint}
                          </span>
                          <span>
                            {e.note ?? (e.record_id ? `record ${e.record_id}` : 'record')}{' '}
                            <a className="link" href={e.url} target="_blank" rel="noreferrer">
                              re-fetch <IconExternal size={11} />
                            </a>
                          </span>
                        </li>
                      ))}
                      {p.corroborating_source_url && (
                        <li>
                          <span className="mono">—</span>
                          <span className="mono">public report</span>
                          <span>
                            {p.corroboration_note}{' '}
                            <a className="link" href={p.corroborating_source_url} target="_blank" rel="noreferrer">
                              read it <IconExternal size={11} />
                            </a>
                          </span>
                        </li>
                      )}
                    </ul>
                  </li>
                );
              })}
            </ol>
            {plan && <PlanCard plan={plan} fmt={money} names={CAR_NAMES} />}
            {updates.map((u) => (
              <ImpactUpdate key={u.id} u={u.payload} />
            ))}
          </article>
        );
      })}
    </div>
  );
}

function groupIncidents(incidents: Published<IncidentSignal>[], currentRace: string | null): Published<IncidentSignal>[][] {
  const m = new Map<string, Published<IncidentSignal>[]>();
  for (const r of incidents) {
    const a = m.get(r.id) ?? [];
    a.push(r);
    m.set(r.id, a);
  }
  const list = [...m.values()].map((vs) => [...vs].sort((a, b) => a.version - b.version));
  list.sort((a, b) => {
    const ca = a[0].payload.race_id === currentRace ? 0 : 1;
    const cb = b[0].payload.race_id === currentRace ? 0 : 1;
    return ca - cb || a[0].payload.event_time_utc.localeCompare(b[0].payload.event_time_utc);
  });
  return list;
}

function Incidents({ incidents, impacts, currentRace, startedAt }: { incidents: Published<IncidentSignal>[]; impacts: Published<FinanceImpactUpdate>[]; currentRace: string | null; startedAt: string }) {
  const [now, earlier] = useMemo(() => {
    const [a, b] = splitByReplay(incidents, startedAt);
    return [groupIncidents(a, currentRace), groupIncidents(b, currentRace)];
  }, [incidents, currentRace, startedAt]);
  return (
    <section aria-labelledby="inc-h">
      <div className="sec-head">
        <h2 id="inc-h">Incidents</h2>
        <p className="muted">
          Every version of every incident signal, in order. A red flag alone names no driver; a car is attached only from its own car data or a race
          control message, and confirmed only after the public report. The financial impact stays unknown until a garage report answers.
        </p>
      </div>
      {now.length === 0 ? <p className="muted small">No incident signal yet in this replay.</p> : <IncidentCards groups={now} impacts={impacts} />}
      <Earlier count={earlier.length}>
        <IncidentCards groups={earlier} impacts={impacts} />
      </Earlier>
    </section>
  );
}

function RoutingList({ list }: { list: Published<JevDecisionRecord>[] }) {
  return (
    <ol className="moments">
      {list.map((d) => (
        <li key={d.id} className="moment">
          <span className="mono">
            {utcClock(d.payload.at)}
            {d.payload.lap !== null && d.payload.lap !== undefined ? ` · lap ${d.payload.lap}` : ' · document'}
          </span>
          <span className="routing-body">
            <b>{sentence(words(d.payload.kind))}</b>
            {d.payload.drivers?.length ? <span className="muted"> · cars {d.payload.drivers.join(', ')}</span> : null}
            <span className="chip-row">
              <JevChip j={d.payload.decision} />
            </span>
            <span className="muted small block">{d.payload.message}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Routing({ list, startedAt }: { list: Published<JevDecisionRecord>[]; startedAt: string }) {
  const [now, earlier] = splitByReplay(list, startedAt);
  return (
    <section aria-labelledby="jev-h">
      <div className="sec-head">
        <h2 id="jev-h">Routing decisions</h2>
        <p className="muted">
          One typed request per material candidate to Jev (TypeSafe System One): route, urgency, needs evidence. Code keeps control: low confidence
          goes to a person, "no action" on a material event is overridden, and no key means the deterministic route, said so.
        </p>
      </div>
      {now.length === 0 ? <p className="muted small">No material candidate yet in this replay.</p> : <RoutingList list={now} />}
      <Earlier count={earlier.length}>
        <RoutingList list={earlier} />
      </Earlier>
    </section>
  );
}

function ResultList({ list }: { list: Published<ResultChangeSignal>[] }) {
  return (
    <ol className="results-list">
      {list.map((r) => {
        const p = r.payload;
        const waiting = p.status === 'at_risk' || p.status.startsWith('provisional_expected');
        return (
          <li key={`${r.id}#${r.version}`} className={`result ${waiting ? 'result--hold' : ''}`}>
            <div className="version-head">
              <span className="mono muted">{utcClock(p.event_time_utc)} UTC</span>
              <b>{p.document?.title ?? sentence(words(p.type))}</b>
              {p.document?.url && (
                <a className="link" href={p.document.url} target="_blank" rel="noreferrer">
                  FIA PDF <IconExternal size={11} />
                </a>
              )}
              {p.document?.cars?.length ? <span className="mono muted">cars {p.document.cars.join(', ')}</span> : null}
              {p.document?.likely_outcome ? <span className="muted">likely outcome: {words(p.document.likely_outcome)}</span> : null}
            </div>
            <div className="before-after">
              <div>
                <span className="muted small">Before · {words(p.before.type)}, {words(p.before.status)}</span>
                <b className="mono big">{money(p.before.amount_cents)}</b>
                <span className="muted small">{p.before.basis}</span>
              </div>
              <span className="mono delta" aria-label="change">
                {delta(p.change.delta_cents)}
              </span>
              <div>
                <span className="muted small">After · {words(p.after.type)}, {words(p.after.status)}</span>
                <b className="mono big">{money(p.after.amount_cents)}</b>
                <span className="muted small">{p.after.basis}</span>
              </div>
            </div>
            <div className="chip-row">
              <ResultStatusChip status={p.status} />
              <JevChip j={p.jev} />
              {p.handoff.status !== 'not_requested' && <HandoffChip h={p.handoff} />}
            </div>
            <p className="version-message">{p.message}</p>
            {(p.change.lost.length > 0 || p.change.gained.length > 0) && (
              <p className="muted small">
                {p.change.lost.length > 0 ? `Lost: ${p.change.lost.join('; ')}. ` : ''}
                {p.change.gained.length > 0 ? `Gained: ${p.change.gained.join('; ')}.` : ''}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ResultChanges({ list, startedAt }: { list: Published<ResultChangeSignal>[]; startedAt: string }) {
  const [now, earlier] = splitByReplay(list, startedAt);
  return (
    <section aria-labelledby="rc-h">
      <div className="sec-head">
        <h2 id="rc-h">Result changes from FIA documents</h2>
        <p className="muted">
          The 2024 Belgian Grand Prix: car 63 won on the road and was disqualified for an underweight car. Code did the arithmetic on the real
          documents; the revenue desk books only from the final classification and its own policy gate.
        </p>
      </div>
      {now.length === 0 ? (
        <p className="muted small">No result change in this replay. Replay Spa from the FIA documents to see one.</p>
      ) : (
        <ResultList list={now} />
      )}
      <Earlier count={earlier.length}>
        <ResultList list={earlier} />
      </Earlier>
    </section>
  );
}

function LogPanel({ log }: { log: string[] }) {
  return (
    <section aria-label="Replay log">
      <details>
        <summary className="log-summary">Replay log · {log.length} lines</summary>
        <pre className="job-log">{log.length ? log.join('\n') : 'nothing logged yet'}</pre>
      </details>
    </section>
  );
}

export function LiveView() {
  const live = useLive();

  if (!live.online) {
    return (
      <div className="empty-state">
        <h1>Live race</h1>
        <p className="muted">
          The live racing API isn't reachable. Start it with <code>make live-api</code> (port 8020) and this page fills in. With <code>spacetime start</code>{' '}
          running as well, the replay mirrors every record into the pit-wall database.
        </p>
      </div>
    );
  }

  const currentRace = live.replay?.race_id ?? null;
  return (
    <div className="live-race">
      <section className="run-bar" aria-label="Live race">
        <div>
          <h1>Live race</h1>
          <p className="muted intro">
            What the race is doing to the money, as it happens: the if-finished-now sponsor exposure, incident signals with their evidence and Jev's
            routing, and result changes from FIA documents. Real sporting facts, synthetic money, nothing booked.
          </p>
        </div>
        <Controls />
        {live.error && (
          <p className="outcome outcome--alert">
            <IconDenied size={14} />
            <span>{live.error}</span>
          </p>
        )}
      </section>
      <FeedStrip />
      <ExposureTally fmt={money} />
      <ReplayPanel />
      <RaceClock race={live.race} replay={live.replay} />
      <Cars race={live.race} moves={live.moves} />
      <Incidents incidents={live.incidents} impacts={live.financeImpacts} currentRace={currentRace} startedAt={live.replayStartedAt} />
      <Routing list={live.jevDecisions} startedAt={live.replayStartedAt} />
      <ResultChanges list={live.resultChanges} startedAt={live.replayStartedAt} />
      <LogPanel log={live.log} />
    </div>
  );
}
