import { useEffect, useRef, useState } from 'react';
import { useSpacetimeDB } from 'spacetimedb/react';
import { useCostCap } from '../lib/costcap';
import { useEvidence } from '../lib/evidence';
import { useRevenue } from '../lib/revenue';
import { PEOPLE, fetchSeatCodes, sha256Hex, useSeat, type SeatId } from '../lib/seat';
import { useSeatConnection } from '../lib/seatConnection';
import { IconLive, IconPlug } from './icons';

export type View = 'overview' | 'race' | 'replay' | 'inbox' | 'books' | 'cost-cap' | 'risk' | 'revenue' | 'evidence' | 'audit' | 'connect' | 'pitwall';

// Four tabs keep the race-day flow in front. Everything else is still routable: #/race (the full live desk),
// #/replay, #/risk, #/pitwall (the old overview), #/cost-cap, #/revenue, #/evidence; Connect sits behind the gear.
const NAV: { id: View; label: string }[] = [
  { id: 'overview', label: 'Race day' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'books', label: 'Books' },
  { id: 'audit', label: 'Audit' },
];

const NAV_OF: Partial<Record<View, View>> = { race: 'overview', 'cost-cap': 'books', revenue: 'books', evidence: 'audit' };

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

const SEAT_NOTE: Record<SeatStatus, string> = {
  readonly: 'read only on the cost cap desk',
  connecting: 'connecting',
  claiming: 'taking the seat',
  seated: 'seat held by this browser',
  'no-code': 'no unused seat code: run make bootstrap',
};

function Source({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`source ${ok ? 'source--ok' : 'source--down'}`} title={`${label}: ${ok ? 'live' : 'not reachable'}`}>
      <IconLive size={12} />
      {label}
    </span>
  );
}

export function Shell({ view, go, inboxCount, status }: { view: View; go: (v: View) => void; inboxCount: number; status: SeatStatus }) {
  const { seat, setSeat } = useSeat();
  const costCap = useSpacetimeDB();
  const evidence = useEvidence();
  const revenue = useRevenue();

  return (
    <header className="shell">
      <a className="brand" href="#/" onClick={() => go('overview')} aria-label="Pit Wall, race-day finance for Williams Racing">
        <span className="brandmark">PW</span>
        <span>
          <span className="brandword">
            PIT <span>WALL</span>
          </span>
          <small>WILLIAMS RACING · RACE-DAY FINANCE</small>
        </span>
      </a>
      <nav className="nav" aria-label="Desks">
        {NAV.map((n) => (
          <a
            key={n.id}
            href={`#/${n.id === 'overview' ? '' : n.id}`}
            className={(NAV_OF[view] ?? view) === n.id ? 'nav-item nav-item--on' : 'nav-item'}
            aria-current={(NAV_OF[view] ?? view) === n.id ? 'page' : undefined}
          >
            {n.label}
            {n.id === 'inbox' && inboxCount > 0 && <span className="nav-count">{inboxCount}</span>}
          </a>
        ))}
      </nav>
      <div className="shell-right">
        <a className={`gear ${view === 'connect' ? 'gear--on' : ''}`} href="#/connect" aria-label="Connections and settings" title="Connections and settings">
          <IconPlug size={16} />
        </a>
        <div className="sources" aria-label="Live sources">
          <Source ok={costCap.isActive} label="cost-cap-desk" />
          <Source ok={evidence.connected} label="pit-wall" />
          <Source ok={revenue.online} label="revenue api" />
        </div>
        <label className="seat">
          <span className="seat-label">Seat</span>
          <select value={seat} onChange={(e) => setSeat(e.target.value as SeatId)}>
            {(Object.keys(PEOPLE) as SeatId[]).map((id) => (
              <option key={id} value={id}>
                {id === 'observer' ? 'Observer' : `${PEOPLE[id].name} · ${PEOPLE[id].title}`}
              </option>
            ))}
          </select>
          <span className={`seat-note seat-note--${status}`}>{SEAT_NOTE[status]}</span>
        </label>
      </div>
    </header>
  );
}
