import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from '../module_bindings';
import type { FiaDecisionFacts, FiaDocuments, JournalEntries } from '../module_bindings/types';

// The pit-wall database (FIA evidence and the revenue ledger mirror) is subscribed inside its own
// SpacetimeDBProvider, then handed down through this context, because the cost cap provider sits
// nested inside it and owns the SDK's hook context below.

export interface EvidenceData {
  connected: boolean;
  documents: readonly FiaDocuments[];
  decisions: readonly FiaDecisionFacts[];
  entries: readonly JournalEntries[];
}

const Ctx = createContext<EvidenceData>({ connected: false, documents: [], decisions: [], entries: [] });

export function EvidenceBridge({ children }: { children: ReactNode }) {
  const conn = useSpacetimeDB();
  const [documents] = useTable(tables.fiaDocuments);
  const [decisions] = useTable(tables.fiaDecisionFacts);
  const [entries] = useTable(tables.journalEntries);
  const value = useMemo(
    () => ({ connected: conn.isActive, documents, decisions, entries }),
    [conn.isActive, documents, decisions, entries]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEvidence(): EvidenceData {
  return useContext(Ctx);
}
