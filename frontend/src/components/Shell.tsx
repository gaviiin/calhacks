import { useEffect, useRef, useState } from 'react';
import { useSpacetimeDB } from 'spacetimedb/react';
import { useCostCap } from '../lib/costcap';
import { useEvidence } from '../lib/evidence';
import { useRace } from '../lib/race';
import { useRevenue } from '../lib/revenue';
import { fetchSeatCodes, sha256Hex, useSeat } from '../lib/seat';
import { useSeatConnection } from '../lib/seatConnection';
import { ReplayControl } from '../views/roles/ReplayControl';
import { IconPlug } from './icons';
import './shell.css';

export type View = 'overview' | 'instruments' | 'race' | 'replay' | 'inbox' | 'books' | 'cost-cap' | 'risk' | 'revenue' | 'evidence' | 'audit' | 'connect' | 'pitwall';

// The bar: the car (home), the books and the audit. One operator holds every seat, so there is no seat to pick; the
// services are six lamps. Everything else is still routable (#/instruments, #/day/<garage|strategy|accounting|cfo>,
// #/inbox, #/race, #/replay, #/risk, #/pitwall, #/cost-cap, #/revenue, #/evidence; Connect behind the plug).
export const NAV: { id: string; label: string; href: string; match: (view: View, arg: string | null) => boolean }[] = [
  { id: 'car', label: 'Car', href: '#/', match: (v, a) => (v === 'overview' && (!a || a === 'garage' || a === 'pitwall' || a === 'strategy')) || v === 'instruments' || v === 'race' || v === 'replay' },
  { id: 'books', label: 'Books', href: '#/books', match: (v, a) => v === 'books' || v === 'cost-cap' || v === 'revenue' || (v === 'overview' && (a === 'accounting' || a === 'cfo')) },
  { id: 'audit', label: 'Audit', href: '#/audit', match: (v) => v === 'audit' || v === 'evidence' || v === 'pitwall' },
];

export type SeatStatus = 'readonly' | 'connecting' | 'claiming' | 'seated' | 'no-code';

/** Takes the cost cap seat for this browser's identity when the person picks one. */
export function useSeatStatus(): SeatStatus {
  const { person } = useSeat();
  const cc = useCostCap();
  const seat = useSeatConnection();
  const tried = useRef<string>('');
  const [status, setStatus] = useState<SeatStatus>('connecting');

  useEffect(() => {
    const want = person.costCapRole;
    if (!want) return setStatus('readonly');
    const conn = seat.conn;
    if (!conn || !seat.identityHex || !cc.seatsReady) return setStatus('connecting');
    const held = cc.roles.find((r) => r.identity.toHexString() === seat.identityHex);
    if (held?.role === want) return setStatus('seated');
    const attempt = `${seat.identityHex}:${want}:${cc.invites.length}:${cc.roles.length}`;
    if (tried.current === attempt) return;
    tried.current = attempt;
    setStatus('claiming');
    let live = true; // a newer render (the role row arriving) supersedes this attempt
    void (async () => {
      const codes = (await fetchSeatCodes())?.seats[want] ?? [];
      const unused = new Set(cc.invites.filter((i) => !i.used && i.role === want).map((i) => i.code));
      for (const { code } of codes) {
        if (!live) return;
        if (unused.has(await sha256Hex(code))) {
          await conn.reducers.claimRole({ code }).catch(() => undefined);
          return; // the role row arrives through the subscription and flips us to seated
        }
      }
      if (live) setStatus('no-code');
    })();
    return () => {
      live = false;
    };
  }, [person.costCapRole, seat, cc.seatsReady, cc.roles, cc.invites]);

  return status;
}

const SERVICE_NAME: Record<string, string> = { openf1: 'OpenF1', jev: 'Jev', claude: 'Claude', erp: 'ERP', spacetimedb: 'SpacetimeDB', notify: 'Notify' };
const SERVICE_ORDER = ['openf1', 'spacetimedb', 'jev', 'claude', 'erp', 'notify'];
const SERVICE_WORD: Record<string, string> = { live: 'live', degraded: 'degraded', offline: 'offline', dry_run: 'dry run', not_configured: 'not configured' };
const SERVICE_LAMP: Record<string, string> = { live: 'live', degraded: 'wait', offline: 'bad', dry_run: 'off', not_configured: 'none' };

function Lamps() {
  const race = useRace();
  const costCap = useSpacetimeDB();
  const evidence = useEvidence();
  const revenue = useRevenue();
  const rows = race.health.slice().sort((a, b) => SERVICE_ORDER.indexOf(a.service) - SERVICE_ORDER.indexOf(b.service));
  const dbs = [
    { k: 'pit-wall', ok: evidence.connected },
    { k: 'cost-cap-desk', ok: costCap.isActive },
    { k: 'revenue api', ok: revenue.online },
  ];
  const title = [...rows.map((h) => `${SERVICE_NAME[h.service] ?? h.service}: ${SERVICE_WORD[h.status] ?? h.status}`), ...dbs.map((d) => `${d.k}: ${d.ok ? 'connected' : 'not reachable'}`)].join('\n');
  return (
    <span className="lamps" title={title} aria-label={title}>
      {rows.map((h) => (
        <span key={h.service} className={`lamp lamp--${SERVICE_LAMP[h.status] ?? 'auto'}`} />
      ))}
      {rows.length ? <span className="lamps-sep" /> : null}
      {dbs.map((d) => (
        <span key={d.k} className={`lamp ${d.ok ? 'lamp--ok' : 'lamp--bad'}`} />
      ))}
    </span>
  );
}

/** One operator, full control: this browser holds the CFO seat on pit-wall (the seat that may make every call on race
 * day). When it has none (a fresh browser, or after a reset), the dev server grants it, once per identity. */
function useOperatorSeat(): 'seated' | 'seating' | 'unavailable' {
  const race = useRace();
  const [tried, setTried] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const id = race.identityHex;
  const seated = !!race.mySeat;
  const attempt = id ? `${id}:${race.seats.length}` : null;
  useEffect(() => {
    if (!race.connected || !id || seated || !attempt || tried === attempt) return;
    setTried(attempt);
    fetch('/local/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ browserId: id }) })
      .then((r) => setFailed(!r.ok))
      .catch(() => setFailed(true));
  }, [race.connected, id, seated, attempt, tried]);
  return seated ? 'seated' : failed ? 'unavailable' : 'seating';
}

const OPERATOR_NOTE = {
  seated: 'This browser holds the CFO seat on pit-wall: every call on race day is yours, and each is on the record',
  seating: 'Taking the seat on pit-wall',
  unavailable: 'Could not take the seat: run make race-reset BROWSER_ID=<this browser>',
};

export function Shell({ view, arg }: { view: View; arg: string | null }) {
  const onHome = view === 'overview' && !arg;
  const seat = useOperatorSeat();
  return (
    <header className="shell glass--bar">
      <a className="brand" href="#/" aria-label="Anneal, the hardware module for Williams Racing">
        <span className="brandmark" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="brandword">ANNEAL</span>
        <span className="brand-div" aria-hidden />
        <small>Hardware module · Williams Racing</small>
      </a>
      <nav className="nav" aria-label="Views">
        {NAV.map((n) => {
          const on = n.match(view, arg);
          return (
            <a key={n.id} href={n.href} className={on ? 'nav-item nav-item--on' : 'nav-item'} aria-current={on ? 'page' : undefined}>
              {n.label}
            </a>
          );
        })}
      </nav>
      <div className="shell-right">
        {onHome ? <ReplayControl /> : null}
        <Lamps />
        <span className={`operator operator--${seat}`} title={OPERATOR_NOTE[seat]}>
          <span className="operator-dot" aria-hidden />
          Full control
        </span>
        <a className={`gear ${view === 'connect' ? 'gear--on' : ''}`} href="#/connect" aria-label="Connections and settings" title="Connections and settings">
          <IconPlug size={15} />
        </a>
      </div>
    </header>
  );
}
