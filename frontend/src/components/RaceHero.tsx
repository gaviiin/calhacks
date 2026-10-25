import { useMemo } from 'react';
import { pct, usdShort } from '../lib/format';
import {
  CLAUSE_WORDS,
  clauseHits,
  maxBonus,
  utc,
  type Crash,
  type Frame,
  type Lap,
  type Replay,
  type SpeedEvent,
} from '../lib/racedesk';
import { ReplayBlueprint } from '../blueprint/ReplayBlueprint';
import { F1Car, ZONES, type CarState } from './F1Car';
import { IconArrow, IconFlag, IconShield, IconWaiting } from './icons';

// The top of the race desk, laid out like a fleet console: a strip of live figures, the car itself with
// a hotspot where each sponsor's money is painted, both Meridian cars as cards, three gauges, the
// selected sponsor's contract, and the running order as a strip of cars.

export function signed(c: number): string {
  if (Math.abs(c) < 50) return '$0';
  return `${c > 0 ? '+' : '−'}${usdShort(Math.abs(c))}`;
}

const SPEC: Record<string, { mass: string; wheelbase: string; width: string; rules: string }> = {
  '2026': { mass: '768 kg', wheelbase: '3,400 mm', width: '1,900 mm', rules: '2026 technical regulations' },
  default: { mass: '798 kg', wheelbase: '3,600 mm', width: '2,000 mm', rules: '2022–25 technical regulations' },
};

export function carState(r: Replay, car: string, lap: Lap, official: boolean): CarState {
  if (official && r.classification?.[car]?.position_text === 'D') return 'dsq';
  if (lap.cars[car]?.position != null) return 'running';
  const crash = r.crashes.find((c) => String(c.car) === car && c.clock <= lap.clock);
  return crash ? 'crashed' : lap.lap === 0 ? 'running' : 'out';
}

// ------------------------------------------------------------------------------------------ stat pills

export function StatPills({ r, lap, speed, crashes }: { r: Replay; lap: Lap; speed: SpeedEvent[]; crashes: Crash[] }) {
  const protectedNow = speed.reduce((s, e) => s + (e.usd_protected ?? 0), 0);
  const fastest = speed.filter((s) => s.seconds_to_act != null).reduce<number | null>((m, s) => (m === null ? s.seconds_to_act! : Math.min(m, s.seconds_to_act!)), null);
  const risk = [...crashes].reverse().find((c) => c.p_breach_after != null);
  const pills: { k: string; label: string; value: string; tone?: 'ok' | 'alert' | 'hold' }[] = [
    { k: 'clock', label: 'UTC', value: utc(lap.clock) },
    { k: 'lap', label: 'Lap', value: lap.lap === 0 ? `Grid / ${r.race_laps}` : `${lap.lap} / ${r.race_laps}` },
    { k: 'total', label: 'On the line', value: usdShort(lap.total) },
    { k: 'delta', label: 'Since lights out', value: signed(lap.total - r.start.total), tone: lap.total >= r.start.total ? 'ok' : 'alert' },
    { k: 'bonus', label: 'Bonuses', value: usdShort(lap.bonus_usd) },
    { k: 'kept', label: 'Kept off invoices', value: usdShort(protectedNow), tone: protectedNow ? 'ok' : undefined },
    { k: 'fast', label: 'Fastest reaction', value: fastest == null ? '—' : `${fastest}s`, tone: fastest != null ? 'ok' : undefined },
  ];
  if (risk) pills.push({ k: 'risk', label: 'Cap breach risk', value: pct(risk.p_breach_after!, 0), tone: 'hold' });
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

// ------------------------------------------------------------------------------------------ the car

interface StageProps {
  r: Replay;
  lap: Lap;
  car: string;
  setCar: (c: string) => void;
  sponsor: string | null;
  setSponsor: (s: string) => void;
  playing: boolean;
  official: boolean;
  scrubber: React.ReactNode;
}

export function CarStage({ r, lap, car, setCar, sponsor, setSponsor, playing, official, scrubber }: StageProps) {
  const cars = Object.keys(r.team_cars);
  const idx = Math.max(0, cars.indexOf(car));
  const state = carState(r, car, lap, official);
  const now = lap.cars[car]?.position && !(official && r.classification?.[car]?.position_text === 'D') ? lap.cars[car] : undefined;
  const grid = r.classification?.[car]?.grid || r.laps[0]?.order[car] || null;
  const crash = r.crashes.find((c) => String(c.car) === car && c.clock <= lap.clock);
  const spec = SPEC[String(r.season)] ?? SPEC.default;
  const driver = r.field?.[car]?.driver ?? r.team_cars[car];
  const earning = (id: string) => lap.bonuses.some((b) => b.sponsor === id && String(b.car) === car);
  const max = maxBonus(r.sponsors ?? []);
  const earnedPct = max ? lap.bonus_usd / max : 0;
  const champ = Object.entries(lap.constructors_position).sort((a, b) => b[1] - a[1])[0];
  const statusPill =
    state === 'crashed' ? { cls: 'status--alert', t: 'Crashed' } : state === 'dsq' ? { cls: 'status--alert', t: 'Disqualified' } : state === 'out' ? { cls: 'status--muted', t: 'Out' } : playing ? { cls: 'status--live', t: 'Live' } : { cls: 'status--ok', t: 'Running' };

  return (
    <section className="stage" aria-label="Car">
      <aside className="stage-spec">
        <p className="stage-carid">
          <span className="muted small">Car</span>
          <b className="mono">{car}</b>
        </p>
        <p className="stage-driver">{driver}</p>
        <dl className="spec">
          <div>
            <dt>Position</dt>
            <dd className="mono">{state === 'dsq' ? 'DSQ' : now?.position ? `P${now.position}` : state === 'running' ? `P${grid ?? '—'}` : 'OUT'}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd className="mono">{grid ? `P${grid}` : '—'}</dd>
          </div>
          <div>
            <dt>One place up</dt>
            <dd className={`mono ${now && now.up_one > 0 ? 'tone-ok' : 'muted'}`}>{now ? signed(now.up_one) : '—'}</dd>
          </div>
          <div>
            <dt>One place down</dt>
            <dd className={`mono ${now && now.down_one < 0 ? 'tone-alert' : 'muted'}`}>{now ? signed(now.down_one) : '—'}</dd>
          </div>
          <div>
            <dt>Minimum mass</dt>
            <dd className="mono">{spec.mass}</dd>
          </div>
          <div>
            <dt>Wheelbase (max)</dt>
            <dd className="mono">{spec.wheelbase}</dd>
          </div>
        </dl>
      </aside>

      <div className="stage-main">
        <header className="stage-head">
          <h2>
            Car layout <span className={`status ${statusPill.cls}`}>{statusPill.t}</span>
          </h2>
          <div className="stage-meters">
            <div className="meter">
              <span className="meter-top">
                <b className="mono">{usdShort(lap.bonus_usd)}</b> <span className="muted">/ {usdShort(max)} bonus potential</span>
                <span className="meter-chip">{pct(earnedPct, 0)}</span>
              </span>
              <span className="meter-track">
                <span className="meter-fill meter-fill--lime" style={{ width: `${Math.min(100, earnedPct * 100)}%` }} />
              </span>
            </div>
            <div className="meter">
              <span className="meter-top">
                <b className="mono">{champ ? `P${champ[0]}` : '—'}</b> <span className="muted">constructors' finish, expected</span>
                <span className="meter-chip">{champ ? pct(champ[1], 0) : '—'}</span>
              </span>
              <span className="meter-track">
                <span className="meter-fill meter-fill--ink" style={{ width: `${champ ? champ[1] * 100 : 0}%` }} />
              </span>
            </div>
          </div>
        </header>

        <div className="stage-car">
          <button type="button" className="stage-arrow stage-arrow--l" onClick={() => setCar(cars[(idx + cars.length - 1) % cars.length])} aria-label="Previous car">
            ‹
          </button>
          <div className="stage-canvas stage-canvas--blueprint">
            <ReplayBlueprint
              car={car}
              code={r.field?.[car]?.code ?? r.team_cars[car]}
              team={r.team}
              position={now?.position ?? null}
              lap={lap.lap || null}
              state={state}
              crash={crash ?? null}
              sponsors={(r.sponsors ?? []).map((s) => ({ id: s.id, name: s.name, earning: earning(s.id) }))}
              sponsor={sponsor}
              onSponsor={setSponsor}
            />
          </div>
          <button type="button" className="stage-arrow stage-arrow--r" onClick={() => setCar(cars[(idx + 1) % cars.length])} aria-label="Next car">
            ›
          </button>
        </div>
        <p className="stage-hint small muted">Tap a + on the car to open that sponsor's contract. Lime rings are paying at this position.</p>
        {scrubber}
      </div>

      <aside className="stage-cars" aria-label="Meridian cars">
        {cars.map((c) => {
          const st = carState(r, c, lap, official);
          const pos = lap.cars[c]?.position;
          const earn = lap.bonuses.filter((b) => String(b.car) === c).reduce((s, b) => s + b.usd, 0);
          return (
            <button key={c} type="button" className={`carid${c === car ? ' carid--on' : ''}`} onClick={() => setCar(c)} aria-pressed={c === car}>
              <span className="carid-top">
                <span className="muted small">Car ID</span>
                <span className={`carid-pos mono${st !== 'running' ? ' tone-alert' : ''}`}>{st === 'dsq' ? 'DSQ' : st === 'running' ? (pos ? `P${pos}` : '—') : 'OUT'}</span>
              </span>
              <b className="carid-num mono">
                {c} <span>{r.team_cars[c]}</span>
              </b>
              <span className="carid-img">
                <F1Car mini number={c} state={st} />
              </span>
              <span className="carid-row">
                <span className="carid-field">
                  <span className="muted small">Earning now</span>
                  <b className="mono">{usdShort(earn)}</b>
                </span>
                <span className="carid-field">
                  <span className="muted small">Driver</span>
                  <b>{r.field?.[c]?.code ?? r.team_cars[c]}</b>
                </span>
              </span>
            </button>
          );
        })}
      </aside>
    </section>
  );
}

// ------------------------------------------------------------------------------------------ gauges

function polar(cx: number, cy: number, r: number, a: number) {
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
}

/** A dial from lo to hi: 240° of sweep, ticks, a needle and the value underneath. */
export function Dial({ value, lo, hi, label, format, ticks = 6, zones }: { value: number; lo: number; hi: number; label: string; format: (v: number) => string; ticks?: number; zones?: 'diverging' | 'risk' }) {
  const A0 = (150 * Math.PI) / 180;
  const A1 = (390 * Math.PI) / 180;
  const f = Math.max(0, Math.min(1, (value - lo) / (hi - lo || 1)));
  const a = A0 + f * (A1 - A0);
  const gid = `dial-${label.replace(/\W/g, '')}`;
  return (
    <svg viewBox="0 0 200 170" className="dial" role="img" aria-label={`${label}: ${format(value)}`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
          {zones === 'risk' ? (
            <>
              <stop offset="0" stopColor="#6d7a84" />
              <stop offset="0.55" stopColor="#ffb547" />
              <stop offset="1" stopColor="#ff725f" />
            </>
          ) : (
            <>
              <stop offset="0" stopColor="#ff725f" />
              <stop offset="0.5" stopColor="#6d7a84" />
              <stop offset="1" stopColor="#c9ff4b" />
            </>
          )}
        </linearGradient>
      </defs>
      <path d={arcPath(100, 96, 76, A0, A1)} stroke="#1b222b" strokeWidth="12" fill="none" strokeLinecap="round" />
      <path d={arcPath(100, 96, 76, A0, A1)} stroke={`url(#${gid})`} strokeWidth="5" fill="none" strokeLinecap="round" opacity="0.9" />
      {Array.from({ length: ticks * 4 + 1 }, (_, k) => {
        const t = A0 + (k / (ticks * 4)) * (A1 - A0);
        const major = k % 4 === 0;
        const [x0, y0] = polar(100, 96, major ? 58 : 62, t);
        const [x1, y1] = polar(100, 96, 66, t);
        return <line key={k} x1={x0} y1={y0} x2={x1} y2={y1} stroke={major ? '#aab5bc' : '#3a434c'} strokeWidth={major ? 1.6 : 1} />;
      })}
      {Array.from({ length: ticks + 1 }, (_, k) => {
        const t = A0 + (k / ticks) * (A1 - A0);
        const [x, y] = polar(100, 96, 46, t);
        return (
          <text key={k} x={x} y={y + 3} textAnchor="middle" className="dial-tick">
            {format(lo + (k / ticks) * (hi - lo))}
          </text>
        );
      })}
      <g style={{ transform: `rotate(${(a * 180) / Math.PI}deg)`, transformOrigin: '100px 96px', transition: 'transform 700ms cubic-bezier(0.22,1,0.36,1)' }}>
        <path d="M100 93 L172 96 L100 99 Z" fill="#f3f3f0" />
      </g>
      <circle cx="100" cy="96" r="7" fill="#0c1118" stroke="#f3f3f0" strokeWidth="2" />
      <text x="100" y="150" textAnchor="middle" className="dial-value">
        {format(value)}
      </text>
    </svg>
  );
}

/** A round tank filled to a share: bonuses earned against what the race could pay. */
export function Tank({ share, top, sub }: { share: number; top: string; sub: string }) {
  const s = Math.max(0, Math.min(1, share));
  const y = 150 - s * 120;
  return (
    <svg viewBox="0 0 200 170" className="tank" role="img" aria-label={`${top}, ${sub}`}>
      <defs>
        <clipPath id="tank-clip">
          <circle cx="100" cy="90" r="62" />
        </clipPath>
        <linearGradient id="tank-liquid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c9ff4b" />
          <stop offset="1" stopColor="#7fa92b" />
        </linearGradient>
      </defs>
      <circle cx="100" cy="90" r="74" fill="none" stroke="#2b323a" strokeDasharray="2 5" strokeWidth="2" />
      <circle cx="100" cy="90" r="62" fill="#111823" />
      <g clipPath="url(#tank-clip)">
        <g className="tank-wave" style={{ transform: `translateY(${y - 90}px)`, transition: 'transform 900ms cubic-bezier(0.22,1,0.36,1)' }}>
          <path d="M-60 90 Q -30 80 0 90 T 60 90 T 120 90 T 180 90 T 240 90 T 300 90 V 260 H -60 Z" fill="url(#tank-liquid)" opacity="0.92" className="tank-wave-path" />
        </g>
      </g>
      <text x="100" y="82" textAnchor="middle" className="tank-top">
        {top}
      </text>
      <text x="100" y="102" textAnchor="middle" className="tank-sub">
        {sub}
      </text>
    </svg>
  );
}

export function Gauges({ r, lap, crashes, car, official }: { r: Replay; lap: Lap; crashes: Crash[]; car: string; official: boolean }) {
  const swings = r.laps.map((l) => l.total - r.start.total);
  const span = Math.max(1, ...swings.map((v) => Math.abs(v))) * 1.15;
  const max = maxBonus(r.sponsors ?? []);
  const crash = [...crashes].reverse().find((c) => c.p_breach_after != null);
  const anyCrash = crashes[crashes.length - 1];
  const dsq = official && r.classification?.[car]?.position_text === 'D';
  const now = lap.cars[car]?.position && !dsq ? lap.cars[car] : undefined;
  return (
    <section className="gauges" aria-label="Gauges">
      <article className="gauge">
        <header>
          <h3>Money vs lights out</h3>
          <span className={`flag ${lap.total >= r.start.total ? 'flag--ok' : 'flag--alert'}`}>{lap.total >= r.start.total ? 'Up' : 'Down'}</span>
        </header>
        <Dial value={lap.total - r.start.total} lo={-span} hi={span} label="Money vs lights out" format={(v) => signed(Math.round(v / 100_000) * 100_000)} ticks={4} zones="diverging" />
      </article>
      <article className="gauge">
        <header>
          <h3>Bonus tank</h3>
          <span className="flag">{max ? pct(lap.bonus_usd / max, 0) : '—'}</span>
        </header>
        <Tank share={max ? lap.bonus_usd / max : 0} top={usdShort(lap.bonus_usd)} sub={`of ${usdShort(max)} a 1–2 would pay`} />
      </article>
      <article className="gauge">
        <header>
          <h3>Cost cap breach risk</h3>
          {crash ? <span className="flag flag--hold">After crash</span> : <span className="flag">No crash</span>}
        </header>
        {crash ? (
          <Dial value={crash.p_breach_after!} lo={0} hi={0.15} label="Breach risk" format={(v) => pct(v, 0)} ticks={3} zones="risk" />
        ) : (
          <div className="gauge-empty">
            <IconShield size={22} />
            <p className="small muted">{anyCrash ? `Damage estimate ${usdShort(anyCrash.damage_estimate ?? 0)} booked. The season forecast models 2026 only.` : 'No damage this race. A crash re-runs the season forecast within the lap.'}</p>
          </div>
        )}
      </article>
      <article className="gauge gauge--warn">
        <IconWaiting size={16} />
        <p>
          {now?.position ? (
            <>
              <b>{r.team_cars[car]} P{now.position}:</b> one place {now.up_one > 0 ? <>up pays <span className="tone-ok mono">{signed(now.up_one)}</span></> : 'up pays nothing more'}; one place{' '}
              {now.down_one < 0 ? <>down costs <span className="tone-alert mono">{signed(now.down_one)}</span></> : 'down costs nothing'}.
            </>
          ) : (
            <>
              <b>Car {car}</b> {dsq ? 'was disqualified. Its bonuses were never invoiced.' : 'is not running. Its bonuses are off the board.'}
            </>
          )}
        </p>
      </article>
    </section>
  );
}

// ------------------------------------------------------------------------------------------ sponsor contract

export function SponsorPanel({ r, lap, car, sponsor, setSponsor, flagged, booked }: { r: Replay; lap: Lap; car: string; sponsor: string | null; setSponsor: (s: string) => void; flagged: boolean; booked: boolean }) {
  const dsq = booked && r.classification?.[car]?.position_text === 'D';
  const road = lap.cars[car]?.position ?? null;
  const pos = dsq ? null : road;
  const total = (id: string) => lap.bonuses.filter((b) => b.sponsor === id).reduce((s, b) => s + b.usd, 0);
  const list = r.sponsors ?? [];
  const sel = list.find((s) => s.id === sponsor) ?? list[0];
  const finalFor = (sp: string, clause: string) => r.final.bonuses.some((b) => b.sponsor === sp && b.clause === clause && String(b.car) === car);
  return (
    <section className="sponsors" aria-labelledby="sp-h">
      <div className="sponsors-head">
        <h2 id="sp-h">Sponsor contracts</h2>
        <p className="small muted">
          Total {list.length} sponsors · paying now <b className="mono">{usdShort(lap.bonus_usd)}</b>
        </p>
      </div>
      <ul className="sponsor-list">
        {list.map((s) => {
          const on = s.id === sel?.id;
          const earn = total(s.id);
          return (
            <li key={s.id} className={`sponsor${on ? ' sponsor--on' : ''}`}>
              <button type="button" className="sponsor-row" onClick={() => setSponsor(s.id)} aria-expanded={on}>
                <span className="sponsor-mark" aria-hidden>
                  {s.name.slice(0, 1)}
                </span>
                <span className="sponsor-name">
                  <b>{s.name}</b>
                  <span className="small muted">
                    {ZONES[s.id]?.part ?? 'livery'} · {s.currency} · {s.clauses.length ? s.clauses.map((c) => CLAUSE_WORDS[c.type] ?? c.type).join(', ') : 'base fee only'}
                  </span>
                </span>
                <span className={`sponsor-earn mono${earn ? ' tone-ok' : ' muted'}`}>{earn ? usdShort(earn) : '$0'}</span>
              </button>
              {on && (
                <div className="sponsor-body">
                  <dl className="sponsor-kv">
                    <div>
                      <dt>Base fee, season</dt>
                      <dd className="mono">{usdShort(s.base_fee_usd)}</dd>
                    </div>
                    <div>
                      <dt>For car {car} at</dt>
                      <dd className={`mono${dsq ? ' tone-alert' : ''}`}>{dsq ? `DSQ (P${road} on the road)` : pos ? `P${pos}` : 'not running'}</dd>
                    </div>
                  </dl>
                  {s.clauses.length === 0 ? (
                    <p className="small muted">No performance bonus: a fixed fee, nothing on the result.</p>
                  ) : (
                    <ul className="clauses">
                      {s.clauses.map((c) => {
                        const hit = clauseHits(c, pos);
                        const kept = finalFor(s.id, c.id);
                        return (
                          <li key={c.id} className={`clause${hit ? ' clause--hit' : ''}`}>
                            <span className="clause-id mono">{c.id}</span>
                            <span className="clause-text">
                              <b>{CLAUSE_WORDS[c.type] ?? c.type}</b> <span className="mono">{usdShort(c.usd)}</span>
                              <span className="small muted">“{c.quote}”</span>
                            </span>
                            <span className={`clause-state small ${hit ? 'tone-ok' : dsq && clauseHits(c, road) ? 'tone-alert' : 'muted'}`}>{hit ? 'paying' : dsq && clauseHits(c, road) ? 'voided: DSQ' : 'not in reach'}</span>
                            {booked && <span className={`clause-final small ${kept ? 'tone-ok' : 'muted'}`}>{kept ? 'booked' : 'not due'}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className={`callout ${booked ? 'callout--ok' : flagged ? 'callout--hold' : 'callout--steel'}`}>
                    {booked ? <IconShield size={15} /> : <IconFlag size={15} />}
                    <span>
                      {booked
                        ? 'Booked from the FIA Final Classification. Anything over $250k waits for the Controller.'
                        : flagged
                          ? 'Chequered flag. Billing is held until the FIA Final Classification; results can still change.'
                          : 'Priced every lap. Nothing is invoiced on the road result.'}
                    </span>
                  </div>
                  <a className="link small" href="#/revenue">
                    Sponsor billing on the revenue desk <IconArrow size={12} />
                  </a>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------------------------------ running order

export function RunningOrder({ r, lap, frame, official }: { r: Replay; lap: Lap; frame: Frame | null; official: boolean }) {
  const rows = useMemo(() => {
    const running = Object.entries(lap.order)
      .map(([car, pos]) => ({ car, pos: pos as number | null }))
      .sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99));
    const out = Object.keys(r.field ?? {})
      .filter((c) => !(c in lap.order))
      .map((car) => ({ car, pos: null as number | null }));
    const dsq = official ? running.filter((x) => r.classification?.[x.car]?.position_text === 'D') : [];
    const kept = running.filter((x) => !dsq.includes(x));
    return [...kept, ...(lap.lap === 0 ? [] : out), ...dsq];
  }, [lap, r.field, r.classification, official]);
  return (
    <section className="order" aria-labelledby="order-h">
      <div className="order-head">
        <h2 id="order-h">Running order</h2>
        <span className="small muted">
          {frame?.kind === 'after' ? 'Final laps, road order' : lap.lap === 0 ? 'Grid' : `Lap ${lap.lap}`} · {utc(lap.clock)} UTC · Meridian in lime
        </span>
      </div>
      <ol className="order-strip">
        {rows.map(({ car, pos }) => {
          const ours = car in r.team_cars;
          const f = r.field?.[car];
          const st: CarState = ours ? carState(r, car, lap, official) : pos == null ? 'out' : 'running';
          return (
            <li key={car} className={`order-card${ours ? ' order-card--ours' : ''}${pos == null ? ' order-card--out' : ''}`}>
              <span className="order-top">
                <b className="mono">{st === 'dsq' ? 'DSQ' : pos ? `P${pos}` : 'OUT'}</b>
                <span className="mono muted">#{car}</span>
              </span>
              <span className="order-car">
                <F1Car mini number={car} state={st} tone={ours ? 'team' : 'field'} />
              </span>
              <span className="order-who">
                <b>{f?.code ?? car}</b>
                <span className="small muted">{ours ? 'Meridian' : f?.constructor_name ?? ''}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
