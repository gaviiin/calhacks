import { useMemo, useState } from 'react';
import { InboxRow } from '../components/InboxList';
import { resolveEntry, type InboxItem } from '../components/inboxModel';
import type { SeatStatus } from '../components/Shell';
import { WhyPane } from '../components/Why';
import { useCostCap } from '../lib/costcap';
import { useSeat } from '../lib/seat';

type Filter = 'all' | 'mine' | 'cost' | 'revenue';

export function InboxView({ inbox, selected, select, status }: { inbox: InboxItem[]; selected: string | null; select: (k: string) => void; status: SeatStatus }) {
  const { person } = useSeat();
  const cc = useCostCap();
  const [filter, setFilter] = useState<Filter>('all');
  const mine = (i: InboxItem) =>
    (person.costCapRole === 'human_head_of_cost_cap' && i.desk === 'cost') ||
    (person.costCapRole === 'human_controller' && i.desk === 'cost' && i.needs !== 'Head of Cost Cap') ||
    (!!person.revenue && i.kind === 'entry' && i.entry.needs.includes(person.revenue.role) && !(i.entry.approved_roles ?? []).includes(person.revenue.role)) ||
    (!!person.revenue && i.kind === 'question' && i.question.to_role === person.revenue.role);
  const shown = useMemo(
    () => inbox.filter((i) => filter === 'all' || (filter === 'mine' ? mine(i) : i.desk === filter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inbox, filter, person]
  );
  const current = resolveEntry(selected, inbox, cc);
  const counts = { all: inbox.length, mine: inbox.filter(mine).length, cost: inbox.filter((i) => i.desk === 'cost').length, revenue: inbox.filter((i) => i.desk === 'revenue').length };
  const labels: Record<Filter, string> = { all: 'Everything', mine: `For ${person.id === 'observer' ? 'my seat' : person.name}`, cost: 'Cost cap', revenue: 'Revenue' };

  return (
    <div className="split">
      <section className="split-list" aria-labelledby="inbox-h">
        <div className="sec-head">
          <h1 id="inbox-h">Inbox</h1>
          <div className="filters" role="tablist" aria-label="Show">
            {(Object.keys(labels) as Filter[]).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'filter filter--on' : 'filter'} onClick={() => setFilter(f)}>
                {labels[f]} <span className="mono">{counts[f]}</span>
              </button>
            ))}
          </div>
        </div>
        {shown.length ? (
          <ul className="inbox-list">
            {shown.map((i) => (
              <InboxRow key={i.key} item={i} selected={i.key === selected} onSelect={() => select(i.key)} />
            ))}
          </ul>
        ) : (
          <p className="muted empty">Nothing here waits for {filter === 'mine' ? person.title : 'a person'}.</p>
        )}
      </section>
      <WhyPane entry={current} status={status} />
    </div>
  );
}
