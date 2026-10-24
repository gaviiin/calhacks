import { useMemo } from 'react';
import { OPEN_STATES, proposedCapEffect, useCostCap } from '../lib/costcap';
import { usdShort } from '../lib/format';

// Relevant Costs against the cap on one track. Lime is what a person approved and the gateway
// posted; steel is what the agents proposed and nobody has posted yet; the outline is still to
// classify. The run rate is labelled for what it is: January times twelve.

const MATERIAL_BREACH = 1.05; // FIA: an overspend of 5% or more is a Material Overspend Breach

export function useCapFigures() {
  const cc = useCostCap();
  return useMemo(() => {
    let posted = 0n;
    for (const p of cc.capPositions) posted += p.relevantUsdMinor;
    let proposed = 0n;
    let unclassified = 0n;
    let unclassifiedLines = 0;
    const periods = new Set<string>();
    for (const w of cc.workItems) {
      periods.add(w.periodKey);
      if (w.kind !== 'classification') continue;
      if (OPEN_STATES.has(w.state)) proposed += proposedCapEffect(cc, w) ?? 0n;
      else if (w.state === 'NEW' || w.state === 'NEEDS_INFO') {
        unclassified += w.amountUsdMinor;
        unclassifiedLines += 1;
      }
    }
    const months = Math.max(1, periods.size);
    const known = Number(posted + proposed);
    const runRate = (known / months) * 12;
    return { cap: Number(cc.cap), posted: Number(posted), proposed: Number(proposed), unclassified: Number(unclassified), unclassifiedLines, months, runRate, materiality: Number(cc.materiality) };
  }, [cc]);
}

export function CapTrack() {
  const f = useCapFigures();
  const max = Math.max(f.cap * 1.2, f.runRate * 1.06, f.posted + f.proposed + f.unclassified);
  const x = (v: number) => `${(Math.max(0, v) / max) * 100}%`;
  const ticks = [0, 50e8, 100e8, 150e8, 200e8].filter((t) => t < max);
  const over = f.runRate - f.cap;
  const monthLabel = f.months === 1 ? 'January' : `${f.months}-month average`;

  return (
    <section className="captrack" aria-labelledby="captrack-h">
      <div className="captrack-head">
        <h2 id="captrack-h">Cost cap 2026</h2>
        <p className="captrack-statement">
          <strong>{usdShort(f.posted)}</strong> of Relevant Costs posted against a <strong>{usdShort(f.cap)}</strong> cap.{' '}
          {f.runRate > 0 && (
            <span className={over > 0 ? 'tone-alert' : 'tone-ok'}>
              At {monthLabel}'s pace the year lands at {usdShort(f.runRate)},{' '}
              {over > 0 ? `${usdShort(over)} over the cap` : `${usdShort(-over)} inside it`}.
            </span>
          )}
        </p>
      </div>
      <div className="track" role="img" aria-label={`Posted ${usdShort(f.posted)}, proposed ${usdShort(f.proposed)}, unclassified ${usdShort(f.unclassified)}, cap ${usdShort(f.cap)}, run rate ${usdShort(f.runRate)}`}>
        <div className="track-bar">
          <span className="seg seg--posted" style={{ left: 0, width: x(f.posted) }} />
          <span className="seg seg--proposed" style={{ left: `calc(${x(f.posted)} + 2px)`, width: `calc(${x(f.proposed)} - 2px)` }} />
          <span
            className="seg seg--unclassified"
            style={{ left: `calc(${x(f.posted + f.proposed)} + 2px)`, width: `calc(${x(f.unclassified)} - 2px)` }}
          />
        </div>
        <span className="track-line track-line--cap" style={{ left: x(f.cap) }}>
          <b>cap {usdShort(f.cap)}</b>
        </span>
        <span className="track-line track-line--breach" style={{ left: x(f.cap * MATERIAL_BREACH) }}>
          <b>+5% breach</b>
        </span>
        {f.runRate > 0 && (
          <span className={`track-runrate ${over > 0 ? 'track-runrate--over' : ''}`} style={{ left: x(f.runRate) }}>
            <i aria-hidden />
            <b>{monthLabel} × 12</b>
          </span>
        )}
        <div className="track-axis" aria-hidden>
          {ticks.map((t) => (
            <span key={t} style={{ left: x(t) }}>
              {usdShort(t)}
            </span>
          ))}
        </div>
      </div>
      <dl className="track-legend">
        <div>
          <dt>
            <span className="key key--posted" /> Posted, approved by a person
          </dt>
          <dd>{usdShort(f.posted)}</dd>
        </div>
        <div>
          <dt>
            <span className="key key--proposed" /> Proposed by the agents, not posted
          </dt>
          <dd>{usdShort(f.proposed)}</dd>
        </div>
        <div>
          <dt>
            <span className="key key--unclassified" /> Still to classify ({f.unclassifiedLines} lines)
          </dt>
          <dd>{usdShort(f.unclassified)}</dd>
        </div>
      </dl>
    </section>
  );
}
