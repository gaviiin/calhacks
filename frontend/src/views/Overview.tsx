import { useEffect, useState } from 'react';
import { CapTrack } from '../components/CapTrack';
import { IconArrow } from '../components/icons';
import { InboxRow } from '../components/InboxList';
import { resolveEntry, type InboxItem } from '../components/inboxModel';
import type { SeatStatus } from '../components/Shell';
import { Spine } from '../components/Spine';
import { WhyPane } from '../components/Why';
import { useCostCap } from '../lib/costcap';
import { usdShort } from '../lib/format';
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

/** One line of figures per desk: what the agents did, what people decided, how it scores. */
function DeskLines() {
  const cc = useCostCap();
  const rev = useRevenue();
  const card = useScorecard();
  const items = cc.workItems.filter((w) => w.kind === 'classification');
  const count = (f: (s: string) => boolean) => items.filter((w) => f(w.state)).length;
  const refused = cc.audit.filter((a) => !a.allowed).length;
  const s = rev.scorecard;
  const finalRounds = rev.timeline.filter((r) => r.final).length;
  return (
    <section className="desklines" aria-label="Both desks at a glance">
      <dl className="deskline">
        <dt>Cost cap desk · January 2026</dt>
        <dd>
          <b>{items.filter((w) => w.proposalSource === 'deterministic').length}</b> decided by code under a policy
        </dd>
        <dd>
          <b>{items.filter((w) => w.proposalSource === 'llm').length}</b> by Claude
        </dd>
        <dd>
          <b>{count((x) => x === 'NEEDS_INFO')}</b> asked a person
        </dd>
        <dd>
          <b>{count((x) => x === 'POSTED')}</b> posted
        </dd>
        <dd>
          <b>{refused}</b> refused and logged
        </dd>
        {card?.accuracy != null && (
          <dd>
            <b>
              {card.matched}/{card.decided}
            </b>{' '}
            right against the answer key the agents never see
          </dd>
        )}
      </dl>
      <dl className="deskline">
        <dt>Revenue desk · 2024 season</dt>
        {rev.online && s ? (
          <>
            <dd>
              <b>{finalRounds}</b> of {rev.timeline.length} rounds final
            </dd>
            <dd>
              <b>
                {s.bonuses.correct}/{s.bonuses.truth}
              </b>{' '}
              sponsor bonuses booked right
            </dd>
            <dd>
              <b>{usdShort(s.dollars_protected_cents)}</b> kept off invoices
            </dd>
            <dd>
              <b>{s.router.code}</b> by code, <b>{s.router.agent}</b> by Claude
            </dd>
            <dd>books {s.books_tie ? 'tie' : 'do not tie'}</dd>
            {rev.audit && (
              <dd>
                auditor: <b>{rev.audit.opinion}</b>
              </dd>
            )}
          </>
        ) : (
          <dd className="muted">{rev.online ? 'no season running: open Revenue to replay 2024' : 'revenue API not reachable (make revenue-api)'}</dd>
        )}
      </dl>
    </section>
  );
}

export function Overview({ inbox, status, toAudit }: { inbox: InboxItem[]; status: SeatStatus; toAudit: (from: number, to: number) => void }) {
  const cc = useCostCap();
  const [selected, setSelected] = useState<string | null>(null);
  const top = inbox.slice(0, 8);
  const key = selected ?? top.find((i) => i.desk === 'cost')?.key ?? top[0]?.key ?? null;
  return (
    <div className="overview">
      <CapTrack />
      <Spine onWindow={toAudit} />
      <div className="split">
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
                <InboxRow key={i.key} item={i} selected={i.key === key} onSelect={() => setSelected(i.key)} />
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing waits for a person. Every proposal is decided.</p>
          )}
        </section>
        <WhyPane entry={resolveEntry(key, inbox, cc)} status={status} />
      </div>
      <DeskLines />
    </div>
  );
}
