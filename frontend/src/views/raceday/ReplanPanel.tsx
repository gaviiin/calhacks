import { useMemo } from 'react';
import { LineChart, type Marker } from '../../charts/LineChart';
import { IconApproved, IconDenied, IconWaiting } from '../../components/icons';
import { usdShort } from '../../lib/format';
import { useRace, type RaceData } from '../../lib/race';
import { clock, parse, type Headline } from './shared';
import './replan.css';

// Stage 6, re-plan: the season and the cap re-run after every change in the evidence (race/season_sim.py,
// race/cap_forecast.py). One chart of the chance of holding our place across the weekend, then the money it moves.

type Sim = RaceData['sims'][number];

interface Cap {
  cap_cents?: number;
  cap_basis?: string;
  weekend_cents?: number;
  weekend_source?: string;
  year_end?: { p10_cents: number; p50_cents: number; p90_cents: number };
  p_overspend?: number;
  p_material?: number;
  relevant_before_basis?: string;
  rules?: string;
  context?: string;
  year?: number;
}

interface Payload {
  headline_value?: string;
  headline?: string;
  tone?: Headline['tone'];
  trigger?: string;
  phase?: string;
  session?: string;
  team?: string;
  target_position?: number;
  p_target?: number;
  p_target_baseline?: number;
  dist?: number[];
  expected_points?: number;
  points_start?: number;
  rivals?: { team: string; points_start: number; expected_points: number; dist: number[] }[];
  prize?: { expected_cents: number; p10_cents: number; p50_cents: number; p90_cents: number; delta_cents: number; basis: string };
  attribution?: { ours_cents: number; rivals_cents: number; note: string };
  atr?: { expected_pct: number; delta_pct: number; most_likely_position: number; most_likely_pct: number; wind_tunnel_runs: number; period: string; source: string };
  sponsor?: { expected_cents: number; delta_cents: number; basis: string; source: string };
  cap?: Cap;
  facets?: Facet[];
}

interface Facet {
  facet: string;
  owner: string;
  basis?: string;
  outcomes: { label: string; p: number }[];
}

const TONE = {
  alert: { label: 'Big change', cls: 'flag--alert', Icon: IconDenied },
  hold: { label: 'Some change', cls: 'flag--hold', Icon: IconWaiting },
  ok: { label: 'Steady', cls: 'flag--ok', Icon: IconApproved },
} as const;

const later = (a: Sim, b: Sim) => a.at > b.at || (a.at === b.at && a.simKey > b.simKey);
/** Season runs only: the close's true-up writes a race_sims row dated after the season, which is not a re-run. */
const isSeasonRun = (s: Sim) => !s.trigger.startsWith('trueup:');

export function latestSim(race: Pick<RaceData, 'sims'>) {
  return race.sims.reduce<Sim | null>((b, s) => (!isSeasonRun(s) ? b : !b || later(s, b) ? s : b), null);
}

export function replanHeadline(race: RaceData): Headline {
  const s = latestSim(race);
  if (!s) return { value: '—', note: 'season not simulated yet', tone: 'muted' };
  const p = parse<Payload>(s.payloadJson, {});
  return { value: String(p.headline_value ?? '—'), note: String(p.headline ?? ''), tone: p.tone ?? '' };
}

const pctTxt = (x: number | undefined, digits = 0) => (x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`);
const signed = (c: number) => (c > 0 ? `+${usdShort(c)}` : c < 0 ? usdShort(c) : '$0');
const change = (c: number) => (Math.abs(c) < 5e6 ? 'no change' : `${c < 0 ? 'down' : 'up'} ${usdShort(Math.abs(c))}`);

/** "#43 Q", "#43 R2": a new incident (its first version) on the timeline. */
function markerLabel(trigger: string, session: string): string | null {
  const m = /^incident:\d+-\d+-(\d+)-(\d+)@v1$/.exec(trigger);
  if (!m) return null;
  return `#${m[1]} ${(session || '?')[0]}${m[2] === '1' ? '' : m[2]}`;
}

function History({ sims, target }: { sims: Sim[]; target: number }) {
  const data = useMemo(() => {
    const rows = sims
      .map((s) => ({ s, p: parse<Payload>(s.payloadJson, {}), t: Date.parse(s.at) }))
      .filter((r) => Number.isFinite(r.t) && typeof r.p.p_target === 'number')
      .sort((a, b) => a.t - b.t || a.s.simKey.localeCompare(b.s.simKey));
    const xs = rows.map((r) => r.t);
    const base = rows.find((r) => r.s.trigger === 'baseline')?.p.p_target ?? rows[0]?.p.p_target ?? null;
    const markers: Marker[] = [];
    rows.forEach((r, i) => {
      const label = markerLabel(r.s.trigger, r.p.session ?? '');
      if (label && !markers.some((m) => m.label === label)) markers.push({ x: r.t, label, tone: 'alert' });
      // a later version of an incident that moved the odds (a DNS found at the start, an answer) gets its own marker
      const moved = i > 0 ? (r.p.p_target ?? 0) - (rows[i - 1]!.p.p_target ?? 0) : 0;
      const car = /^(?:incident|answer):\d+-\d+-(\d+)-/.exec(r.s.trigger)?.[1];
      if (!label && car && Math.abs(moved) >= 0.05) markers.push({ x: r.t, label: `#${car} ${moved < 0 ? '−' : '+'}${Math.round(Math.abs(moved) * 100)} pts`, tone: 'alert' });
      if (r.s.trigger.startsWith('result:')) markers.push({ x: r.t, label: `${r.p.session || 'session'} result`, tone: 'muted' });
    });
    return { rows, xs, base, markers };
  }, [sims]);
  if (data.rows.length < 2) return <p className="muted">The chart starts with the second run; the baseline is in.</p>;
  return (
    <LineChart
      xs={data.xs}
      series={[
        { key: 'p', label: `P(P${target})`, values: data.rows.map((r) => r.p.p_target ?? null), color: '--ink', area: 0.06 },
        { key: 'b', label: 'baseline', values: data.rows.map(() => data.base), color: '--s1', dashed: true },
      ]}
      xLabel={(x) => clock(new Date(x).toISOString()).slice(0, 5)}
      yLabel={(y) => `${Math.round(y * 100)}%`}
      yMin={0}
      yMax={1}
      height={200}
      markers={data.markers}
      tooltip={(i) => {
        const r = data.rows[i]!;
        return (
          <div className="tooltip-row">
            <span>
              <b className="mono">{pctTxt(r.p.p_target)}</b> <span className="muted">P(P{target}) · {r.p.phase} · {r.s.trigger.split('@')[0]}</span>
            </span>
          </div>
        );
      }}
      ariaLabel={`Chance of finishing the championship P${target} or better, across the weekend, one point per re-run of the season`}
    />
  );
}

function AttributionBars({ ours, rivals }: { ours: number; rivals: number }) {
  const max = Math.max(Math.abs(ours), Math.abs(rivals), 1);
  const bar = (label: string, v: number) => (
    <div className="replan-bar">
      <span className="replan-bar-label">{label}</span>
      <span className="replan-bar-track" aria-hidden>
        <span className={`replan-bar-fill ${v < 0 ? 'replan-bar-fill--loss' : ''}`} style={{ width: `${(Math.abs(v) / max) * 100}%` }} />
      </span>
      <span className="mono replan-bar-value">{signed(v)}</span>
    </div>
  );
  return (
    <div className="replan-bars">
      {bar('Our weekend', ours)}
      {bar("Rivals' weekend", rivals)}
    </div>
  );
}

export function ReplanPanel() {
  const race = useRace();
  const s = useMemo(() => latestSim(race), [race]);
  const history = useMemo(() => (s ? race.sims.filter((x) => x.meetingKey === s.meetingKey && isSeasonRun(x)) : []), [race.sims, s]);
  if (!s) return <p className="muted">The season runs as soon as the weekend starts.</p>;
  const p = parse<Payload>(s.payloadJson, {});
  const target = p.target_position ?? 8;
  const tone = p.tone && p.tone in TONE ? TONE[p.tone as keyof typeof TONE] : null;
  const cap = p.cap ?? {};
  return (
    <div className="replan">
      <div className="replan-head">
        <span className={`replan-value mono ${p.tone ? `tone-${p.tone}` : ''}`}>{p.headline_value ?? '—'}</span>
        {tone && (
          <span className={`flag ${tone.cls}`} role="status">
            <tone.Icon size={12} />
            {tone.label}
          </span>
        )}
        <span className="muted">
          {p.headline} · {p.phase} · {clock(s.at)} UTC · {s.runtimeMs} ms
        </span>
      </div>

      <History sims={history} target={target} />

      {p.attribution && (
        <div className="replan-why">
          <span className="muted">Why the expected prize moved {change(p.prize?.delta_cents ?? 0)} since the baseline</span>
          <AttributionBars ours={p.attribution.ours_cents} rivals={p.attribution.rivals_cents} />
        </div>
      )}

      <p className="muted small">What the weekend means for each part of the team: the chance of each outcome over 10,000 seasons. Probabilities, not advice: each owner decides what to do.</p>
      <div className="facets">
        {(p.facets ?? []).map((f) => (
          <section key={f.facet} className="facet" aria-label={f.facet}>
            <h4>
              {f.facet} <span className="muted">· {f.owner}</span>
            </h4>
            <ul>
              {f.outcomes.map((o) => (
                <li key={o.label}>
                  <span className="facet-label">{o.label}</span>
                  <span className="facet-bar" aria-hidden>
                    <span style={{ width: `${Math.max(o.p * 100, o.p > 0 ? 1 : 0)}%` }} />
                  </span>
                  <span className="mono facet-p">{pctTxt(o.p, o.p > 0 && o.p < 0.1 ? 1 : 0)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <ul className="replan-notes">
        {p.sponsor && (
          <li>
            <b>Assumed sponsor clause:</b> <span className="mono">{usdShort(p.sponsor.expected_cents)}</span> expected ({change(p.sponsor.delta_cents)}).{' '}
            <span className="muted">
              {p.sponsor.basis} (
              <a href={p.sponsor.source} target="_blank" rel="noreferrer">
                case
              </a>
              ).
            </span>
          </li>
        )}
        {cap.context && <li className="muted">{cap.context}</li>}
        <li className="muted">
          {p.prize?.basis}. {cap.cap_basis} {cap.relevant_before_basis}.
        </li>
      </ul>
    </div>
  );
}
