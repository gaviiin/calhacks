import { AuditView } from './AuditView';
import { EvidenceView } from './EvidenceView';
import { RaceAuditView } from './RaceAuditView';

// Audit: the log of who decided what, on race day (pit-wall) and in the books, and the official documents behind it.

export function AuditTabsView({ tab, nav, window: win, costCapReady }: { tab: string | null; nav: (h: string) => void; window: [number, number] | null; costCapReady: boolean }) {
  const t = tab?.startsWith('evidence') ? 'evidence' : tab?.startsWith('books') ? 'log' : 'race';
  return (
    <div className="audit-tabs">
      <nav className="subtabs" aria-label="Audit">
        <a href="#/audit" className={t === 'race' ? 'subtab subtab--on' : 'subtab'} onClick={(e) => (e.preventDefault(), nav('/audit'))}>
          Race weekend
        </a>
        <a href="#/audit/books" className={t === 'log' ? 'subtab subtab--on' : 'subtab'} onClick={(e) => (e.preventDefault(), nav('/audit/books'))}>
          Books
        </a>
        <a href="#/audit/evidence" className={t === 'evidence' ? 'subtab subtab--on' : 'subtab'} onClick={(e) => (e.preventDefault(), nav('/audit/evidence'))}>
          Evidence
        </a>
      </nav>
      {t === 'evidence' ? (
        <EvidenceView />
      ) : t === 'race' ? (
        <RaceAuditView />
      ) : costCapReady ? (
        <AuditView window={win} clearWindow={() => nav('/audit/books')} />
      ) : (
        <p className="muted loading">Connecting to the cost cap desk on SpacetimeDB…</p>
      )}
    </div>
  );
}
