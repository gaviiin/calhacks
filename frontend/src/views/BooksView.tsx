import type { InboxItem } from '../components/inboxModel';
import type { SeatStatus } from '../components/Shell';
import { AccountPanel } from './raceday/AccountPanel';
import { CostCapView } from './CostCapView';
import { RevenueView } from './RevenueView';

// Books: where the race day's entries land. The race entries first, then the two desks behind them
// (cost cap classification and the revenue ledger), each as it was.

const TABS = [
  { id: 'race', label: 'Race entries' },
  { id: 'cost-cap', label: 'Cost cap' },
  { id: 'revenue', label: 'Revenue' },
] as const;

export function BooksView({ tab, nav, status, inbox, costCapReady }: { tab: string | null; nav: (h: string) => void; status: SeatStatus; inbox: InboxItem[]; costCapReady: boolean }) {
  const t = TABS.find((x) => x.id === tab)?.id ?? 'race';
  return (
    <div className="books">
      <nav className="subtabs" aria-label="Books">
        {TABS.map((x) => (
          <a key={x.id} href={`#/books/${x.id}`} className={x.id === t ? 'subtab subtab--on' : 'subtab'} aria-current={x.id === t ? 'page' : undefined} onClick={(e) => (e.preventDefault(), nav(`/books/${x.id}`))}>
            {x.label}
          </a>
        ))}
      </nav>
      {t === 'race' ? (
        <section className="panel">
          <div className="sec-head">
            <h2>Race entries</h2>
            <span className="muted">provisional accruals from race day, with when the cap counts each</span>
          </div>
          <AccountPanel />
        </section>
      ) : t === 'cost-cap' ? (
        costCapReady ? <CostCapView status={status} inbox={inbox} /> : <p className="muted loading">Connecting to the cost cap desk on SpacetimeDB…</p>
      ) : (
        <RevenueView />
      )}
    </div>
  );
}
