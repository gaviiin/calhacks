import report from '../../../../race/data/onboarding_report.json';
import { usdShort } from '../../lib/format';
import { Pill } from '../roles/kit';
import './learned.css';

// What the desk knows before its first race (race/onboarding_report.py, from race/backtest.py): how accurate it was on
// the 2024 races it had not seen, the rules it learned and how sure each is, and every number that is still assumed with
// the team system that would replace it. Regenerate with `make race-backtest race-onboarding-report`.

interface Policy {
  id: string;
  title: string;
  cases: number;
  agree: number;
  outcome: string;
  lower_bound: number;
  licensed: boolean;
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.round(Math.abs(x) * 100)}%`;

export function LearnedView() {
  const r = report as unknown as typeof report & { policies: Policy[] };
  const a = r.accuracy;
  const lf = r.learned_from;
  const ops = r.operations;
  return (
    <div className="ln">
      <header className="ln-head">
        <h1>What it knows before its first race</h1>
        <p>
          Learned from Williams' 2024 races before São Paulo ({lf.race_sessions} race sessions, {lf.events} events, {ops.crashes} crashes the press recorded part by part), then
          tested on them in order: each event is decided only from the races before it.
        </p>
      </header>

      {a ? (
        <section className="ln-scores" aria-label="How accurate it was">
          <article className="glass ln-score">
            <h2>What happened</h2>
            <div className="ln-big mono">{pct(a.events.accuracy)}</div>
            <p className="ln-of">of {a.events.n} events right, with nothing known after the event</p>
            <ul>
              <li>
                <b>{pct(a.events.decided_by_learning)}</b> decided by what it learned, <b>{pct(a.events.learned_accuracy)}</b> right: mostly pit stops
              </li>
              <li>
                Damage events: <b>{pct(a.events.damage_accuracy)}</b> of {a.events.damage_n}; learning covered only {a.events.damage_by_learning}
              </li>
              <li>
                {a.events.missed_damage} damage missed ({a.events.missed_without_telemetry} practice crashes known only from the press, no telemetry), {a.events.false_alarms} false alarms
              </li>
            </ul>
          </article>
          <article className="glass ln-score">
            <h2>Which parts</h2>
            <div className="ln-big mono">{pct(a.parts.template.recall)}</div>
            <p className="ln-of">of the parts each crash destroyed were reserved, {a.parts.n} crashes</p>
            <ul>
              <li>
                <b>{pct(a.parts.template.value_recall)}</b> of the destroyed parts' value
              </li>
              <li>
                <b>{pct(a.parts.template.precision)}</b> of what it reserved was needed: it over-reserves heavy crashes
              </li>
              <li>Learning from the earlier crashes: {pct(a.parts.learned.recall)} of parts; six crashes are too few to beat the template</li>
            </ul>
          </article>
          <article className="glass ln-score">
            <h2>What it cost</h2>
            <div className="ln-big mono">{signed(a.cost.against[0]!.estimate_error)}</div>
            <p className="ln-of">
              São Paulo's estimate, {usdShort(a.cost.estimate_cents)}, against {a.cost.against[0]!.source}'s {usdShort(a.cost.against[0]!.cents)}
            </p>
            <ul>
              <li>
                {signed(a.cost.against[1]!.estimate_error)} against PlanetF1's {usdShort(a.cost.against[1]!.cents)}: the press sources disagree by 61%
              </li>
              {a.cost.per_crash.map((c) => (
                <li key={`${c.car}-${c.session}`}>
                  Car {c.car}, {c.session.toLowerCase()}: <b>{signed(c.estimate_error)}</b> against PlanetF1
                </li>
              ))}
              <li>The total is calibrated, so not an independent test; the split between crashes is, and it is off</li>
            </ul>
          </article>
        </section>
      ) : (
        <p className="glass ln-none">No backtest yet: run make race-backtest race-onboarding-report.</p>
      )}

      <div className="ln-grid">
        <section className="glass ln-sec" aria-label="Rules it learned">
          <h2>Rules it learned</h2>
          <p className="ln-note">A rule decides on its own only when its record clears the licence: the 90% Wilson lower bound of its agreement at 0.75 or more, with five cases or more.</p>
          <ol className="ln-policies">
            {r.policies.map((p) => (
              <li key={p.id}>
                <span className="ln-pol-title">
                  <b>{p.title}</b>
                  <span className="mono">
                    {p.agree} of {p.cases} ended {p.outcome === 'none' ? 'with no cost' : p.outcome}
                  </span>
                </span>
                <span className="ln-lb" aria-label={`lower bound ${p.lower_bound}`}>
                  <i style={{ width: `${p.lower_bound * 100}%` }} className={p.licensed ? 'is-on' : ''} />
                  <em style={{ left: '75%' }} />
                </span>
                <span className="mono ln-lb-v">{p.lower_bound.toFixed(2)}</span>
                {p.licensed ? (
                  <Pill tone="ok">Licensed</Pill>
                ) : (
                  <Pill tone="wait">Shadow</Pill>
                )}
              </li>
            ))}
          </ol>
          <h3>The team's operations history</h3>
          <p className="ln-note">
            {ops.cases} operations from {ops.crashes} crashes over {ops.weekends.length} weekends ({ops.weekends.join(', ')}): the cases every response plan line is matched against.
          </p>
          <div className="ln-parts">
            {ops.parts_replaced.map((p) => (
              <span key={p.part} className="ln-part">
                {p.label} <b className="mono">×{p.times}</b>
              </span>
            ))}
          </div>
        </section>

        <section className="glass ln-sec" aria-label="What it still assumes">
          <h2>What it still assumes, and what replaces it</h2>
          <p className="ln-note">Public data taught it the team's routine. The damage needs the team's own records: these are the inputs a team connects first.</p>
          <table className="ln-table">
            <thead>
              <tr>
                <th>Input</th>
                <th>Today</th>
                <th>From the team</th>
              </tr>
            </thead>
            <tbody>
              {r.assumptions.map((x) => (
                <tr key={x.what}>
                  <td>
                    <b>{x.what}</b>
                  </td>
                  <td>{x.now}</td>
                  <td>{x.replace_with}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
