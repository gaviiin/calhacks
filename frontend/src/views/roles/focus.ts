import { createContext } from 'react';

// The incident every race-day view is following. Its own module, so a hot reload of the strip that reads it never
// leaves the provider and its readers holding two different contexts.

export interface Focus {
  incidentKey: string | null;
  setIncidentKey: (k: string | null) => void;
}

export const FocusCtx = createContext<Focus>({ incidentKey: null, setIncidentKey: () => {} });
export const FlowFocus = FocusCtx.Provider;
