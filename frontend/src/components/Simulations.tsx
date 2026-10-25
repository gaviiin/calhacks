import { useState } from 'react';
import { IconPlay, IconShield } from './icons';
import { useCostCap } from '../lib/costcap';
import { clock, dayTime } from '../lib/format';
import { DEMO_STOP_BEFORE, useRevenue } from '../lib/revenue';
import { useSim, type SimJob } from '../lib/sim';

// Every simulation the desk can run, where each stands, and what it is working on right now.
// The revenue desk runs inside its API; the cost cap jobs run on this machine through the dev
// server (vite.config.ts), online with Claude when a key is set, offline otherwise.

const STEPS = ['sync', 'learner', 'review-policies', 'analyst', 'standing', 'gateway', 'redteam', 'score'];

function Progress({ value, tone = 'lime' }: { value: number; tone?: 'lime' | 'hold' }) {
  return (
    <span className="progress" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i className={`progress-fill progress-fill--${tone}`} style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </span>
  );
}

function JobLog({ job }: { job: SimJob }) {
  const [open, setOpen] = useState(false);
  const last = job.lines.at(-1) ?? '';
  return (
    <div className={`job job--${job.endedAt === null ? 'running' : job.code === 0 ? 'done' : 'failed'}`}>
      <button className="job-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="job-dot" aria-hidden />
        <span className="job-target mono">make {job.target}</span>
        <span className="job-status">
          {job.endedAt === null ? 'running' : job.code === 0 ? 'done' : `exit ${job.code}`} · {clock(new Date(job.startedAt))}
        </span>
        <span className="job-last mono">{last}</span>
      </button>
      {open && (
        <pre className="job-log">
          {job.lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

export function Simulations({ full = false }: { full?: boolean }) {
  const sim = useSim();
  const rev = useRevenue();
  const cc = useCostCap();
  const [err, setErr] = useState<string | null>(null);

  // what the cost cap agents did in their latest runs
  const runs = new Map<string, { role: string; steps: number; last: number; first: number; decisions: number; models: number }>();
  for (const s of [...cc.modelCalls, ...[...cc.decisionsByItem.values()].flat()]) {
    const r = runs.get(s.runId) ?? { role: s.actorRole, steps: 0, last: 0, first: Infinity, decisions: 0, models: 0 };
    r.steps++;
    const t = s.at.toDate().getTime();
    r.last = Math.max(r.last, t);
    r.first = Math.min(r.first, t);
    if (s.kind === 'decision') r.decisions++;
    else r.models++;
    runs.set(s.runId, r);
  }
  const recent = [...runs.entries()].sort((a, b) => b[1].last - a[1].last).slice(0, full ? 8 : 3);
  const busyCost = sim.running.filter((j) => sim.targets[j.target]?.desk === 'cost');
  const spaDone = rev.timeline.some((r) => r.round === DEMO_STOP_BEFORE && r.final);
  const launch = async (t: string) => setErr(await sim.start(t));

  return (
    <section className="sims" aria-labelledby="sims-h">
      <div className="sec-head">
        <h2 id="sims-h">Simulations</h2>
        <p className="muted">
          What is running, what ran, and what the agents are working through.{' '}
          {sim.available ? (sim.online ? 'Claude is on: the agents call the model.' : 'No ANTHROPIC_API_KEY in .env: the agents run their deterministic path.') : 'Runs start from the dev server on this machine.'}
        </p>
      </div>
      <div className="sims-grid">
        <div className="sim">
          <h3>Revenue desk · 2024 season</h3>
          {!rev.online ? (
            <p className="muted">The revenue API is not reachable (make revenue-api).</p>
          ) : rev.run ? (
            <>
              <p className="sim-line">
                <span className="mono muted">run {rev.run.run_id}</span>
                <span className="mono">race clock {dayTime(new Date(rev.run.clock))}</span>
              </p>
              <Progress value={rev.run.events_done / Math.max(1, rev.run.events_total)} />
              <p className="sim-figures">
                <b className="mono">{rev.run.events_done}</b> of <b className="mono">{rev.run.events_total}</b> events · <b className="mono">{rev.timeline.filter((r) => r.final).length}</b> of{' '}
                {rev.timeline.length} rounds final
                {rev.scorecard && (
                  <>
                    {' '}· <b className="mono">{rev.scorecard.bonuses.correct}/{rev.scorecard.bonuses.truth}</b> bonuses right
                  </>
                )}
              </p>
              <div className="sim-actions">
                {!spaDone && (
                  <button className="btn btn--primary" onClick={() => void rev.advance(DEMO_STOP_BEFORE)} disabled={rev.busy !== null}>
                    <IconPlay size={13} /> {rev.busy ?? 'Run the Belgian GP weekend'}
                  </button>
                )}
                {spaDone && rev.run.events_done < rev.run.events_total && (
                  <button className="btn btn--primary" onClick={() => void rev.advance(99)} disabled={rev.busy !== null}>
                    <IconPlay size={13} /> {rev.busy ?? 'Run the rest of the season'}
                  </button>
                )}
                <button className="btn" onClick={() => void rev.runAudit()} disabled={rev.busy !== null}>
                  <IconShield size={13} /> Independent audit
                </button>
                <button className="btn" onClick={() => void rev.startRun()} disabled={rev.busy !== null}>
                  Replay from the start
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">No season running. Replay 2024 from the real results, stopping before the Belgian Grand Prix.</p>
              <div className="sim-actions">
                <button className="btn btn--primary" onClick={() => void rev.startRun()} disabled={rev.busy !== null}>
                  <IconPlay size={13} /> {rev.busy ?? 'Replay 2024 to Spa'}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="sim">
          <h3>Cost cap desk · January 2026</h3>
          <ol className="pipeline" aria-label="The cost cap run, step by step">
            {STEPS.map((s) => {
              const job = sim.jobs.find((j) => j.target === s);
              const run = sim.jobs.find((j) => j.target === 'cost-cap-run');
              const state = job ? (job.endedAt === null ? 'running' : job.code === 0 ? 'done' : 'failed') : run && run.endedAt === null ? 'queued' : 'idle';
              return (
                <li key={s} className={`pipe pipe--${state}`}>
                  <button className="pipe-btn" onClick={() => void launch(s)} disabled={!sim.available || busyCost.length > 0} title={sim.targets[s]?.note}>
                    <span className="pipe-dot" aria-hidden />
                    {sim.targets[s]?.label ?? s}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="sim-actions">
            <button className="btn btn--primary" onClick={() => void launch('cost-cap-run')} disabled={!sim.available || busyCost.length > 0}>
              <IconPlay size={13} /> {busyCost.length ? 'Running…' : 'Run January end to end'}
            </button>
            <button className="btn" onClick={() => void launch('advance')} disabled={!sim.available || busyCost.length > 0}>
              Advance the clock a month
            </button>
            <button className="btn" onClick={() => void launch('redteam')} disabled={!sim.available || busyCost.length > 0}>
              <IconShield size={13} /> Red team
            </button>
          </div>
          {err && <p className="tone-alert">{err}</p>}
          {!sim.available && <p className="muted">Start the dashboard with <code>make dashboard</code> to run these from here.</p>}
        </div>
      </div>

      {recent.length > 0 && (
        <div className="agent-runs">
          <h3>What the agents worked through</h3>
          <ul>
            {recent.map(([id, r]) => (
              <li key={id}>
                <span className="mono muted">{id}</span>
                <span>
                  <b>{r.role === 'ai_cap_analyst' ? 'Cap Analyst' : r.role === 'ai_policy_learner' ? 'Policy Learner' : r.role}</b> · {r.decisions.toLocaleString()} decisions, {r.models.toLocaleString()} model calls ·{' '}
                  {Number.isFinite(r.first) ? `${clock(new Date(r.first))} → ${clock(new Date(r.last))}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sim.jobs.length > 0 && (
        <div className="jobs">
          {[...sim.jobs].sort((a, b) => b.startedAt - a.startedAt).slice(0, full ? 12 : 3).map((j) => (
            <JobLog key={j.target + j.startedAt} job={j} />
          ))}
        </div>
      )}
    </section>
  );
}
