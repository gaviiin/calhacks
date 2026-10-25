import { AuditView } from './AuditView';
import { EvidenceView } from './EvidenceView';

// Audit: the log of who decided what, and the official documents behind it.

export function AuditTabsView({ tab, nav, window: win, costCapReady }: { tab: string | null; nav: (h: string) => void; window: [number, number] | null; costCapReady: boolean }) {
  const t = tab?.startsWith('evidence') ? 'evidence' : 'log';
  return (
    <div className="audit-tabs">
      <nav className="subtabs" aria-label="Audit">
        <a href="#/audit" className={t === 'log' ? 'subtab subtab--on' : 'subtab'} onClick={(e) => (e.preventDefault(), nav('/audit'))}>
          Audit log
        </a>
        <a href="#/audit/evidence" className={t === 'evidence' ? 'subtab subtab--on' : 'subtab'} onClick={(e) => (e.preventDefault(), nav('/audit/evidence'))}>
          Evidence
        </a>
      </nav>
      {t === 'evidence' ? (
        <EvidenceView />
      ) : costCapReady ? (
        <AuditView window={win} clearWindow={() => nav('/audit')} />
      ) : (
        <p className="muted loading">Connecting to the cost cap desk on SpacetimeDB…</p>
      )}
    </div>
  );
}
