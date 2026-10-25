import { useEffect, useState } from 'react';
import { AgentsAtWork } from '../components/AgentsAtWork';
import { Attention } from '../components/Attention';
import { CapTrack, useCapFigures } from '../components/CapTrack';
import { CapTrajectory, useTrajectory } from '../components/CapTrajectory';
import { Figure } from '../components/Figure';
import { IconArrow, IconChart } from '../components/icons';
import { resolveEntry, type InboxItem } from '../components/inboxModel';
import type { SeatStatus } from '../components/Shell';
import { Simulations } from '../components/Simulations';
import { WhyPane } from '../components/Why';
import { DEFAULTS, evaluate } from '../lib/caprisk';
import { useCostCap } from '../lib/costcap';
import { pct, usdShort } from '../lib/format';
import { useLive } from '../lib/live';
import { useRevenue } from '../lib/revenue';

interface Scorecard {
  decided: number;
  matched: number;
  accuracy: number | null;
  wrong_side_usd_minor: number;
}

function useScorecard(): Scorecard | null {
  const [s, set] = useState<Scorecard | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch('/local/scorecard', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => live && set(d))
        .catch(() => undefined);
    load();
    const t = window.setInterval(load, 20_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);
  return s;
}

/** The results, as tiles: what the agents did, what people decided, how it scores. */
function Results() {
  const cc = useCostCap();
  const rev = useRevenue();
  const card = useScorecard();
  const items = cc.workItems.filter((w) => w.kind === 'classification');
  const refused = cc.audit.filter((a) => !a.allowed).length;
  const standing = cc.audit.filter((a) => a.action === 'approve' && a.allowed && a.actorRole === 'auto_approver').length;
  const byPeople = cc.audit.filter((a) => a.allowed && a.actorRole.startsWith('human_') && ['approve', 'reject', 'answer', 'teach_policy', 'approve_policy'].includes(a.action)).length;
  const posted = items.filter((w) => w.state === 'POSTED').length;
  const asked = items.filter((w) => w.state === 'NEEDS_INFO').length;
  const s = rev.scorecard;
  const n = (v: number) => v.toLocaleString('en-US');
  const tiles: { label: string; value: number; format: (v: number) => string; sub: string; tone?: 'ok' | 'alert' | 'hold' }[] = [
    { label: 'Lines decided without a person', value: standing, format: n, sub: 'under a rule a person approved' },
    { label: 'Decisions by people', value: byPeople, format: n, sub: 'new scenarios, questions, policies', tone: 'ok' },
    { label: 'Posted to the ERP', value: posted, format: n, sub: `of ${n(items.length)} lines this month` },
    { label: 'Open questions', value: asked, format: n, sub: 'waiting for an answer', tone: asked ? 'hold' : undefined },
    { label: 'Attempts refused', value: refused, format: n, sub: 'every one logged', tone: refused ? 'alert' : undefined },
  ];
  if (card?.accuracy != null) tiles.push({ label: 'Right against the answer key', value: card.accuracy, format: (v) => pct(v, 1), sub: `${card.matched} of ${card.decided}; the agents never see it`, tone: 'ok' });
  if (rev.online && s) {
    tiles.push({ label: 'Sponsor bonuses booked right', value: s.bonuses.truth ? s.bonuses.correct / s.bonuses.truth : 0, format: (v) => pct(v, 0), sub: `${s.bonuses.correct} of ${s.bonuses.truth}, 2024 season`, tone: 'ok' });
    tiles.push({ label: 'Kept off invoices', value: s.dollars_protected_cents, format: usdShort, sub: 'overturned results, not billed' });
  }
  return (
    <section className="results" aria-label="Results">
      {tiles.map((t) => (
        <div key={t.label} className={`tile${t.tone ? ` tile--${t.tone}` : ''}`}>
          <Figure value={t.value} format={t.format} className="tile-figure" />
          <span className="tile-label">{t.label}</span>
          <span className="tile-sub muted">{t.sub}</span>
        </div>
      ))}
    </section>
  );
}

/** One line on breach risk at the current pace, with the way to the full model. */
function RiskLine() {
  const f = useCapFigures();
  const t = useTrajectory();
  if (t.last < 0) return null;
  const cap = f.cap / 100;
  const over = t.landing / 100 - cap;
  const o = evaluate({ ...DEFAULTS, overspend: Math.max(0, over) }, cap);
  return (
    <a className={`riskline riskline--${o.band}`} href="#/risk">
      <IconChart size={15} />
      <span>
        {over <= 0 ? (
          <>
            At this pace the year lands <b>{usdShort(-over * 100)} inside</b> the cap. The cap risk model prices spending some of that headroom.
          </>
        ) : (
          <>
            At this pace the year lands <b>{usdShort(over * 100)} over</b> the cap ({pct(o.overspendPct, 1)}): {o.band === 'material' ? 'a Material Overspend Breach' : 'a Minor Overspend Breach'}. Expected penalty on
            the default assumptions: <b>{usdShort(o.expectedPenalty * 100)}</b>.
          </>
        )}
      </span>
      <span className="link">
        Cap risk <IconArrow size={13} />
      </span>
    </a>
  );
}

export function Overview({ inbox, status }: { inbox: InboxItem[]; status: SeatStatus }) {
  const cc = useCostCap();
  const [selected, setSelected] = useState<string | null>(null);
  const key = selected ?? inbox[0]?.key ?? null;
  const live = useLive();
  const exposure = live.race?.forecast.amount_cents;
  return (
    <div className="overview">
      <dl className="deskline deskline--solo">
        <dt>
          <a className="link" href="#/race">
            Race desk <IconArrow size={13} />
          </a>
        </dt>
        <dd>
          {live.race ? (
            <>
              lap {live.race.lap ?? '—'} · if finished now <b>{exposure == null ? '—' : usdShort(exposure)}</b>
              <span className="muted"> · Jev on the live feed</span>
            </>
          ) : (
            <span className="muted">{live.online ? 'the live feed has not started a race' : 'live feed not reachable'}</span>
          )}
        </dd>
      </dl>
      <Results />
      <div className="split">
        <Attention inbox={inbox} selected={key} onSelect={setSelected} />
        <WhyPane entry={resolveEntry(key, inbox, cc)} status={status} />
      </div>
      <CapTrack tall>
        <CapTrajectory compact bare />
        <RiskLine />
      </CapTrack>
      <AgentsAtWork />
      <Simulations />
    </div>
  );
}
