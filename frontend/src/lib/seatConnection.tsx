import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DbConnection as CostCapConnection } from '../cost_cap_bindings';
import { COST_CAP_DB, HOST, readToken, saveToken, useSeat } from './seat';

// The seat's own connection to cost-cap-desk, used only to call reducers. Reading goes through the
// shared read-only subscription; the SDK's React provider pools connections by host and database
// and keeps the live one whatever token a new builder carries, so a seat's identity is held here,
// built directly, one connection per seat, closed when the person changes seats.

export interface SeatConnection {
  conn: CostCapConnection | null;
  identityHex: string | null;
}

const Ctx = createContext<SeatConnection>({ conn: null, identityHex: null });

export function SeatConnectionProvider({ children }: { children: ReactNode }) {
  const { seat, person } = useSeat();
  const [state, setState] = useState<SeatConnection>({ conn: null, identityHex: null });

  useEffect(() => {
    setState({ conn: null, identityHex: null });
    if (!person.costCapRole) return;
    let open = true;
    const conn = CostCapConnection.builder()
      .withUri(HOST)
      .withDatabaseName(COST_CAP_DB)
      .withToken(readToken(COST_CAP_DB, seat))
      .onConnect((c, identity, token) => {
        saveToken(COST_CAP_DB, seat, token);
        if (open) setState({ conn: c, identityHex: identity.toHexString() });
      })
      .build();
    return () => {
      open = false;
      conn.disconnect();
    };
  }, [seat, person.costCapRole]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useSeatConnection(): SeatConnection {
  return useContext(Ctx);
}
