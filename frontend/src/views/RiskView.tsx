import { useMemo, useState } from 'react';
import { LineChart } from '../charts/LineChart';
import { useCapFigures } from '../components/CapTrack';
import { CapTrajectory, useTrajectory } from '../components/CapTrajectory';
import { Figure } from '../components/Figure';
import { IconChart } from '../components/icons';
import { breakEven, curve, DEFAULTS, evaluate, REG, type Assumptions } from '../lib/caprisk';
import { pct, usdShort } from '../lib/format';

// Cap risk: what deliberately spending over the cap would buy on track, against what the FIA can
// take back, on the team's own assumptions. The regulation bands are the 2026 text; everything
// else is a slider the Head of Cost Cap can set and the page says so.

type Key = keyof Assumptions;

interface Control {
  key: Key;
  label: string;
  note: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
}

const money = (v: number) => usdShort(v * 100);
const CONTROLS: { group: string; items: Control[] }[] = [
  {
    group: 'What the money buys',
    items: [
      { key: 'gainPerMillion', label: 'Lap time per $1m, at the margin', note: 'seconds per lap the first extra million buys', min: 0.002, max: 0.04, step: 0.001, fmt: (v) => `${v.toFixed(3)} s` },
      { key: 'halfLife', label: 'Diminishing returns', note: '$m after which each extra million buys half as much', min: 2, max: 40, step: 1, fmt: (v) => `$${v}m` },
      { key: 'secondsPerPlace', label: 'Gap between constructors’ places', note: 'seconds per lap between neighbouring teams', min: 0.05, max: 0.5, step: 0.01, fmt: (v) => `${v.toFixed(2)} s` },
      { key: 'prizePerPlace', label: 'Prize money per place', note: 'from world/prize_table.json, synthetic', min: 2e6, max: 20e6, step: 5e5, fmt: money },
      { key: 'bonusPerPlace', label: 'Sponsor bonuses per place', note: 'wins, podiums and points finishes over a season', min: 0, max: 6e6, step: 1e5, fmt: money },
    ],
  },
  {
    group: 'What the FIA takes back',
    items: [
      { key: 'pFound', label: 'Chance the review finds it', note: 'the Cost Cap Administration reviews every submission', min: 0.3, max: 1, step: 0.05, fmt: (v) => pct(v, 0) },
      { key: 'fineMultiple', label: 'Fine, as a multiple of the overspend', note: '2021 precedent: $7m on a $2.2m overspend', min: 0.5, max: 6, step: 0.25, fmt: (v) => `${v.toFixed(2)}×` },
      { key: 'atrCut', label: 'Aero testing cut', note: 'D12.1.1.b.v; 2021 precedent: 10% for 12 months', min: 0, max: 0.3, step: 0.025, fmt: (v) => pct(v, 1) },
      { key: 'atrSecondsPer10', label: 'Lap time lost per 10% less aero testing', note: 'next season', min: 0, max: 0.2, step: 0.01, fmt: (v) => `${v.toFixed(2)} s` },
      { key: 'pointsDeduction', label: 'Constructors’ points deducted', note: 'D10.3.4: mandatory for a material breach', min: 0, max: 150, step: 5, fmt: (v) => `${v} pts` },
      { key: 'pointsPerPlace', label: 'Points between places', note: 'in the constructors’ standings', min: 5, max: 120, step: 5, fmt: (v) => `${v} pts` },
      { key: 'capCutNextYear', label: 'Next year’s cap reduction', note: 'D12.1.1.c.vii, if imposed', min: 0, max: 20e6, step: 5e5, fmt: money },
      { key: 'nextYearWeight', label: 'Next season counts', note: 'uncertainty and time', min: 0.3, max: 1, step: 0.05, fmt: (v) => pct(v, 0) },
    ],
  },
];

function Slider({ c, value, onChange }: { c: Control; value: number; onChange: (v: number) => void }) {
  return (
    <label className="ctl">
      <span className="ctl-head">
        <span className="ctl-label">{c.label}</span>
        <b className="mono">{c.fmt(value)}</b>
      </span>
      <input type="range" min={c.min} max={c.max} step={c.step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="ctl-note muted">{c.note}</span>
    </label>
  );
}

export function RiskView() {
  const f = useCapFigures();
  const traj = useTrajectory();
  const cap = f.cap / 100; // USD
  const [a, setA] = useState<Assumptions>(() => ({ ...DEFAULTS, overspend: Math.max(0, traj.landing / 100 - cap) || DEFAULTS.overspend }));
  const set = (k: Key) => (v: number) => setA((p) => ({ ...p, [k]: v }));
  const o = useMemo(() => evaluate(a, cap), [a, cap]);
  const cv = useMemo(() => curve(a, cap), [a, cap]);
  const be = useMemo(() => breakEven(a, cap), [a, cap]);
  const paceOver = traj.landing / 100 - cap;
  const bandWord = { inside: 'inside the cap', minor: 'a Minor Overspend Breach', material: 'a Material Overspend Breach' }[o.band];

  return (
    <div className="risk">
      <section className="risk-head">
        <div>
          <h1>Cap risk</h1>
          <p className="muted">
            Teams sometimes spend over the cap on purpose: a tenth a lap can be worth a place in the standings. This page prices that choice on the
            team's own assumptions against the FIA's sanctions, so the decision is a number, not a feeling. The bands are the 2026 regulations; every
            other input is editable and labelled.
          </p>
        </div>
        <dl className="risk-now">
          <div>
            <dt>Posted + proposed</dt>
            <dd>
              <Figure value={f.posted + f.proposed} format={usdShort} />
            </dd>
          </div>
          <div>
            <dt>At this pace the year lands</dt>
            <dd className={paceOver > 0 ? 'tone-alert' : 'tone-ok'}>
              <Figure value={traj.landing} format={usdShort} /> <span className="muted">({paceOver > 0 ? `${usdShort(paceOver * 100)} over` : `${usdShort(-paceOver * 100)} inside`})</span>
            </dd>
          </div>
          <div>
            <dt>Cap</dt>
            <dd>{usdShort(f.cap)}</dd>
          </div>
        </dl>
      </section>

      <section className="risk-model">
        <div className="risk-main">
          <label className="ctl ctl--big">
            <span className="ctl-head">
              <span className="ctl-label">Planned overspend</span>
              <b className="mono">
                {money(a.overspend)} · {pct(o.overspendPct, 2)} over the cap
              </b>
            </span>
            <input type="range" min={0} max={cap * 0.06} step={100_000} value={a.overspend} onChange={(e) => set('overspend')(Number(e.target.value))} />
            <span className={`ctl-note band band--${o.band}`}>{bandWord} (FIA {o.band === 'material' ? REG.articles.material : REG.articles.minor})</span>
          </label>

          <dl className="risk-figures">
            <div>
              <dt>Lap time bought</dt>
              <dd>
                <Figure value={o.gainSeconds} format={(v) => `${v.toFixed(3)} s`} />
              </dd>
            </div>
            <div>
              <dt>Places gained</dt>
              <dd>
                <Figure value={o.placesGained} format={(v) => v.toFixed(2)} />
              </dd>
            </div>
            <div>
              <dt>Upside, prize + bonuses</dt>
              <dd className="tone-ok">
                <Figure value={o.upside} format={money} />
              </dd>
            </div>
            <div>
              <dt>Penalty if found</dt>
              <dd className="tone-alert">
                <Figure value={o.penaltyIfFound} format={money} />
              </dd>
            </div>
            <div className="risk-figures-net">
              <dt>Expected value</dt>
              <dd className={o.expected >= 0 ? 'tone-ok' : 'tone-alert'}>
                <Figure value={o.expected} format={(v) => `${v < 0 ? '−' : '+'}${money(Math.abs(v))}`} />
              </dd>
            </div>
          </dl>

          <LineChart
            xs={cv.xs}
            xLabel={(x) => `${pct(x / cap, 1)} over`}
            yLabel={(y) => money(y)}
            zero
            height={260}
            series={[
              { key: 'up', label: 'Upside', values: cv.rows.map((r) => r.upside), color: '--steel' },
              { key: 'pen', label: 'Expected penalty', values: cv.rows.map((r) => -r.expectedPenalty), color: '--alert', dashed: true },
              { key: 'net', label: 'Expected value', values: cv.rows.map((r) => r.expected), color: '--ink', area: 0.1 },
            ]}
            markers={[
              { x: REG.minorBelow * cap, label: '2% · material breach', tone: 'alert' },
              { x: a.overspend, label: 'your plan', tone: 'hold' },
              ...(paceOver > 0 ? [{ x: paceOver, label: 'at this pace', tone: 'muted' as const }] : []),
            ]}
            bands={[{ from: 0.0000001, to: REG.minorBelow * cap, label: 'minor' }]}
            tooltip={(i) => {
              const r = cv.rows[i];
              return (
                <>
                  <div className="tooltip-row">
                    <span className="tooltip-line" style={{ background: 'var(--steel)' }} />
                    <span>
                      <b className="mono">{money(r.upside)}</b> <span className="muted">upside, {r.placesGained.toFixed(2)} places</span>
                    </span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-line" style={{ background: 'var(--alert)' }} />
                    <span>
                      <b className="mono">{money(r.expectedPenalty)}</b> <span className="muted">expected penalty ({r.band})</span>
                    </span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-line" style={{ background: 'var(--ink)' }} />
                    <span>
                      <b className="mono">{r.expected < 0 ? '−' : '+'}{money(Math.abs(r.expected))}</b> <span className="muted">expected value</span>
                    </span>
                  </div>
                </>
              );
            }}
            ariaLabel="Expected value of an overspend against its size; the table below lists the sanctions"
          />
          <p className="risk-readout">
            <IconChart size={14} />{' '}
            {be === null ? (
              <>On these assumptions the expected value stays positive across the whole range. Check the penalty side before believing that.</>
            ) : (
              <>
                The expected value turns negative at <b className="mono">{money(be)}</b> over the cap ({pct(be / cap, 2)}).
                {be < REG.minorBelow * cap ? ' That is inside the minor band: the fine and the aero-testing cut alone outweigh the lap time.' : ' The points deduction at 2% is what tips it.'}
              </>
            )}
          </p>
        </div>

        <aside className="risk-side">
          <h3>Scenarios at {money(a.overspend)} over</h3>
          <table className="data data--tight">
            <tbody>
              <tr>
                <td>Never found</td>
                <td className="num mono tone-ok">+{money(o.best)}</td>
              </tr>
              <tr>
                <td>Expected ({pct(a.pFound, 0)} found)</td>
                <td className={`num mono ${o.expected >= 0 ? 'tone-ok' : 'tone-alert'}`}>{o.expected < 0 ? '−' : '+'}{money(Math.abs(o.expected))}</td>
              </tr>
              <tr>
                <td>Found, full sanction</td>
                <td className={`num mono ${o.worst >= 0 ? 'tone-ok' : 'tone-alert'}`}>{o.worst < 0 ? '−' : '+'}{money(Math.abs(o.worst))}</td>
              </tr>
            </tbody>
          </table>
          <h3>The sanction, if found</h3>
          <table className="data data--tight">
            <tbody>
              <tr>
                <td>Fine ({a.fineMultiple}× the overspend)</td>
                <td className="num mono">{money(o.fine)}</td>
              </tr>
              <tr>
                <td>Aero testing cut, next season</td>
                <td className="num mono">{money(o.atrLoss)}</td>
              </tr>
              <tr>
                <td>Points deduction ({o.band === 'material' ? `${a.pointsDeduction} pts` : 'none below 2%'})</td>
                <td className="num mono">{money(o.pointsLoss)}</td>
              </tr>
              {a.capCutNextYear > 0 && (
                <tr>
                  <td>Smaller cap next year</td>
                  <td className="num mono">{money(o.capCutLoss)}</td>
                </tr>
              )}
            </tbody>
          </table>
          <h3>What the regulations say</h3>
          <dl className="kv kv--reg">
            <div>
              <dt>{REG.articles.minor}</dt>
              <dd>A Minor Overspend Breach: Relevant Costs over the Cost Cap by less than 2%.</dd>
            </div>
            <div>
              <dt>{REG.articles.minorSanction}</dt>
              <dd>A Financial Penalty and any other appropriate Minor Sporting Penalty: reprimand, points, suspension from sessions, less aerodynamic testing, a smaller cap next year.</dd>
            </div>
            <div>
              <dt>{REG.articles.material}</dt>
              <dd>A Material Overspend Breach: 2% or more over.</dd>
            </div>
            <div>
              <dt>{REG.articles.materialSanction}</dt>
              <dd>A Constructors' Championship points deduction, a Financial Penalty and any other appropriate Material Sporting Penalty, up to suspension from Competitions and exclusion.</dd>
            </div>
          </dl>
          <p className="muted small">Source: 2026 Formula 1 Financial Regulations, Section D Issue 07, on file. The fine, the testing cut and the points are not fixed by the text; the defaults follow the 2021 precedent and are the team's to change.</p>
        </aside>
      </section>

      <section className="risk-controls">
        {CONTROLS.map((g) => (
          <div key={g.group} className="ctl-group">
            <h3>{g.group}</h3>
            {g.items.map((c) => (
              <Slider key={c.key} c={c} value={a[c.key]} onChange={set(c.key)} />
            ))}
          </div>
        ))}
        <div className="ctl-group ctl-group--reset">
          <button className="btn" onClick={() => setA({ ...DEFAULTS, overspend: a.overspend })}>
            Reset the assumptions
          </button>
        </div>
      </section>

      <CapTrajectory />
    </div>
  );
}
