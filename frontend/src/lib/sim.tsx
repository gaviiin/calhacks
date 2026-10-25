import { useCallback, useEffect, useState } from 'react';

// Simulations the dev server can run on this machine (vite.config.ts spawns Makefile targets).

export interface SimTarget {
  label: string;
  desk: 'cost' | 'revenue' | 'evidence';
  note: string;
}

export interface SimJob {
  target: string;
  startedAt: number;
  endedAt: number | null;
  code: number | null;
  lines: string[];
}

export interface SimState {
  available: boolean;
  online: boolean;
  targets: Record<string, SimTarget>;
  jobs: SimJob[];
  running: SimJob[];
  start: (target: string) => Promise<string | null>;
  refresh: () => Promise<void>;
}

export function useSim(): SimState {
  const [available, setAvailable] = useState(false);
  const [online, setOnline] = useState(false);
  const [targets, setTargets] = useState<Record<string, SimTarget>>({});
  const [jobs, setJobs] = useState<SimJob[]>([]);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/local/sim', { cache: 'no-store' });
      if (!r.ok) return setAvailable(false);
      const d = (await r.json()) as { targets: Record<string, SimTarget>; online: boolean; jobs: SimJob[] };
      setAvailable(true);
      setOnline(d.online);
      setTargets(d.targets);
      setJobs(d.jobs);
    } catch {
      setAvailable(false);
    }
  }, []);
  const running = jobs.filter((j) => j.endedAt === null);
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), running.length ? 2000 : 10000);
    return () => window.clearInterval(t);
  }, [refresh, running.length]);
  const start = useCallback(
    async (target: string) => {
      const r = await fetch(`/local/sim/${target}`, { method: 'POST' });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      await refresh();
      return r.ok ? null : d.error ?? `HTTP ${r.status}`;
    },
    [refresh]
  );
  return { available, online, targets, jobs, running, start, refresh };
}
