import { useMemo, useState, type ReactNode } from 'react';
import { IconApproved, IconDenied, IconEntry, IconPerson, IconWaiting, IconFlag } from '../../components/icons';
import { parseJson, usdShort } from '../../lib/format';
import { useRace, type RaceData } from '../../lib/race';
import { TEAM, carLabel, eventDetail, kindMeta, sortTime, utcClock } from '../../lib/raceModel';
import { RECOGNITION_WORDS, signedCents } from '../raceday/AccountPanel';
import { ActButton, roleLabel } from '../raceday/shared';
import './accounting.css';

// Accounting: for the financial controller and the accountants. On the left, everything that happened as the desk
// learned it, newest first: our cars' race events, what the incident log believed, what people decided, the answers
// they gave, the entries booked and where each went. On the right, the books: every race entry by where it stands in
// the ERP (posted with its ERP id, held for a named reviewer with the reason, rejected, failed), and its lines.
//
// race/erp.py decides post or hold. Holds: a crash line that waits for a person (controller), $250k or more (Head of
// Cost Cap, the cost cap desk's materiality), $1m or more (CFO, finance K10), an FIA fine outside the cap (Head of
// Cost Cap). A person approves here and the desk posts it; a rejected entry never reaches the ERP.

type Entry = RaceData['entries'][number];
type Line = RaceData['entryLines'][number];
type Posting = RaceData['postings'][number];

// ---------------------------------------------------------------- the ERP's accounts (race/erp.py)
const ACCOUNT_NAME: Record<string, string> = {
  '6050': 'Crash damage repairs & race spares',
  '5200': 'Contract & agency staff',
  '6300': 'Freight & logistics',
  '6910': 'FIA fines & penalties',
  '1400': 'Inventory: race spares',
  '2100': 'Accrued liabilities: race costs',
};
const BALANCE_ERP: Record<string, string> = { '1400': 'capadj-RACE_SPARES_INVENTORY_1400', '2100': 'capadj-RACE_ACCRUED_COSTS_2100' };
const DEFAULT_CATEGORY: Record<string, string> = { '6910': 'FINES' };
const erpAccount = (code: string) => BALANCE_ERP[code] ?? `acct-${code}`;
const isExpense = (code: string) => /^[5-9]\d{3}$/.test(code);

interface ErpLine {
  account: string;
  debit: bigint;
  credit: bigint;
  note: string;
}

/** The journal entry as the desk sends it: our lines on the ERP's accounts, then the cost cap classification pair. */
function erpLines(e: Entry, lines: readonly Line[]): ErpLine[] {
  const out: ErpLine[] = lines.map((l) => ({ account: erpAccount(l.account), debit: l.debitCents, credit: l.creditCents, note: ACCOUNT_NAME[l.account] ?? '' }));
  const net = new Map<string, bigint>();
  for (const l of lines) if (isExpense(l.account)) net.set(l.account, (net.get(l.account) ?? 0n) + l.debitCents - l.creditCents);
  for (const [code, amt] of net) {
    const cat = e.capRelevant ? 'RELEVANT' : DEFAULT_CATEGORY[code];
    if (!cat || amt === 0n) continue;
    const cap = `capcat-${cat}`;
    const src = `acct-${code}`;
    const a = amt < 0n ? -amt : amt;
    const [dr, cr] = amt > 0n ? [cap, src] : [src, cap];
    out.push({ account: dr, debit: a, credit: 0n, note: 'cost cap classification' }, { account: cr, debit: 0n, credit: a, note: 'cost cap classification' });
  }
  return out;
}

// ---------------------------------------------------------------- status: an icon and a word, never colour alone
type Status = 'posted' | 'held' | 'approved' | 'rejected' | 'failed' | 'unrouted';
const STATUS: Record<Status, { label: string; icon: (p: { size?: number }) => JSX.Element; tone: string }> = {
  posted: { label: 'Posted to ERP', icon: IconApproved, tone: 'ok' },
  held: { label: 'Held for review', icon: IconWaiting, tone: 'hold' },
  approved: { label: 'Approved, posting', icon: IconPerson, tone: 'hold' },
  failed: { label: 'Failed, will retry', icon: IconDenied, tone: 'alert' },
  rejected: { label: 'Rejected, kept out', icon: IconDenied, tone: 'muted' },
  unrouted: { label: 'Not routed yet', icon: IconWaiting, tone: 'muted' },
};
const statusOf = (p: Posting | undefined): Status => (p && p.status in STATUS ? (p.status as Status) : 'unrouted');

function StatusTag({ s }: { s: Status }) {
  const m = STATUS[s];
  const Icon = m.icon;
  return (
    <span className={`acc-status acc-status--${m.tone}`}>
      <Icon size={12} />
      <span>{m.label}</span>
    </span>
  );
}

const firstSentence = (memo: string) => {
  const m = /^(.*?)( - counts|[.:]\s)/.exec(memo);
  return (m ? m[1]! : memo).trim();
};
const personOf = (by: string) => by.replace(/^person:/, '').replace(/^race_desk after /, '');

// ---------------------------------------------------------------- the feed
type FeedKind = 'race' | 'belief' | 'person' | 'answer' | 'entry' | 'books';
interface FeedItem {
  key: string;
  kind: FeedKind;
  order: number; // when the desk learned it (system time)
  raceAt: string; // race time, when the item belongs to the tape
  who: string;
  what: ReactNode;
  amount: bigint | null;
  status?: Status;
}

const FILTERS: { id: string; label: string; kinds: FeedKind[] }[] = [
  { id: 'all', label: 'All', kinds: ['race', 'belief', 'person', 'answer', 'entry', 'books'] },
  { id: 'people', label: 'People', kinds: ['person', 'answer'] },
  { id: 'books', label: 'Books', kinds: ['entry', 'books'] },
  { id: 'race', label: 'Race', kinds: ['race', 'belief'] },
];

const KIND_WORD: Record<FeedKind, string> = { race: 'Race', belief: 'Incident', person: 'Decision', answer: 'Answer', entry: 'Entry', books: 'Books' };
const MONEY_KINDS = new Set(['incident', 'penalty', 'retirement_suspected', 'retirement_confirmed', 'car_stopped', 'pit_stop', 'red_flag']);

function midOf(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.round(v));
  if (Array.isArray(v) && v.length >= 2 && typeof v[1] === 'number') return BigInt(Math.round(v[1]));
  return null;
}

function buildFeed(race: RaceData, lines: Map<string, Line[]>): FeedItem[] {
  const out: FeedItem[] = [];
  const evByKey = new Map(race.events.map((e) => [e.eventKey, e]));
  const incByKey = new Map(race.incidents.map((i) => [i.incidentKey, i]));
  const cost = new Map<string, bigint>();
  for (const f of race.effects) if (f.kind === 'cost' && f.status !== 'corrected') cost.set(f.eventKey, (cost.get(f.eventKey) ?? 0n) + f.midCents);

  for (const e of race.events) {
    const ours = e.driverNumber ? e.teamName === TEAM : false;
    if (!ours || !(MONEY_KINDS.has(e.kind) || cost.has(e.eventKey))) continue;
    out.push({
      key: `ev:${e.eventKey}`, kind: 'race', order: sortTime(e.ingestedAt), raceAt: e.at, who: e.source.startsWith('openf1') ? 'OpenF1 tape' : e.source,
      what: (
        <>
          <b>{kindMeta(e.kind).label}</b> {carLabel(e.driverNumber)} L{e.lap}: {eventDetail(e)}
        </>
      ),
      amount: cost.get(e.eventKey) ?? null,
    });
  }
  for (const b of race.beliefs) {
    const inc = incByKey.get(b.incidentKey);
    out.push({
      key: `bel:${b.beliefKey}`, kind: 'belief', order: sortTime(b.recordedAt), raceAt: b.at, who: 'incident log',
      what: (
        <>
          <b>{inc ? carLabel(inc.driverNumber) : 'Incident'} v{b.version}</b> {b.status}: {b.cause}
        </>
      ),
      amount: null,
    });
  }
  for (const a of race.actions) {
    if (!a.decidedBy.startsWith('person:')) continue;
    const d = parseJson<Record<string, unknown>>(a.detailJson, {});
    const chosen = typeof d.chosen === 'string' ? d.chosen : '';
    const opts = Array.isArray(d.options) ? (d.options as { id?: string; label?: string; cost_cents?: unknown }[]) : [];
    const pick = opts.find((o) => o.id === chosen);
    out.push({
      key: `act:${a.actionKey}`, kind: 'person', order: sortTime(a.updatedAt), raceAt: '', who: personOf(a.decidedBy),
      what: (
        <>
          <b>{a.status.replace(/_/g, ' ')}</b> {a.title}
          {chosen ? ` · chose: ${pick?.label ?? chosen}` : ''}
        </>
      ),
      amount: midOf(pick ? pick.cost_cents : d.cost_cents),
    });
  }
  for (const q of race.questions) {
    if (q.status === 'open') continue;
    const ans = parseJson<{ option?: string; defaulted?: boolean }>(q.answerJson, {});
    const opts = parseJson<{ id?: string; label?: string }[]>(q.optionsJson, []);
    const label = opts.find((o) => o.id === ans.option)?.label ?? ans.option ?? '';
    // An answer carries no time of its own; the desk re-decides the incident when it applies one.
    const after = race.beliefs.filter((b) => b.incidentKey === q.incidentKey).reduce((m, b) => Math.max(m, sortTime(b.recordedAt)), 0);
    out.push({
      key: `q:${q.questionKey}`, kind: 'answer', order: after || sortTime(q.createdAt), raceAt: q.createdAt,
      who: q.status === 'defaulted' ? 'deadline (default)' : q.answeredBy || roleLabel(q.routeRole),
      what: (
        <>
          <b>{q.status === 'defaulted' ? 'Defaulted' : 'Answered'}</b> {q.prompt} <span className="acc-answer">→ {label || 'neither'}</span>
        </>
      ),
      amount: q.expectedLossCents ? q.expectedLossCents : null,
    });
  }
  const posting = new Map(race.postings.map((p) => [p.entryKey, p]));
  for (const e of race.entries) {
    const ev = parseJson<string[]>(e.evidenceJson, []).map((k) => evByKey.get(k)).find(Boolean);
    const p = posting.get(e.entryKey);
    out.push({
      key: `en:${e.entryKey}`, kind: 'entry', order: ev ? sortTime(ev.ingestedAt) : p ? sortTime(p.at) - 1 : sortTime(e.at), raceAt: e.at, who: 'race desk',
      what: (
        <>
          <b>Booked</b> {firstSentence(e.memo)} <span className="muted">({RECOGNITION_WORDS[e.recognition] ?? e.recognition})</span>
        </>
      ),
      amount: signedCents(e, lines.get(e.entryKey)),
    });
  }
  for (const p of race.postings) {
    const s = statusOf(p);
    const word =
      s === 'posted' ? <>Posted as <span className="mono">{p.erpEntryId}</span></> :
      s === 'held' ? <>Held for {roleLabel(p.reviewRole)}</> :
      s === 'failed' ? <>Not posted: {p.reason}</> :
      s === 'rejected' ? <>Rejected, kept out of the ERP</> : <>Approved, posting to the ERP</>;
    out.push({
      key: `po:${p.entryKey}`, kind: 'books', order: sortTime(p.at), raceAt: '', who: p.by.replace(/^race_desk after /, 'desk, after '),
      what: word, amount: p.amountCents, status: s,
    });
  }
  return out.sort((a, b) => b.order - a.order || a.key.localeCompare(b.key));
}

function wallClock(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function Feed({ items }: { items: FeedItem[] }) {
  const [filter, setFilter] = useState('all');
  const kinds = new Set(FILTERS.find((f) => f.id === filter)!.kinds);
  const shown = items.filter((i) => kinds.has(i.kind)).slice(0, 200);
  return (
    <section className="acc-panel" aria-labelledby="acc-feed-h">
      <header className="acc-head">
        <h2 id="acc-feed-h">As it happens</h2>
        <div className="acc-filters" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`acc-filter ${f.id === filter ? 'acc-filter--on' : ''}`} aria-pressed={f.id === filter} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </header>
      {!shown.length && <p className="muted">Nothing yet. The feed fills as the replay runs.</p>}
      <ol className="acc-feed">
        {shown.map((i) => (
          <li key={i.key} className={`acc-item acc-item--${i.kind}`}>
            <span className="acc-time mono" title={i.raceAt ? `race time ${utcClock(i.raceAt)} UTC` : 'when it was decided'}>
              {wallClock(i.order)}
              {i.raceAt && <span className="acc-race muted">{utcClock(i.raceAt)}</span>}
            </span>
            <span className="acc-kind">{KIND_WORD[i.kind]}</span>
            <span className="acc-what">
              {i.what}
              <span className="acc-who muted">
                {i.kind === 'person' || i.kind === 'answer' ? <IconPerson size={11} /> : null} {i.who}
              </span>
            </span>
            <span className="acc-amt mono">{i.amount !== null && i.amount !== 0n ? usdShort(i.amount) : ''}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- the books
function LinesTable({ e, lines }: { e: Entry; lines: readonly Line[] }) {
  const erp = erpLines(e, lines);
  return (
    <div className="acc-lines">
      <table className="entries">
        <caption className="muted">Our entry</caption>
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Dr</th>
            <th className="num">Cr</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineKey}>
              <td>
                <span className="mono">{l.account}</span> {ACCOUNT_NAME[l.account] ?? ''}
              </td>
              <td className="num mono">{l.debitCents > 0n ? usdShort(l.debitCents) : ''}</td>
              <td className="num mono">{l.creditCents > 0n ? usdShort(l.creditCents) : ''}</td>
            </tr>
          ))}
          {!lines.length && (
            <tr>
              <td colSpan={3} className="muted">Lines not loaded yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      {lines.length > 0 && (
        <table className="entries">
          <caption className="muted">As the ERP journal gets it</caption>
          <thead>
            <tr>
              <th>ERP account</th>
              <th className="num">Dr</th>
              <th className="num">Cr</th>
            </tr>
          </thead>
          <tbody>
            {erp.map((l, n) => (
              <tr key={n}>
                <td>
                  <span className="mono">{l.account}</span> <span className="muted">{l.note}</span>
                </td>
                <td className="num mono">{l.debit > 0n ? usdShort(l.debit) : ''}</td>
                <td className="num mono">{l.credit > 0n ? usdShort(l.credit) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function BookRow({ e, p, lines }: { e: Entry; p: Posting | undefined; lines: readonly Line[] }) {
  const race = useRace();
  const [open, setOpen] = useState(false);
  const s = statusOf(p);
  const amt = signedCents(e, lines);
  return (
    <li className="acc-book">
      <div className="acc-book-top">
        <StatusTag s={s} />
        <span className="acc-book-memo">{firstSentence(e.memo)}</span>
        <span className="mono acc-book-amt">{usdShort(amt)}</span>
      </div>
      <div className="acc-book-meta">
        <span className={e.capRelevant ? 'acc-cap' : 'acc-cap acc-cap--off'}>{e.capRelevant ? 'In the cap' : 'Outside the cap'}: {RECOGNITION_WORDS[e.recognition] ?? e.recognition}</span>
        {p?.erpEntryId && <span className="mono acc-erp">ERP {p.erpEntryId}</span>}
        {p && s === 'held' && <span className="acc-role">Review: {roleLabel(p.reviewRole)}</span>}
        {p && s !== 'held' && p.by && <span className="muted">by {p.by}</span>}
      </div>
      {p?.reason && <p className="acc-reason muted">{p.reason}</p>}
      {p && s === 'held' && (
        <div className="acc-actions">
          <ActButton label="Approve and post" busyLabel="Approving…" primary run={(by, at) => race.decidePosting({ entryKey: e.entryKey, status: 'approved', by, at })} title={`Approve as ${roleLabel(p.reviewRole)}: the desk posts it to the ERP`} />
          <ActButton label="Reject" busyLabel="Rejecting…" run={(by, at) => race.decidePosting({ entryKey: e.entryKey, status: 'rejected', by, at })} title="Keep it out of the ERP" />
        </div>
      )}
      <button type="button" className="acc-link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide Dr / Cr lines' : 'Dr / Cr lines'}
      </button>
      {open && <LinesTable e={e} lines={lines} />}
    </li>
  );
}

const GROUPS: { s: Status; title: string; empty?: string }[] = [
  { s: 'held', title: 'Held for review', empty: 'Nothing waits for a person.' },
  { s: 'approved', title: 'Approved, posting' },
  { s: 'failed', title: 'Failed' },
  { s: 'posted', title: 'Posted to the ERP', empty: 'Nothing posted yet.' },
  { s: 'rejected', title: 'Rejected' },
  { s: 'unrouted', title: 'Booked, not routed yet' },
];

function Books({ race, lines }: { race: RaceData; lines: Map<string, Line[]> }) {
  const posting = useMemo(() => new Map(race.postings.map((p) => [p.entryKey, p])), [race.postings]);
  const by = useMemo(() => {
    const m = new Map<Status, Entry[]>();
    for (const e of race.entries) {
      const s = statusOf(posting.get(e.entryKey));
      m.set(s, [...(m.get(s) ?? []), e]);
    }
    for (const list of m.values()) list.sort((a, b) => sortTime(b.at) - sortTime(a.at) || a.entryKey.localeCompare(b.entryKey));
    return m;
  }, [race.entries, posting]);

  const sum = (s: Status, capOnly = false) => (by.get(s) ?? []).filter((e) => !capOnly || e.capRelevant).reduce((t, e) => t + signedCents(e, lines.get(e.entryKey)), 0n);
  const held = by.get('held') ?? [];
  const roles = [...new Set(held.map((e) => posting.get(e.entryKey)?.reviewRole ?? ''))].filter(Boolean).map(roleLabel);

  return (
    <section className="acc-panel" aria-labelledby="acc-books-h">
      <header className="acc-head">
        <h2 id="acc-books-h">The books</h2>
        <span className="muted">{race.entries.length} race entries · ERP journal through the gateway key</span>
      </header>
      <dl className="acc-totals">
        <div>
          <dt>
            <IconApproved size={12} /> Posted
          </dt>
          <dd className="mono">{usdShort(sum('posted'))}</dd>
          <dd className="muted">{(by.get('posted') ?? []).length} entries</dd>
        </div>
        <div>
          <dt>
            <IconEntry size={12} /> Cap-relevant posted
          </dt>
          <dd className="mono">{usdShort(sum('posted', true))}</dd>
          <dd className="muted">counts against the cap</dd>
        </div>
        <div className={held.length ? 'acc-total--hold' : ''}>
          <dt>
            <IconWaiting size={12} /> Held
          </dt>
          <dd className="mono">{usdShort(sum('held'))}</dd>
          <dd className="muted">{held.length ? `${held.length} for ${roles.join(', ')}` : 'none'}</dd>
        </div>
        {(by.get('failed') ?? []).length > 0 && (
          <div className="acc-total--alert">
            <dt>
              <IconFlag size={12} /> Failed
            </dt>
            <dd className="mono">{usdShort(sum('failed'))}</dd>
            <dd className="muted">{(by.get('failed') ?? []).length} retried</dd>
          </div>
        )}
      </dl>
      {!race.entries.length && <p className="muted">No entries booked yet.</p>}
      {GROUPS.map((g) => {
        const list = by.get(g.s) ?? [];
        if (!list.length && !(g.empty && race.entries.length)) return null;
        return (
          <div key={g.s} className="acc-group">
            <h3>
              <StatusTag s={g.s} /> <span className="mono muted">{list.length} · {usdShort(sum(g.s))}</span>
            </h3>
            {!list.length && <p className="muted">{g.empty}</p>}
            <ul className="acc-books">
              {list.map((e) => (
                <BookRow key={e.entryKey} e={e} p={posting.get(e.entryKey)} lines={lines.get(e.entryKey) ?? []} />
              ))}
            </ul>
          </div>
        );
      })}
      <p className="muted acc-legend">
        Held: a crash line that waits for a person goes to the Financial Controller; $250k or more to the Head of Cost Cap (the cost cap desk's materiality); $1m or more to the CFO (finance K10); an FIA fine to the Head of Cost Cap, who confirms it is outside the cap. Everything else the desk posts itself. Spares and inventory sit on <span className="mono">capadj-</span> offset accounts in the ERP because its chart has no balance-sheet accounts.
      </p>
    </section>
  );
}

export function AccountingView() {
  const race = useRace();
  const lines = useMemo(() => {
    const m = new Map<string, Line[]>();
    for (const l of race.entryLines) m.set(l.entryKey, [...(m.get(l.entryKey) ?? []), l]);
    for (const list of m.values()) list.sort((a, b) => a.lineNo - b.lineNo);
    return m;
  }, [race.entryLines]);
  const feed = useMemo(() => buildFeed(race, lines), [race, lines]);
  return (
    <div className="acc">
      <Feed items={feed} />
      <Books race={race} lines={lines} />
    </div>
  );
}
