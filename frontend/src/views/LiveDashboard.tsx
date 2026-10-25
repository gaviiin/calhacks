import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Figure } from '../components/Figure';
import { IconAgent, IconApproved, IconBolt, IconChart, IconDenied, IconDoc, IconExternal, IconFlag, IconLive, IconPlay, IconRadio, IconShield, IconStop, IconWaiting } from '../components/icons';
import { BRAZIL, SPA, useLive, type AdvisorNote, type DriverState, type FeedHealth, type IncidentSignal, type JevDecision, type LiveState, type RaceStateUpdate } from '../lib/live';
import {
  buildStory,
  clock,
  compoundWord,
  driverName,
  exposureSeries,
  feedAge,
  flagSegments,
  flagTone,
  flagWord,
  frac,
  KIND_WORDS,
  money,
  rainSegments,
  ROUTE_WORDS,
  sentence,
  signed,
  sinkByName,
  stints,
  trackTempSeries,
  URGENCY_TONE,
  words,
  type Advice,
  type Plan,
  type Signal,
  type StoryItem,
  type StoryKind,
  type Tone,
} from '../lib/liveStory';
import '../live-dashboard.css';

// The live race, read as a finance desk reads it: what the money is right now, what every lever
// (a place, a stop, the tyres, the weather) is worth, what moved it, and what Jev decided about each
// event, in the time the race happened. Real sporting facts (OpenF1, the FIA), synthetic contracts,
// calculated exposure; nothing on this page is booked. Lime is the person's primary action and
// "earning now"; amber is waiting or a caution; coral is money lost or a red flag.

const PRESETS = [
  { id: 'brazil-incident', race: BRAZIL, label: 'São Paulo 2024 · laps 28–34', note: 'the VSC stop and the lap-32 crash', body: { from_lap: 28, to_lap: 34 } },
  { id: 'brazil-mid', race: BRAZIL, label: 'São Paulo 2024 · laps 20–45', note: 'rain, tyres, the restart', body: { from_lap: 20, to_lap: 45 } },
  { id: 'brazil-full', race: BRAZIL, label: 'São Paulo 2024 · whole race', note: '69 laps', body: { from_lap: 1, to_lap: null } },
  { id: 'spa', race: SPA, label: 'Spa 2024 · FIA documents', note: 'Russell disqualified after winning', body: {} },
] as const;
const SPEEDS = [10, 20, 40, 60] as const;

async function post(path: string, body: unknown): Promise<unknown> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { detail?: string }).detail ?? `HTTP ${r.status}`);
  return data;
}

function Chip({ tone = 'neutral', icon, children, title, className = '' }: { tone?: Tone; icon?: ReactNode; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`ld-chip ld-chip--${tone} ${className}`} title={title}>
      {icon}
      <span>{children}</span>
    </span>
  );
}

function Delta({ cents, strong = false }: { cents: number | null | undefined; strong?: boolean }) {
  const tone = (cents ?? 0) < 0 ? 'alert' : (cents ?? 0) > 0 ? 'ok' : 'neutral';
  return <span className={`ld-delta ld-delta--${tone} ${strong ? 'ld-delta--strong' : ''}`}>{signed(cents)}</span>;
}

// ---------------------------------------------------------------- command bar

function CommandBar({ live }: { live: LiveState }) {
  const [speed, setSpeed] = useState<number>(20);
  const [pauseAt32, setPauseAt32] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rp = live.replay;
  const running = rp?.state === 'running' || rp?.state === 'fast_forward';
  const start = async (preset: (typeof PRESETS)[number]) => {
    setBusy(preset.label);
    setErr(null);
    try {
      const body = preset.race === SPA ? { race_id: SPA, speed: 120 } : { race_id: BRAZIL, ...preset.body, speed, pause_at_lap: pauseAt32 ? 32 : null, corroborate_after_s: 45 };
      await post('/live/replay', body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const pct = rp && rp.events_total ? Math.round((100 * rp.events_done) / rp.events_total) : 0;
  const stateTone: Tone = rp?.state === 'running' ? 'ok' : rp?.state === 'paused' ? 'hold' : rp?.state === 'error' ? 'alert' : 'neutral';
  return (
    <section className="ld-command" aria-label="Replay controls">
      <div className="ld-command-row">
        <div className="ld-presets" role="group" aria-label="Race">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className={`ld-preset ${rp?.race_id === p.race && !busy ? 'ld-preset--race' : ''}`} onClick={() => void start(p)} disabled={!!busy || !live.online} title={p.note}>
              <span className="ld-preset-label">{p.label}</span>
              <span className="ld-preset-note">{p.note}</span>
            </button>
          ))}
        </div>
        <div className="ld-knobs">
          <label className="ld-knob">
            <span>Speed</span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
          <label className="ld-knob ld-knob--check">
            <input type="checkbox" checked={pauseAt32} onChange={(e) => setPauseAt32(e.target.checked)} />
            <span>Pause at lap 32</span>
          </label>
          {rp?.state === 'paused' ? (
            <button type="button" className="btn btn--primary" onClick={() => void live.resume()}>
              <IconPlay /> Resume
            </button>
          ) : null}
          {running || rp?.state === 'paused' ? (
            <button type="button" className="btn" onClick={() => void live.stop()}>
              <IconStop /> Stop
            </button>
          ) : null}
        </div>
      </div>
      <div className="ld-command-row ld-command-row--status">
        <Chip tone={stateTone} icon={rp?.state === 'running' ? <IconLive /> : rp?.state === 'paused' ? <IconWaiting /> : <IconStop />}>
          {rp ? `${sentence(words(rp.state))}${rp.speed ? ` · ${rp.speed}×` : ' · no waiting'}` : live.online ? 'No replay running' : 'Live API not reachable (make live-api)'}
        </Chip>
        {rp ? (
          <span className="ld-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Replay progress">
            <span style={{ width: `${pct}%` }} />
          </span>
        ) : null}
        {rp ? <span className="ld-muted mono">{rp.events_done.toLocaleString()} / {rp.events_total.toLocaleString()} records</span> : null}
        <span className="ld-muted">mode {rp?.mode ?? 'replay'} · real OpenF1 timing, synthetic contracts, calculated exposure, nothing booked</span>
        {busy ? <span className="ld-muted">Starting {busy}…</span> : null}
        {err ?? live.error ? <span className="ld-error">{err ?? live.error}</span> : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- health strip

function HealthStrip({ feed, feedAt, now, running }: { feed: FeedHealth | null; feedAt: number; now: number; running: boolean }) {
  const age = feedAge(feed, feedAt, now);
  const stdb = sinkByName(feed, 'spacetimedb');
  const stale = running && age !== null && age > 10;
  const ageTone: Tone = !feed ? 'neutral' : stale ? 'hold' : running ? 'ok' : 'neutral';
  return (
    <div className="ld-health" aria-label="Feed health">
      <Chip tone={ageTone} icon={<IconLive />} title="wall-clock seconds since the feed last published anything">
        {feed ? `Updated ${age !== null ? age.toFixed(1) : '?'} s ago` : 'Feed health unknown'}
      </Chip>
      {feed ? <span className="ld-health-item mono">{feed.publishes_last_60s} updates/min · {feed.publishes_per_second_10s}/s</span> : null}
      {feed?.race_clock_utc ? (
        <span className="ld-health-item">
          race clock <b className="mono">{clock(feed.race_clock_utc)}Z</b> lap <b className="mono">{feed.lap ?? '—'}</b>
        </span>
      ) : null}
      <Chip tone={stdb ? (stdb.ok ? 'ok' : 'alert') : 'neutral'} icon={stdb?.ok ? <IconApproved /> : <IconDenied />} title={stdb?.detail ?? 'the pit-wall database the dashboard subscribes to'}>
        {stdb ? (stdb.ok ? `SpacetimeDB ${stdb.written.toLocaleString()} rows · last ${clock(stdb.last_write_utc)}` : `SpacetimeDB off: ${stdb.detail ?? 'unreachable'}`) : 'SpacetimeDB: no replay yet'}
      </Chip>
      <Chip tone={feed?.jev?.mode?.startsWith('api') ? 'ok' : 'hold'} icon={<IconBolt />} title={feed?.jev?.mode}>
        {feed?.jev?.mode?.startsWith('api') ? `Jev live · ${feed.jev.requests ?? 0} req · p95 ${feed.jev.p95_ms ?? '—'} ms` : `Jev ${feed?.jev?.mode ?? 'unknown'}`}
      </Chip>
      <Chip tone={feed?.advisor?.startsWith('claude') ? 'ok' : 'neutral'} icon={<IconAgent />} title={feed?.advisor}>
        {feed?.advisor?.startsWith('claude') ? 'Advisor on' : 'Advisor off'}
      </Chip>
    </div>
  );
}

// ---------------------------------------------------------------- hero cards

function ClockCard({ race, rp }: { race: RaceStateUpdate | null; rp: LiveState['replay'] }) {
  const w = race?.weather;
  return (
    <section className="ld-card ld-clock" aria-labelledby="ld-clock-h">
      <h2 id="ld-clock-h" className="ld-h">
        Race clock
      </h2>
      <div className="ld-clock-big mono">{race ? `${clock(race.event_time_utc)}Z` : '--:--:--'}</div>
      <div className="ld-clock-lap">
        Lap <b className="mono">{race?.lap ?? '—'}</b> <span className="ld-muted">of 69</span>
      </div>
      <div className="ld-chips">
        <Chip tone={flagTone(race?.flag_status)} icon={<IconFlag />}>
          {flagWord(race?.flag_status)}
        </Chip>
        <Chip tone={w?.rainfall ? 'hold' : 'neutral'} icon={<IconRadio />}>
          {w ? `${w.rainfall ? 'Rain' : 'Dry'} · track ${w.track_temperature_c ?? '?'}°C · air ${w.air_temperature_c ?? '?'}°C` : 'Weather unknown'}
        </Chip>
      </div>
      <p className="ld-muted ld-small">
        {rp?.race_id === SPA ? '2024 Belgian Grand Prix, from the FIA documents at their real publication times.' : '2024 São Paulo Grand Prix, from OpenF1 timing, weather, race control and car data.'}
      </p>
    </section>
  );
}

function Sparkline({ points, width = 320, height = 64, tone = 'ink' }: { points: { v: number; t: string }[]; width?: number; height?: number; tone?: 'ink' | 'lime' | 'hold' }) {
  if (points.length < 2) return <svg className="ld-spark" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" />;
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const t0 = Date.parse(points[0].t);
  const t1 = Date.parse(points[points.length - 1].t);
  const x = (t: string) => (t1 > t0 ? ((Date.parse(t) - t0) / (t1 - t0)) * (width - 4) + 2 : 2);
  const y = (v: number) => (hi > lo ? height - 6 - ((v - lo) / (hi - lo)) * (height - 12) : height / 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  return (
    <svg className={`ld-spark ld-spark--${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d} L${x(last.t).toFixed(1)},${height} L2,${height} Z`} className="ld-spark-fill" />
      <path d={d} className="ld-spark-line" />
      <circle cx={x(last.t)} cy={y(last.v)} r={3} className="ld-spark-dot" />
    </svg>
  );
}

function MoneyCard({ live, advice }: { live: LiveState; advice: Advice | null }) {
  const race = live.race;
  const fc = race?.forecast;
  const series = useMemo(() => exposureSeries(live.states), [live.states]);
  const now = fc?.amount_cents ?? advice?.exposure_now_cents ?? null;
  const lost = advice?.lost_from_peak_cents ?? null;
  const byCar = new Map<number, { total: number; lines: string[] }>();
  for (const l of fc?.lines ?? []) {
    const e = byCar.get(l.car) ?? { total: 0, lines: [] };
    e.total += l.amount_usd_cents;
    e.lines.push(`${l.sponsor_name} ${l.clause_type === 'win' ? 'win' : l.clause_type === 'podium' ? 'podium' : l.clause_type === 'top6' ? 'top six' : 'points'} ${money(l.amount_usd_cents)}`);
    byCar.set(l.car, e);
  }
  return (
    <section className="ld-card ld-money" aria-labelledby="ld-money-h">
      <div className="ld-card-head">
        <h2 id="ld-money-h" className="ld-h">
          Sponsor money if the race ended now
        </h2>
        <Chip tone="neutral" icon={<IconChart />}>
          indicative · unbooked
        </Chip>
      </div>
      <div className="ld-money-main">
        <div>
          <Figure className="ld-money-big mono" value={now ?? 0} format={(v) => (now === null ? '—' : money(Math.round(v)))} />
          {race?.forecast_change?.delta_cents ? <Delta cents={race.forecast_change.delta_cents} strong /> : null}
        </div>
        <Sparkline points={series} tone={(lost ?? 0) > 0 ? 'hold' : 'lime'} />
      </div>
      <dl className="ld-tally">
        <div>
          <dt>Peak this replay</dt>
          <dd className="mono">{money(advice?.exposure_peak_cents)}</dd>
        </div>
        <div className={lost ? 'ld-tally-lost' : ''}>
          <dt>Given up since the peak</dt>
          <dd className="mono">{lost ? `−${money(lost)}` : '$0'}</dd>
        </div>
        <div>
          <dt>At the join</dt>
          <dd className="mono">{money(advice?.exposure_at_join_cents)}</dd>
        </div>
        <div>
          <dt>Constructors' place</dt>
          <dd className="mono">{fc?.prize ? `P${fc.prize.constructors_position}` : '—'}</dd>
        </div>
      </dl>
      <ul className="ld-lines" aria-label="Clauses paying at the current positions">
        {[...byCar.entries()].map(([car, e]) => (
          <li key={car}>
            <b>
              {driverName(car)} <span className="ld-muted">car {car}</span>
            </b>
            <span className="mono">{money(e.total)}</span>
            <span className="ld-muted ld-small">{e.lines.join(' · ')}</span>
          </li>
        ))}
        {!byCar.size ? <li className="ld-muted">No clause pays at the current positions.</li> : null}
      </ul>
    </section>
  );
}

function JevCard({ live, feed }: { live: LiveState; feed: FeedHealth | null }) {
  const material = live.jevDecisions.filter((d) => d.payload.material);
  const last = material[material.length - 1] ?? null;
  const d: JevDecision | null = last?.payload.decision ?? null;
  const probs = d?.route_probabilities ? Object.entries(d.route_probabilities).sort((a, b) => b[1] - a[1]) : [];
  return (
    <section className="ld-card ld-jev" aria-labelledby="ld-jev-h">
      <div className="ld-card-head">
        <h2 id="ld-jev-h" className="ld-h">
          Quick decisions · Jev
        </h2>
        <Chip tone={feed?.jev?.mode?.startsWith('api') ? 'ok' : 'hold'} icon={<IconBolt />}>
          {feed?.jev?.mode?.startsWith('api') ? `live · p50 ${feed.jev.p50_ms ?? '—'} ms` : 'deterministic fallback'}
        </Chip>
      </div>
      {last && d ? (
        <>
          <div className="ld-jev-last">
            <div className="ld-jev-kind">
              {KIND_WORDS[last.payload.kind] ?? sentence(words(last.payload.kind))} <span className="ld-muted">· lap {last.payload.lap ?? '—'} · {clock(last.payload.at)}Z</span>
            </div>
            <div className="ld-jev-route">{ROUTE_WORDS[d.chosen_route] ?? d.chosen_route}</div>
            <div className="ld-chips">
              {d.urgency ? (
                <Chip tone={URGENCY_TONE[d.urgency]} icon={<IconWaiting />}>
                  {d.urgency}
                </Chip>
              ) : null}
              <Chip tone={d.used ? (d.status === 'ok' ? 'ok' : 'hold') : 'neutral'} icon={d.used ? <IconApproved /> : <IconDenied />}>
                {d.used ? `Jev ${d.status === 'ok' ? 'decided' : words(d.status)}` : `Jev ${words(d.status)}`}
              </Chip>
              {d.latency_ms !== null ? <span className="ld-muted mono">{d.latency_ms} ms</span> : null}
              {d.model ? <span className="ld-muted mono">{d.model}</span> : null}
            </div>
            {d.route && d.route !== d.chosen_route ? (
              <p className="ld-small ld-muted">
                Jev said <b>{ROUTE_WORDS[d.route] ?? d.route}</b> at {((d.route_confidence ?? 0) * 100).toFixed(0)}%; code kept <b>{ROUTE_WORDS[d.chosen_route]}</b>: {d.reason}
              </p>
            ) : (
              <p className="ld-small ld-muted">{d.reason}</p>
            )}
            {probs.length ? (
              <ul className="ld-probs" aria-label="Route probabilities">
                {probs.map(([k, v]) => (
                  <li key={k}>
                    <span>{ROUTE_WORDS[k] ?? k}</span>
                    <span className="ld-prob-bar">
                      <span style={{ width: `${Math.round(v * 100)}%` }} />
                    </span>
                    <span className="mono">{(v * 100).toFixed(0)}%</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <ol className="ld-jev-list" aria-label="Earlier decisions">
            {material
              .slice(-6, -1)
              .reverse()
              .map((m) => (
                <li key={m.id + m.version}>
                  <span className="mono ld-muted">{clock(m.payload.at)}</span>
                  <span>{KIND_WORDS[m.payload.kind] ?? words(m.payload.kind)}</span>
                  <span className="ld-jev-mini-route">{ROUTE_WORDS[m.payload.decision.chosen_route] ?? m.payload.decision.chosen_route}</span>
                  <span className="mono ld-muted">{m.payload.decision.latency_ms !== null ? `${m.payload.decision.latency_ms} ms` : words(m.payload.decision.status)}</span>
                </li>
              ))}
          </ol>
        </>
      ) : (
        <p className="ld-muted">No material event yet. Jev is asked once per material candidate (a flag, a stopped car, a forecast swing, a weather flip, an FIA document), never per telemetry tick.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the two cars

function CarCard({ car, race, advice }: { car: number; race: RaceStateUpdate | null; advice: Advice | null }) {
  const d: DriverState | undefined = race?.driver_states.find((x) => x.driver_number === car);
  const place = advice?.places.find((p) => p.car === car);
  const pit = advice?.pit.find((p) => p.car === car);
  const tyre = advice?.tyres.find((t) => t.car === car);
  const earning = place?.value_now_cents ?? 0;
  const statusTone: Tone = d?.status === 'stopped_candidate' ? 'alert' : d?.status === 'in_pit' ? 'hold' : 'neutral';
  const under = pit?.under;
  const factor = under === 'RED_FLAG' ? 'red flag' : under?.startsWith('SAFETY') ? 'Safety Car' : under?.startsWith('VSC') ? 'VSC' : null;
  const hasGreen = pit?.green_positions_lost !== undefined && pit?.green_positions_lost !== null;
  return (
    <section className="ld-card ld-car" aria-label={`Car ${car}`}>
      <div className="ld-car-head">
        <div className="ld-car-num mono">{car}</div>
        <div>
          <div className="ld-car-name">{driverName(car, d)}</div>
          <div className="ld-chips">
            <Chip tone={statusTone} icon={d?.status === 'stopped_candidate' ? <IconDenied /> : <IconLive />}>
              {d?.status === 'in_pit' ? 'In the pits' : d?.status === 'stopped_candidate' ? 'Stopped' : d ? 'Running' : 'Unknown'}
            </Chip>
            <Chip tone="neutral" icon={<IconRadio />}>
              {compoundWord(d?.compound)}s · {d?.tyre_age_laps ?? '?'} laps{tyre?.field_median_age_laps !== null && tyre?.field_median_age_laps !== undefined ? ` (field ${tyre.field_median_age_laps.toFixed(0)})` : ''}
            </Chip>
          </div>
        </div>
        <div className="ld-car-pos">
          <span className="ld-muted">Position</span>
          <b className="mono">{d?.position ? `P${d.position}` : '—'}</b>
        </div>
      </div>
      <dl className="ld-levers">
        <div>
          <dt>Earning now</dt>
          <dd className={`mono ${earning ? 'ld-ok' : ''}`}>{money(earning)}</dd>
        </div>
        <div>
          <dt>One place up</dt>
          <dd>
            <Delta cents={place?.up_one_cents ?? 0} />
          </dd>
        </div>
        <div>
          <dt>One place down</dt>
          <dd>
            <Delta cents={place?.down_one_cents ?? 0} />
          </dd>
        </div>
        <div>
          <dt>Pit now{factor ? ` (${factor})` : ''}</dt>
          <dd>
            <Delta cents={pit?.delta_cents ?? 0} />{' '}
            <span className="ld-muted ld-small">
              {pit ? `${pit.positions_lost} place${pit.positions_lost === 1 ? '' : 's'}, ${pit.pit_loss_s.toFixed(0)} s${pit.rejoin_position ? `, rejoin P${pit.rejoin_position}` : ''}` : ''}
            </span>
          </dd>
        </div>
        {pit && hasGreen && factor && factor !== 'red flag' ? (
          <div>
            <dt>Same stop under green</dt>
            <dd>
              <Delta cents={pit.green_delta_cents ?? 0} /> <span className="ld-muted ld-small">{pit.green_positions_lost ?? '?'} places, {pit.green_pit_loss_s?.toFixed(0) ?? '?'} s</span>
            </dd>
          </div>
        ) : null}
      </dl>
      {pit?.cars_passed.length ? <p className="ld-small ld-muted">A stop now lets {pit.cars_passed.map((c) => `car ${c}`).join(', ')} past{pit.cars_maybe.length ? `; ${pit.cars_maybe.map((c) => `car ${c}`).join(', ')} too close to call` : ''}.</p> : null}
      {tyre ? <p className="ld-small ld-muted">{tyre.note}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------- conditions

function Strip({ segments, from, to, kind }: { segments: { from: string; to: string; label: string }[]; from: string; to: string; kind: 'flag' | 'rain' }) {
  return (
    <div className={`ld-strip ld-strip--${kind}`} role="img" aria-label={segments.map((s) => `${s.label} ${clock(s.from)} to ${clock(s.to)}`).join('; ')}>
      {segments.map((s, i) => {
        const a = frac(s.from, from, to);
        const b = i === segments.length - 1 ? 1 : frac(segments[i + 1].from, from, to);
        return <span key={s.from + s.label} className={`ld-seg ld-seg--${s.label.toLowerCase()}`} style={{ left: `${a * 100}%`, width: `${Math.max(0.4, (b - a) * 100)}%` }} title={`${kind === 'flag' ? flagWord(s.label) : sentence(s.label)} from ${clock(s.from)}Z`} />;
      })}
    </div>
  );
}

function StintBar({ car, list, minLap, maxLap }: { car: number; list: ReturnType<typeof stints>; minLap: number; maxLap: number }) {
  const span = Math.max(1, maxLap - minLap);
  return (
    <div className="ld-stint-row">
      <span className="ld-stint-car mono">{car}</span>
      <div className="ld-strip ld-strip--stint" role="img" aria-label={list.map((s) => `${compoundWord(s.compound)} from lap ${s.fromLap} to ${s.toLap}`).join('; ')}>
        {list.map((s, i) => {
          const a = ((s.fromLap ?? minLap) - minLap) / span;
          const b = i === list.length - 1 ? 1 : (((list[i + 1].fromLap ?? maxLap) - minLap) / span);
          return (
            <span key={`${s.fromLap}-${s.compound}-${s.pitLap}`} className={`ld-seg ld-seg--${(s.compound ?? 'unknown').toLowerCase()}`} style={{ left: `${a * 100}%`, width: `${Math.max(0.6, (b - a) * 100)}%` }} title={`${compoundWord(s.compound)} laps ${s.fromLap}–${s.toLap}, age ${s.ageAtEnd ?? '?'}`}>
              {b - a > 0.12 ? `${compoundWord(s.compound)} ${s.ageAtEnd ?? ''}` : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ConditionsCard({ live, advice }: { live: LiveState; advice: Advice | null }) {
  const states = live.states;
  const from = states[0]?.payload.event_time_utc ?? '';
  const to = states[states.length - 1]?.payload.event_time_utc ?? '';
  const flags = useMemo(() => flagSegments(states), [states]);
  const rain = useMemo(() => rainSegments(states), [states]);
  const temp = useMemo(() => trackTempSeries(states), [states]);
  const cars = live.race?.team_cars ?? [63, 44];
  const laps = states.map((s) => s.payload.lap ?? 0).filter(Boolean);
  const minLap = laps.length ? Math.min(...laps) : 1;
  const maxLap = laps.length ? Math.max(...laps) : 69;
  const levers = advice?.levers ?? [];
  const tempRange = temp.length ? `${Math.min(...temp.map((p) => p.v)).toFixed(1)}–${Math.max(...temp.map((p) => p.v)).toFixed(1)}°C` : '—';
  return (
    <section className="ld-card ld-cond" aria-labelledby="ld-cond-h">
      <div className="ld-card-head">
        <h2 id="ld-cond-h" className="ld-h">
          Why weather, tyres and pit stops are money
        </h2>
        <span className="ld-muted ld-small">
          {states.length ? `${clock(from)}Z → ${clock(to)}Z · laps ${minLap}–${maxLap}` : 'waiting for the first state'}
        </span>
      </div>
      <div className="ld-cond-grid">
        <div className="ld-cond-strips">
          <div className="ld-strip-label">Flag</div>
          <Strip segments={flags} from={from} to={to} kind="flag" />
          <div className="ld-strip-label">Rain at the sensor</div>
          <Strip segments={rain} from={from} to={to} kind="rain" />
          <div className="ld-strip-label">Track temperature {tempRange}</div>
          <Sparkline points={temp} height={44} tone="hold" />
          <div className="ld-strip-label">Tyre stints (compound · age at end)</div>
          {cars.map((c) => (
            <StintBar key={c} car={c} list={stints(states, c)} minLap={minLap} maxLap={maxLap} />
          ))}
          <div className="ld-legend ld-small ld-muted">
            <span className="ld-seg ld-seg--green" /> green <span className="ld-seg ld-seg--vsc" /> VSC <span className="ld-seg ld-seg--safety_car" /> Safety Car <span className="ld-seg ld-seg--red_flag" /> red flag <span className="ld-seg ld-seg--rain" /> rain
          </div>
        </div>
        <div className="ld-cond-text">
          <h3>Right now</h3>
          {levers.length ? (
            <ul className="ld-levers-list">
              {levers.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : (
            <p className="ld-muted">The lever lines appear with the first strategy advice (a team car moving, a flag, a pit stop).</p>
          )}
          <p className="ld-small ld-muted">
            Pit loss is this race's median pit-lane time ({advice?.pit[0]?.pit_loss_basis ?? 'default until a stop is seen'}); under the Safety Car a stop costs about half the track position, under a red flag nothing. Gaps come from when each car started its current lap. No tyre-wear or pace model is pretended.
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the story

const STORY_FILTERS: { id: 'all' | StoryKind[]; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: ['money', 'strategy'], label: 'Money' },
  { id: ['jev', 'advisor'], label: 'Jev & advisor' },
  { id: ['incident', 'handoff'], label: 'Incidents' },
  { id: ['flag', 'weather', 'pit'], label: 'Conditions' },
  { id: ['result'], label: 'FIA documents' },
];

const KIND_ICON: Record<StoryKind, ReactNode> = {
  money: <IconChart />,
  flag: <IconFlag />,
  weather: <IconRadio />,
  pit: <IconWaiting />,
  incident: <IconDenied />,
  jev: <IconBolt />,
  advisor: <IconAgent />,
  result: <IconDoc />,
  handoff: <IconShield />,
  strategy: <IconChart />,
};

function Story({ items }: { items: StoryItem[] }) {
  const [filter, setFilter] = useState(0);
  const f = STORY_FILTERS[filter].id;
  const shown = (f === 'all' ? items : items.filter((i) => (f as StoryKind[]).includes(i.kind))).slice(0, 80);
  return (
    <section className="ld-card ld-story" aria-labelledby="ld-story-h">
      <div className="ld-card-head">
        <h2 id="ld-story-h" className="ld-h">
          What moved the money
        </h2>
        <div className="ld-filters" role="tablist" aria-label="Story filter">
          {STORY_FILTERS.map((x, i) => (
            <button key={x.label} type="button" role="tab" aria-selected={i === filter} className={`ld-filter ${i === filter ? 'ld-filter--on' : ''}`} onClick={() => setFilter(i)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      {shown.length ? (
        <ol className="ld-story-list">
          {shown.map((it) => (
            <li key={it.key} className={`ld-story-item ld-story-item--${it.tone} ld-story-item--${it.kind}`}>
              <span className="ld-story-when mono">
                {clock(it.t)}
                <small>{it.lap ? `lap ${it.lap}` : ''}</small>
              </span>
              <span className="ld-story-icon" aria-hidden="true">
                {KIND_ICON[it.kind]}
              </span>
              <span className="ld-story-body">
                <span className="ld-story-title">{it.title}</span>
                {it.detail ? <span className="ld-story-detail">{it.detail}</span> : null}
                {it.meta ? <span className="ld-story-meta ld-muted">{it.meta}</span> : null}
              </span>
              <span className="ld-story-delta">{it.delta !== undefined && it.delta !== null && it.delta !== 0 ? <Delta cents={it.delta} /> : null}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="ld-muted">Nothing yet. Start a replay above; every change in the money, every flag, stop, incident and Jev decision lands here in race time.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- incidents and plans

function AdvisorCard({ a }: { a: AdvisorNote }) {
  if (a.status === 'pending') {
    return (
      <div className="ld-advisor ld-advisor--pending">
        <Chip tone="hold" icon={<IconWaiting />}>
          Live finance agent drafting…
        </Chip>
      </div>
    );
  }
  if (!a.used) {
    return (
      <div className="ld-advisor ld-advisor--off">
        <Chip tone="neutral" icon={<IconDenied />}>
          Advisor {words(a.status)}
        </Chip>
        {a.error ? <span className="ld-small ld-muted">{a.error}</span> : null}
      </div>
    );
  }
  return (
    <div className="ld-advisor">
      <div className="ld-advisor-head">
        <IconAgent />
        <b>{a.headline}</b>
      </div>
      <p>{a.rationale}</p>
      {a.what_we_need.length ? (
        <p className="ld-small">
          <span className="ld-muted">Still needed: </span>
          {a.what_we_need.join('; ')}
        </p>
      ) : null}
      <div className="ld-chips ld-small">
        <Chip tone={a.confidence === 'high' ? 'ok' : 'hold'} icon={<IconApproved />}>
          prepares for {words(a.recommended_scenario)} · {a.confidence} confidence
        </Chip>
        <span className="ld-muted mono">
          {a.model} · {a.latency_ms} ms
        </span>
        <span className="ld-muted">a draft, nothing booked</span>
      </div>
    </div>
  );
}

function PlanTable({ plan }: { plan: Plan }) {
  const p = plan.payload;
  const rec = p.advisor.recommended_scenario;
  return (
    <table className="ld-plan" aria-label={`Outcomes priced for car ${p.car}`}>
      <thead>
        <tr>
          <th>Outcome</th>
          <th>Position</th>
          <th>Exposure</th>
          <th>Change</th>
          <th>What it assumes</th>
        </tr>
      </thead>
      <tbody>
        {p.scenarios.map((s) => (
          <tr key={s.key} className={s.key === rec ? 'ld-plan-rec' : ''}>
            <td>
              {s.label}
              {s.key === rec ? <span className="ld-rec">advisor</span> : null}
            </td>
            <td className="mono">{s.position_after ? `P${s.position_after}` : 'out'}</td>
            <td className="mono">{money(s.exposure_after_cents)}</td>
            <td>
              <Delta cents={s.delta_cents} />
            </td>
            <td className="ld-small ld-muted">
              {s.assumption}
              {s.lines_lost.length ? ` Loses ${s.lines_lost.join('; ')}.` : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GarageDemo({ sig }: { sig: IncidentSignal }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!(sig.handoff.status === 'requested' && sig.financial_impact.status === 'unknown')) return null;
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/live/incidents/${encodeURIComponent(sig.incident_id)}/finance-impact`, {
        incident_id: sig.incident_id,
        financial_status: 'synthetic_projected_not_booked',
        initial_exposure_cents: 40_000_000,
        selected_recovery_cost_cents: 13_000_000,
        forecast_headroom_after_cents: 107_000_000,
        requires_engineering_approval: true,
        requires_finance_approval: true,
        accounting_rule_version: 'demo-config',
        evidence_refs: ['synthetic_garage_report:demo'],
        note: 'Demo figures from the plan, not a valuation',
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ld-garage">
      <button type="button" className="btn" onClick={() => void send()} disabled={busy}>
        <IconShield /> Simulate the cost cap desk's answer
      </button>
      <span className="ld-small ld-muted">synthetic demo figures ($400k exposure, $130k recovery); the real answer comes from the cost cap agent by incident id</span>
      {err ? <span className="ld-error">{err}</span> : null}
    </div>
  );
}

function IncidentsPanel({ live }: { live: LiveState }) {
  const latest = new Map<string, Signal>();
  const bestJev = new Map<string, JevDecision>();
  for (const s of live.incidents) {
    latest.set(s.id, s); // sorted by seq, so the last wins
    if (s.payload.jev.used || !bestJev.has(s.id)) bestJev.set(s.id, s.payload.jev); // a follow-up message is not re-asked; keep Jev's real answer
  }
  const plans = new Map(live.plans.map((p) => [p.id, p]));
  const list = [...latest.values()].sort((a, b) => b.payload.event_time_utc.localeCompare(a.payload.event_time_utc));
  return (
    <section className="ld-card ld-incidents" aria-labelledby="ld-inc-h">
      <div className="ld-card-head">
        <h2 id="ld-inc-h" className="ld-h">
          Crashes and what they could cost
        </h2>
        <span className="ld-muted ld-small">{list.length ? `${list.length} incident${list.length === 1 ? '' : 's'} this replay` : ''}</span>
      </div>
      {list.length ? (
        list.map((s) => {
          const p = s.payload;
          const jev = bestJev.get(s.id) ?? p.jev;
          const plan = plans.get(s.id);
          const impact = live.financeImpacts.filter((f) => f.payload.incident_id === s.id).at(-1)?.payload;
          return (
            <article key={s.id} className={`ld-incident ld-incident--${p.type}`} aria-label={p.incident_id}>
              <header className="ld-incident-head">
                <div>
                  <div className="ld-incident-title">
                    {p.driver_number ? `${driverName(p.driver_number)} · car ${p.driver_number}` : 'Red flag, no driver named'} <span className="ld-muted">· lap {p.lap} · {clock(p.event_time_utc)}Z · v{p.version}</span>
                  </div>
                  <div className="ld-chips">
                    <Chip tone={p.sporting_confirmation === 'verified_historical_incident' ? 'ok' : 'hold'} icon={p.sporting_confirmation === 'verified_historical_incident' ? <IconApproved /> : <IconWaiting />}>
                      {sentence(words(p.sporting_confirmation))}
                    </Chip>
                    <Chip tone="neutral" icon={<IconDoc />}>
                      {words(p.driver_attribution)}
                    </Chip>
                    <Chip tone={jev.used ? 'ok' : 'neutral'} icon={<IconBolt />}>
                      Jev {jev.used ? `${ROUTE_WORDS[jev.chosen_route] ?? jev.chosen_route}${jev.route_confidence !== null ? ` · ${((jev.route_confidence ?? 0) * 100).toFixed(0)}%` : ''}${jev.latency_ms !== null ? ` · ${jev.latency_ms} ms` : ''}` : words(jev.status)}
                    </Chip>
                    <Chip tone={p.handoff.status === 'assessed' ? 'ok' : p.handoff.status === 'requested' ? 'hold' : 'neutral'} icon={<IconShield />}>
                      {p.handoff.target === 'cost_cap_agent' ? `Cost cap agent: ${words(p.handoff.status)}` : 'Not handed over'}
                    </Chip>
                    <Chip tone={p.financial_impact.status === 'unknown' ? 'neutral' : 'ok'} icon={<IconChart />}>
                      {p.financial_impact.status === 'unknown' ? 'Damage cost unknown' : `Projected ${money(p.financial_impact.amount_cents)}, not booked`}
                    </Chip>
                  </div>
                </div>
              </header>
              <p className="ld-incident-msg">{p.message}</p>
              <ul className="ld-evidence ld-small">
                {p.source_evidence.map((e, i) => (
                  <li key={`${e.record_id ?? i}-${e.endpoint}`}>
                    <span className="mono">{e.endpoint}</span> {clock(e.event_time_utc)}Z {e.note ? `· ${e.note}` : ''}
                    {e.url ? (
                      <a href={e.url} target="_blank" rel="noreferrer" className="ld-ext">
                        <IconExternal />
                      </a>
                    ) : null}
                  </li>
                ))}
                {p.corroborating_source_url ? (
                  <li>
                    <span className="mono">race report</span> {p.corroboration_note}{' '}
                    <a href={p.corroborating_source_url} target="_blank" rel="noreferrer" className="ld-ext">
                      <IconExternal />
                    </a>
                  </li>
                ) : null}
              </ul>
              {plan ? (
                <>
                  <h3 className="ld-h3">
                    Outcomes priced for {driverName(plan.payload.car)} <span className="ld-muted">· as of {clock(plan.payload.as_of_utc)}Z, {flagWord(plan.payload.flag_status).toLowerCase()}, team exposure {money(plan.payload.exposure_now_cents)}</span>
                  </h3>
                  {!plan.payload.team_car ? <p className="ld-small ld-muted">Car {plan.payload.car} is not a Meridian car: only the running order behind it moves the team's sponsor money. The garage side is the demo's fiction.</p> : null}
                  <PlanTable plan={plan} />
                  <p className="ld-small ld-muted">{plan.payload.cost_cap_note}</p>
                  <AdvisorCard a={plan.payload.advisor} />
                </>
              ) : (
                <p className="ld-small ld-muted">No outcome plan for this incident (it only prices watched cars).</p>
              )}
              {impact ? (
                <p className="ld-small">
                  Cost cap desk answered: exposure {money(impact.initial_exposure_cents)}, recovery {money(impact.selected_recovery_cost_cents)}, headroom after {money(impact.forecast_headroom_after_cents)} · {impact.financial_status.replace(/_/g, ' ')}
                  {impact.note ? ` · ${impact.note}` : ''}
                </p>
              ) : (
                <GarageDemo sig={p} />
              )}
            </article>
          );
        })
      ) : (
        <p className="ld-muted">No incident yet. On the São Paulo replay the lap-32 stop arrives at 16:37Z: a candidate from car data, the red flag ten seconds later, corroboration, then the hand-off to the cost cap agent with every outcome priced.</p>
      )}
    </section>
  );
}

function ResultsPanel({ live }: { live: LiveState }) {
  if (!live.resultChanges.length) return null;
  return (
    <section className="ld-card" aria-labelledby="ld-res-h">
      <h2 id="ld-res-h" className="ld-h">
        FIA documents and the money
      </h2>
      <ol className="ld-results">
        {live.resultChanges.map((r) => (
          <li key={r.id + r.version}>
            <span className="mono ld-muted">{clock(r.payload.event_time_utc)}Z</span>
            <span>
              <b>{r.payload.document?.title ?? words(r.payload.type)}</b>
              <span className="ld-small">{r.payload.message}</span>
            </span>
            <span className="mono">
              {money(r.payload.before.amount_cents)} → {money(r.payload.after.amount_cents)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- the page

export function LiveDashboard() {
  const live = useLive();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  const advice = (live.strategy as unknown as Advice | null) ?? null;
  // Only this replay's records: the store keeps earlier runs' incidents and decisions (the stream replays from the start).
  const since = live.replayStartedAt;
  const scoped = useMemo<LiveState>(() => {
    const keep = <T,>(list: { published_at_utc: string; payload: T }[]) => (since ? list.filter((r) => r.published_at_utc >= since) : list);
    return { ...live, incidents: keep(live.incidents), jevDecisions: keep(live.jevDecisions), plans: keep(live.plans), financeImpacts: keep(live.financeImpacts), resultChanges: keep(live.resultChanges) } as LiveState;
  }, [live, since]);
  const story = useMemo(() => buildStory(scoped), [scoped]);
  const running = live.replay?.state === 'running' || live.replay?.state === 'fast_forward';
  const cars = live.race?.team_cars ?? [63, 44];
  const isSpa = live.replay?.race_id === SPA;
  return (
    <div className="ld">
      <header className="ld-title">
        <div>
          <p className="crumbs">Pit wall › Live race</p>
          <h1>{isSpa ? 'Belgian Grand Prix 2024' : 'São Paulo Grand Prix 2024'}</h1>
          <p className="ld-sub">Meridian Racing's money, lap by lap: what the race is worth right now, what each lever costs, and what Jev decided about every event.</p>
        </div>
        <HealthStrip feed={live.feed} feedAt={live.feedAt} now={now} running={running} />
      </header>
      <CommandBar live={live} />
      {!isSpa ? (
        <>
          <div className="ld-hero">
            <ClockCard race={live.race} rp={live.replay} />
            <MoneyCard live={live} advice={advice} />
            <JevCard live={scoped} feed={live.feed} />
          </div>
          <div className="ld-cars">
            {cars.map((c) => (
              <CarCard key={c} car={c} race={live.race} advice={advice} />
            ))}
          </div>
          <ConditionsCard live={live} advice={advice} />
        </>
      ) : (
        <div className="ld-hero ld-hero--spa">
          <JevCard live={scoped} feed={live.feed} />
          <ResultsPanel live={scoped} />
        </div>
      )}
      <div className="ld-main">
        <Story items={story} />
        <IncidentsPanel live={scoped} />
      </div>
      <p className="ld-foot ld-small ld-muted">
        Real: OpenF1 positions, laps, stints, pit stops, weather, race control and car 43's car data; the FIA documents; the race report. Synthetic: Meridian Racing, its sponsor contracts, the garage figures. Calculated: every dollar on this page, labelled indicative. Booked: nothing here; the revenue desk books from the final classification.
      </p>
    </div>
  );
}
