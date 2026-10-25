import { useEffect, useState, type ReactNode } from 'react';
import { usdShort } from '../lib/format';
import { SPA, useLive, type AdvisorNote, type IncidentPlan, type IncidentScenario, type PitScenario } from '../lib/live';
import { IconAgent, IconApproved, IconChart, IconDenied, IconLive, IconQuestion, IconShield, IconWaiting } from './icons';

// The strategic layer of the live feed, drawn once for the Race desk and the Live tab: how alive the
// feed is (the strip), the money given up since the peak (the tally), what every lever costs per car
// (the strategy cards) and the priced outcomes of an incident with the live finance agent's draft
// (the plan). Every figure here is the server's arithmetic on the synthetic contracts; nothing is
// booked, and the advisor is a draft a person reads, never a decision.

type Fmt = (cents: number) => string;

const utc = (iso: string | null | undefined) => (iso && iso.length >= 19 ? iso.slice(11, 19) : '—');
const signed = (c: number, fmt: Fmt) => (Math.abs(c) < 50 ? '$0' : `${c > 0 ? '+' : '−'}${fmt(Math.abs(c))}`);
const COMPOUND: Record<string, string> = { SOFT: 'Softs', MEDIUM: 'Mediums', HARD: 'Hards', INTERMEDIATE: 'Intermediates', WET: 'Wets' };
const compound = (c: string | null) => (c ? COMPOUND[c] ?? c.toLowerCase() : 'tyre unknown');
const UNDER: Record<string, string> = { SAFETY_CAR: 'under the safety car', VSC: 'under the virtual safety car', VIRTUAL_SAFETY_CAR: 'under the virtual safety car', RED_FLAG: 'under the red flag' };
const under = (u: string | null) => (u ? UNDER[u] ?? `under ${u.replace(/_/g, ' ').toLowerCase()}` : 'under green');

function Lamp({ tone, icon, children }: { tone: 'neutral' | 'hold' | 'alert'; icon: ReactNode; children: ReactNode }) {
  return (
    <span className={`flag ${tone === 'neutral' ? 'flag--neutral' : `flag--${tone}`}`}>
      {icon}
      <span>{children}</span>
    </span>
  );
}

// ---------------------------------------------------------------- the strip

/** How alive the feed is, from `feed_health`: the age ticks on the browser's clock between reports. */
export function FeedStrip() {
  const live = useLive();
  const f = live.feed;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!f) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [f]);

  if (!f) {
    return (
      <div className="feedstrip" role="status">
        <Lamp tone="neutral" icon={<IconLive size={12} />}>
          {live.online ? 'Live feed reachable' : 'Live feed not reachable'}
        </Lamp>
        <span className="feedstrip-item">{live.online ? 'No health report yet: one arrives every 5 s while a replay runs.' : 'Start it with make live-api (port 8020).'}</span>
      </div>
    );
  }
  const running = f.state === 'running' || f.state === 'fast_forward';
  const age = f.seconds_since_last_publish == null ? null : f.seconds_since_last_publish + Math.max(0, now - live.feedAt) / 1000;
  const stdb = f.sinks.find((s) => s.name === 'spacetimedb');
  const down = f.sinks.filter((s) => !s.ok);
  const stale = running && age != null && age > 10;
  const tone = down.length ? 'alert' : stale ? 'hold' : 'neutral';
  const word = down.length ? `${down.map((s) => s.name).join(', ')} down` : stale ? `Stale, ${age!.toFixed(0)} s since the last update` : running ? 'Live feed' : f.state === 'paused' ? 'Feed paused' : `Feed ${f.state ?? 'idle'}`;
  const icon = down.length ? <IconDenied size={12} /> : stale ? <IconWaiting size={12} /> : <IconLive size={12} />;
  const jev = f.jev ?? {};
  const jevLive = /^api/.test(jev.mode ?? '');
  const jevText = jevLive ? (jev.p95_ms != null ? `Jev live p95 ${jev.p95_ms} ms` : `Jev live, ${jev.requests ?? 0} calls`) : 'Jev fallback';
  const advisorOn = /^claude/i.test(f.advisor);
  return (
    <div className={`feedstrip feedstrip--${tone}`} role="status" aria-live="polite">
      <Lamp tone={tone} icon={icon}>
        {word}
      </Lamp>
      <span className="feedstrip-item mono">
        Updated <b>{age == null ? '—' : age < 10 ? age.toFixed(1) : age.toFixed(0)} s</b> ago
      </span>
      <span className="feedstrip-item mono" title={`${f.publishes_per_second_10s.toFixed(1)} per second over the last 10 s · ${f.publishes_total} published in this replay`}>
        <b>{f.publishes_last_60s}</b> updates/min
      </span>
      <span className="feedstrip-item mono">
        race clock <b>{utc(f.race_clock_utc)}Z</b> lap <b>{f.lap ?? '—'}</b>
      </span>
      <span className="feedstrip-item mono" title={stdb?.detail ?? undefined}>
        {!stdb ? 'SpacetimeDB: not a sink' : stdb.ok ? (
          <>
            SpacetimeDB <b>{stdb.written.toLocaleString('en-US')}</b> rows, last write <b>{utc(stdb.last_write_utc)}</b>
            {stdb.errors ? ` (${stdb.errors} errors)` : ''}
          </>
        ) : (
          `SpacetimeDB off: ${stdb.detail ?? 'not ok'}`
        )}
      </span>
      <span className="feedstrip-item mono" title={jev.mode}>
        {jevText}
      </span>
      <span className="feedstrip-item mono" title={f.advisor}>
        Advisor {advisorOn ? 'on' : 'off'}
      </span>
      <span className="feedstrip-item mono muted">{live.streaming ? 'stream open' : 'polling'}</span>
    </div>
  );
}

// ---------------------------------------------------------------- the tally

/** Exposure now, at the join and at the peak, and what has been given up since the peak. */
export function ExposureTally({ fmt = usdShort }: { fmt?: Fmt }) {
  const live = useLive();
  const s = live.strategy;
  const f = live.feed;
  const now = s?.exposure_now_cents ?? f?.exposure_now_cents ?? live.race?.forecast.amount_cents ?? null;
  const join = s?.exposure_at_join_cents ?? f?.exposure_at_join_cents ?? null;
  const peak = s?.exposure_peak_cents ?? f?.exposure_peak_cents ?? null;
  const lost = s?.lost_from_peak_cents ?? f?.lost_from_peak_cents ?? null;
  if (now == null && lost == null) return null;
  const cell = (v: number | null) => (v == null ? '—' : fmt(v));
  return (
    <section className="tally panel" aria-label="Sponsor exposure tally">
      <div className="tally-big">
        <b className="mono">{cell(lost)}</b>
        <span>sponsor exposure given up since the peak, indicative, unbooked</span>
      </div>
      <dl className="tally-kv">
        <div>
          <dt>Now</dt>
          <dd>{cell(now)}</dd>
        </div>
        <div>
          <dt>At the join</dt>
          <dd>{cell(join)}</dd>
        </div>
        <div>
          <dt>Peak</dt>
          <dd>{cell(peak)}</dd>
        </div>
      </dl>
      <p className="small muted tally-note">
        {s ? `Strategy advice v${s.version}, as of ${utc(s.as_of_utc)}Z lap ${s.lap ?? '—'}` : 'From the feed health report'}. Every dollar is synthetic; the contracts are Meridian's.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- the strategy cards

function PitLine({ pit, fmt }: { pit: PitScenario; fmt: Fmt }) {
  return (
    <p className="strategy-pit">
      <b>
        Pit now: <span className="mono">{signed(pit.delta_cents, fmt)}</span>
      </b>
      {pit.rejoin_position ? `, rejoin P${pit.rejoin_position}` : ''}
      {pit.cars_passed.length ? ` behind ${pit.cars_passed.length === 1 ? 'car' : 'cars'} ${pit.cars_passed.join(', ')}` : pit.rejoin_position ? ', nobody gets past' : ''}
      {pit.cars_maybe.length ? ` (maybe ${pit.cars_maybe.join(', ')} too)` : ''} · <span className="mono">{pit.pit_loss_s.toFixed(1)} s</span> pit loss {under(pit.under)}
      <span className="small muted block">
        {pit.pit_loss_basis}
        {pit.text ? ` ${pit.text}` : ''}
      </span>
    </p>
  );
}

/** One card per team car from `strategy_advice`: a new version remounts the cards, so the change shows. */
export function StrategyCards({ fmt = usdShort, names = {} }: { fmt?: Fmt; names?: Record<number, string> }) {
  const live = useLive();
  const s = live.strategy;
  if (!s) {
    return (
      <p className="muted small">
        No strategy advice yet from the feed
        {live.replay?.race_id === SPA ? ': the Belgian Grand Prix is replayed from documents, with no running order to price' : ''}. Until it arrives, the place values come from the desk's own
        contract table.
      </p>
    );
  }
  return (
    <div className="strategy-cards">
      {s.places.map((pl) => {
        const pit = s.pit.find((x) => x.car === pl.car);
        const ty = s.tyres.find((x) => x.car === pl.car);
        return (
          <article key={`${pl.car}:${s.version}`} className="strategy-card strategy-card--fresh" aria-label={`Car ${pl.car} strategy`}>
            <header className="strategy-head">
              <b className="mono">{pl.car}</b>
              <span>{names[pl.car] ?? pl.driver_id}</span>
              <span className="mono">{pl.position ? `P${pl.position}` : 'not running'}</span>
              <span className="mono muted small">
                v{s.version} · {utc(s.as_of_utc)}Z{s.flag_status ? ` · ${s.flag_status.replace(/_/g, ' ').toLowerCase()}` : ''}
              </span>
            </header>
            <dl className="strategy-kv">
              <div>
                <dt>Worth now</dt>
                <dd>{fmt(pl.value_now_cents)}</dd>
              </div>
              <div>
                <dt>One place up</dt>
                <dd>{signed(pl.up_one_cents, fmt)}</dd>
                <span className="small muted">{pl.up_one_text}</span>
              </div>
              <div>
                <dt>One place down</dt>
                <dd>{signed(pl.down_one_cents, fmt)}</dd>
                <span className="small muted">{pl.down_one_text}</span>
              </div>
            </dl>
            {pit ? <PitLine pit={pit} fmt={fmt} /> : <p className="small muted">No pit-stop scenario for this car.</p>}
            {ty && (
              <p className="strategy-tyres small">
                <b>Tyres:</b> {compound(ty.compound)}, <span className="mono">{ty.age_laps ?? '—'}</span> laps old
                {ty.stint_lap_start ? ` since lap ${ty.stint_lap_start}` : ''} · field median <span className="mono">{ty.field_median_age_laps ?? '—'}</span>
                {ty.note ? <span className="muted"> · {ty.note}</span> : null}
              </p>
            )}
          </article>
        );
      })}
      {s.weather_note ? <p className="small muted strategy-weather">{s.weather_note}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- the plan and the advisor

function AdvisorCard({ a, rec }: { a: AdvisorNote; rec: IncidentScenario | null }) {
  const meta = [a.model, a.latency_ms != null ? `${a.latency_ms} ms` : null, a.drafted_at_utc ? `drafted ${utc(a.drafted_at_utc)}Z` : null].filter(Boolean).join(' · ');
  if (a.status === 'pending') {
    return (
      <div className="advisor advisor--pending">
        <Lamp tone="hold" icon={<IconWaiting size={12} />}>
          Live finance agent drafting
        </Lamp>
        <p className="small muted">The agent is reading the priced outcomes; a versioned update arrives when it answers, typically within 5 to 8 s.</p>
      </div>
    );
  }
  if (a.status === 'ok') {
    return (
      <div className="advisor">
        <div className="advisor-head">
          <Lamp tone="neutral" icon={<IconAgent size={12} />}>
            Live finance agent
          </Lamp>
          {rec && (
            <Lamp tone="neutral" icon={<IconChart size={12} />}>
              recommends {rec.label}
            </Lamp>
          )}
          {a.confidence && (
            <Lamp tone="neutral" icon={<IconApproved size={12} />}>
              confidence {a.confidence}
            </Lamp>
          )}
        </div>
        {a.headline && <p className="advisor-headline">{a.headline}</p>}
        {a.rationale && <p className="small">{a.rationale}</p>}
        {a.what_we_need.length > 0 && (
          <>
            <h4>What we need</h4>
            <ul>
              {a.what_we_need.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </>
        )}
        {meta && <p className="small muted mono">{meta}</p>}
        <p className="small muted">A draft among the outcomes code priced, using only the figures above. Nothing is booked or approved by it.</p>
      </div>
    );
  }
  const refusedish = a.status === 'refused' || a.status === 'unavailable' || a.status === 'error' || a.status === 'invalid';
  return (
    <div className="advisor">
      <Lamp tone={refusedish ? 'alert' : 'neutral'} icon={refusedish ? <IconDenied size={12} /> : <IconQuestion size={12} />}>
        Advisor {a.status === 'disabled' ? 'off' : a.status}
      </Lamp>
      <p className="small muted">
        {a.error ?? (a.status === 'disabled' ? 'LIVE_ADVISOR is off or no ANTHROPIC_API_KEY is set.' : 'No answer; the priced outcomes above stand on their own.')}
        {meta ? ` ${meta}.` : ''}
      </p>
    </div>
  );
}

/** The priced outcomes of one incident, in the server's order, with the cost-cap note and the advisor's draft. */
export function PlanCard({ plan, fmt = usdShort, names = {} }: { plan: IncidentPlan; fmt?: Fmt; names?: Record<number, string> }) {
  const a = plan.advisor;
  const rec = a.recommended_scenario ? plan.scenarios.find((s) => s.key === a.recommended_scenario) ?? null : null;
  return (
    <article className="plan" aria-label={`Priced outcomes for car ${plan.car}`}>
      <header className="plan-head">
        <h3>
          <IconChart size={14} /> Priced outcomes · car {plan.car} {names[plan.car] ?? plan.driver_id} · lap {plan.lap ?? '—'} · {plan.position_now ? `P${plan.position_now}` : 'not running'}
        </h3>
        <span className="mono muted small">
          v{plan.version} · {utc(plan.as_of_utc)}Z{plan.flag_status ? ` · ${plan.flag_status.replace(/_/g, ' ').toLowerCase()}` : ''}
        </span>
      </header>
      {!plan.team_car && (
        <p className="callout callout--steel">
          <IconQuestion size={15} />
          <span>Car {plan.car} is not a Meridian car: only the running order behind it moves the team's money.</span>
        </p>
      )}
      <p className="small muted">
        Exposure now <b className="mono">{fmt(plan.exposure_now_cents)}</b> · damage estimate: {plan.damage_estimate_cents == null ? 'awaiting the garage report' : <b className="mono">{fmt(plan.damage_estimate_cents)}</b>}
        {plan.basis ? ` · ${plan.basis}` : ''}
      </p>
      <div className="table-wrap">
        <table className="data data--tight scenario-table">
          <thead>
            <tr>
              <th>Outcome</th>
              <th className="num">Position after</th>
              <th className="num">Exposure after</th>
              <th className="num">Delta</th>
              <th>Clauses lost or gained</th>
              <th className="num">Constructors</th>
            </tr>
          </thead>
          <tbody>
            {plan.scenarios.map((sc) => (
              <tr key={sc.key} className={rec?.key === sc.key ? 'row--rec' : undefined}>
                <td>
                  <span className="cell-title">
                    {sc.label}
                    {rec?.key === sc.key ? " · the advisor's pick" : ''}
                  </span>
                  <span className="cell-sub muted">{sc.assumption}</span>
                </td>
                <td className="num mono">{sc.position_after ? `P${sc.position_after}` : '—'}</td>
                <td className="num mono">{fmt(sc.exposure_after_cents)}</td>
                <td className="num mono">{signed(sc.delta_cents, fmt)}</td>
                <td className="small">
                  {sc.lines_lost.length ? `Lost: ${sc.lines_lost.join('; ')}.` : ''}
                  {sc.lines_gained.length ? ` Gained: ${sc.lines_gained.join('; ')}.` : ''}
                  {!sc.lines_lost.length && !sc.lines_gained.length ? <span className="muted">no clause moves</span> : null}
                </td>
                <td className="num mono">
                  {sc.constructors_position_after ? `P${sc.constructors_position_after}` : '—'}
                  {sc.prize_delta_cents ? ` (${signed(sc.prize_delta_cents, fmt)})` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small plan-note">
        <IconShield size={14} />
        <span>{plan.cost_cap_note}</span>
      </p>
      <AdvisorCard a={a} rec={rec} />
    </article>
  );
}

/** The plans of the replay on screen (the API's memory keeps every run's). */
export function usePlansNow(): IncidentPlan[] {
  const live = useLive();
  const started = live.replayStartedAt;
  return live.plans.filter((p) => !started || p.published_at_utc >= started).map((p) => p.payload);
}
