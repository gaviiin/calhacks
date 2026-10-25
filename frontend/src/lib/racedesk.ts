import { useEffect, useMemo, useRef, useState } from 'react';

// The Race Desk (racedesk/api.py, mounted by finance/api.py at /api/racedesk). A real race replayed lap by
// lap: what the running order is worth to Meridian under its sponsor contracts and in expected
// championship prize money, every money call on the team radio, crashes booked against the cost cap,
// and the speed scoreboard (when it happened, when Pit Wall acted, what a month-end close would do).
// Money is USD cents; clocks are UTC ISO strings.

export interface RaceInfo {
  round: number;
  name: string;
  date: string;
  laps: number;
}

export interface LapBonus {
  sponsor: string;
  clause: string;
  type: string;
  car: number;
  usd: number;
}

export interface CarNow {
  code: string;
  position: number | null;
  up_one: number;
  down_one: number;
}

export interface Lap {
  lap: number;
  clock: string;
  order: Record<string, number>;
  bonus_usd: number;
  prize_ev: number;
  total: number;
  delta: number;
  constructors_position: Record<string, number>;
  cars: Record<string, CarNow>;
  bonuses: LapBonus[];
}

export interface RadioCall {
  lap: number;
  clock: string;
  kind: 'lights_out' | 'money' | 'retirement' | 'safety_car' | 'flag' | 'final_classification' | string;
  text: string;
  delta?: number;
  car?: number;
  status?: string;
}

export interface Crash {
  lap: number;
  clock: string;
  car: number;
  driver: string;
  status: string;
  lap_ms: number | null;
  damage_estimate: number | null;
  p_breach_before: number | null;
  p_breach_after: number | null;
  p_breach_after_with_final_package: number | null;
}

export interface SpeedEvent {
  event: string;
  happened_at: string | null;
  acted_at: string | null;
  seconds_to_act: number | null;
  action: string;
  manual_baseline: string;
  usd_at_stake: number | null;
  usd_protected: number | null;
}

export interface Clause {
  id: string;
  type: 'win' | 'podium' | 'points_finish' | 'top6' | string;
  amount: number;
  usd: number;
  quote: string;
  excludes_win: boolean;
}

export interface Sponsor {
  id: string;
  name: string;
  currency: string;
  base_fee: number;
  base_fee_usd: number;
  clauses: Clause[];
}

const GP_POINTS = 10;

/** racedesk/money.py's rule for whether a clause pays at a finishing position */
export function clauseHits(c: Clause, pos: number | null | undefined): boolean {
  if (!pos) return false;
  if (c.type === 'win') return pos === 1;
  if (c.type === 'podium') return c.excludes_win ? pos === 2 || pos === 3 : pos <= 3;
  if (c.type === 'points_finish') return pos <= GP_POINTS;
  if (c.type === 'top6') return pos <= 6;
  return false;
}

/** the most Meridian's sponsors can pay for one race: its two cars first and second */
export function maxBonus(sponsors: Sponsor[]): number {
  let s = 0;
  for (const sp of sponsors) for (const c of sp.clauses) s += (clauseHits(c, 1) ? c.usd : 0) + (clauseHits(c, 2) ? c.usd : 0);
  return s;
}

export const CLAUSE_WORDS: Record<string, string> = { win: 'Win', podium: 'Podium', points_finish: 'Points finish', top6: 'Top six' };

export interface Valuation {
  total: number;
  bonus_usd: number;
  prize_ev: number;
}

export interface FinalBonus {
  sponsor: string;
  clause: string;
  car: number;
  position: number;
  amount_orig: number;
  currency: string;
  usd: number;
}

export interface Replay {
  season: number;
  round: number;
  race: string;
  date: string;
  start_utc: string;
  race_laps: number;
  team: string;
  team_cars: Record<string, string>;
  /** official result for our cars: position_text is a number, R (retired), D (disqualified), ... */
  classification: Record<string, { position_text: string; status: string; grid: number | null }>;
  remaining_rounds: number;
  /** every car in the race */
  field: Record<string, { code: string; driver: string; constructor: string; constructor_name: string }>;
  /** Meridian's sponsors and the bonus clauses in force at this round */
  sponsors: Sponsor[];
  totals: { start: number; road: number; final: number; money_protected: number; fastest_reaction_seconds: number | null };
  start: Valuation;
  road: Valuation;
  final: Valuation & { bonuses: FinalBonus[] };
  most_expensive_lap: { lap: number; delta: number } | null;
  best_lap: { lap: number; delta: number } | null;
  radio: RadioCall[];
  crashes: Crash[];
  speed: SpeedEvent[];
  laps: Lap[];
  method: Record<string, string>;
}

/** The races the demo is built around, one click each. */
export const FEATURED: { season: number; round: number; label: string; story: string }[] = [
  { season: 2024, round: 14, label: 'Spa 2024', story: 'Russell wins, then is disqualified: $1.76m kept off invoices' },
  { season: 2026, round: 10, label: 'Spa 2026', story: 'Lap 1 crash booked to the cost cap in one lap' },
  { season: 2023, round: 15, label: 'Singapore 2023', story: 'Last-lap crash, priced to the dollar' },
];

export const SEASONS = [2026, 2024, 2023];

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal, cache: 'no-store' });
  if (!r.ok) {
    let detail = `${r.status}`;
    try {
      detail = (await r.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(detail);
  }
  return (await r.json()) as T;
}

export function useRaces(season: number) {
  const [races, setRaces] = useState<RaceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    setError(null);
    get<RaceInfo[]>(`/api/racedesk/races?season=${season}`, ac.signal)
      .then(setRaces)
      .catch((e) => !ac.signal.aborted && setError(String(e.message ?? e)));
    return () => ac.abort();
  }, [season]);
  return { races, error };
}

export function useReplay(season: number, round: number) {
  const [data, setData] = useState<Replay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    get<Replay>(`/api/racedesk/replay/${season}/${round}`, ac.signal)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError(String(e.message ?? e));
        setLoading(false);
      });
    return () => ac.abort();
  }, [season, round]);
  return { data, loading, error };
}

// ------------------------------------------------------------------------------------------ playback

/** One step of the replay: a lap of the race, or a moment after the flag (an FIA document). */
export interface Frame {
  i: number;
  clock: string;
  /** index into laps; after the flag it stays on the last lap */
  lapIndex: number;
  kind: 'lap' | 'after';
  label: string;
}

export function framesOf(r: Replay): Frame[] {
  const out: Frame[] = r.laps.map((l, i) => ({ i, clock: l.clock, lapIndex: i, kind: 'lap', label: l.lap === 0 ? 'Lights out' : `Lap ${l.lap}` }));
  const last = r.laps[r.laps.length - 1];
  const after = r.speed
    .filter((s) => s.happened_at && s.happened_at > (last?.clock ?? ''))
    .sort((a, b) => (a.happened_at! < b.happened_at! ? -1 : 1));
  for (const s of after) {
    out.push({ i: out.length, clock: s.acted_at ?? s.happened_at!, lapIndex: r.laps.length - 1, kind: 'after', label: s.event.replace(/^FIA /, 'FIA ') });
  }
  return out;
}

export const SPEEDS = [1, 4, 12] as const;
export type Speed = (typeof SPEEDS)[number];

/** Steps through frames: a lap every 1.1s at 1×, a post-race moment every 2.2s. */
export function usePlayback(frames: Frame[]) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(4);
  const timer = useRef<number | null>(null);
  const n = frames.length;

  useEffect(() => {
    setI(0);
    setPlaying(false);
  }, [frames]);

  useEffect(() => {
    if (!playing) return;
    if (i >= n - 1) {
      setPlaying(false);
      return;
    }
    const next = frames[i + 1];
    const ms = (next?.kind === 'after' ? 2200 : 1100) / speed;
    timer.current = window.setTimeout(() => setI((v) => Math.min(n - 1, v + 1)), Math.max(60, ms));
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [playing, i, n, speed, frames]);

  return {
    i,
    frame: frames[Math.min(i, n - 1)] ?? null,
    playing,
    speed,
    setSpeed,
    play: () => {
      if (i >= n - 1) setI(0);
      setPlaying(true);
    },
    pause: () => setPlaying(false),
    seek: (v: number) => {
      setPlaying(false);
      setI(Math.max(0, Math.min(n - 1, v)));
    },
    end: () => {
      setPlaying(false);
      setI(n - 1);
    },
    done: i >= n - 1,
  };
}

// ------------------------------------------------------------------------------------------ helpers

export function utc(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(11, 19);
}

/** "15s", "2m 01s", "10 days" */
export function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return `${m}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  }
  if (seconds < 86400 * 2) return `${(seconds / 3600).toFixed(1)}h`;
  return `${Math.round(seconds / 86400)} days`;
}

/** The manual baseline's "about N days later" as seconds, when it says so. */
export function manualSeconds(baseline: string): number | null {
  const m = baseline.match(/about (\d+) days/);
  return m ? Number(m[1]) * 86400 : null;
}

export function sponsorName(id: string): string {
  return id ? id[0].toUpperCase() + id.slice(1) : id;
}

export function useDerived(r: Replay | null, frame: Frame | null) {
  return useMemo(() => {
    if (!r || !frame) return null;
    const lap = r.laps[frame.lapIndex];
    const radio = r.radio.filter((c) => c.clock <= frame.clock);
    const crashes = r.crashes.filter((c) => c.clock <= frame.clock);
    const speed = r.speed.filter((s) => s.acted_at && s.acted_at <= frame.clock);
    const flagged = frame.lapIndex >= r.laps.length - 1;
    const finalIn = r.speed.some((s) => s.event === 'FIA Final Classification' && s.acted_at && s.acted_at <= frame.clock);
    return { lap, radio, crashes, speed, flagged, finalIn };
  }, [r, frame]);
}
