import { IconArrow, IconWaiting } from './icons';
import { InboxRow } from './InboxList';
import type { InboxItem } from './inboxModel';
import { useCostCap } from '../lib/costcap';
import { usdShort } from '../lib/format';

// What needs a person now, most urgent first: material cost lines only the Head of Cost Cap can
// decide, revenue reversals waiting on the Controller and the CFO, then questions and policies.

export function urgency(i: InboxItem, materiality: number): { rank: number; why: string } {
  if (i.kind === 'entry') {
    const cfo = i.needs.includes('CFO');
    const kind = i.entry.kind.replace(/_/g, ' ');
    return { rank: cfo ? 0 : 2, why: cfo ? `Material ${kind}: Controller and CFO` : `${kind}: Controller` };
  }
  if (i.kind === 'item') {
    const material = i.amount >= materiality;
    if (i.item.state === 'NEEDS_INFO') return { rank: material ? 1 : 3, why: material ? 'Material line, no policy covers it: a question' : 'No policy covers it: a question' };
    return { rank: material ? 0 : 2, why: material ? 'Material line: Head of Cost Cap' : 'New scenario: Controller' };
  }
  return { rank: 4, why: 'House policy to approve' };
}

export function Attention({ inbox, selected, onSelect }: { inbox: InboxItem[]; selected: string | null; onSelect: (key: string) => void }) {
  const cc = useCostCap();
  const materiality = Number(cc.materiality);
  const ranked = inbox.map((i) => ({ i, u: urgency(i, materiality) })).sort((a, b) => a.u.rank - b.u.rank || b.i.amount - a.i.amount);
  const urgent = ranked.filter((r) => r.u.rank <= 1);
  const money = ranked.reduce((s, r) => s + r.i.amount, 0);
  const top = ranked.slice(0, 7);
  const n = (v: number) => v.toLocaleString('en-US');
  const counts = {
    material: ranked.filter((r) => r.u.rank <= 1).length,
    entries: inbox.filter((i) => i.kind === 'entry').length,
    questions: inbox.filter((i) => i.kind === 'item' && i.item.state === 'NEEDS_INFO').length,
    policies: inbox.filter((i) => i.kind === 'policy').length,
  };
  return (
    <section className="attention" aria-labelledby="att-h">
      <div className="sec-head">
        <h2 id="att-h">
          <IconWaiting size={16} /> Needs a person now
        </h2>
        <a className="link" href="#/inbox">
          All {inbox.length} in the inbox <IconArrow size={13} />
        </a>
        <p className="attention-sum">
          <b className="mono">{n(inbox.length)}</b> items worth <b className="mono">{usdShort(money)}</b> wait for a decision
          {urgent.length > 0 && (
            <>
              , <b className="tone-alert">{n(urgent.length)} material</b>
            </>
          )}
          . {counts.entries > 0 && `${n(counts.entries)} revenue ${counts.entries === 1 ? 'entry' : 'entries'} for the Controller or CFO. `}
          {counts.questions > 0 && `${n(counts.questions)} ${counts.questions === 1 ? 'question' : 'questions'} the analyst could not settle. `}
          {counts.policies > 0 && `${n(counts.policies)} ${counts.policies === 1 ? 'policy' : 'policies'} to approve.`}
        </p>
      </div>
      {top.length ? (
        <ul className="inbox-list">
          {top.map(({ i, u }) => (
            <li key={i.key} className={`att-row att-row--${u.rank <= 1 ? 'urgent' : 'normal'}`}>
              <span className="att-why">{u.why}</span>
              <InboxRow item={i} selected={i.key === selected} onSelect={() => onSelect(i.key)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing waits for a person. Every proposal is decided.</p>
      )}
    </section>
  );
}
