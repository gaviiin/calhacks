import { useMemo, useState } from 'react';
import { IconDoc, IconExternal } from '../components/icons';
import { useEvidence } from '../lib/evidence';

// Official FIA documents, captured by the Apify actor and ingested by the one identity allowed to.
// Evidence only: nothing here can write a journal entry.

const MODE: Record<string, string> = {
  live_actor_run: 'Apify run',
  replay_captured_run: 'Replay of an Apify run',
  test_fixture: 'Test fixture',
};

const OUTCOME: Record<string, string> = {
  disqualification: 'Disqualification',
  time_penalty: 'Time penalty',
  fine: 'Fine',
  reprimand: 'Reprimand',
  warning: 'Warning',
  no_further_action: 'No further action',
};

/** FIA prints "28.07.24 18:53 CET"; shown as printed, sorted as YYMMDDHHMM. */
function fiaSortKey(s: string): string {
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})/);
  return m ? `${m[3]}${m[2]}${m[1]}${m[4]}${m[5]}` : '';
}

export function EvidenceView() {
  const ev = useEvidence();
  const [q, setQ] = useState('');
  const facts = useMemo(() => new Map(ev.decisions.map((d) => [d.docKey, d])), [ev.decisions]);
  const docs = useMemo(
    () =>
      ev.documents
        .filter((d) => !q || `${d.title} ${d.eventName} ${d.season}`.toLowerCase().includes(q.toLowerCase()))
        .slice()
        .sort((a, b) => fiaSortKey(b.publishedAt).localeCompare(fiaSortKey(a.publishedAt))),
    [ev.documents, q]
  );
  return (
    <div className="evidence-view">
      <div className="sec-head">
        <h1>Evidence</h1>
        <p className="muted">
          {ev.documents.length} official FIA documents across {new Set(ev.documents.map((d) => `${d.season}-${d.eventSlug}`)).size} weekends,{' '}
          {ev.decisions.length} read for a decision. Each keeps its FIA source URL and the Apify run that found it.
        </p>
      </div>
      <label className="field field--search">
        <span>Search</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="infringement, Belgian, car 63" />
      </label>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Document</th>
              <th>Weekend</th>
              <th>Published</th>
              <th>Provenance</th>
            </tr>
          </thead>
          <tbody>
            {docs.slice(0, 200).map((d) => {
              const fact = facts.get(d.docKey);
              return (
                <tr key={d.docKey}>
                  <td>
                    <a className="doc-link" href={d.documentUrl} target="_blank" rel="noreferrer">
                      <IconDoc size={13} /> {d.title} <IconExternal size={11} />
                    </a>
                    {fact && (
                      <div className="extract">
                        <span className="mono">{fact.cars ? `Car ${fact.cars}` : ''}</span> {fact.offence}
                        <strong>{fact.outcome ? OUTCOME[fact.outcome] ?? fact.outcome : 'no outcome recognised'}</strong>
                        {fact.excerpt && <q>{fact.excerpt}</q>}
                        <span className="muted">read from the official PDF · {fact.reviewStatus.replace(/_/g, ' ')}</span>
                      </div>
                    )}
                  </td>
                  <td>
                    {d.season} {d.eventName}
                  </td>
                  <td className="mono nowrap">{d.publishedAt || '—'}</td>
                  <td className="mono muted">
                    {MODE[d.ingestMode] ?? d.ingestMode}
                    <br />
                    {d.actorRunId}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
