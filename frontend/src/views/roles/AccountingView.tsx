import { Fragment, useMemo, useState } from 'react';
import { IconPerson } from '../../components/icons';
import { parseJson, usdShort } from '../../lib/format';
import { useRace, type RaceData } from '../../lib/race';
import { TEAM, carLabel, eventDetail, kindMeta, sortTime, utcClock } from '../../lib/raceModel';
import { RECOGNITION_WORDS, signedCents } from '../raceday/AccountPanel';
import { ActButton, roleLabel } from '../raceday/shared';
import { Axis, Figure, Panel, Pill, Stack, type Tone } from './kit';
import './accounting.css';

// Accounting: for the financial controller and the accountants. What changed in the books, what is stuck, and why.
// Top: posted / held / cap-relevant posted and the books as one bar. Then the weekend axis (booked vs posted),
// the ledger (held rows first, with Approve / Reject), and the live feed, one line per item.
//
// race/erp.py decides post or hold: a crash line that waits for a person goes to the controller; $250k or more to
// the Head of Cost Cap; $1m or more to the CFO; an FIA fine to the Head of Cost Cap. A rejected entry never posts.

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

// ---------------------------------------------------------------- status: Pill (icon + word), and a bar tone
type Status = 'posted' | 'held' | 'approved' | 'rejected' | 'failed' | 'unrouted';
type BarTone = Tone | 'navy' | 'sky' | 'gray';
const STATUS: Record<Status, { word: string; long: string; tone: Tone; bar: BarTone; rank: number }> = {
  held: { word: 'Held', long: 'Held for review', tone: 'wait', bar: 'wait', rank: 0 },
  failed: { word: 'Failed', long: 'Failed, will retry', tone: 'bad', bar: 'bad', rank: 1 },
  approved: { word: 'Approved', long: 'Approved, posting', tone: 'ok', bar: 'sky', rank: 2 },
  unrouted: { word: 'Not routed', long: 'Booked, not routed yet', tone: 'neutral', bar: 'neutral', rank: 3 },
  posted: { word: 'Posted', long: 'Posted to the ERP', tone: 'ok', bar: 'navy', rank: 4 },
  rejected: { word: 'Rejected', long: 'Rejected, kept out of the ERP', tone: 'neutral', bar: 'gray', rank: 5 },
};
const statusOf = (p: Posting | undefined): Status => (p && p.status in STATUS ? (p.status as Status) : 'unrouted');
const StatusPill = ({ s, title }: { s: Status; title?: string }) => (
  <Pill tone={STATUS[s].tone} title={title ?? STATUS[s].long}>
    {STATUS[s].word}
  </Pill>
);

const firstSentence = (memo: string) => {
  const m = /^(.*?)( - counts|[.:]\s)/.exec(memo);
  return (m ? m[1]! : memo).trim();
};
const personOf = (by: string) => by.replace(/^person:/, '').replace(/^race_desk after /, '');
const abs = (v: bigint) => (v < 0n ? -v : v);
const money = (v: bigint) => Number(abs(v)) / 100;

function wallClock(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// ---------------------------------------------------------------- the feed: one line per thing the desk learned
type FeedKind = 'race' | 'belief' | 'person' | 'answer' | 'entry' | 'books';
interface FeedItem {
  key: string;
  kind: FeedKind;
  order: number; // when the desk learned it (system time)
  raceAt: string;
  who: string;
  pill: { tone: Tone; word: string };
  head: string;
  text: string;
  more: string; // the long version, on hover
  amount: bigint | null;
}

const FILTERS: { id: string; label: string; kinds: FeedKind[] }[] = [
  { id: 'all', label: 'All', kinds: ['race', 'belief', 'person', 'answer', 'entry', 'books'] },
  { id: 'people', label: 'People', kinds: ['person', 'answer'] },
  { id: 'books', label: 'Books', kinds: ['entry', 'books'] },
  { id: 'race', label: 'Race', kinds: ['race', 'belief'] },
];

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
  const entryByKey = new Map(race.entries.map((e) => [e.entryKey, e]));
  const cost = new Map<string, bigint>();
  for (const f of race.effects) if (f.kind === 'cost' && f.status !== 'corrected') cost.set(f.eventKey, (cost.get(f.eventKey) ?? 0n) + f.midCents);

  for (const e of race.events) {
    const ours = e.driverNumber ? e.teamName === TEAM : false;
    if (!ours || !(MONEY_KINDS.has(e.kind) || cost.has(e.eventKey))) continue;
    const detail = eventDetail(e);
    const who = e.source.startsWith('openf1') ? 'OpenF1 tape' : e.source;
    out.push({
      key: `ev:${e.eventKey}`, kind: 'race', order: sortTime(e.ingestedAt), raceAt: e.at, who,
      pill: { tone: 'neutral', word: 'Race' },
      head: `${carLabel(e.driverNumber)} L${e.lap} ${kindMeta(e.kind).label}`, text: detail, more: detail,
      amount: cost.get(e.eventKey) ?? null,
    });
  }
  for (const b of race.beliefs) {
    const inc = incByKey.get(b.incidentKey);
    out.push({
      key: `bel:${b.beliefKey}`, kind: 'belief', order: sortTime(b.recordedAt), raceAt: b.at, who: 'incident log',
      pill: { tone: 'neutral', word: 'Incident' },
      head: `${inc ? carLabel(inc.driverNumber) : 'Incident'} v${b.version} ${b.status}`, text: b.cause, more: b.cause,
      amount: null,
    });
  }
  for (const a of race.actions) {
    if (!a.decidedBy.startsWith('person:')) continue;
    const d = parseJson<Record<string, unknown>>(a.detailJson, {});
    const chosen = typeof d.chosen === 'string' ? d.chosen : '';
    const opts = Array.isArray(d.options) ? (d.options as { id?: string; label?: string; cost_cents?: unknown }[]) : [];
    const pick = opts.find((o) => o.id === chosen);
    const text = `${a.title}${chosen ? ` → ${pick?.label ?? chosen}` : ''}`;
    out.push({
      key: `act:${a.actionKey}`, kind: 'person', order: sortTime(a.updatedAt), raceAt: '', who: personOf(a.decidedBy),
      pill: { tone: 'ok', word: 'Decision' },
      head: a.status.replace(/_/g, ' '), text, more: text,
      amount: midOf(pick ? pick.cost_cents : d.cost_cents),
    });
  }
  for (const q of race.questions) {
    if (q.status === 'open') continue;
    const ans = parseJson<{ option?: string; defaulted?: boolean }>(q.answerJson, {});
    const opts = parseJson<{ id?: string; label?: string }[]>(q.optionsJson, []);
    const label = opts.find((o) => o.id === ans.option)?.label ?? ans.option ?? '';
    const inc = incByKey.get(q.incidentKey);
    // An answer carries no time of its own; the desk re-decides the incident when it applies one.
    const after = race.beliefs.filter((b) => b.incidentKey === q.incidentKey).reduce((m, b) => Math.max(m, sortTime(b.recordedAt)), 0);
    const defaulted = q.status === 'defaulted';
    out.push({
      key: `q:${q.questionKey}`, kind: 'answer', order: after || sortTime(q.createdAt), raceAt: q.createdAt,
      who: defaulted ? 'deadline (default)' : q.answeredBy || roleLabel(q.routeRole),
      pill: defaulted ? { tone: 'wait', word: 'Default' } : { tone: 'ok', word: 'Answer' },
      head: inc ? carLabel(inc.driverNumber) : 'Question', text: `→ ${label || 'neither'}`, more: `${q.prompt} → ${label || 'neither'}`,
      amount: q.expectedLossCents ? q.expectedLossCents : null,
    });
  }
  const posting = new Map(race.postings.map((p) => [p.entryKey, p]));
  for (const e of race.entries) {
    const ev = parseJson<string[]>(e.evidenceJson, []).map((k) => evByKey.get(k)).find(Boolean);
    const p = posting.get(e.entryKey);
    const rec = RECOGNITION_WORDS[e.recognition] ?? e.recognition;
    out.push({
      key: `en:${e.entryKey}`, kind: 'entry', order: ev ? sortTime(ev.ingestedAt) : p ? sortTime(p.at) - 1 : sortTime(e.at), raceAt: e.at, who: 'race desk',
      pill: { tone: 'info', word: 'Booked' },
      head: firstSentence(e.memo), text: rec, more: `${e.memo} (${rec})`,
      amount: signedCents(e, lines.get(e.entryKey)),
    });
  }
  for (const p of race.postings) {
    const s = statusOf(p);
    const e = entryByKey.get(p.entryKey);
    const head =
      s === 'posted' ? p.erpEntryId :
      s === 'held' ? `for ${roleLabel(p.reviewRole)}` :
      s === 'failed' ? 'not posted' :
      s === 'rejected' ? 'kept out' : 'posting';
    out.push({
      key: `po:${p.entryKey}`, kind: 'books', order: sortTime(p.at), raceAt: '', who: p.by.replace(/^race_desk after /, 'desk, after '),
      pill: { tone: STATUS[s].tone, word: STATUS[s].word },
      head, text: e ? firstSentence(e.memo) : '', more: p.reason,
      amount: p.amountCents,
    });
  }
  return out.sort((a, b) => b.order - a.order || a.key.localeCompare(b.key));
}

function Segmented({ value, options, onChange, label }: { value: string; options: { id: string; label: string; n?: number }[]; onChange: (id: string) => void; label: string }) {
  return (
    <div className="acc-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className={o.id === value ? 'acc-seg--on' : ''} aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
          {o.n !== undefined && <span className="acc-seg-n">{o.n}</span>}
        </button>
      ))}
    </div>
  );
}

function Feed({ items, loading }: { items: FeedItem[]; loading: boolean }) {
  const [filter, setFilter] = useState('all');
  const kinds = new Set(FILTERS.find((f) => f.id === filter)!.kinds);
  const shown = items.filter((i) => kinds.has(i.kind)).slice(0, 200);
  return (
    <Panel title="As it happens" className="acc-feed-panel" aside={<Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS} />}>
      {loading && <div className="acc-skel" aria-label="Loading" />}
      {!loading && !shown.length && <p className="acc-empty">Race events, decisions and postings appear here as the replay runs.</p>}
      <ol className="acc-feed">
        {shown.map((i) => (
          <li
            key={i.key}
            className={`acc-item acc-item--${i.kind}`}
            title={[i.more, `${i.who}${i.raceAt ? ` · race ${utcClock(i.raceAt)} UTC` : ''}`].filter(Boolean).join('\n')}
          >
            <span className="acc-time">{wallClock(i.order)}</span>
            <span className="acc-kind">
              <Pill tone={i.pill.tone}>{i.pill.word}</Pill>
            </span>
            <span className="acc-what">
              {(i.kind === 'person' || (i.kind === 'answer' && i.pill.word === 'Answer')) && (
                <span className="acc-who">
                  <IconPerson size={11} />
                  {i.who}
                </span>
              )}
              <b className={i.kind === 'books' && i.pill.word === 'Posted' ? 'acc-mono' : ''}>{i.head}</b> <span className="acc-text">{i.text}</span>
            </span>
            <span className="acc-amt">{i.amount !== null && i.amount !== 0n ? usdShort(i.amount) : ''}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

// ---------------------------------------------------------------- the weekend: when entries were booked and posted
function Weekend({ race, posting }: { race: RaceData; posting: Map<string, Posting> }) {
  const view = useMemo(() => {
    const times = race.events.map((e) => sortTime(e.at)).filter(Boolean);
    if (!times.length || !race.entries.length) return null;
    const from = Math.min(...times);
    const to = Math.max(...times);
    // A posting carries the desk's clock; place it at the race moment the desk had reached when it posted.
    const tape = race.events.map((e) => [sortTime(e.ingestedAt), sortTime(e.at)] as const).filter(([a, b]) => a && b).sort((a, b) => a[0] - b[0]);
    const raceMoment = (sys: number) => {
      let at = tape[0]?.[1] ?? from;
      for (const [ing, r] of tape) {
        if (ing > sys) break;
        at = Math.max(at, r);
      }
      return at;
    };
    const entryAt = new Map(race.entries.map((e) => [e.entryKey, sortTime(e.at) || from]));
    const booked = race.entries.map((e) => {
      const s = statusOf(posting.get(e.entryKey));
      return { t: entryAt.get(e.entryKey)!, tone: STATUS[s].bar, big: abs(e.amountCents) >= 25_000_000n, label: `${utcClock(e.at)} UTC · ${firstSentence(e.memo)} · ${usdShort(e.amountCents)} · ${STATUS[s].long}` };
    });
    const posted = race.postings
      .filter((p) => p.status !== 'held')
      .map((p) => {
        const s = statusOf(p);
        const t = Math.max(raceMoment(sortTime(p.at)), entryAt.get(p.entryKey) ?? from);
        const tone: BarTone = s === 'posted' ? 'navy' : STATUS[s].bar;
        return { t, tone, big: abs(p.amountCents) >= 25_000_000n, label: `${wallClock(sortTime(p.at))} · ${STATUS[s].long}${p.erpEntryId ? ` ${p.erpEntryId}` : ''} · ${usdShort(p.amountCents)}` };
      });
    // Time scale: a tick every 1/2/3/6/12/24 hours, whichever keeps it to eight or fewer; a day boundary names the day.
    const HOUR = 3_600_000;
    const span = to - from || 1;
    const step = [1, 2, 3, 6, 12, 24].map((h) => h * HOUR).find((st) => span / st <= 8) ?? 24 * HOUR;
    const dayWord = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const ticks: { left: number; label: string }[] = [];
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
      const midnight = t % (24 * HOUR) === 0;
      ticks.push({ left: ((t - from) / span) * 100, label: midnight || step >= 24 * HOUR ? dayWord(t) : utcClock(new Date(t).toISOString()).slice(0, 5) });
    }
    const oneDay = dayWord(from) === dayWord(to);
    const scaleLabel = oneDay ? dayWord(from) : 'UTC';
    return { from, to, booked, posted, ticks, scaleLabel };
  }, [race.events, race.entries, race.postings, posting]);

  if (!view) return null;
  return (
    <Panel
      title="Across the weekend"
      className="acc-weekend"
      aside={
        <span className="acc-weekend-key">
          <span><i className="k-dot k-seg--navy" />posted</span>
          <span><i className="k-dot k-seg--sky" />approved</span>
          <span><i className="k-dot k-seg--wait" />held</span>
          <span><i className="k-dot k-seg--bad" />failed</span>
        </span>
      }
    >
      <div className="acc-axes">
        <span className="acc-axis-label">Booked</span>
        <Axis from={view.from} to={view.to} marks={view.booked} height={24} />
        <span className="acc-axis-label">Posted</span>
        <Axis from={view.from} to={view.to} marks={view.posted} height={24} />
        <span className="acc-axis-label acc-axis-label--scale">{view.scaleLabel}</span>
        <div className="acc-ticks" aria-hidden>
          {view.ticks.map((t) => (
            <span key={t.left} className={t.left > 88 ? 'acc-tick--end' : undefined} style={{ left: `${t.left}%` }}>
              {t.label}
            </span>
          ))}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- the ledger
function LinesTable({ e, lines }: { e: Entry; lines: readonly Line[] }) {
  if (!lines.length) return <p className="acc-empty">Lines not loaded yet.</p>;
  const erp = erpLines(e, lines);
  const table = (caption: string, rows: { k: string; acct: string; note: string; dr: bigint; cr: bigint }[]) => (
    <table className="acc-jl">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th>Account</th>
          <th className="num">Dr</th>
          <th className="num">Cr</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.k}>
            <td title={r.note}>
              <span className="acc-mono">{r.acct}</span> <span className="acc-note">{r.note}</span>
            </td>
            <td className="num">{r.dr > 0n ? usdShort(r.dr) : ''}</td>
            <td className="num">{r.cr > 0n ? usdShort(r.cr) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div className="acc-lines">
      {table('Our entry', lines.map((l) => ({ k: l.lineKey, acct: l.account, note: ACCOUNT_NAME[l.account] ?? '', dr: l.debitCents, cr: l.creditCents })))}
      {table('ERP journal', erp.map((l, n) => ({ k: String(n), acct: l.account, note: l.note, dr: l.debit, cr: l.credit })))}
    </div>
  );
}

function AccountChips({ lines }: { lines: readonly Line[] }) {
  const dr = [...new Set(lines.filter((l) => l.debitCents > 0n).map((l) => l.account))];
  const cr = [...new Set(lines.filter((l) => l.creditCents > 0n).map((l) => l.account))];
  if (!dr.length && !cr.length) return <span className="acc-dim">—</span>;
  return (
    <span className="acc-chips">
      {dr.map((a) => (
        <span key={`d${a}`} className="acc-chip" title={`Dr ${a} ${ACCOUNT_NAME[a] ?? ''}`}>
          <i>Dr</i>
          {a}
        </span>
      ))}
      {cr.map((a) => (
        <span key={`c${a}`} className="acc-chip acc-chip--cr" title={`Cr ${a} ${ACCOUNT_NAME[a] ?? ''}`}>
          <i>Cr</i>
          {a}
        </span>
      ))}
    </span>
  );
}

function LedgerRow({ e, p, lines }: { e: Entry; p: Posting | undefined; lines: readonly Line[] }) {
  const race = useRace();
  const [open, setOpen] = useState(false);
  const s = statusOf(p);
  const amt = signedCents(e, lines);
  const rec = RECOGNITION_WORDS[e.recognition] ?? e.recognition;
  const detailId = `acc-d-${e.entryKey}`;
  return (
    <Fragment>
      <tr className={`acc-row acc-row--${s} ${open ? 'acc-row--open' : ''}`}>
        <td className="acc-c-tog">
          <button type="button" className="acc-tog" aria-expanded={open} aria-controls={detailId} aria-label={open ? 'Hide lines and reason' : 'Show lines and reason'} onClick={() => setOpen((o) => !o)}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </td>
        <td className="acc-c-status">
          <StatusPill s={s} title={p?.reason || STATUS[s].long} />
        </td>
        <td className="acc-c-entry" title={`${e.memo}\n${rec}${p?.reason ? `\n${p.reason}` : ''}`}>
          <span className="acc-memo">{firstSentence(e.memo)}</span>
          {!e.capRelevant && <span className="acc-offcap">off cap</span>}
        </td>
        <td className="acc-c-acct">
          <AccountChips lines={lines} />
        </td>
        <td className="acc-c-amt">{usdShort(amt)}</td>
        <td className="acc-c-erp">
          {p?.erpEntryId ? (
            <span className="acc-mono acc-erp">{p.erpEntryId}</span>
          ) : p && (s === 'held' || s === 'approved') && p.reviewRole ? (
            <Pill tone="neutral" title={`${s === 'held' ? 'Waits for' : 'Approved by'} ${roleLabel(p.reviewRole)}: ${p.reason}`}>
              <IconPerson size={12} />
              {roleLabel(p.reviewRole)}
            </Pill>
          ) : (
            <span className="acc-dim">—</span>
          )}
        </td>
        <td className="acc-c-act">
          {p && s === 'held' && (
            <span className="acc-actions">
              <ActButton label="Approve" busyLabel="Approving…" primary run={(by, at) => race.decidePosting({ entryKey: e.entryKey, status: 'approved', by, at })} title={`Approve as ${roleLabel(p.reviewRole)}: the desk posts it to the ERP`} />
              <ActButton label="Reject" busyLabel="Rejecting…" run={(by, at) => race.decidePosting({ entryKey: e.entryKey, status: 'rejected', by, at })} title="Keep it out of the ERP" />
            </span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="acc-detail" id={detailId}>
          <td colSpan={7}>
            <dl className="acc-facts">
              <div>
                <dt>Why</dt>
                <dd>{p?.reason || 'Not routed to the ERP yet.'}</dd>
              </div>
              <div>
                <dt>Cap</dt>
                <dd>{e.capRelevant ? 'In the cap' : 'Outside the cap'}: {rec}</dd>
              </div>
              {p?.by && (
                <div>
                  <dt>By</dt>
                  <dd>{p.by}</dd>
                </div>
              )}
            </dl>
            <LinesTable e={e} lines={lines} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function Ledger({ race, lines, posting, loading }: { race: RaceData; lines: Map<string, Line[]>; posting: Map<string, Posting>; loading: boolean }) {
  const [show, setShow] = useState('all');
  const rows = useMemo(
    () =>
      race.entries
        .map((e) => ({ e, s: statusOf(posting.get(e.entryKey)) }))
        .sort((a, b) => STATUS[a.s].rank - STATUS[b.s].rank || sortTime(b.e.at) - sortTime(a.e.at) || a.e.entryKey.localeCompare(b.e.entryKey)),
    [race.entries, posting]
  );
  const count = (s: Status) => rows.filter((r) => r.s === s).length;
  const shown = rows.filter((r) => show === 'all' || r.s === show);
  const options = [
    { id: 'all', label: 'All', n: rows.length },
    { id: 'held', label: 'Held', n: count('held') },
    { id: 'posted', label: 'Posted', n: count('posted') },
    ...(['approved', 'failed', 'rejected', 'unrouted'] as Status[]).filter((s) => count(s)).map((s) => ({ id: s, label: STATUS[s].word, n: count(s) })),
  ];
  return (
    <Panel title="The books" className="acc-ledger" aside={<Segmented label="Show entries" value={show} onChange={setShow} options={options} />}>
      {loading && <div className="acc-skel" aria-label="Loading" />}
      {!loading && !rows.length && <p className="acc-empty">No entries booked yet. Each crash line the desk books lands here, posted or held.</p>}
      {rows.length > 0 && (
        <div className="acc-table-wrap">
          <table className="acc-table">
            <thead>
              <tr>
                <th className="acc-c-tog">
                  <span className="acc-sr">Details</span>
                </th>
                <th className="acc-c-status">Status</th>
                <th className="acc-c-entry">Entry</th>
                <th className="acc-c-acct">Dr / Cr</th>
                <th className="acc-c-amt">Amount</th>
                <th className="acc-c-erp">ERP id / review</th>
                <th className="acc-c-act">
                  <span className="acc-sr">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ e }) => (
                <LedgerRow key={e.entryKey} e={e} p={posting.get(e.entryKey)} lines={lines.get(e.entryKey) ?? []} />
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={7} className="acc-empty">
                    None {show === 'held' ? 'waiting for a person' : 'here'}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <details className="acc-basis">
        <summary>Basis</summary>
        <table>
          <tbody>
            <tr>
              <th>Crash line waits for a person</th>
              <td>Financial Controller</td>
            </tr>
            <tr>
              <th>$250k or more (cost cap materiality)</th>
              <td>Head of Cost Cap</td>
            </tr>
            <tr>
              <th>$1m or more (finance K10)</th>
              <td>CFO</td>
            </tr>
            <tr>
              <th>FIA fine, outside the cap</th>
              <td>Head of Cost Cap</td>
            </tr>
            <tr>
              <th>Everything else</th>
              <td>Desk posts it</td>
            </tr>
          </tbody>
        </table>
        <p>
          Spares and inventory sit on <span className="acc-mono">capadj-</span> offset accounts: the ERP chart has no balance-sheet accounts.
        </p>
      </details>
    </Panel>
  );
}

// ---------------------------------------------------------------- the top strip
function Summary({ race, lines, posting }: { race: RaceData; lines: Map<string, Line[]>; posting: Map<string, Posting> }) {
  const totals = useMemo(() => {
    const amt = new Map<Status, bigint>();
    const n = new Map<Status, number>();
    let capPosted = 0n;
    let capHeld = 0n;
    for (const e of race.entries) {
      const s = statusOf(posting.get(e.entryKey));
      const v = signedCents(e, lines.get(e.entryKey));
      amt.set(s, (amt.get(s) ?? 0n) + v);
      n.set(s, (n.get(s) ?? 0) + 1);
      if (e.capRelevant && s === 'posted') capPosted += v;
      if (e.capRelevant && s === 'held') capHeld += v;
    }
    const heldRoles = [...new Set(race.entries.filter((e) => statusOf(posting.get(e.entryKey)) === 'held').map((e) => roleLabel(posting.get(e.entryKey)!.reviewRole)).filter(Boolean))];
    return { amt, n, capPosted, capHeld, heldRoles };
  }, [race.entries, lines, posting]);
  const a = (s: Status) => totals.amt.get(s) ?? 0n;
  const n = (s: Status) => totals.n.get(s) ?? 0;
  const order: Status[] = ['posted', 'approved', 'held', 'failed', 'unrouted', 'rejected'];
  const parts = order.filter((s) => n(s) > 0).map((s) => ({ label: STATUS[s].word, value: money(a(s)), tone: STATUS[s].bar }));
  const booked = order.reduce((t, s) => t + a(s), 0n);
  return (
    <section className="k-panel acc-summary" aria-label="The books at a glance">
      <div className="acc-figs">
        <Figure size="lg" label="Posted to ERP" value={usdShort(a('posted'))} sub={`${n('posted')} entries`} />
        <Figure
          size="lg"
          label="Held for review"
          value={usdShort(a('held'))}
          delta={n('held') ? `${n('held')} waiting` : 'none waiting'}
          deltaTone={n('held') ? 'wait' : 'neutral'}
          sub={totals.heldRoles.length ? totals.heldRoles.join(' · ') : undefined}
        />
        <Figure size="lg" label="Cap-relevant posted" value={usdShort(totals.capPosted)} sub={totals.capHeld ? `${usdShort(totals.capHeld)} more held` : 'none held'} />
        {n('failed') > 0 && <Figure size="lg" label="Failed" value={usdShort(a('failed'))} delta={`${n('failed')} retrying`} deltaTone="bad" />}
        <Figure label="Booked" value={usdShort(booked)} sub={`${race.entries.length} entries`} />
      </div>
      {race.entries.length > 0 ? <Stack parts={parts} height={12} /> : <div className="acc-stack-empty" />}
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
  const posting = useMemo(() => new Map(race.postings.map((p) => [p.entryKey, p])), [race.postings]);
  const feed = useMemo(() => buildFeed(race, lines), [race, lines]);
  const loading = !race.connected && !race.entries.length && !race.events.length;
  return (
    <div className="acc">
      <Summary race={race} lines={lines} posting={posting} />
      <Weekend race={race} posting={posting} />
      <div className="acc-main">
        <Ledger race={race} lines={lines} posting={posting} loading={loading} />
        <Feed items={feed} loading={loading} />
      </div>
    </div>
  );
}
