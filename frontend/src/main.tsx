import { StrictMode, useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection as CostCapConnection } from './cost_cap_bindings';
import { DbConnection as EvidenceConnection } from './module_bindings';
import App from './App';
import { CostCapDataProvider } from './lib/costcap';
import { EvidenceBridge } from './lib/evidence';
import { RaceBridge } from './lib/race';
import { RevenueProvider } from './lib/revenue';
import { COST_CAP_DB, EVIDENCE_DB, HOST, SeatProvider, readToken, saveToken } from './lib/seat';
import { SeatConnectionProvider } from './lib/seatConnection';
import './styles.css';

// Two SpacetimeDB databases on one server, both read with this browser's read-only identity. The
// cost cap desk is written through the seat's own connection (lib/seatConnection.tsx).

function EvidenceRoot({ children }: { children: ReactNode }) {
  const builder = useMemo(
    () =>
      EvidenceConnection.builder()
        .withUri(HOST)
        .withDatabaseName(EVIDENCE_DB)
        .withToken(readToken(EVIDENCE_DB, 'observer'))
        .onConnect((_c, _id, token) => saveToken(EVIDENCE_DB, 'observer', token)),
    []
  );
  return (
    <SpacetimeDBProvider connectionBuilder={builder}>
      <EvidenceBridge>
        <RaceBridge>{children}</RaceBridge>
      </EvidenceBridge>
    </SpacetimeDBProvider>
  );
}

function CostCapRoot({ children }: { children: ReactNode }) {
  const builder = useMemo(
    () =>
      CostCapConnection.builder()
        .withUri(HOST)
        .withDatabaseName(COST_CAP_DB)
        .withToken(readToken(COST_CAP_DB, 'observer'))
        .onConnect((_c, _id, token) => saveToken(COST_CAP_DB, 'observer', token)),
    []
  );
  return (
    <SpacetimeDBProvider connectionBuilder={builder}>
      <CostCapDataProvider>{children}</CostCapDataProvider>
    </SpacetimeDBProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SeatProvider>
      <SeatConnectionProvider>
      <RevenueProvider>
        <EvidenceRoot>
          <CostCapRoot>
            <App />
          </CostCapRoot>
        </EvidenceRoot>
      </RevenueProvider>
      </SeatConnectionProvider>
    </SeatProvider>
  </StrictMode>
);
