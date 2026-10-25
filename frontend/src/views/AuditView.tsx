import { useMemo, useState } from 'react';
import { IconApproved, IconDenied } from '../components/icons';
import { Spine, useLedgerTime } from '../components/Spine';
import { ROLE_LABEL } from '../components/Why';
import { useCostCap } from '../lib/costcap';
import { clock, refusalText } from '../lib/format';

// The spine's table: every transition the system of work recorded, allowed or refused, newest first.

const MATRIX: { action: string; who: string }[] = [
  { action: 'Propose a classification, ask a question', who: 'Cap Analyst (AI)' },
  { action: 'Propose a house policy', who: 'Policy Learner (AI)' },
  { action: 'Approve what an approved rule decided, at any amount', who: 'Standing approvals' },
  { action: 'Decide a line no rule covers, below materiality', who: 'Controller, Head of Cost Cap' },
  { action: 'Decide a line no rule covers, at or above materiality', who: 'Head of Cost Cap' },
  { action: 'Teach a rule from one decision', who: 'Head of Cost Cap; Controller, below materiality only' },
  { action: 'Approve a policy, take its standing approval back', who: 'Head of Cost Cap' },
  { action: 'Post to the ERP', who: 'ERP gateway, only when approved' },
  { action: 'Approve your own proposal', who: 'Nobody' },
];

const ledgerDay = (t: number | null) =>
  t === null ? '—' : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function AuditView({ window: win, clearWindow }: { window: [number, number] | null; clearWindow: () => void }) {
  const cc = useCostCap();
  const ledgerTime = useLedgerTime();
  const [only, setOnly] = useState<'all' | 'refused'>(win ? 'all' : 'refused');
  const [role, setRole] = useState<string>('');
  const roles = useMemo(() => [...new Set(cc.audit.map((a) => a.actorRole))].sort(), [cc.audit]);
  const rows = useMemo(
    () =>
      cc.audit
        .filter((a) => (only === 'all' || !a.allowed) && (!role || a.actorRole === role))
        .filter((a) => {
          if (!win) return true;
          const t = ledgerTime(a);
          return t !== null && t >= win[0] && t < win[1];
        })
        .slice()
        .sort((a, b) => Number(b.id - a.id)),
    [cc.audit, only, role, win, ledgerTime]
  );
  const refused = cc.audit.filter((a) => !a.allowed).length;
  const holders = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of cc.roles) m.set(r.role, (m.get(r.role) ?? 0) + 1);
    return m;
  }, [cc.roles]);

  return (
    <div className="audit">
      <Spine onWindow={(a, b) => (window.location.hash = `/audit/${Math.floor(a)}-${Math.ceil(b)}`)} />
      <section aria-labelledby="audit-h">
        <div className="sec-head">
          <h1 id="audit-h">Audit log</h1>
          <p className="muted">
            {cc.audit.length.toLocaleString()} transitions, each written in the same transaction as the change it records. {refused} were refused and kept.
          </p>
        </div>
        <div className="filters">
          <button className={only === 'refused' ? 'filter filter--on' : 'filter'} onClick={() => setOnly('refused')}>
            Refused <span className="mono">{refused}</span>
          </button>
          <button className={only === 'all' ? 'filter filter--on' : 'filter'} onClick={() => setOnly('all')}>
            Everything <span className="mono">{cc.audit.length}</span>
          </button>
          <label className="select">
            <span>Actor</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">all</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r] ?? r}
                </option>
              ))}
            </select>
          </label>
          {win && (
            <button className="filter filter--on" onClick={clearWindow}>
              {ledgerDay(win[0])} <IconDenied size={11} title="clear the time window" />
            </button>
          )}
        </div>
        <div className="table-wrap">
          <table className="data audit-table">
            <thead>
              <tr>
                <th>Ledger date</th>
                <th>Written</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Subject</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map((a) => (
                <tr key={String(a.id)} className={a.allowed ? undefined : 'row--denied'}>
                  <td className="mono">{ledgerDay(ledgerTime(a))}</td>
                  <td className="mono muted">{clock(a.at.toDate())}</td>
                  <td>{ROLE_LABEL[a.actorRole] ?? a.actorRole}</td>
                  <td className="mono">{a.action}</td>
                  <td className="mono">
                    {a.resourceKind === 'work_item' ? `item ${a.subjectId}` : a.subjectId}
                    {a.policyId !== undefined && <span className="muted"> · pol-{String(a.policyId)} v{a.policyVersion}</span>}
                  </td>
                  <td>
                    {a.allowed ? (
                      <span className="outcome-cell">
                        <IconApproved size={12} /> {a.fromState} → {a.toState}
                      </span>
                    ) : (
                      <span className="outcome-cell outcome-cell--refused" title={a.reason}>
                        <IconDenied size={12} /> {refusalText(a.reason)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 300 && <p className="muted">Showing the newest 300 of {rows.length.toLocaleString()}.</p>}
        </div>
      </section>
      <section className="matrix" aria-labelledby="matrix-h">
        <h2 id="matrix-h">Who may do what</h2>
        <p className="muted">Enforced inside the module's one transition function, not by the agents.</p>
        <table className="data">
          <tbody>
            {MATRIX.map((m) => (
              <tr key={m.action}>
                <th scope="row">{m.action}</th>
                <td>{m.who}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Seat holders now</h3>
        <ul className="holders">
          {[...holders.entries()].map(([r, n]) => (
            <li key={r}>
              <span>{ROLE_LABEL[r] ?? r}</span>
              <span className="mono">{n}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
