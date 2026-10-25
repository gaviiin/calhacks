import { useCallback, useEffect, useState } from 'react';
import { IconPlay, IconRestart } from '../../components/icons';
import { useRace } from '../../lib/race';

// Start the São Paulo replay from the page: the dev server runs `make race-demo` (or `make race-reset` first for a
// clean slate) on this machine, and the views move as the rows land. Only the dev server offers it.

interface Job {
  target: string;
  endedAt: number | null;
  code: number | null;
  lines: string[];
  ready?: boolean;
}

export function ReplayControl() {
  const race = useRace();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const r = await fetch('/local/sim');
      if (!r.ok) return setAvailable(false);
      const j = (await r.json()) as { jobs: Job[] };
      setJobs(j.jobs.filter((x) => x.target.startsWith('race-')));
    } catch {
      setAvailable(false);
    }
  }, []);
  // A built snapshot keeps listening for decisions (it posts what the dashboard approves): ready, not busy.
  const listening = jobs.find((j) => j.endedAt === null && j.target === 'race-snapshot' && (j.ready || j.lines.some((l) => l.includes('lap 32 ready'))));
  const running = jobs.find((j) => j.endedAt === null && j !== listening);
  useEffect(() => {
    void poll();
    const t = setInterval(poll, running ? 1500 : 6000);
    return () => clearInterval(t);
  }, [poll, running]);

  const start = async (target: 'race-demo' | 'race-reset' | 'race-snapshot') => {
    setError(null);
    if (target !== 'race-demo' && !window.confirm('Wipe pit-wall and reload the evidence and the 2024 history? The current replay is cleared.')) return;
    const r = await fetch(`/local/sim/${target}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ browserId: race.identityHex }) });
    if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
    void poll();
  };

  if (!available) return null;
  const last = jobs.filter((j) => j.endedAt !== null).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  return (
    <div className="replay-ctl">
      {running ? (
        <span className="replay-live" role="status">
          <span className="replay-dot" aria-hidden />
          {running.target === 'race-reset' ? 'Resetting…' : running.target === 'race-snapshot' ? 'Building lap 32…' : 'Replaying live'}
        </span>
      ) : (
        <>
          {listening ? (
            <span className="replay-live" role="status" title="The desk is running at lap 32: what you approve here is posted to the ERP">
              <span className="replay-dot" aria-hidden />
              Lap 32 · listening
            </span>
          ) : null}
          <button type="button" className="btn btn--small btn--primary" onClick={() => start('race-demo')}>
            <IconPlay size={13} /> Replay São Paulo
          </button>
          <button type="button" className="btn btn--small" onClick={() => start('race-snapshot')} title="A clean pit-wall, then the weekend up to a few minutes after Colapinto's lap-32 crash">
            Lap 32
          </button>
          <button type="button" className="btn btn--small" onClick={() => start('race-reset')} title="Wipe pit-wall and start clean">
            <IconRestart size={13} /> Reset
          </button>
        </>
      )}
      {!running && last && last.code !== 0 && <span className="replay-err" title={last.lines.slice(-6).join('\n')}>last run failed</span>}
      {error && <span className="replay-err">{error}</span>}
    </div>
  );
}
