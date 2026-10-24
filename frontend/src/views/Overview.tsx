import { useEffect, useState } from 'react';
import { CapTrack } from '../components/CapTrack';
import { IconApproved, IconArrow, IconDenied, IconShield } from '../components/icons';
import { InboxRow } from '../components/InboxList';
import type { InboxItem } from '../components/inboxModel';
import { Spine } from '../components/Spine';
import { useCostCap } from '../lib/costcap';
import { pct, usdShort } from '../lib/format';
import { useRevenue } from '../lib/revenue';

interface Scorecard {
  decided: number;
  matched: number;
  asked: number;
  accuracy: number | null;
  wrong_side_usd_minor: number;
  proposed_usd_minor: number;
  by_source: Record<string, { decided: number; matched: number }>;
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

function CostDesk() {
  const cc = useCostCap();
  const card = useScorecard();
  const items = cc.workItems.filter((w) => w.kind === 'classification');
  const by = (pred: (s: string) => boolean) => items.filter((w) => pred(w.state)).length;
  const llm = items.filter((w) => w.proposalSource === 'llm').length;
  const code = items.filter((w) => w.proposalSource === 'deterministic').length;
  const refused = cc.audit.filter((a) => !a.allowed).length;
  const redteam = cc.audit.filter((a) => a.actorRole === 'red_team');
  return (
    <section className="desk" aria-labelledby="desk-cost">
      <h2 id="desk-cost">Cost cap desk</h2>
      <p className="desk-line muted">January 2026 · {items.length} ledger lines · {cc.policies.filter((p) => p.state === 'APPROVED').length} approved house policies</p>
      <dl className="figures">
        <div>
          <dt>Decided by code under a policy</dt>
          <dd>{code}</dd>
        </div>
        <div>
          <dt>Decided by Claude, no policy covered it</dt>
          <dd>{llm}</dd>
        </div>
        <div>
          <dt>Asked a person instead of guessing</dt>
          <dd>{by((s) => s === 'NEEDS_INFO')}</dd>
        </div>
        <div>
          <dt>Posted to the ERP</dt>
          <dd>{by((s) => s === 'POSTED')}</dd>
        </div>
      </dl>
      <ul className="proofs">
        <li>
          <IconShield size={14} /> {refused} attempts refused and logged, {redteam.filter((a) => !a.allowed).length} of {redteam.length} from the red team
        </li>
        {card && card.accuracy !== null && (
          <li>
            <IconApproved size={14} /> Scored against the answer key the agents never see: {card.matched} of {card.decided} right ({pct(card.accuracy)}),{' '}
            {usdShort(card.wrong_side_usd_minor)} on the wrong side of the cap
          </li>
        )}
      </ul>
    </section>
  );
}

function RevenueDesk() {
  const rev = useRevenue();
  if (!rev.online || !rev.run || !rev.scorecard) {
    return (
      <section className="desk">
        <h2>Revenue desk</h2>
        <p className="muted">
          {rev.online ? 'No season is running.' : 'The revenue API is not reachable on :8000 (make revenue-api).'} Open the Revenue tab to replay 2024.
        </p>
      </section>
    );
  }
  const s = rev.scorecard;
  const done = rev.timeline.filter((r) => r.final).length;
  return (
    <section className="desk" aria-labelledby="desk-rev">
      <h2 id="desk-rev">Revenue desk</h2>
      <p className="desk-line muted">
        2024 season replayed from real results · {done} of {rev.timeline.length} rounds final · {s.entries.posted ?? 0} entries posted
      </p>
      <dl className="figures">
        <div>
          <dt>Sponsor bonuses booked right</dt>
          <dd>
            {s.bonuses.correct}/{s.bonuses.truth}
          </dd>
        </div>
        <div>
          <dt>Kept off invoices (results overturned)</dt>
          <dd>{usdShort(s.dollars_protected_cents)}</dd>
        </div>
        <div>
          <dt>Decisions handled by code, by Claude</dt>
          <dd>
            {s.router.code} · {s.router.agent}
          </dd>
        </div>
        <div>
          <dt>Parked for the Controller or CFO</dt>
          <dd>{s.entries.parked ?? 0}</dd>
        </div>
      </dl>
      <ul className="proofs">
        <li>{s.books_tie ? <IconApproved size={14} /> : <IconDenied size={14} />} Trial balance {s.books_tie ? 'ties' : 'does not tie'}</li>
        {rev.audit && (
          <li>
            <IconShield size={14} /> Independent auditor: {rev.audit.opinion} opinion, {rev.audit.summary.findings} findings over {rev.audit.summary.entries} entries
          </li>
        )}
      </ul>
    </section>
  );
}

export function Overview({ inbox, open, toAudit }: { inbox: InboxItem[]; open: (key: string) => void; toAudit: (from: number, to: number) => void }) {
  const top = inbox.slice(0, 7);
  return (
    <div className="overview">
      <CapTrack />
      <Spine onWindow={toAudit} />
      <div className="ov-grid">
        <section className="waiting" aria-labelledby="waiting-h">
          <div className="sec-head">
            <h2 id="waiting-h">Waiting for a person</h2>
            <a className="link" href="#/inbox">
              All {inbox.length} in the inbox <IconArrow size={13} />
            </a>
          </div>
          {top.length ? (
            <ul className="inbox-list">
              {top.map((i) => (
                <InboxRow key={i.key} item={i} selected={false} onSelect={() => open(i.key)} />
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing waits for a person. Every proposal is decided.</p>
          )}
        </section>
        <div className="desks">
          <CostDesk />
          <RevenueDesk />
        </div>
      </div>
    </div>
  );
}
