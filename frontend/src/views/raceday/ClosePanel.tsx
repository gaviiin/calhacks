import { useMemo, useState, type KeyboardEvent } from 'react';
import { useRace, type RaceData } from '../../lib/race';
import { ActButton, parse, roleLabel, type Headline } from './shared';
import './close.css';

// Stage 7, close: the sealed weekend, its root hash, and one brief per role. The CFO approves before anything goes
// out. Stage 8, true-up: weeks later the press actuals are measured against the sealed estimate (race/trueup.py).

type Close = RaceData['closes'][number];
type Sim = RaceData['sims'][number];

interface Band {
  low_cents: number;
  mid_cents: number;
  high_cents: number;
  effects?: number;
}

interface Totals {
  weekend?: string;
  race_cost?: Band;
  cap_relevant_cents?: number;
  excluded_cents?: number;
  already_counted_cents?: number;
  entries?: number;
  prize?: {
    before_cents?: number | null;
    after_cents?: number | null;
    delta_cents?: number;
    p_p8_before?: number | null;
    p_p8_after?: number | null;
    attribution?: Record<string, number>;
  } | null;
  awaiting_count?: number;
  open_questions_count?: number;
  leaves?: number;
  briefs_by?: Record<string, string>;
}

interface TrueUp {
  actual_cents: number;
  estimate_low_cents: number;
  estimate_mid_cents: number;
  estimate_high_cents: number;
  variance_cents: number;
  variance_pct: number | null;
  inside_band: boolean;
  root_hash?: string;
  primary?: { source: string; url: string; published: string; quote?: string };
}

const ROLE_ORDER = ['cfo', 'head_of_cost_cap', 'technical_director', 'team_principal'];

function usd(cents: number | null | undefined): string {
  if (cents == null) return '—';
  const v = Math.abs(cents) / 100;
  const sign = cents < 0 ? '−' : '';
  if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(2)}m`;
  if (v >= 1e3) return `${sign}$${(v / 1e3).toFixed(0)}k`;
  return `${sign}$${v.toFixed(0)}`;
}

const pct = (p: number | null | undefined) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const signed = (p: number) => `${p >= 0 ? '+' : '−'}${Math.abs(Math.round(p * 100))}%`;

function latestClose(race: Pick<RaceData, 'closes'>): Close | null {
  return race.closes.reduce<Close | null>((b, c) => (!b || c.closedAt > b.closedAt ? c : b), null);
}

function latestTrueUp(race: Pick<RaceData, 'sims'>, meetingKey: number): Sim | null {
  return race.sims.reduce<Sim | null>(
    (b, s) => (s.trigger.startsWith('trueup:') && s.meetingKey === meetingKey && (!b || s.at > b.at) ? s : b),
    null,
  );
}

const STATUS_WORDS: Record<string, string> = {
  draft: 'Draft. Nothing has been sent: the CFO approves before the briefs go out.',
  approved: 'Approved. The desk sends the briefs next (python -m race.close --send).',
  sent: 'Sent to the four roles.',
};

export function closeHeadline(race: RaceData): Headline {
  const c = latestClose(race);
  if (!c) return { value: 'open', note: 'seals when the weekend ends', tone: 'muted' };
  const t = latestTrueUp(race, c.meetingKey);
  const tu = t ? parse<TrueUp | null>(t.payloadJson, null) : null;
  const note = tu && tu.variance_pct != null ? `true-up ${signed(tu.variance_pct)} · ${tu.inside_band ? 'inside' : 'outside'} the band` : `root ${c.rootHash.slice(0, 10)}… · ${c.leaves} rows`;
  return { value: c.status, note, tone: c.status === 'draft' ? 'hold' : 'ok' };
}

/** Row keys in a brief ([1249-9627-43-1]) read as citations, quieter than the words. */
function BriefText({ text }: { text: string }) {
  const parts = text.split(/(\[[^\][]+\])/g);
  return (
    <p className="close-brief-text">
      {parts.map((p, i) =>
        p.startsWith('[') && p.endsWith(']') ? (
          <span key={i} className="close-cite mono">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </p>
  );
}

function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="close-root">
      <span className="muted">root</span>
      <code className="mono" title={hash}>
        {hash.slice(0, 12)}…{hash.slice(-4)}
      </code>
      <button type="button" className="btn btn--small" onClick={copy} aria-label="Copy the full root hash">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

export function ClosePanel() {
  const race = useRace();
  const c = useMemo(() => latestClose(race), [race]);
  const [tab, setTab] = useState('cfo');
  if (!c) return <p className="muted">Nothing sealed yet. The close runs once, after the last session of the weekend.</p>;
  const briefs = parse<Record<string, string>>(c.briefsJson, {});
  const t = parse<Totals>(c.totalsJson, {});
  const roles = [...ROLE_ORDER.filter((r) => r in briefs), ...Object.keys(briefs).filter((r) => !ROLE_ORDER.includes(r))];
  const active = roles.includes(tab) ? tab : roles[0] ?? '';
  const sim = latestTrueUp(race, c.meetingKey);
  const tu = sim ? parse<TrueUp | null>(sim.payloadJson, null) : null;
  const rc = t.race_cost;
  const prize = t.prize ?? null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = roles.indexOf(active);
    const next = roles[(i + (e.key === 'ArrowRight' ? 1 : roles.length - 1)) % roles.length];
    if (next) {
      setTab(next);
      document.getElementById(`close-tab-${next}`)?.focus();
    }
  };

  const print = () => {
    document.body.classList.add('close-printing');
    const done = () => {
      document.body.classList.remove('close-printing');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };

  return (
    <div className="close">
      <div className="close-seal">
        <CopyHash hash={c.rootHash} />
        <span className="muted small">
          {c.leaves} rows sealed · {c.closeKey} · flash close, provisional: the books close at month end, the cap year on 31 December
        </span>
      </div>

      <dl className="close-totals">
        <div>
          <dt>Weekend cost</dt>
          <dd className="mono">{usd(rc?.mid_cents)}</dd>
          <dd className="muted small">
            band {usd(rc?.low_cents)} to {usd(rc?.high_cents)}
          </dd>
        </div>
        <div>
          <dt>New cap spend</dt>
          <dd className="mono">{usd(t.cap_relevant_cents)}</dd>
          <dd className="muted small">
            outside the cap {usd(t.excluded_cents)}
            {t.already_counted_cents ? ` · already counted ${usd(t.already_counted_cents)}` : ''}
          </dd>
        </div>
        <div>
          <dt>Prize expectation</dt>
          <dd className={`mono ${prize?.delta_cents != null && prize.delta_cents < 0 ? 'tone-alert' : ''}`}>{usd(prize?.delta_cents)}</dd>
          <dd className="muted small">now {usd(prize?.after_cents)}</dd>
        </div>
        <div>
          <dt>P(P8 or better)</dt>
          <dd className="mono">
            {pct(prize?.p_p8_before)} → {pct(prize?.p_p8_after)}
          </dd>
          <dd className="muted small">baseline to latest run</dd>
        </div>
        <div>
          <dt>Waiting for a person</dt>
          <dd className={`mono ${(t.awaiting_count ?? 0) + (t.open_questions_count ?? 0) ? 'tone-hold' : ''}`}>{(t.awaiting_count ?? 0) + (t.open_questions_count ?? 0)}</dd>
          <dd className="muted small">
            {t.awaiting_count ?? 0} actions · {t.open_questions_count ?? 0} questions
          </dd>
        </div>
      </dl>

      {tu && (
        <p className={`close-trueup ${tu.inside_band ? 'close-trueup--in' : 'close-trueup--out'}`}>
          <strong>True-up{tu.primary?.published ? `, ${tu.primary.published}` : ''}:</strong> press {usd(tu.actual_cents)} against the sealed mid {usd(tu.estimate_mid_cents)}
          {tu.variance_pct != null && <span className="mono"> ({signed(tu.variance_pct)})</span>}; {tu.inside_band ? 'inside' : 'outside'} the band {usd(tu.estimate_low_cents)} to{' '}
          {usd(tu.estimate_high_cents)}.
          {tu.primary?.url && (
            <>
              {' '}
              <a href={tu.primary.url} target="_blank" rel="noreferrer">
                {tu.primary.source}
              </a>
            </>
          )}
        </p>
      )}

      <div className="close-status">
        <p>
          <strong className={c.status === 'draft' ? 'tone-hold' : 'tone-ok'}>{c.status}</strong> {STATUS_WORDS[c.status] ?? ''}
          {c.approvedBy && c.status !== 'draft' && <span className="muted"> Approved by {c.approvedBy}.</span>}
        </p>
        {c.status === 'draft' && <ActButton label="Approve and send" busyLabel="Approving…" primary run={(by, at) => race.approveClose({ closeKey: c.closeKey, by, at })} />}
      </div>

      {roles.length > 0 && (
        <>
          <div className="close-tabs" role="tablist" aria-label="Briefs by role" onKeyDown={onKey}>
            {roles.map((r) => (
              <button
                key={r}
                id={`close-tab-${r}`}
                type="button"
                role="tab"
                aria-selected={r === active}
                aria-controls="close-brief"
                tabIndex={r === active ? 0 : -1}
                className={r === active ? 'filter filter--on' : 'filter'}
                onClick={() => setTab(r)}
              >
                {roleLabel(r)}
              </button>
            ))}
            <button type="button" className="btn btn--small close-print" onClick={print}>
              Print this brief
            </button>
          </div>
          <article className="close-brief" id="close-brief" role="tabpanel" aria-labelledby={`close-tab-${active}`}>
            <header className="close-print-head">
              <h3>{roleLabel(active)} brief</h3>
              <p className="mono small">
                {t.weekend ?? c.closeKey} · {c.closeKey} · root {c.rootHash} · {c.status}
              </p>
            </header>
            <BriefText text={briefs[active] ?? ''} />
            <p className="muted small close-by">
              {(t.briefs_by?.[active] ?? 'offline') === 'offline' ? 'Written by the desk from the sealed rows alone.' : `Written by ${t.briefs_by?.[active]}, checked against the sealed rows.`} Bracketed keys are the rows behind each figure.
            </p>
          </article>
        </>
      )}
    </div>
  );
}
