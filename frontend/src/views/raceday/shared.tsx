import { useState, type ReactNode } from 'react';
import { IconDenied } from '../../components/icons';
import type { RaceData } from '../../lib/race';
import { useSeat } from '../../lib/seat';

// The race-day page is seven stages on one rail. Each stage file exports its panel and a one-line headline
// for the rail; everything below the headline starts collapsed, so the page reads as the flow, not as tables.

export type Tone = 'ok' | 'hold' | 'alert' | 'muted' | '';

export interface Headline {
  value: string; // the one figure the rail shows
  note: string; // a few words under it
  tone?: Tone;
}

export type HeadlineFn = (race: RaceData) => Headline;

export function parse<T>(json: string, fallback: T): T {
  try {
    const v = JSON.parse(json);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function clock(iso: string): string {
  const m = /T(\d\d:\d\d:\d\d)/.exec(iso);
  return m ? m[1]! : iso;
}

export function newest<T extends { [k: string]: unknown }>(rows: readonly T[], key: keyof T): T | null {
  return rows.reduce<T | null>((best, r) => (!best || String(r[key]) >= String(best[key]) ? r : best), null);
}

/** One stage of the flow: its number, name and headline, and a body that opens on click. */
export function Stage({ n, id, title, headline, children, defaultOpen = false }: { n: number; id: string; title: string; headline: Headline; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`stage panel ${open ? 'stage--open' : ''}`} id={`stage-${id}`} aria-labelledby={`stage-${id}-h`}>
      <button type="button" className="stage-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={`stage-${id}-body`}>
        <span className="stage-n mono">{n}</span>
        <span className="stage-title" id={`stage-${id}-h`}>
          {title}
        </span>
        <span className={`stage-value mono ${headline.tone ? `tone-${headline.tone}` : ''}`}>{headline.value}</span>
        <span className="stage-note muted">{headline.note}</span>
        <span className="stage-caret" aria-hidden>
          {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <div className="stage-body" id={`stage-${id}-body`}>
          {children}
        </div>
      )}
    </section>
  );
}

/** A button that calls a reducer as the seated person; shows the module's refusal in words. */
export function ActButton({ label, busyLabel, run, primary = false, disabled = false, title }: { label: string; busyLabel?: string; run: (by: string, at: string) => Promise<void>; primary?: boolean; disabled?: boolean; title?: string }) {
  const { person } = useSeat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await run(person.name, new Date().toISOString());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/no seat|race_head|unauthorized/i.test(msg) ? `${msg}. Seat this browser: scripts/race_grant.py --role race_head --identity <hex> --name "<name>"` : msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="act">
      <button type="button" className={`btn btn--small ${primary ? 'btn--primary' : ''}`} onClick={go} disabled={disabled || busy} title={title}>
        {busy ? busyLabel ?? '…' : label}
      </button>
      {error && (
        <span className="outcome outcome--alert" role="alert">
          <IconDenied size={12} />
          <span>{error}</span>
        </span>
      )}
    </span>
  );
}

export const ROLE_LABEL: Record<string, string> = {
  team_principal: 'Team Principal',
  technical_director: 'Technical Director',
  chief_mechanic: 'Chief Mechanic',
  head_of_cost_cap: 'Head of Cost Cap',
  head_of_racing_finance: 'Head of Racing Finance',
  controller: 'Financial Controller',
  cfo: 'CFO',
  logistics: 'Head of Logistics',
  sporting_director: 'Sporting Director',
};

export const roleLabel = (r: string) => ROLE_LABEL[r] ?? r.replace(/_/g, ' ');
