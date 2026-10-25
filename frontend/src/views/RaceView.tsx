import { useEffect, useMemo, useRef, useState } from 'react';
import { LineChart, type Marker } from '../charts/LineChart';
import { Attention } from '../components/Attention';
import { CarStage, Gauges, RunningOrder, SponsorPanel, StatPills } from '../components/RaceHero';
import { ExposureTally, FeedStrip, PlanCard, StrategyCards, usePlansNow } from '../components/StrategyDesk';
import { IconArrow, IconBolt, IconPause, IconPlay, IconRadio, IconRestart, IconShield, IconSkip, IconWaiting } from '../components/icons';
import { resolveEntry, type InboxItem } from '../components/inboxModel';
import type { SeatStatus } from '../components/Shell';
import { WhyPane } from '../components/Why';
import { useCostCap } from '../lib/costcap';
import { usdShort } from '../lib/format';
import { replayFromLive } from '../lib/liveDesk';
import { BRAZIL, SPA, useLive } from '../lib/live';
import {
  FEATURED,
  SEASONS,
  SPEEDS,
  duration,
  framesOf,
  manualSeconds,
  sponsorName,
  useDerived,
  usePlayback,
  useRaces,
  utc,
  type Crash,
  type Frame,
  type RadioCall,
  type Replay,
  type SpeedEvent,
} from '../lib/racedesk';

// The race, as the finance desk sees it. A real race replays lap by lap; every lap the running order is
// re-priced under Meridian's sponsor contracts and in expected championship prize money. Crashes go to the
// cost cap forecast the lap they happen, FIA documents are acted on 15 seconds after they are published,
// and the scoreboard sets each reaction against the month-end close a finance team runs today.

const MATERIALITY_CENTS = 25_000_000; // finance/config.py: $250,000

function signed(c: number): string {
  if (Math.abs(c) < 50) return '$0';
  return `${c > 0 ? '+' : ''}${usdShort(c)}`;
}

function parseRoute(arg: string | null): { season: number; round: number } {
  const m = arg?.match(/^(\d{4})-(\d+)$/);
  return m ? { season: Number(m[1]), round: Number(m[2]) } : { season: FEATURED[0].season, round: FEATURED[0].round };
}

// ------------------------------------------------------------------------------------------ picker

function Picker({ season, round, go }: { season: number; round: number; go: (s: number, r: number) => void }) {
  const { races } = useRaces(season);
  return (
    <div className="race-picker">
      <ul className="race-featured" aria-label="Demo races">
        {FEATURED.map((f) => {
          const on = f.season === season && f.round === round;
          return (
            <li key={`${f.season}-${f.round}`}>
              <button type="button" className={`race-feat${on ? ' race-feat--on' : ''}`} onClick={() => go(f.season, f.round)} aria-pressed={on}>
                <span className="race-feat-label">{f.label}</span>
                <span className="race-feat-story">{f.story}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="race-select">
        <label>
          <span className="ctl-label">Season</span>
          <select value={season} onChange={(e) => go(Number(e.target.value), races.some((r) => r.round === round) ? round : races[0]?.round ?? round)}>
            {SEASONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="ctl-label">Race</span>
          <select value={round} onChange={(e) => go(season, Number(e.target.value))}>
            {races.length === 0 && <option value={round}>Round {round}</option>}
            {races.map((r) => (
              <option key={r.round} value={r.round}>
                R{r.round} · {r.name.replace(' Grand Prix', ' GP')}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ header + scrubber

function Header({ r, pb }: { r: Replay; pb: ReturnType<typeof usePlayback> }) {
  const f = pb.frame;
  const lap = f ? r.laps[f.lapIndex] : null;
  const phase = f?.kind === 'after' ? { cls: 'status--hold', t: 'After the flag' } : lap && lap.lap === r.race_laps ? { cls: 'status--ok', t: 'Chequered flag' } : pb.tracking || pb.playing ? { cls: 'status--live', t: 'Live' } : { cls: 'status--muted', t: pb.i === 0 ? 'On the grid' : 'Paused' };
  return (
    <section className="race-head" aria-label="Race">
      <nav className="crumbs small muted" aria-label="Breadcrumb">
        <a href="#/">Pit wall</a> <span aria-hidden>›</span> <a href="#/race">Race desk</a> <span aria-hidden>›</span> <span>
          {r.season} R{r.round}
        </span>
      </nav>
      <div className="race-head-row">
        <div className="race-head-title">
          <h1>
            {r.race} <span className={`status ${phase.cls}`}>{phase.t}</span>
          </h1>
          <p className="muted small">
            {r.date} · {r.race_laps} laps · Meridian cars {Object.entries(r.team_cars).map(([c, code]) => `${c} ${code}`).join(' and ')} · {r.remaining_rounds} rounds left
          </p>
        </div>
        <div className="race-controls">
          <div className="seg-ctl" role="group" aria-label="Replay speed">
            {SPEEDS.map((s) => (
              <button key={s} type="button" className={pb.speed === s ? 'seg-btn seg-btn--on' : 'seg-btn'} onClick={() => pb.setSpeed(s)} aria-pressed={pb.speed === s}>
                {s}×
              </button>
            ))}
          </div>
          <button type="button" className="btn pillbtn" onClick={pb.end} disabled={pb.done}>
            <IconSkip size={13} /> To the end
          </button>
          <button type="button" className="btn btn--primary pillbtn race-play" onClick={pb.tracking ? pb.hold : pb.playing ? pb.pause : pb.play} aria-label={pb.tracking || pb.playing ? 'Pause' : 'Play'}>
            {pb.tracking || pb.playing ? <IconPause size={14} /> : pb.done ? <IconRestart size={14} /> : <IconPlay size={14} />}
            {pb.tracking || pb.playing ? 'Pause' : pb.done ? 'Replay' : pb.i === 0 ? 'Start the race' : 'Resume'}
          </button>
        </div>
      </div>
    </section>
  );
}

function Scrubber({ r, frames, pb }: { r: Replay; frames: Frame[]; pb: ReturnType<typeof usePlayback> }) {
  const at = (i: number) => `${(i / Math.max(1, frames.length - 1)) * 100}%`;
  return (
    <div className="race-scrub">
      <input
        type="range"
        min={0}
        max={frames.length - 1}
        value={pb.i}
        onChange={(e) => pb.seek(Number(e.target.value))}
        aria-label="Replay position"
        style={{ ['--p' as string]: at(pb.i) }}
      />
      <div className="race-scrub-ticks" aria-hidden>
        {frames.map((fr) => (fr.kind === 'after' ? <span key={fr.i} className="race-scrub-tick race-scrub-tick--doc" style={{ left: at(fr.i) }} title={fr.label} /> : null))}
        {r.crashes.map((c) => {
          const idx = r.laps.findIndex((l) => l.lap === c.lap);
          return idx < 0 ? null : <span key={`c${c.car}`} className="race-scrub-tick race-scrub-tick--crash" style={{ left: at(idx) }} title={`${c.driver} crash`} />;
        })}
        <span className="race-scrub-flag" style={{ left: at(r.laps.length - 1) }} title="Chequered flag" />
      </div>
      <div className="race-scrub-legend small muted">
        <span>Lights out</span>
        <span>
          <i className="lg lg--crash" /> crash <i className="lg lg--doc" /> FIA document <i className="lg lg--flag" /> flag
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ telemetry

function Telemetry({ r, upto }: { r: Replay; upto: number }) {
  const xs = r.laps.map((_, i) => i);
  const swing = r.laps.map((l, i) => (i <= upto ? l.total - r.start.total : null));
  const bonus = r.laps.map((l, i) => (i <= upto ? l.bonus_usd : null));
  const allSwing = r.laps.map((l) => l.total - r.start.total);
  const lo = Math.min(0, ...allSwing);
  const hi = Math.max(0, ...allSwing);
  const radioByLap = useMemo(() => {
    const m = new Map<number, RadioCall[]>();
    for (const c of r.radio) m.set(c.lap, [...(m.get(c.lap) ?? []), c]);
    return m;
  }, [r]);
  const markers: Marker[] = [];
  const at = (clock: string) => {
    let idx = 0;
    r.laps.forEach((l, i) => { if (l.clock <= clock) idx = i; });
    return idx;
  };
  for (const c of r.radio) {
    const x = at(c.clock);
    if (x > upto) continue;
    if (c.kind === 'retirement') markers.push({ x, label: `Incident L${c.lap}`, tone: 'alert' });
    if (c.kind === 'safety_car') markers.push({ x, label: `SC L${c.lap}`, tone: 'hold' });
  }
  const tip = (i: number) => {
    const l = r.laps[i];
    const calls = (radioByLap.get(l.lap) ?? []).filter((c) => c.kind !== 'lights_out');
    return (
      <div className="race-tip">
        <div className="tooltip-row">
          <span className="tooltip-line" style={{ background: 'var(--s2)' }} />
          <span>
            <b className="mono">{usdShort(l.total)}</b> <span className="muted">on the line</span>{' '}
            <span className={l.delta >= 0 ? 'tone-ok mono' : 'tone-alert mono'}>{l.lap ? signed(l.delta) : ''}</span>
          </span>
        </div>
        <div className="tooltip-row">
          <span className="tooltip-line" style={{ background: 'var(--lime)' }} />
          <span>
            <b className="mono">{usdShort(l.bonus_usd)}</b> <span className="muted">sponsor bonuses</span>
          </span>
        </div>
        <p className="race-tip-pos mono">
          {Object.entries(l.cars)
            .map(([, c]) => `${c.code} ${c.position ? `P${c.position}` : 'out'}`)
            .join(' · ')}{' '}
          · {utc(l.clock)}
        </p>
        {calls.slice(0, 2).map((c, k) => (
          <p key={k} className="race-tip-call">
            {c.text}
          </p>
        ))}
      </div>
    );
  };
  return (
    <section className="race-telemetry panel" aria-labelledby="tele-h">
      <div className="sec-head">
        <h2 id="tele-h">Money telemetry</h2>
        <p className="muted">
          What the running order is worth to Meridian against lights out, lap by lap: sponsor bonuses earned at each position, plus expected championship prize money
          over the {r.remaining_rounds} remaining rounds. Hover a lap for the call.
        </p>
      </div>
      <LineChart
        xs={xs}
        series={[{ key: 'swing', label: 'vs lights out', values: swing, color: '--s2', area: 0.08 }]}
        xLabel={(x) => { const l = r.laps[x]; return !l || l.lap === 0 ? 'Start' : `L${l.lap}`; }}
        yLabel={(y) => signed(y)}
        yMin={lo - (hi - lo) * 0.08}
        yMax={hi + (hi - lo) * 0.08 || 1}
        zero
        height={250}
        markers={markers}
        tooltip={tip}
        ariaLabel="Change in money on the line since lights out, by lap"
      />
      <h3 className="race-sub-h">Sponsor bonuses on the board</h3>
      <LineChart
        xs={xs}
        series={[{ key: 'bonus', label: 'bonuses', values: bonus, color: '--lime', area: 0.1 }]}
        xLabel={(x) => { const l = r.laps[x]; return !l || l.lap === 0 ? 'Start' : `L${l.lap}`; }}
        yLabel={(y) => usdShort(y)}
        yMin={0}
        yMax={Math.max(...r.laps.map((l) => l.bonus_usd)) * 1.1 || 1}
        height={150}
        tooltip={tip}
        ariaLabel="Sponsor bonuses earned at the running order, by lap"
      />
    </section>
  );
}

// ------------------------------------------------------------------------------------------ radio

const RADIO_LABEL: Record<string, string> = {
  lights_out: 'Lights out',
  money: 'Money',
  retirement: 'Retirement',
  safety_car: 'Safety car',
  flag: 'Flag',
  final_classification: 'FIA final',
  strategy: 'Strategy',
  plan: 'Outcomes',
  advisor: 'Advisor',
};

function Radio({ calls, after }: { calls: RadioCall[]; after: SpeedEvent[] }) {
  const items = useMemo(() => {
    const out: { key: string; clock: string; kind: string; label: string; text: string; delta?: number }[] = calls.map((c, i) => ({
      key: `r${i}`,
      clock: c.clock,
      kind: c.kind,
      label: c.lap ? `${RADIO_LABEL[c.kind] ?? c.kind} · L${c.lap}` : RADIO_LABEL[c.kind] ?? c.kind,
      text: c.text,
      delta: c.delta,
    }));
    for (const s of after) {
      if (s.event.startsWith('Crash')) continue;
      out.push({ key: `s${s.event}`, clock: s.acted_at ?? '', kind: 'fia', label: s.event, text: `${s.action[0].toUpperCase()}${s.action.slice(1)}.` });
    }
    return out.sort((a, b) => (a.clock < b.clock ? 1 : -1));
  }, [calls, after]);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [items.length]);
  return (
    <section className="race-radio panel" aria-labelledby="radio-h">
      <div className="sec-head">
        <h2 id="radio-h">
          <IconRadio size={16} /> Finance radio
        </h2>
        <p className="muted">Every call the desk makes, newest first, with the race clock.</p>
      </div>
      <ol className="radio-list" ref={list} aria-live="polite">
        {items.length === 0 && <li className="muted radio-empty">Start the race to hear the calls.</li>}
        {items.map((c) => (
          <li key={c.key} className={`radio-call radio-call--${c.kind}`}>
            <span className="radio-time mono">{utc(c.clock)}</span>
            <span className="radio-kind">{c.label}</span>
            {c.delta != null && <span className={`radio-delta mono ${c.delta >= 0 ? 'tone-ok' : 'tone-alert'}`}>{signed(c.delta)}</span>}
            <p className="radio-text">{c.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------------------------------ crash → cost cap

function CrashDesk({ r, crashes }: { r: Replay; crashes: Crash[] }) {
  const all = r.crashes;
  const plans = usePlansNow();
  const names: Record<number, string> = {};
  for (const [c, code] of Object.entries(r.team_cars)) names[Number(c)] = r.field?.[c]?.driver ?? code;
  for (const [c, f] of Object.entries(r.field ?? {})) names[Number(c)] ??= f.driver;
  const planFor = (c: Crash) => plans.find((p) => p.incident_id === c.incident_id) ?? plans.find((p) => p.car === c.car && p.lap === c.lap) ?? null;
  const orphans = plans.filter((p) => !crashes.some((c) => c.incident_id === p.incident_id || (c.car === p.car && c.lap === p.lap)));
  return (
    <section className="race-crash panel" aria-labelledby="crash-h">
      <div className="sec-head">
        <h2 id="crash-h">
          <IconBolt size={16} /> Crash desk
        </h2>
        <p className="muted">
          When a car stops, the feed prices every outcome against the same contracts: continue, pit, repair, penalties, retire, disqualification. The damage side waits for
          the garage report, and the live finance agent drafts a recommendation a person reads. Nothing here is booked.
        </p>
      </div>
      {all.length === 0 && orphans.length === 0 ? (
        <p className="muted empty">No incident on the feed yet for this race.</p>
      ) : crashes.length === 0 && orphans.length === 0 ? (
        <p className="muted empty">
          {all.length === 1 ? 'An incident is coming in this race.' : `${all.length} incidents are coming in this race.`} Keep the replay running.
        </p>
      ) : (
        <div className="plans">
          {crashes.map((c) => {
            const plan = planFor(c);
            return (
              <article key={c.incident_id ?? `${c.car}${c.lap}`} className="crash-card">
                <header className="crash-head">
                  <span className="crash-who">
                    {c.driver} · <span className="tone-alert">{c.status.toLowerCase()}</span> · lap {c.lap}
                  </span>
                  <span className="mono muted">{utc(c.clock)} UTC</span>
                </header>
                <div className="crash-figs">
                  <div>
                    <b className="mono crash-big">{plan && plan.damage_estimate_cents != null ? usdShort(plan.damage_estimate_cents) : c.damage_estimate != null ? usdShort(c.damage_estimate) : '—'}</b>
                    <span className="small muted">
                      {plan && plan.damage_estimate_cents != null ? 'damage estimate from the garage report' : c.damage_estimate != null ? 'recovery cost selected by the cost cap desk' : 'damage estimate: awaiting the garage report'}
                    </span>
                  </div>
                  <div>
                    <b className="mono crash-big">{c.lap_ms ? duration(c.lap_ms / 1000) : '—'}</b>
                    <span className="small muted">Jev's routing latency on the incident</span>
                  </div>
                </div>
                {plan ? (
                  <PlanCard plan={plan} names={names} />
                ) : (
                  <p className="small muted">
                    <IconWaiting size={13} /> No priced outcomes yet for this incident: the feed publishes a plan for incidents on a watched car.
                  </p>
                )}
                <p className="small not-modelled">
                  Cap breach risk: not modelled on the live feed; the season model is on the{' '}
                  <a className="link" href="#/risk">
                    cap risk desk <IconArrow size={12} />
                  </a>
                  .
                </p>
              </article>
            );
          })}
          {orphans.map((plan) => (
            <PlanCard key={plan.incident_id} plan={plan} names={names} />
          ))}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------ speed

function SpeedBoard({ r, clock, flagged }: { r: Replay; clock: string; flagged: boolean }) {
  const rows = r.speed;
  const maxManual = Math.max(86400 * 10, ...rows.map((s) => manualSeconds(s.manual_baseline) ?? 0));
  const L = (s: number) => Math.log10(Math.max(1, s)) / Math.log10(maxManual);
  return (
    <section className="race-speed panel" aria-labelledby="speed-h">
      <div className="sec-head">
        <h2 id="speed-h">Speed scoreboard</h2>
        <p className="muted">
          Every money event in this race: when it happened, when Pit Wall acted, and when a finance team running a month-end close would have. Bars are on a log scale; a
          month is long.
        </p>
      </div>
      <div className="table-wrap">
        <table className="data speed-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Happened</th>
              <th>Acted</th>
              <th className="speed-bars-h">Pit Wall vs month-end close</th>
              <th className="num">At stake</th>
              <th className="num">Kept off invoices</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const reached = s.acted_at ? s.acted_at <= clock : flagged;
              const manual = manualSeconds(s.manual_baseline);
              return (
                <tr key={s.event} className={reached ? 'speed-row speed-row--on' : 'speed-row'}>
                  <td>
                    <span className="cell-title">{s.event}</span>
                    <span className="cell-sub muted">{reached ? s.action : 'not yet'}</span>
                  </td>
                  <td className="mono">{utc(s.happened_at)}</td>
                  <td className="mono">{reached ? utc(s.acted_at) : '—'}</td>
                  <td className="speed-bars">
                    <div className="speed-bar">
                      <span className="speed-bar-who">Pit Wall</span>
                      <span className="speed-bar-track">
                        {reached && s.seconds_to_act != null && <span className="speed-bar-fill speed-bar-fill--pw" style={{ width: `${Math.max(2, L(s.seconds_to_act) * 100)}%` }} />}
                      </span>
                      <b className="mono tone-ok">{reached && s.seconds_to_act != null ? duration(s.seconds_to_act) : s.seconds_to_act == null && reached ? '—' : ''}</b>
                    </div>
                    <div className="speed-bar">
                      <span className="speed-bar-who">Close</span>
                      <span className="speed-bar-track">
                        {manual != null && <span className="speed-bar-fill speed-bar-fill--manual" style={{ width: `${L(manual) * 100}%` }} />}
                      </span>
                      <b className="mono muted">{manual != null ? duration(manual) : 'days'}</b>
                    </div>
                    <span className="cell-sub muted">{s.manual_baseline}</span>
                  </td>
                  <td className="num mono">{s.usd_at_stake != null ? usdShort(s.usd_at_stake) : '—'}</td>
                  <td className={`num mono ${s.usd_protected && reached ? 'tone-ok' : 'muted'}`}>{s.usd_protected && reached ? usdShort(s.usd_protected) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted race-method">{r.method.speed}.</p>
    </section>
  );
}

// ------------------------------------------------------------------------------------------ what it books

function Books({ r, flagged, finalIn, finalKnown }: { r: Replay; flagged: boolean; finalIn: boolean; finalKnown: boolean }) {
  const road = r.laps[r.laps.length - 1]?.bonuses ?? [];
  const final = r.final.bonuses;
  const inFinal = (b: { sponsor: string; clause: string; car: number }) => final.some((f) => f.sponsor === b.sponsor && f.clause === b.clause && f.car === b.car);
  const booked = finalIn || (!finalKnown && flagged);
  const lines = [
    ...road.map((b) => ({ key: `r${b.sponsor}${b.clause}${b.car}`, sponsor: b.sponsor, clause: b.clause, what: b.type.replace('_', ' '), car: b.car, usd: b.usd, kept: inFinal(b) })),
    ...final
      .filter((f) => !road.some((b) => b.sponsor === f.sponsor && b.clause === f.clause && b.car === f.car))
      .map((f) => ({ key: `f${f.sponsor}${f.clause}${f.car}`, sponsor: f.sponsor, clause: f.clause, what: `P${f.position}`, car: f.car, usd: f.usd, kept: true })),
  ].sort((a, b) => b.usd - a.usd);
  const status = (l: (typeof lines)[number]) => {
    if (!flagged) return { cls: 'state--proposed', text: 'Race running' };
    if (!booked) return { cls: 'state--proposed', text: 'Held for the FIA final' };
    if (!l.kept) return { cls: 'state--rejected', text: 'Overturned · never invoiced' };
    return l.usd >= MATERIALITY_CENTS ? { cls: 'state--proposed', text: 'Proposed · Controller approves' } : { cls: 'state--approved', text: 'Booked · straight through' };
  };
  const reversed = r.road.bonus_usd - r.final.bonus_usd;
  return (
    <section className="race-books panel" aria-labelledby="books-h">
      <div className="sec-head">
        <h2 id="books-h">What this race books</h2>
        <p className="muted">
          Nothing is invoiced on the road result. Billing is held until the FIA Final Classification; then each bonus is proposed as an entry. Anything over $250k waits for
          the Controller.
        </p>
      </div>
      <div className="books-sum">
        <div>
          <span className="small muted">On the road</span>
          <b className="mono">{usdShort(r.road.bonus_usd)}</b>
        </div>
        <span className="books-arrow" aria-hidden>
          →
        </span>
        <div>
          <span className="small muted">Booked after the FIA final</span>
          <b className={`mono ${booked ? '' : 'muted'}`}>{booked ? usdShort(r.final.bonus_usd) : 'pending'}</b>
        </div>
        {booked && reversed > 0 && (
          <div className="books-protected">
            <IconShield size={15} />
            <span>
              <b className="mono">{usdShort(reversed)}</b> would have been invoiced on the road result and credited back days later.
            </span>
          </div>
        )}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Sponsor</th>
              <th>Clause</th>
              <th>Car</th>
              <th className="num">Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No sponsor bonus earned at the final order.
                </td>
              </tr>
            )}
            {lines.map((l) => {
              const s = status(l);
              return (
                <tr key={l.key} className={booked && !l.kept ? 'row--struck' : undefined}>
                  <td>{sponsorName(l.sponsor)}</td>
                  <td className="mono">
                    {l.clause} <span className="muted">{l.what}</span>
                  </td>
                  <td className="mono">
                    {l.car} {r.team_cars[String(l.car)]}
                  </td>
                  <td className="num mono">{usdShort(l.usd)}</td>
                  <td>
                    <span className={`state ${s.cls}`}>{s.text}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Approvals({ inbox, status }: { inbox: InboxItem[]; status: SeatStatus }) {
  const cc = useCostCap();
  const revenue = inbox.filter((i) => i.kind === 'entry');
  const [selected, setSelected] = useState<string | null>(null);
  const key = selected ?? revenue[0]?.key ?? null;
  return (
    <section className="race-approvals" aria-labelledby="appr-h">
      <div className="sec-head">
        <h2 id="appr-h">Waiting for a person</h2>
        <p className="muted">
          The agents only propose. Material revenue entries from the season so far wait here for the Controller and the CFO; pick your seat at the top right to decide.
        </p>
      </div>
      {revenue.length === 0 ? (
        <p className="muted empty">
          Nothing is waiting. Start the revenue desk (<code>uvicorn finance.api:app</code>) and run a season to fill the queue, or open the <a href="#/inbox">inbox</a>.
        </p>
      ) : (
        <div className="split">
          <Attention inbox={revenue} selected={key} onSelect={setSelected} />
          <WhyPane entry={resolveEntry(key, revenue, cc)} status={status} />
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------ view

export function RaceView({ arg, nav, inbox, status }: { arg: string | null; nav: (hash: string) => void; inbox: InboxItem[]; status: SeatStatus }) {
  const live = useLive();
  const { season, round } = parseRoute(arg);
  const r = useMemo(() => {
    const built = replayFromLive(live);
    return built && built.round === round ? built : null;
  }, [live, round]);
  const follow = live.replay?.state === 'running' || live.replay?.state === 'fast_forward';
  const frames = useMemo(() => (r ? framesOf(r) : []), [r]);
  const pb = usePlayback(frames, follow);
  const d = useDerived(r, pb.frame);
  const asked = useRef('');
  useEffect(() => {
    if (!live.online || live.busy) return;
    const id = round === 14 ? SPA : round === 21 ? BRAZIL : null;
    if (!id) return;
    const same = live.replay?.race_id === id && ['fast_forward', 'running', 'paused', 'finished'].includes(live.replay.state);
    if (same) {
      asked.current = '';
      return;
    }
    if (asked.current === id) return;
    asked.current = id;
    void live.playRace(id);
  }, [live.online, live.busy, live.replay, round, live.playRace]);
  const go = (s: number, n: number) => {
    const id = n === 14 ? SPA : n === 21 ? BRAZIL : null;
    if (!id) return;
    nav(`/race/${s}-${n}`);
    const running = live.replay && ['fast_forward', 'running', 'paused'].includes(live.replay.state);
    if (running && live.replay?.race_id === id) return;
    asked.current = id;
    void live.playRace(id);
  };
  const finalKnown = !!r?.speed.some((s) => s.event === 'FIA Final Classification' && s.acted_at);
  const [carPick, setCar] = useState<string | null>(null);
  const [sponsor, setSponsor] = useState<string | null>('halcyon');
  useEffect(() => setCar(null), [season, round]);
  // default to the car that matters in this race: the one that crashed or was disqualified, else the leader
  const carSel = useMemo(() => {
    if (!r) return '';
    const cars = Object.keys(r.team_cars);
    if (carPick && cars.includes(carPick)) return carPick;
    const story = r.crashes[0]?.car ?? Object.entries(r.classification ?? {}).find(([, c]) => c.position_text === 'D')?.[0];
    return story != null && cars.includes(String(story)) ? String(story) : cars[0];
  }, [r, carPick]);
  // once the FIA Final Classification is in, the money shown is what was booked, not the road result
  const booked = !!d && (d.finalIn || (!finalKnown && d.flagged));
  const lap = useMemo(() => {
    if (!r || !d) return null;
    if (!booked) return d.lap;
    const typeOf = (sp: string, clause: string) => r.sponsors?.find((x) => x.id === sp)?.clauses.find((c) => c.id === clause)?.type ?? '';
    const kept = r.final.bonuses.map((f) => ({ sponsor: f.sponsor, clause: f.clause, type: typeOf(f.sponsor, f.clause), car: f.car, usd: f.usd }));
    return { ...d.lap, bonuses: kept, bonus_usd: r.final.bonus_usd, prize_ev: r.final.prize_ev, total: r.final.total };
  }, [r, d, booked]);

  return (
    <div className="race">
      <Picker season={season} round={round} go={go} />
      {(!r || !d) && <FeedStrip />}
      {!live.online && !r ? (
        <section className="panel">
          <h2>Live feed not reachable</h2>
          <p className="muted">
            Start it with <code>make live-api</code> (port 8020). This desk plays that feed: Jev’s routing, the if-finished-now exposure, and the incident hand-off.
          </p>
        </section>
      ) : !r || !d ? (
        <p className="muted loading">{live.busy ?? 'Waiting for the first lap from the live feed…'}</p>
      ) : (
        <>
          {live.error && (
            <p className="outcome outcome--alert" role="alert">
              {live.error}
            </p>
          )}
          <Header r={r} pb={pb} />
          <FeedStrip />
          <ExposureTally />
          <StatPills r={r} lap={lap!} speed={d.speed} crashes={d.crashes} />
          <CarStage
            r={r}
            lap={lap!}
            car={carSel}
            setCar={setCar}
            sponsor={sponsor}
            setSponsor={setSponsor}
            playing={pb.playing || pb.tracking}
            official={d.finalIn}
            scrubber={<Scrubber r={r} frames={frames} pb={pb} />}
          />
          <RunningOrder r={r} lap={lap!} frame={pb.frame} official={d.finalIn} />
          <section className="race-strategy panel" aria-labelledby="strat-h">
            <div className="sec-head">
              <h2 id="strat-h">What every lever costs</h2>
              <p className="muted">
                From the feed's strategy advice, re-published on every team-car position change, flag change and pit stop: one place up, one place down, what a stop
                now would cost given this race's pit-lane time and the gaps, and the tyre context. No pace or degradation model is pretended.
              </p>
            </div>
            <StrategyCards names={Object.fromEntries(Object.entries(r.team_cars).map(([c, code]) => [Number(c), r.field?.[c]?.driver ?? code]))} />
          </section>
          <Gauges r={r} lap={lap!} crashes={d.crashes} car={carSel} official={d.finalIn} />
          <div className="race-mid">
            <SponsorPanel r={r} lap={lap!} car={carSel} sponsor={sponsor} setSponsor={setSponsor} flagged={d.flagged} booked={booked} />
            <Radio calls={d.radio} after={d.speed} />
          </div>
          <Telemetry r={r} upto={pb.frame?.lapIndex ?? 0} />
          <div className="race-two">
            <CrashDesk r={r} crashes={d.crashes} />
            <Books r={r} flagged={d.flagged} finalIn={d.finalIn} finalKnown={finalKnown} />
          </div>
          <SpeedBoard r={r} clock={pb.frame?.clock ?? r.start_utc} flagged={d.flagged} />
          <Approvals inbox={inbox} status={status} />
          <p className="small muted race-method">
            {r.method.data}. Bonuses: {r.method.bonuses}. Prize money: {r.method.prize_money}. Clock: {r.method.clock}.
          </p>
        </>
      )}
    </div>
  );
}
