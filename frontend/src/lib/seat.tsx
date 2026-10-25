import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// The people at the desk. A person takes a seat; the seat decides what the browser may do. On the
// cost cap desk the seat is a role row held by this browser's own SpacetimeDB identity (claimed with
// a one-time invite code), so the module's roles matrix judges every click. On the revenue desk the
// seat names the approver the ledger's K11 check sees.

export type SeatId = 'observer' | 'head' | 'controller' | 'cfo' | 'cos';

export interface Person {
  id: SeatId;
  name: string;
  title: string;
  /** cost cap desk role this seat claims, or null: read-only there */
  costCapRole: 'human_head_of_cost_cap' | 'human_controller' | null;
  /** revenue desk approver and role, or null: cannot approve there */
  revenue: { approver: string; role: string } | null;
}

export const PEOPLE: Record<SeatId, Person> = {
  observer: { id: 'observer', name: 'Observer', title: 'Read only', costCapRole: null, revenue: null },
  head: {
    id: 'head',
    name: 'Morgan Hale',
    title: 'Head of Cost Cap',
    costCapRole: 'human_head_of_cost_cap',
    revenue: null,
  },
  controller: {
    id: 'controller',
    name: 'Dana Okafor',
    title: 'Financial Controller',
    costCapRole: 'human_controller',
    revenue: { approver: 'dana', role: 'controller' },
  },
  cfo: {
    id: 'cfo',
    name: 'Priya Raman',
    title: 'CFO',
    costCapRole: null,
    revenue: { approver: 'priya', role: 'cfo' },
  },
  cos: {
    id: 'cos',
    name: 'Sam Reyes',
    title: 'Chief of Staff',
    costCapRole: null,
    revenue: null,
  },
};

export const HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? 'ws://localhost:3000';
export const COST_CAP_DB = import.meta.env.VITE_COST_CAP_DB ?? 'cost-cap-desk';
export const EVIDENCE_DB = import.meta.env.VITE_EVIDENCE_DB ?? 'pit-wall';

const tokenKey = (db: string, who: string) => `pitwall:${HOST}/${db}/token:${who}`;

export function readToken(db: string, who: string): string | undefined {
  try {
    return localStorage.getItem(tokenKey(db, who)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveToken(db: string, who: string, token: string): void {
  try {
    localStorage.setItem(tokenKey(db, who), token);
  } catch {
    // blocked storage: a fresh identity next load, and the seat is taken again
  }
}

export function forgetToken(db: string, who: string): void {
  try {
    localStorage.removeItem(tokenKey(db, who));
  } catch {
    // nothing stored
  }
}

const SEAT_KEY = 'pitwall:seat';

function initialSeat(): SeatId {
  try {
    const s = localStorage.getItem(SEAT_KEY) as SeatId | null;
    return s && s in PEOPLE ? s : 'observer';
  } catch {
    return 'observer';
  }
}

interface SeatState {
  seat: SeatId;
  person: Person;
  setSeat: (s: SeatId) => void;
}

const SeatContext = createContext<SeatState | null>(null);

export function SeatProvider({ children }: { children: ReactNode }) {
  const [seat, setSeatState] = useState<SeatId>(initialSeat);
  const setSeat = useCallback((s: SeatId) => {
    setSeatState(s);
    try {
      localStorage.setItem(SEAT_KEY, s);
    } catch {
      // per-viewer convenience only
    }
  }, []);
  const value = useMemo(() => ({ seat, person: PEOPLE[seat], setSeat }), [seat, setSeat]);
  return <SeatContext.Provider value={value}>{children}</SeatContext.Provider>;
}

export function useSeat(): SeatState {
  const v = useContext(SeatContext);
  if (!v) throw new Error('useSeat outside SeatProvider');
  return v;
}

// ---------------------------------------------------------------- seat codes

export interface SeatCodes {
  db_epoch: string;
  seats: Record<string, { code: string; label: string }[]>;
}

export async function fetchSeatCodes(): Promise<SeatCodes | null> {
  try {
    const r = await fetch('/local/seats', { cache: 'no-store' });
    return r.ok ? ((await r.json()) as SeatCodes) : null;
  } catch {
    return null;
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
