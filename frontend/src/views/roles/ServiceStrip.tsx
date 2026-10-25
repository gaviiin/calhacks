import { useRace } from '../../lib/race';
import { clock } from '../raceday/shared';

// What each outside service actually did on this run, from race_health: nothing on the page claims to be live
// that the runner did not use.

const NAME: Record<string, string> = { openf1: 'OpenF1', jev: 'Jev', claude: 'Claude', erp: 'ERP', spacetimedb: 'SpacetimeDB', notify: 'Notify' };
const ORDER = ['openf1', 'spacetimedb', 'jev', 'claude', 'erp', 'notify'];
const WORD: Record<string, string> = { live: 'live', degraded: 'degraded', offline: 'offline', dry_run: 'dry run', not_configured: 'not configured' };

export function ServiceStrip() {
  const race = useRace();
  if (!race.health.length) return null;
  const rows = race.health.slice().sort((a, b) => ORDER.indexOf(a.service) - ORDER.indexOf(b.service));
  return (
    <ul className="services" aria-label="Services this run used">
      {rows.map((h) => (
        <li key={h.service} className={`service service--${h.status}`} title={`${h.detail} (as of ${clock(h.at)} UTC)`}>
          <span className="service-dot" aria-hidden />
          {NAME[h.service] ?? h.service}
          {h.status !== 'live' && <span className="service-word">{WORD[h.status] ?? h.status}</span>}
          <span className="sr-only"> {WORD[h.status] ?? h.status}</span>
        </li>
      ))}
    </ul>
  );
}
