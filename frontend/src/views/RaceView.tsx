import { useMemo, useState, type FormEvent } from 'react';
import { LineChart, type Marker } from '../charts/LineChart';
import { F1Car } from '../components/F1Car';
import { IconApproved, IconDenied, IconLive, IconWaiting } from '../components/icons';
import { usdShort } from '../lib/format';
import { useRace } from '../lib/race';
import {
  DRIVERS,
  TEAM,
  TRACK_LABEL,
  band,
  carLabel,
  carVisual,
  costByLap,
  damageLabel,
  eventDetail,
  involvesTeam,
  isTeamCar,
  jevStats,
  kindMeta,
  ledger,
  live,
  readForecast,
  readJev,
  runningOrder,
  signed,
  sortTime,
  stepClock,
  tierOf,
  trackStatus,
  utcClock,
  type Ledger,
  type TrackStatus,
} from '../lib/raceModel';
import type { CarState, RaceEffects, RaceEvents, RaceForecasts } from '../module_bindings/types';
import { useSeat } from '../lib/seat';

// The race desk: the live tape of a Grand Prix read as money. Events arrive from the replayer, the
// agents turn them into cost and revenue bands, a person corrects what they got wrong, and the
// policies that decided them learn from the correction.

type Filter = 'all' | 'team' | 'money';

const CAR_STATUS: Record<string, { label: string; tone: string }> = {
  running: { label: 'running', tone: 'flag--ok' },
  pit: { label: 'in pit', tone: 'flag--hold' },
  retired_suspected: { label: 'stopped?', tone: 'flag--hold' },
  retired: { label: 'OUT', tone: 'flag--alert' },
};

// ---------------------------------------------------------------- header + live figures

/** The field's lap: the highest lap any event has reported. */
function fieldLap(events: readonly RaceEvents[]): number {
  return events.reduce((m, e) => Math.max(m, e.lap), 0);
}

function Header({ events }: { events: readonly RaceEvents[] }) {
  const latest = events[0];
  return (
    <section className="race-head" aria-label="Session">
      <div>
        <h1>
          Race desk <span className="muted">· {TEAM}</span>
        </h1>
        <p className="muted">
          {latest ? (
            <>
              Session <span className="mono">{latest.sessionKey}</span> · meeting <span className="mono">{latest.meetingKey}</span> · {events.length.toLocaleString('en-US')}{' '}
              events on the tape
            </>
          ) : (
            'Waiting for the replayer to write the first event.'
          )}
        </p>
      </div>
    </section>
  );
}

type PillTone = 'ok' | 'alert' | 'hold';

const TRACK_PILL: Record<TrackStatus, PillTone | undefined> = {
  GREEN: 'ok',
  SC: 'alert',
  VSC: 'alert',
  RED: 'alert',
  CHEQUERED: undefined,
  UNKNOWN: undefined,
};

/** The strip of live figures: the same pills as the replay desk, read from the SpacetimeDB tables. */
function LiveStrip({ events, effects, led, status }: { events: readonly RaceEvents[]; effects: readonly RaceEffects[]; led: Ledger; status: TrackStatus }) {
  const latest = events[0];
  const lap = fieldLap(events);
  const jev = useMemo(() => jevStats(effects), [effects]);
  const bonuses = led.bonuses.filter(live).reduce((sum, b) => sum + b.midCents, 0n);
  const pills: { k: string; label: string; value: string; tone?: PillTone }[] = [
    { k: 'clock', label: 'UTC', value: latest ? utcClock(latest.at) : '—' },
    { k: 'lap', label: 'Lap', value: lap ? `${lap} / ?` : '— / ?' },
    { k: 'track', label: 'Track', value: status === 'UNKNOWN' ? TRACK_LABEL[status] : status, tone: TRACK_PILL[status] },
    { k: 'cost', label: 'Race cost', value: led.cost.n ? usdShort(led.cost.mid) : '$0', tone: led.cost.mid > 0n ? 'alert' : undefined },
    { k: 'prize', label: 'Prize projection', value: led.prize.n ? signed(led.prize.mid) : '—', tone: led.prize.mid < 0n ? 'alert' : led.prize.mid > 0n ? 'ok' : undefined },
    { k: 'cap', label: 'Cap headroom', value: led.headroom ? usdShort(led.headroom.midCents) : '—', tone: led.headroom && led.headroom.midCents < 0n ? 'alert' : undefined },
    { k: 'bonus', label: 'Sponsor bonuses', value: bonuses ? signed(bonuses) : '$0', tone: bonuses > 0n ? 'ok' : undefined },
    { k: 'jev', label: 'Jev', value: jev.meanMs === null ? 'offline' : `${Math.round(jev.meanMs)}ms · ${jev.n} decisions`, tone: jev.meanMs === null ? undefined : 'ok' },
  ];
  return (
    <ul className="pills" aria-label="Live figures">
      {pills.map((p) => (
        <li key={p.k} className={`pill${p.tone ? ` pill--${p.tone}` : ''}`}>
          <span className="pill-label">{p.label}</span>
          <b className="mono">{p.value}</b>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- the team's cars

/** What the race did to the car, from Jev's part probabilities on its latest cost booking. */
function carDamage(car: CarState, effects: readonly RaceEffects[]): string | null {
  const cost = effects
    .filter((e) => e.driverNumber === car.driverNumber && e.kind === 'cost' && e.bucket === '6050' && live(e))
    .sort((a, b) => sortTime(b.at) - sortTime(a.at));
  for (const e of cost) {
    const label = damageLabel(readJev(e.jevJson)?.parts ?? {});
    if (label) return label;
  }
  if (cost.length) return 'damage booked';
  return carVisual(car.status) === 'running' ? null : 'assessing';
}

function CarCard({ car, effects }: { car: CarState; effects: readonly RaceEffects[] }) {
  const st = CAR_STATUS[car.status] ?? { label: car.status.replace(/_/g, ' '), tone: '' };
  const code = DRIVERS[car.driverNumber] ?? '';
  const visual = carVisual(car.status);
  const damage = carDamage(car, effects);
  return (
    <article className={`car car--${car.status}`} aria-label={`Car ${car.driverNumber} ${code}`}>
      <div className="car-stage">
        <F1Car number={String(car.driverNumber)} state={visual} spinning={car.status === 'running'} damage={damage} title={`${TEAM} car ${car.driverNumber}${code ? `, ${code}` : ''}`} />
      </div>
      <div className="car-pos">
        <b className="mono">P{car.position || '—'}</b>
        <span className="car-id">
          <span className="mono">#{car.driverNumber}</span> {code}
        </span>
        <span className={`flag ${st.tone}`}>
          {car.status === 'retired' ? <IconDenied size={12} /> : car.status === 'running' ? <IconLive size={12} /> : <IconWaiting size={12} />}
          {st.label}
        </span>
      </div>
      <dl className="car-facts">
        <div>
          <dt>Tyre</dt>
          <dd>
            {car.compound ? car.compound.toUpperCase() : '—'} <span className="muted">age {car.tyreAge}</span>
          </dd>
        </div>
        <div>
          <dt>Gap</dt>
          <dd className="mono">{car.gapToLeader || '—'}</dd>
        </div>
        <div>
          <dt>Lap</dt>
          <dd className="mono">{car.lap}</dd>
        </div>
        <div>
          <dt>Last pit</dt>
          <dd className="mono">{car.lastPitLap ? `L${car.lastPitLap}` : '—'}</dd>
        </div>
        {damage && visual !== 'crashed' && (
          <div>
            <dt>Damage</dt>
            <dd className="tone-alert">{damage}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}

function Timing({ cars, effects }: { cars: readonly CarState[]; effects: readonly RaceEffects[] }) {
  const team = cars.filter((c) => c.teamName === TEAM || isTeamCar(c.driverNumber)).sort((a, b) => a.driverNumber - b.driverNumber);
  return (
    <section className="race-timing" aria-label="Team cars">
      {team.length ? team.map((c) => <CarCard key={c.driverNumber} car={c} effects={effects} />) : <p className="muted empty">No car state yet.</p>}
    </section>
  );
}

// ---------------------------------------------------------------- running order

function RunningOrder({ cars, events }: { cars: readonly CarState[]; events: readonly RaceEvents[] }) {
  const rows = useMemo(() => runningOrder(cars), [cars]);
  const latest = events[0];
  const lap = fieldLap(events);
  return (
    <section className="order" aria-labelledby="order-h">
      <div className="order-head">
        <h2 id="order-h">Running order</h2>
        <span className="small muted">
          {lap ? `Lap ${lap}` : 'Grid'} · {latest ? utcClock(latest.at) : '—'} UTC · {TEAM} in lime
        </span>
      </div>
      {rows.length ? (
        <ol className="order-strip">
          {rows.map((c) => {
            const ours = c.teamName === TEAM || isTeamCar(c.driverNumber);
            const visual = carVisual(c.status);
            const out = visual !== 'running';
            return (
              <li key={c.driverNumber} className={`order-card${ours ? ' order-card--ours' : ''}${out ? ' order-card--out' : ''}`}>
                <span className="order-top">
                  <b className="mono">{out ? 'OUT' : c.position ? `P${c.position}` : '—'}</b>
                  <span className="mono muted">#{c.driverNumber}</span>
                </span>
                <span className="order-car">
                  <F1Car mini number={String(c.driverNumber)} state={visual} tone={ours ? 'team' : 'field'} title={`${c.teamName || 'Car'} ${c.driverNumber}`} />
                </span>
                <span className="order-who">
                  <b>{DRIVERS[c.driverNumber] ?? `#${c.driverNumber}`}</b>
                  <span className="small muted">{c.teamName || '—'}</span>
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted empty order-empty">No cars on the timing screen yet.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- tape

function Tape({ events, moneyKeys }: { events: readonly RaceEvents[]; moneyKeys: ReadonlySet<string> }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [all, setAll] = useState(false);
  const shown = useMemo(() => {
    const f = events.filter((e) => (filter === 'all' ? true : filter === 'team' ? involvesTeam(e) : moneyKeys.has(e.eventKey)));
    return { total: f.length, rows: all ? f : f.slice(0, 200) };
  }, [events, filter, all, moneyKeys]);
  const teamCount = useMemo(() => events.filter(involvesTeam).length, [events]);
  return (
    <section className="race-tape panel" aria-labelledby="tape-h">
      <div className="sec-head">
        <h2 id="tape-h">Event tape</h2>
        <div className="filters" role="group" aria-label="Filter the tape">
          {(
            [
              ['all', 'All', events.length],
              ['team', TEAM, teamCount],
              ['money', 'Money', moneyKeys.size],
            ] as [Filter, string, number][]
          ).map(([id, label, n]) => (
            <button key={id} type="button" className={filter === id ? 'filter filter--on' : 'filter'} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label} <span className="mono">{n}</span>
            </button>
          ))}
        </div>
      </div>
      {shown.rows.length ? (
        <ol className="tape">
          {shown.rows.map((e) => {
            const meta = kindMeta(e.kind);
            const team = involvesTeam(e);
            const cls = ['tape-row', team && 'tape-row--team', team && meta.loud && 'tape-row--loud', moneyKeys.has(e.eventKey) && 'tape-row--money']
              .filter(Boolean)
              .join(' ');
            return (
              <li key={e.eventKey} className={cls}>
                <span className="tape-time mono">{utcClock(e.at)}</span>
                <span className="tape-lap mono">{e.lap ? `L${e.lap}` : ''}</span>
                <span className={`tape-car mono ${isTeamCar(e.driverNumber) ? 'tape-car--team' : ''}`}>{carLabel(e.driverNumber)}</span>
                <span className="tape-kind">
                  <span className="tape-glyph mono" aria-hidden="true">
                    {meta.glyph}
                  </span>
                  {meta.label}
                </span>
                <span className="tape-detail">
                  {eventDetail(e)}
                  {moneyKeys.has(e.eventKey) && <span className="tape-tag">$ booked</span>}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="muted empty">{events.length ? 'Nothing on the tape matches this filter.' : 'The tape is empty until the replayer starts.'}</p>
      )}
      {shown.total > 200 && (
        <button type="button" className="btn tape-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show the latest 200' : `Show all ${shown.total.toLocaleString('en-US')}`}
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- money

const TIER_LABEL: Record<string, string> = { policy: 'policy', jev: 'Jev', claude: 'Claude', code: 'code' };

function dollars(cents: bigint): string {
  return (Number(cents) / 100).toFixed(2);
}

function toCents(s: string): bigint | null {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? BigInt(Math.round(n * 100)) : null;
}

function CorrectForm({ effect, onDone }: { effect: RaceEffects; onDone: () => void }) {
  const race = useRace();
  const { person } = useSeat();
  const [low, setLow] = useState(dollars(effect.lowCents));
  const [mid, setMid] = useState(dollars(effect.midCents));
  const [high, setHigh] = useState(dollars(effect.highCents));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const l = toCents(low);
    const m = toCents(mid);
    const h = toCents(high);
    if (l === null || m === null || h === null) return setError('Each figure needs to be a dollar amount.');
    if (!(l <= m && m <= h)) return setError('The band must run low ≤ mid ≤ high.');
    if (!reason.trim()) return setError('Say why: the precedent carries the reason.');
    setBusy(true);
    setError(null);
    try {
      await race.correct({ effectKey: effect.effectKey, lowCents: l, midCents: m, highCents: h, reason: reason.trim(), by: person.name, at: new Date().toISOString() });
      onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /race_head|unauthorized/i.test(msg)
          ? `This browser's pit-wall identity does not hold the Head of Racing Finance seat. Grant it with: uv run python scripts/race_grant.py --role race_head --identity ${race.identityHex ?? '<hex>'}`
          : msg
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="correct" onSubmit={submit}>
      <div className="correct-band">
        <label className="field">
          <span>Low $</span>
          <input inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} />
        </label>
        <label className="field">
          <span>Mid $</span>
          <input inputMode="decimal" value={mid} onChange={(e) => setMid(e.target.value)} />
        </label>
        <label className="field">
          <span>High $</span>
          <input inputMode="decimal" value={high} onChange={(e) => setHigh(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Reason</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="floor was already in spares; only the labour" maxLength={512} />
      </label>
      {error && (
        <p className="outcome outcome--alert" role="alert">
          <IconDenied size={14} />
          <span>{error}</span>
        </p>
      )}
      <div className="decide-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Correcting…' : 'Correct the band'}
        </button>
        <button type="button" className="btn" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EffectRow({ effect, connected }: { effect: RaceEffects; connected: boolean }) {
  const [open, setOpen] = useState(false);
  const tier = tierOf(effect.decidedBy);
  const jev = tier === 'jev' ? readJev(effect.jevJson) : null;
  const corrected = effect.status === 'corrected';
  const cls = ['effect', `effect--${tier}`, effect.status === 'proposed' && 'effect--proposed', corrected && 'effect--corrected'].filter(Boolean).join(' ');
  return (
    <li className={cls}>
      <div className="effect-top">
        <span className={`tier tier--${tier}`}>
          {TIER_LABEL[tier]}
          {jev && (
            <span className="tier-note mono">
              {jev.ms !== null && `${Math.round(jev.ms)}ms`}
              {jev.topSeverity && ` · ${jev.topSeverity.name} ${Math.round(jev.topSeverity.p * 100)}%`}
            </span>
          )}
        </span>
        <span className="effect-car mono">{carLabel(effect.driverNumber)}</span>
        <span className="effect-bucket mono muted">{effect.bucket}</span>
        {effect.status !== 'autonomous' && <span className={`state state--${effect.status === 'proposed' ? 'proposed' : 'rejected'}`}>{effect.status}</span>}
        <span className="effect-time mono muted">{utcClock(effect.at)}</span>
      </div>
      <div className="effect-line">
        <span className="effect-memo">{effect.memo || effect.kind.replace(/_/g, ' ')}</span>
        <span className="effect-amount mono">
          <b>{effect.kind === 'revenue_projection' ? signed(effect.midCents) : usdShort(effect.midCents)}</b>
          <small className="muted">{band(effect.lowCents, effect.highCents)}</small>
        </span>
      </div>
      {effect.why && <p className="effect-why muted">{effect.why}</p>}
      <div className="effect-foot">
        <span className="muted mono">
          {effect.basis} · {effect.decidedBy}
        </span>
        {!corrected && !open && (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setOpen(true)}
            disabled={!connected}
            title={connected ? 'Correct this band; the policy that decided it learns' : 'not connected to pit-wall'}
          >
            Correct
          </button>
        )}
      </div>
      {open && <CorrectForm effect={effect} onDone={() => setOpen(false)} />}
    </li>
  );
}

const OUT_KINDS: Record<string, string> = { incident: 'incident', retirement_suspected: 'stopped', retirement_confirmed: 'out' };

/** Cumulative race cost by lap, with the team's incidents marked on the laps they happened. */
function CostChart({ effects, events }: { effects: readonly RaceEffects[]; events: readonly RaceEvents[] }) {
  const data = useMemo(() => costByLap(effects, events, fieldLap(events)), [effects, events]);
  const markers = useMemo(() => {
    const seen = new Set<string>();
    const out: Marker[] = [];
    for (const e of events) {
      const word = OUT_KINDS[e.kind];
      if (!word || !isTeamCar(e.driverNumber)) continue;
      const label = `#${e.driverNumber} ${word}`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({ x: e.lap, label, tone: 'alert' });
    }
    return out;
  }, [events]);
  const booked = data.mid[data.mid.length - 1] > 0;
  if (!booked || data.xs.length < 2) {
    return <p className="muted small">Nothing booked yet. The line starts when an event costs the team money.</p>;
  }
  return (
    <LineChart
      xs={data.xs}
      series={[
        { key: 'mid', label: 'mid', values: data.mid, color: '--lime', area: 0.1 },
        { key: 'low', label: 'low', values: data.low, color: '--s1', dashed: true },
        { key: 'high', label: 'high', values: data.high, color: '--s1', dashed: true },
      ]}
      xLabel={(x) => `L${x}`}
      yLabel={(y) => usdShort(y)}
      yMin={0}
      height={200}
      markers={markers}
      tooltip={(i) => (
        <div className="tooltip-row">
          <span className="tooltip-line" style={{ background: 'var(--lime)' }} />
          <span>
            Lap {data.xs[i]} · <b className="mono">{usdShort(data.mid[i])}</b> <span className="muted mono">{usdShort(data.low[i])} – {usdShort(data.high[i])}</span>
          </span>
        </div>
      )}
      ariaLabel="Race cost by lap"
    />
  );
}

function Money({ effects, events, led, connected }: { effects: readonly RaceEffects[]; events: readonly RaceEvents[]; led: Ledger; connected: boolean }) {
  const latest = useMemo(() => effects.slice().sort((a, b) => sortTime(b.at) - sortTime(a.at)).slice(0, 20), [effects]);
  return (
    <section className="race-money panel" aria-labelledby="money-h">
      <div className="sec-head">
        <h2 id="money-h">Money</h2>
        <span className="muted">{effects.filter(live).length} live effects</span>
      </div>
      <dl className="money-grid">
        <div className="money-cell money-cell--lead">
          <dt>Race cost so far</dt>
          <dd>
            <b className="mono">{usdShort(led.cost.mid)}</b>
            <small className="mono muted">{led.cost.n ? band(led.cost.low, led.cost.high) : 'nothing booked yet'}</small>
          </dd>
        </div>
        <div className="money-cell">
          <dt>Projected prize money</dt>
          <dd>
            <b className={`mono ${led.prize.mid < 0n ? 'tone-alert' : led.prize.mid > 0n ? 'tone-ok' : ''}`}>{led.prize.n ? signed(led.prize.mid) : '—'}</b>
            <small className="muted">constructors' ladder, estimate</small>
          </dd>
        </div>
        <div className="money-cell">
          <dt>Cap headroom</dt>
          <dd>
            <b className={`mono ${led.headroom && led.headroom.midCents < 0n ? 'tone-alert' : ''}`}>{led.headroom ? usdShort(led.headroom.midCents) : '—'}</b>
            <small className="muted">{led.headroom ? `as of ${utcClock(led.headroom.at)} UTC` : 'no reading yet'}</small>
          </dd>
        </div>
        <div className="money-cell">
          <dt>Sponsor bonuses</dt>
          <dd>
            {led.bonuses.length ? (
              <ul className="bonus-list">
                {led.bonuses.slice(0, 4).map((b) => (
                  <li key={b.effectKey} className={b.status === 'corrected' ? 'struck' : ''}>
                    <span>{b.memo || b.bucket}</span>
                    <span className="mono">
                      {signed(b.midCents)} <span className="muted">{b.status}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <small className="muted">none triggered</small>
            )}
          </dd>
        </div>
      </dl>
      <h3>Race cost by lap</h3>
      <CostChart effects={effects} events={events} />
      <h3>Latest effects</h3>
      {latest.length ? (
        <ul className="effects">
          {latest.map((e) => (
            <EffectRow key={e.effectKey} effect={e} connected={connected} />
          ))}
        </ul>
      ) : (
        <p className="muted empty">No effects yet. The first appears when an event costs or earns the team money.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- forecast

const FORECAST_STATUS: Record<string, { label: string; tone: string; pulse?: boolean }> = {
  running: { label: 'forecasting', tone: 'flag--hold', pulse: true },
  ready: { label: 'ready', tone: 'flag--ok' },
  failed: { label: 'failed', tone: 'flag--alert' },
  offline: { label: 'deterministic fallback', tone: '' },
};

function Forecast({ forecast }: { forecast: RaceForecasts | null }) {
  const f = useMemo(() => (forecast ? readForecast(forecast) : null), [forecast]);
  if (!forecast || !f) {
    return (
      <section className="race-forecast panel" aria-labelledby="fc-h">
        <div className="sec-head">
          <h2 id="fc-h">Incident forecast</h2>
        </div>
        <p className="muted empty">No incident forecast yet. One appears when a Williams car is involved in an incident.</p>
      </section>
    );
  }
  const st = FORECAST_STATUS[forecast.status] ?? { label: forecast.status, tone: '' };
  const money = (c: number) => usdShort(c);
  return (
    <section className="race-forecast panel" aria-labelledby="fc-h">
      <div className="sec-head">
        <h2 id="fc-h">Incident forecast</h2>
        <span className={`flag ${st.tone} ${st.pulse ? 'flag--pulse' : ''}`} role="status">
          {forecast.status === 'failed' ? <IconDenied size={12} /> : forecast.status === 'ready' ? <IconApproved size={12} /> : <IconWaiting size={12} />}
          {st.label}
        </span>
        <p className="muted">
          {carLabel(forecast.driverNumber)} · {utcClock(forecast.createdAt)} UTC{forecast.model ? ` · ${forecast.model}` : ''}
        </p>
      </div>
      {forecast.summary && <p className="forecast-summary">{forecast.summary}</p>}
      {f.totals && (
        <p className="forecast-total">
          <b className="mono">{money(f.totals.mid)}</b> <span className="mono muted">{money(f.totals.low)} – {money(f.totals.high)}</span>
        </p>
      )}
      {f.steps.length > 0 && (
        <ol className="steps">
          {f.steps.map((s, i) => (
            <li key={i}>
              <span className="step-t mono">{stepClock(s.t)}</span>
              <span className="step-body">
                <span className="step-label">{s.label}</span>
                {s.detail && <span className="muted">{s.detail}</span>}
              </span>
              <span className="step-band mono">
                {money(s.cents_mid)}
                <small className="muted">
                  {money(s.cents_low)} – {money(s.cents_high)}
                </small>
              </span>
            </li>
          ))}
        </ol>
      )}
      {f.parts.length > 0 && (
        <div className="table-wrap">
          <table className="mini parts">
            <thead>
              <tr>
                <th>Part</th>
                <th className="num">p</th>
                <th className="num">Low</th>
                <th className="num">Mid</th>
                <th className="num">High</th>
                <th>Basis</th>
                <th>Stock</th>
              </tr>
            </thead>
            <tbody>
              {f.parts.map((p, i) => (
                <tr key={`${p.part}-${i}`}>
                  <td>{p.label}</td>
                  <td className="num mono">{Math.round(p.p * 100)}%</td>
                  <td className="num mono">{money(p.low)}</td>
                  <td className="num mono">{money(p.mid)}</td>
                  <td className="num mono">{money(p.high)}</td>
                  <td className="muted">{p.basis}</td>
                  <td>{p.in_spares ? 'in spares' : 'order'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(f.prize || f.cap) && (
        <dl className="kv forecast-kv">
          {f.prize && (
            <div>
              <dt>Prize money</dt>
              <dd className="mono">
                {f.prize.position_before ? `P${f.prize.position_before} ${money(f.prize.before)}` : '—'} → P{f.prize.position_after} {money(f.prize.after)}{' '}
                <span className={f.prize.delta < 0 ? 'tone-alert' : 'tone-ok'}>({f.prize.delta > 0 ? '+' : ''}{money(f.prize.delta)})</span>
              </dd>
            </div>
          )}
          {f.cap && (
            <div>
              <dt>Cap headroom</dt>
              <dd className="mono">
                {money(f.cap.headroom_before)} → {money(f.cap.headroom_after)}
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- learning

const AUTONOMY_TONE: Record<string, string> = { GRANTED: 'state--approved', SHADOW: 'state--proposed', REVOKED: 'state--rejected', SUSPENDED: 'state--rejected' };

function Learning() {
  const race = useRace();
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of race.policies) m.set(p.autonomy, (m.get(p.autonomy) ?? 0) + 1);
    return ['GRANTED', 'SHADOW', 'SUSPENDED', 'REVOKED'].filter((a) => m.has(a)).map((a) => [a, m.get(a) ?? 0] as const);
  }, [race.policies]);
  const policies = useMemo(() => race.policies.slice().sort((a, b) => b.hits - a.hits), [race.policies]);
  const precedents = useMemo(() => race.precedents.slice().sort((a, b) => sortTime(b.at) - sortTime(a.at)).slice(0, 5), [race.precedents]);
  return (
    <section className="race-learning panel" aria-labelledby="learn-h">
      <div className="sec-head">
        <h2 id="learn-h">Learning</h2>
        <span className="muted">
          {counts.length ? counts.map(([a, n]) => `${n} ${a.toLowerCase()}`).join(' · ') : 'no policies yet'}
        </span>
      </div>
      {policies.length > 0 && (
        <ul className="policy-list">
          {policies.map((p) => (
            <li key={p.policyId} className="policy-line">
              <span className="policy-title">{p.title || p.policyId}</span>
              <span className={`state ${AUTONOMY_TONE[p.autonomy] ?? ''}`}>{p.autonomy}</span>
              <span className="mono muted">
                {p.hits} hits · {p.contradictions} contradictions
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3>Latest corrections</h3>
      {precedents.length ? (
        <ul className="precedents">
          {precedents.map((p) => (
            <li key={p.precedentKey}>
              <span>{p.reason}</span>
              <span className="muted">
                {p.by} · <span className="mono">{usdShort(p.correctedMidCents)}</span> · {utcClock(p.at)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No corrections yet. Correct an effect and its policy learns.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- view

export function RaceView() {
  const race = useRace();
  const events = useMemo(() => race.events.slice().sort((a, b) => sortTime(b.at) - sortTime(a.at) || b.eventKey.localeCompare(a.eventKey)), [race.events]);
  const moneyKeys = useMemo(() => new Set(race.effects.map((e) => e.eventKey)), [race.effects]);
  const forecast = useMemo(
    () => race.forecasts.reduce<RaceForecasts | null>((best, f) => (!best || sortTime(f.createdAt) >= sortTime(best.createdAt) ? f : best), null),
    [race.forecasts]
  );
  const led = useMemo(() => ledger(race.effects), [race.effects]);
  const status = useMemo(() => trackStatus(events), [events]);
  return (
    <div className="race race--live">
      <Header events={events} />
      <LiveStrip events={events} effects={race.effects} led={led} status={status} />
      <Timing cars={race.cars} effects={race.effects} />
      <RunningOrder cars={race.cars} events={events} />
      {!race.connected && (
        <p className="muted loading race-span">Connecting to pit-wall on SpacetimeDB…</p>
      )}
      <div className="race-cols">
        <Tape events={events} moneyKeys={moneyKeys} />
        <div className="race-side">
          <Money effects={race.effects} events={events} led={led} connected={race.connected} />
          <Forecast forecast={forecast} />
          <Learning />
        </div>
      </div>
    </div>
  );
}
