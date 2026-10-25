import { useMemo } from 'react';
import { LineChart } from '../charts/LineChart';
import { REG } from '../lib/caprisk';
import { OPEN_STATES, proposedCapEffect, useCostCap } from '../lib/costcap';
import { usdShort } from '../lib/format';

// Relevant Costs through the year: what is posted and proposed per period, cumulative, against the
// cap spent evenly, with the current pace projected to December. The chart the cap risk view opens on.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function useTrajectory() {
  const cc = useCostCap();
  return useMemo(() => {
    const cap = Number(cc.cap);
    const posted = new Map<number, number>();
    const proposed = new Map<number, number>();
    for (const p of cc.capPositions) {
      const m = Number(p.periodKey.slice(5, 7)) - 1;
      if (m >= 0 && m < 12) posted.set(m, (posted.get(m) ?? 0) + Number(p.relevantUsdMinor));
    }
    for (const w of cc.workItems) {
      if (w.kind !== 'classification' || !OPEN_STATES.has(w.state)) continue;
      const m = Number(w.periodKey.slice(5, 7)) - 1;
      if (m >= 0 && m < 12) proposed.set(m, (proposed.get(m) ?? 0) + Number(proposedCapEffect(cc, w) ?? 0n));
    }
    const months = [...new Set([...posted.keys(), ...proposed.keys()])].sort((a, b) => a - b);
    const last = months.length ? months[months.length - 1] : -1;
    let acc = 0;
    const actual: (number | null)[] = [];
    for (let m = 0; m < 12; m++) {
      if (m <= last) {
        acc += (posted.get(m) ?? 0) + (proposed.get(m) ?? 0);
        actual.push(acc);
      } else actual.push(null);
    }
    const perMonth = last >= 0 ? acc / (last + 1) : 0;
    const projected: (number | null)[] = [];
    for (let m = 0; m < 12; m++) projected.push(m < last ? null : m === last ? acc : acc + perMonth * (m - last));
    const pace = MONTHS.map((_, m) => (cap * (m + 1)) / 12);
    const landing = last >= 0 ? acc + perMonth * (11 - last) : 0;
    return { cap, actual, projected, pace, landing, last, perMonth };
  }, [cc]);
}

export function CapTrajectory({ compact = false }: { compact?: boolean }) {
  const t = useTrajectory();
  if (t.last < 0) return null;
  const cap = t.cap;
  const over = t.landing - cap;
  return (
    <section className="trajectory" aria-labelledby="traj-h">
      <div className="sec-head">
        <h2 id="traj-h">The year, at this pace</h2>
        <p className="muted">
          Relevant Costs posted and proposed, cumulative by month, against the cap spent evenly. The dotted line carries {MONTHS[t.last]}'s pace to
          December:{' '}
          <span className={over > 0 ? 'tone-alert' : 'tone-ok'}>
            {usdShort(t.landing)}, {over > 0 ? `${usdShort(over)} over` : `${usdShort(-over)} inside`} the cap
            {over > 0 ? ` (${((over / cap) * 100).toFixed(1)}%${over / cap >= REG.minorBelow ? ', a Material Overspend Breach' : ', a Minor Overspend Breach'})` : ''}.
          </span>
        </p>
      </div>
      <LineChart
        xs={MONTHS.map((_, i) => i)}
        xLabel={(x) => MONTHS[x]}
        yLabel={(y) => usdShort(y)}
        yMin={0}
        height={compact ? 190 : 240}
        series={[
          { key: 'pace', label: 'Cap, spent evenly', values: t.pace, color: '--muted', dashed: true },
          { key: 'actual', label: 'Posted + proposed', values: t.actual, color: '--lime', area: 0.12 },
          { key: 'proj', label: `${MONTHS[t.last]}'s pace`, values: t.projected, color: over > 0 ? '--alert' : '--steel', dashed: true },
        ]}
        bands={[{ from: t.last, to: 11 }]}
        ariaLabel="Cumulative Relevant Costs by month against the cap; the cap risk view explains the breach bands"
      />
    </section>
  );
}
