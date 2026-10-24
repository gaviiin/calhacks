import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// The revenue desk (finance/api.py on :8000, proxied at /api). Runs live in the API process; the
// dashboard follows the newest run of the test season and polls it.

export interface RunInfo {
  run_id: string;
  season: number;
  events_done: number;
  events_total: number;
  clock: string;
}

export interface Parked {
  je_id: string;
  kind: string;
  memo: string;
  total_cents: number;
  needs: string[];
  reason: string;
  recorded_at: string;
}

export interface Alert {
  key: string;
  text: string;
  to: string;
  fia_url?: string;
  backend?: string;
  at: string;
}

export interface Queue {
  parked: Parked[];
  questions: { q_id: string; text?: string; question?: string; asked_at?: string; [k: string]: unknown }[];
  held_billing: { request_id: string; [k: string]: unknown }[];
  alerts: Alert[];
}

export interface Scorecard {
  books_tie: boolean;
  bonuses: { truth: number; correct: number; missing: unknown[]; wrong_postings: unknown[] };
  dollars_protected_cents: number;
  expected_bonuses_avoided: number;
  entries: Record<string, number>;
  router: { events: number; code: number; agent: number };
  rules_approved: string[];
  model: { model_calls: number; cost_cents: number };
}

export interface Sponsor {
  sponsor_id: string;
  name: string;
  currency: string;
  bonuses_earned: number;
  bonuses_reversed: number;
  billing: Record<string, number>;
}

export interface Round {
  round: number;
  name: string;
  slug: string;
  date: string;
  final: boolean;
  revenue: { base: number; bonus: number; prize: number };
  cumulative: { base: number; bonus: number; prize: number };
}

export interface Why {
  je_id: string;
  text: string;
  lines: string[];
  evidence: string[];
  checks: { check_id: string; result: string; reason: string | null }[];
}

export interface Weekend {
  round: number;
  name: string;
  fia_documents: { at: string; kind: string; title: string; url: string; cars: number[] }[];
  actions?: { at: string; kind?: string; text?: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

export interface AuditReport {
  opinion: string;
  summary: { findings: number; high: number; medium: number; low: number; entries: number; posted: number };
  independence: Record<string, string | boolean>;
}

export interface Impact {
  headline: {
    entries_posted: number;
    straight_through_rate: number;
    human_decisions: number;
    dollars_protected: string;
    bonus_minutes_after_final_median: number;
    manual_close_days_after_race_median: number;
    books_tie: boolean;
  };
  effort?: { analyst_hours_replaced: number };
}

export interface RevenueState {
  online: boolean;
  run: RunInfo | null;
  queue: Queue | null;
  scorecard: Scorecard | null;
  sponsors: Sponsor[];
  timeline: Round[];
  impact: Impact | null;
  audit: AuditReport | null;
  busy: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  startRun: () => Promise<void>;
  advance: (round: number) => Promise<void>;
  approve: (je: string, approver: string, role: string, decision: 'approve' | 'reject', reason?: string) => Promise<string>;
  why: (je: string) => Promise<Why | null>;
  weekend: (round: number) => Promise<Weekend | null>;
  runAudit: () => Promise<void>;
}

const Ctx = createContext<RevenueState | null>(null);

async function get<T>(path: string): Promise<T | null> {
  const r = await fetch(path, { cache: 'no-store' });
  return r.ok ? ((await r.json()) as T) : null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { detail?: string }).detail ?? `HTTP ${r.status}`);
  return data as T;
}

export const DEMO_SEASON = 2024;
export const DEMO_STOP_BEFORE = 14; // the Belgian Grand Prix: Russell's disqualification

export function RevenueProvider({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(false);
  const [run, setRun] = useState<RunInfo | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [timeline, setTimeline] = useState<Round[]>([]);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef<RunInfo | null>(null);

  const refresh = useCallback(async () => {
    try {
      const runs = await get<RunInfo[]>('/api/runs');
      setOnline(runs !== null);
      const latest = (runs ?? []).filter((r) => r.season === DEMO_SEASON).at(-1) ?? null;
      runRef.current = latest;
      setRun(latest);
      if (!latest) return;
      const base = `/api/runs/${latest.run_id}`;
      const [q, s, sp, tl, im, au] = await Promise.all([
        get<Queue>(`${base}/queue`),
        get<Scorecard>(`${base}/scorecard`),
        get<Sponsor[]>(`${base}/sponsors`),
        get<Round[]>(`${base}/timeline`),
        get<Impact>(`${base}/impact`),
        get<AuditReport>(`${base}/audit`),
      ]);
      setQueue(q);
      setScorecard(s);
      setSponsors(sp ?? []);
      setTimeline(tl ?? []);
      setImpact(im);
      setAudit(au);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 8000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const act = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
      setBusy(label);
      setError(null);
      try {
        const out = await fn();
        await refresh();
        return out;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  const value = useMemo<RevenueState>(
    () => ({
      online, run, queue, scorecard, sponsors, timeline, impact, audit, busy, error, refresh,
      startRun: () =>
        act('Replaying the 2024 season to the Belgian Grand Prix', async () => {
          await post('/api/runs', { season: DEMO_SEASON, stop_before_round: DEMO_STOP_BEFORE, auto_people: false });
        }),
      advance: (round: number) =>
        act(`Running round ${round}`, async () => {
          if (runRef.current) await post(`/api/runs/${runRef.current.run_id}/advance`, { round });
        }),
      approve: (je, approver, role, decision, reason = '') =>
        act(decision === 'approve' ? 'Approving' : 'Rejecting', async () => {
          if (!runRef.current) return 'no run';
          const res = await post<{ status?: string; reason?: string }>(`/api/runs/${runRef.current.run_id}/approve`, {
            je_id: je, approver, role, decision, reason,
          });
          return [res.status, res.reason].filter(Boolean).join(': ');
        }),
      why: (je) => (runRef.current ? get<Why>(`/api/runs/${runRef.current.run_id}/entries/${je}/why`) : Promise.resolve(null)),
      weekend: (round) => (runRef.current ? get<Weekend>(`/api/runs/${runRef.current.run_id}/weekend/${round}`) : Promise.resolve(null)),
      runAudit: () =>
        act('Running the independent audit', async () => {
          if (runRef.current) await post(`/api/runs/${runRef.current.run_id}/audit`, {});
        }),
    }),
    [online, run, queue, scorecard, sponsors, timeline, impact, audit, busy, error, refresh, act]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRevenue(): RevenueState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRevenue outside RevenueProvider');
  return v;
}
