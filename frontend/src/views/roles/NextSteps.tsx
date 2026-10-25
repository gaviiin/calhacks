import { useMemo } from 'react';
import { useRace } from '../../lib/race';
import { sortTime } from '../../lib/raceModel';
import type { RaceActions } from '../../module_bindings/types';
import { ActButton, clock, parse, roleLabel } from '../raceday/shared';
import { useFocusIncident } from './IncidentFlow';
import { Panel, Pill } from './kit';
import './flow.css';

// What follows the calls for the incident being followed. The desk does the reversible work itself (reserving spares,
// work orders, the inventory move, the evidence pack); anything outward or irreversible waits for the person who owns
// it, with its deadline. When the Team Principal has chosen, only the paperwork for that choice is left.

const DESK_WORDS: Record<string, [string, string]> = {
  spares_reserve: ['spare reserved', 'spares reserved'],
  work_order: ['Grove work order', 'Grove work orders'],
  td017_move: ['inventory move', 'inventory moves'],
  evidence_pack: ['evidence pack', 'evidence packs'],
  parc_ferme_list: ['parc fermé list', 'parc fermé lists'],
  pu_check: ['PU and gearbox check', 'PU and gearbox checks'],
  hand_carry: ['hand-carry', 'hand-carries'],
  freight: ['freight booking', 'freight bookings'],
};
const SKIP = new Set(['garage_check', 'withdraw_car']);

interface Detail { why?: string; to?: string; draft?: string; chosen?: string; drafts?: { option: string; to: string; draft: string }[] }

const dueWord = (iso: string, day: string) =>
  !iso ? '' : iso.slice(0, 10) === day ? clock(iso).slice(0, 5) : new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).replace(',', '');

export function NextSteps() {
  const race = useRace();
  const inc = useFocusIncident();
  const acts = useMemo(() => (inc ? race.actions.filter((a) => a.incidentKey === inc.incidentKey && !SKIP.has(a.kind)) : []), [race.actions, inc]);
  if (!inc || !acts.length) return null;
  const day = inc.firstSeenAt.slice(0, 10);
  const waiting = acts.filter((a) => a.status === 'awaiting_approval').sort((a, b) => sortTime(a.dueAt || '9999') - sortTime(b.dueAt || '9999'));
  const decided = acts.filter((a) => a.status === 'approved' || a.status === 'done' || a.status === 'rejected');
  const desk = acts.filter((a) => a.status === 'auto');
  const off = acts.filter((a) => a.status === 'cancelled');
  const groups = new Map<string, RaceActions[]>();
  for (const a of desk) groups.set(a.kind, [...(groups.get(a.kind) ?? []), a]);

  return (
    <div id="next-steps">
      <Panel title={`Next steps · car ${inc.driverNumber}`} aside={waiting.length ? `${waiting.length} waiting for a person` : 'nothing waiting'} className="ns">
        {waiting.length || decided.length ? (
          <ol className="ns-list">
            {[...waiting, ...decided].map((a) => {
              const d = parse<Detail>(a.detailJson, {});
              const wait = a.status === 'awaiting_approval';
              return (
                <li key={a.actionKey} className={`ns-row ${wait ? 'ns-row--wait' : ''}`} title={d.why}>
                  <span className="ns-due">{a.dueAt ? <>by <b>{dueWord(a.dueAt, day)}</b></> : '—'}</span>
                  <span className="ns-what">
                    <span className="ns-title">{a.title}</span>
                    {d.draft ? <q className="ns-draft">{d.draft}</q> : null}
                  </span>
                  <span className="ns-who">
                    <Pill tone="neutral">{roleLabel(a.ownerRole)}</Pill>
                    {a.outward ? <Pill tone="info" title="Leaves the team: a person sends it">Outward</Pill> : null}
                  </span>
                  <span className="ns-act">
                    {wait ? (
                      <>
                        <ActButton primary label={a.kind === 'fia_notice' ? 'Send' : 'Approve'} run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'approved', by, at })} />
                        <ActButton label="Reject" run={(by, at) => race.decideAction({ actionKey: a.actionKey, status: 'rejected', by, at })} />
                      </>
                    ) : (
                      <Pill tone={a.status === 'rejected' ? 'bad' : 'ok'} title={a.decidedBy}>
                        {a.status === 'rejected' ? 'Rejected' : 'Approved'}
                      </Pill>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}
        <div className="ns-desk" aria-label="Done by the desk">
          {[...groups.entries()].map(([kind, xs]) => {
            const w = DESK_WORDS[kind] ?? [kind.replace(/_/g, ' '), kind.replace(/_/g, ' ')];
            return (
              <span key={kind} className="ns-chip" title={xs.map((x) => x.title).join('\n')}>
                <b>{xs.length}</b> {xs.length === 1 ? w[0] : w[1]}
              </span>
            );
          })}
          {off.map((a) => (
            <span key={a.actionKey} className="ns-chip ns-chip--off" title={parse<Detail>(a.detailJson, {}).why ?? a.title}>
              {(DESK_WORDS[a.kind]?.[0] ?? a.kind.replace(/_/g, ' '))}: not needed
            </span>
          ))}
        </div>
      </Panel>
    </div>
  );
}
