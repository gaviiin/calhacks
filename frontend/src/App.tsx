import { useEffect, useRef, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from './module_bindings';
import type { FiaDocuments } from './module_bindings/types';

const HIGHLIGHT_MS = 8000;

const MODE_LABEL: Record<string, { label: string; tone: string }> = {
  live_actor_run: { label: 'Apify run', tone: 'live' },
  replay_captured_run: { label: 'Replay of Apify run', tone: 'replay' },
  test_fixture: { label: 'Test fixture', tone: 'fixture' },
};

function formatIngested(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function byNewest(a: FiaDocuments, b: FiaDocuments) {
  return (
    b.ingestedAt.localeCompare(a.ingestedAt) ||
    b.season - a.season ||
    a.eventSlug.localeCompare(b.eventSlug) ||
    Number(b.documentNumber || 0) - Number(a.documentNumber || 0)
  );
}

function Provenance({ doc }: { doc: FiaDocuments }) {
  const mode = MODE_LABEL[doc.ingestMode] ?? { label: doc.ingestMode, tone: 'fixture' };
  return (
    <div className="provenance">
      <span className={`badge badge-${mode.tone}`}>{mode.label}</span>
      {doc.actorRunId ? (
        <a
          className="mono run-id"
          href={`https://console.apify.com/view/runs/${doc.actorRunId}`}
          target="_blank"
          rel="noreferrer"
          title="Open this run in the Apify console"
        >
          {doc.actorRunId}
        </a>
      ) : (
        <span className="mono muted">no run</span>
      )}
    </div>
  );
}

export default function App({ host, database }: { host: string; database: string }) {
  const { isActive } = useSpacetimeDB();
  const readyRef = useRef(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [lastArrival, setLastArrival] = useState<string | null>(null);

  const [docs, ready] = useTable(tables.fiaDocuments, {
    onInsert: (row: FiaDocuments) => {
      // Rows replayed by the initial subscription are not "new".
      if (!readyRef.current) return;
      setFresh(prev => new Set(prev).add(row.docKey));
      setLastArrival(`Doc ${row.documentNumber || '—'} · ${row.eventName} ${row.season}`);
      setTimeout(() => {
        setFresh(prev => {
          const next = new Set(prev);
          next.delete(row.docKey);
          return next;
        });
      }, HIGHLIGHT_MS);
    },
  });

  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  const sorted = [...docs].sort(byNewest);
  const needsReview = docs.filter(d => d.reviewStatus === 'unreviewed').length;
  const events = new Set(docs.map(d => `${d.season}-${d.eventSlug}`)).size;

  return (
    <div className="page">
      <header className="masthead">
        <div>
          <p className="eyebrow">Meridian Racing · Pit Wall</p>
          <h1>FIA evidence feed</h1>
        </div>
        <div className={`status ${isActive ? 'status-on' : 'status-off'}`} role="status">
          <span className="dot" aria-hidden="true" />
          <span>{isActive ? 'SpacetimeDB connected' : 'Disconnected'}</span>
          <span className="mono muted">
            {database} @ {host.replace(/^wss?:\/\//, '')}
          </span>
        </div>
      </header>

      <section className="stats" aria-label="Summary">
        <div className="stat">
          <span className="stat-value">{docs.length}</span>
          <span className="stat-label">Official documents</span>
        </div>
        <div className="stat">
          <span className="stat-value stat-review">{needsReview}</span>
          <span className="stat-label">Need review</span>
        </div>
        <div className="stat">
          <span className="stat-value">{events}</span>
          <span className="stat-label">Events</span>
        </div>
        <div className="stat stat-wide" aria-live="polite">
          <span className="stat-label">Latest arrival</span>
          <span className="stat-arrival">{lastArrival ?? 'Waiting for new documents…'}</span>
        </div>
      </section>

      <p className="notice">
        <strong>Evidence only.</strong> A listed FIA document proves a document exists — not that a
        classification changed, and not that money is owed. Nothing on this screen creates a journal
        entry; every row waits for human review.
      </p>

      {!ready ? (
        <p className="empty">Loading current evidence…</p>
      ) : sorted.length === 0 ? (
        <p className="empty">
          No documents yet. Run <code>python ingestion/ingest.py run</code> to ingest an Apify run.
        </p>
      ) : (
        <table className="feed">
          <thead>
            <tr>
              <th scope="col">Race</th>
              <th scope="col">Document</th>
              <th scope="col">Published (FIA)</th>
              <th scope="col">Ingested</th>
              <th scope="col">Provenance</th>
              <th scope="col">Review</th>
              <th scope="col">
                <span className="visually-hidden">Official document</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(doc => (
              <tr key={doc.docKey} className={fresh.has(doc.docKey) ? 'row-new' : undefined}>
                <td data-label="Race">
                  <span className="race">{doc.eventName}</span>
                  <span className="muted"> {doc.season}</span>
                </td>
                <td data-label="Document">
                  {doc.documentNumber && <span className="doc-num mono">#{doc.documentNumber}</span>}
                  <span className="doc-title">{doc.title.replace(/^Doc\s+\d+\s*-\s*/i, '')}</span>
                </td>
                <td data-label="Published" className="mono nowrap">
                  {doc.publishedAt || <span className="muted">not shown</span>}
                </td>
                <td data-label="Ingested" className="mono nowrap">
                  {formatIngested(doc.ingestedAt)}
                </td>
                <td data-label="Provenance">
                  <Provenance doc={doc} />
                </td>
                <td data-label="Review">
                  <span className="badge badge-review">
                    {doc.reviewStatus === 'unreviewed' ? 'Needs review' : doc.reviewStatus}
                  </span>
                </td>
                <td data-label="Source">
                  <a className="open-link" href={doc.documentUrl} target="_blank" rel="noreferrer">
                    Open official document ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer className="footnote">
        Source discovery ≠ final sporting fact ≠ financial obligation ≠ posted accounting entry.
      </footer>
    </div>
  );
}
