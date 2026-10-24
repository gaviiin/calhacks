import { useEffect, useMemo, useState } from 'react';
import type { AgentStep, AuditLog, Policy, WorkItem } from '../cost_cap_bindings/types';
import { abs, needsHead, proposedCapEffect, useCostCap } from '../lib/costcap';
import { categoryName, clock, parseJson, refusalText, revenueReason, tidyMemo, usd, usdShort } from '../lib/format';
import { useRevenue, type Parked, type Why as EntryWhyData } from '../lib/revenue';
import { useSeat } from '../lib/seat';
import { useSeatConnection } from '../lib/seatConnection';
import { IconAgent, IconApproved, IconDenied, IconPerson, IconQuestion, IconWaiting } from './icons';
import type { InboxItem } from './inboxModel';
import type { SeatStatus } from './Shell';

const ROLE_LABEL: Record<string, string> = {
  ai_cap_analyst: 'Cap Analyst (AI)',
  ai_policy_learner: 'Policy Learner (AI)',
  human_controller: 'Controller',
  human_head_of_cost_cap: 'Head of Cost Cap',
  gateway: 'ERP gateway',
  sync: 'Sync job',
  auto_approver: 'Standing approvals',
  red_team: 'Red team',
  admin: 'Bootstrap',
};

const TREATMENT: Record<string, { label: string; tone: string }> = {
  RELEVANT: { label: 'Inside the cap', tone: 'in' },
  EXCLUDED: { label: 'Excluded from the cap', tone: 'out' },
  ADJUSTMENT: { label: 'Cap adjustment', tone: 'adj' },
};

export function WhyPane({ entry, status }: { entry: InboxItem | null; status: SeatStatus }) {
  if (!entry) {
    return (
      <aside className="why why--empty">
        <h2>Why</h2>
        <p className="muted">
          Pick a line on the left. Its regulation, the policy it relied on, what the agent considered and every step of its
          trail show here, with the decision at the bottom.
        </p>
      </aside>
    );
  }
  if (entry.kind === 'item') return <WorkItemWhy item={entry.item} status={status} />;
  if (entry.kind === 'policy') return <PolicyWhy policy={entry.policy} status={status} />;
  return <EntryWhy entry={entry.entry} />;
}

// ---------------------------------------------------------------- cost cap work item

function Flag({ state, needs }: { state: string; needs?: string }) {
  if (state === 'NEEDS_INFO')
    return (
      <span className="flag flag--hold">
        <IconQuestion size={13} /> Question for a person
      </span>
    );
  if (state === 'PROPOSED')
    return (
      <span className="flag flag--hold">
        <IconWaiting size={13} /> Waiting for {needs}
      </span>
    );
  if (state === 'POSTED' || state === 'APPROVED')
    return (
      <span className="flag flag--ok">
        <IconApproved size={13} /> {state === 'POSTED' ? 'Posted' : 'Approved'}
      </span>
    );
  if (state === 'REJECTED')
    return (
      <span className="flag flag--alert">
        <IconDenied size={13} /> Rejected
      </span>
    );
  return <span className="flag">{state}</span>;
}

function Considered({ step }: { step: AgentStep | undefined }) {
  if (!step) return null;
  const input = parseJson<Record<string, unknown>>(step.input, {});
  const considered = input.considered;
  const rows: { k: string; v: string }[] = [];
  if (Array.isArray(considered)) {
    for (const c of considered as Record<string, unknown>[]) {
      switch (c.kind) {
        case 'denial_history':
          rows.push({ k: 'Earlier refusals', v: c.blocked ? `blocked: ${c.reason}` : 'none on this line' });
          break;
        case 'prechecks': {
          const hits = (c.hits as { check?: string; kind?: string }[]) ?? [];
          rows.push({
            k: 'Duplicate, bank, lookalike, split checks',
            v: hits.length ? hits.map((h) => h.check ?? h.kind ?? 'hit').join(', ') : 'all clear',
          });
          break;
        }
        case 'related_party_fair_value':
          rows.push({ k: 'Related party', v: c.applies ? `fair value applies (uplift ${usdShort(Number(c.uplift_usd_minor ?? 0))})` : 'not a related-party line' });
          break;
        case 'house_policies': {
          const matched = (c.matched as { policy: string; category_code: string }[]) ?? [];
          rows.push({
            k: 'House policies',
            v: `${c.in_force} in force; ${matched.length ? matched.map((m) => `${m.policy} → ${categoryName(m.category_code)}`).join(', ') : 'none matched'}; ${String(c.resolution ?? '').replace(/_/g, ' ')}`,
          });
          break;
        }
        case 'bill_line_resolution': {
          const lines = (c.lines as { bill_line: string; category_code: string | null; result: string }[]) ?? [];
          rows.push({ k: 'Per bill line', v: lines.map((l) => `${l.bill_line} → ${l.category_code ? categoryName(l.category_code) : l.result}`).join('; ') });
          break;
        }
        default:
          rows.push({ k: String(c.kind ?? 'check').replace(/_/g, ' '), v: JSON.stringify(c).slice(0, 160) });
      }
    }
  } else if (considered && typeof considered === 'object') {
    const c = considered as { evidence_seen?: string[]; tool_calls_so_far?: unknown[]; requires_category?: string | null };
    rows.push({ k: 'Evidence Claude read', v: (c.evidence_seen ?? []).join(', ') || 'the line only' });
    if (c.tool_calls_so_far?.length) rows.push({ k: 'Tool calls', v: `${c.tool_calls_so_far.length}` });
  }
  if (!rows.length) return null;
  return (
    <section className="why-sec">
      <h3>What it considered</h3>
      <dl className="kv">
        {rows.map((r) => (
          <div key={r.k}>
            <dt>{r.k}</dt>
            <dd>{r.v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Trail({ rows }: { rows: AuditLog[] }) {
  const sorted = [...rows].sort((a, b) => Number(a.id - b.id));
  return (
    <section className="why-sec">
      <h3>Trail</h3>
      <ol className="trail">
        {sorted.map((a) => (
          <li key={String(a.id)} className={a.allowed ? '' : 'trail-denied'}>
            <span className="trail-mark">{a.allowed ? <IconApproved size={12} /> : <IconDenied size={12} />}</span>
            <span className="trail-time mono">{clock(a.at.toDate())}</span>
            <span className="trail-who">{ROLE_LABEL[a.actorRole] ?? a.actorRole}</span>
            <span className="trail-what">
              {a.action.replace(/_/g, ' ')} {a.allowed ? `${a.fromState} → ${a.toState}` : 'refused'}
              {!a.allowed && <em title={a.reason}>{refusalText(a.reason)}</em>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function WorkItemWhy({ item, status }: { item: WorkItem; status: SeatStatus }) {
  const cc = useCostCap();
  const gl = cc.glLines.get(item.subjectRef);
  const vendor = gl?.vendorId ? cc.vendors.get(gl.vendorId) : undefined;
  const bills = cc.billLinesByGl.get(item.subjectRef) ?? [];
  const entry = item.proposedRulebookEntryId ? cc.rulebook.get(item.proposedRulebookEntryId) : undefined;
  const policy = item.proposedPolicyId !== undefined ? cc.policyById.get(item.proposedPolicyId) : undefined;
  const allocations = (cc.allocationsByItem.get(item.id) ?? []).slice().sort((a, b) => a.lineNo - b.lineNo);
  const decision = (cc.decisionsByItem.get(item.id) ?? []).slice().sort((a, b) => Number(b.id - a.id))[0];
  const models = cc.modelCallsByItem.get(item.id) ?? [];
  const trail = cc.auditBySubject.get(String(item.id)) ?? [];
  const material = needsHead(item, cc.materiality);
  const effect = proposedCapEffect(cc, item);
  const source = item.proposalSource;
  const model = models.length ? models[models.length - 1].model : undefined;

  return (
    <aside className="why" aria-labelledby="why-h">
      <header className="why-head">
        <Flag state={item.state} needs={material ? 'Head of Cost Cap' : 'Controller'} />
        <h2 id="why-h">{gl?.memo ?? item.subjectRef}</h2>
        <p className="why-sub mono">
          {usd(item.amountUsdMinor, { cents: true })}
          {gl && gl.currency !== 'USD' && ` · ${gl.currency} ${(Number(gl.amountMinor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
          {' · '}
          {vendor?.name ?? 'no vendor'} · account {gl?.accountCode} · {gl?.departmentId?.replace('dept-', '')} · {item.periodKey} · {item.subjectRef}
        </p>
        {material && <p className="why-material">Material: at or above {usdShort(cc.materiality)}, so only the Head of Cost Cap may approve it.</p>}
      </header>

      {item.state === 'NEEDS_INFO' ? (
        <section className="why-sec why-question">
          <h3>The analyst asks</h3>
          <p>{item.question}</p>
        </section>
      ) : (
        <section className="why-sec">
          <h3>Proposed</h3>
          <p className="why-proposal">
            <strong>{categoryName(item.proposedCategoryCode)}</strong>
            {entry && <span className={`treat treat--${TREATMENT[entry.treatment]?.tone}`}>{TREATMENT[entry.treatment]?.label}</span>}
            {effect !== null && <span className="mono muted">adds {usdShort(effect)} to Relevant Costs</span>}
          </p>
          {allocations.length > 0 && (
            <table className="mini">
              <thead>
                <tr>
                  <th>Split</th>
                  <th>Category</th>
                  <th className="num">USD</th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((a) => {
                  const bl = bills.find((b) => b.id === a.basisRef);
                  const t = cc.rulebook.get(a.rulebookEntryId)?.treatment;
                  return (
                    <tr key={String(a.id)}>
                      <td>{bl?.description ?? `${a.basis} ${a.basisRef}`}</td>
                      <td>
                        {categoryName(a.categoryCode)} <span className={`treat treat--${TREATMENT[t ?? '']?.tone}`}>{TREATMENT[t ?? '']?.label}</span>
                      </td>
                      <td className="num mono">{usd(a.amountUsdMinor, { cents: true })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {entry && (
            <blockquote className="reg">
              <cite>
                FIA Financial Regulations {entry.ruleVersion === 'SECD-ISS07' ? 'Section D, Issue 7' : entry.ruleVersion} · {entry.article} · {entry.title}
              </cite>
              <p>{entry.text.length > 520 ? `${entry.text.slice(0, 520)}…` : entry.text}</p>
            </blockquote>
          )}
        </section>
      )}

      <section className="why-sec">
        <h3>
          {source === 'llm' ? (
            <>
              <IconAgent size={14} /> Decided by Claude{model ? ` (${model})` : ''}: no approved policy covered this line
            </>
          ) : source === 'human_text' ? (
            <>
              <IconPerson size={14} /> From a person's answer
            </>
          ) : policy ? (
            <>
              <IconAgent size={14} /> Decided by code under {policy.policyKey} v{policy.version}
            </>
          ) : (
            <>
              <IconAgent size={14} /> The analyst's reason
            </>
          )}
        </h3>
        {policy ? <PolicyCard policy={policy} /> : <p className="why-reason">{item.reason.replace(/\s*\[MATERIAL[^\]]*\]\s*$/, '')}</p>}
      </section>

      <Considered step={decision} />

      {bills.length > 0 && (
        <section className="why-sec">
          <h3>The invoice</h3>
          <table className="mini">
            <tbody>
              {bills
                .slice()
                .sort((a, b) => a.lineNo - b.lineNo)
                .map((b) => (
                  <tr key={b.id}>
                    <td>{b.description}</td>
                    <td className="num mono">{(Number(b.amountMinor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}

      <Trail rows={trail} />
      <ItemDecision item={item} status={status} material={material} trail={trail} />
    </aside>
  );
}

function PolicyCard({ policy }: { policy: Policy }) {
  const cc = useCostCap();
  const parent = policy.parentPolicyId !== undefined ? cc.policyById.get(policy.parentPolicyId) : undefined;
  const approver = policy.decidedBy ? cc.roles.find((r) => r.identity.isEqual(policy.decidedBy!)) : undefined;
  return (
    <div className="policycard">
      <p>
        <span className="mono">{policy.policyKey}</span> v{policy.version} · {policy.precedentCount} precedents in 2025 ·{' '}
        {policy.state === 'APPROVED' ? `approved by ${approver?.label ?? 'the Head of Cost Cap'}` : policy.state.toLowerCase()}
        {parent && (
          <>
            {' '}
            · refines <span className="mono">{parent.policyKey}</span>
          </>
        )}
      </p>
      <p className="muted">{policy.rationale}</p>
    </div>
  );
}

function useOutcome(trail: AuditLog[], since: number | null) {
  const { identityHex } = useSeatConnection();
  return useMemo(() => {
    if (since === null || !identityHex) return null;
    const mine = trail
      .filter((a) => a.actor.toHexString() === identityHex && a.at.toDate().getTime() >= since - 2000)
      .sort((a, b) => Number(b.id - a.id));
    return mine[0] ?? null;
  }, [trail, since, identityHex]);
}

function SeatHint({ status }: { status: SeatStatus }) {
  const { person } = useSeat();
  if (status === 'seated') return null;
  if (status === 'readonly')
    return (
      <p className="decide-hint">
        {person.id === 'observer' ? 'Take the Controller or Head of Cost Cap seat to decide.' : `${person.title} has no role on the cost cap desk.`}
      </p>
    );
  return <p className="decide-hint">Taking the seat…</p>;
}

function Outcome({ row }: { row: AuditLog | null }) {
  if (!row) return null;
  return row.allowed ? (
    <p className="outcome outcome--ok">
      <IconApproved size={14} /> {row.action.replace(/_/g, ' ')}: {row.fromState} → {row.toState}. Recorded in the audit log under your seat.
    </p>
  ) : (
    <div className="outcome outcome--alert">
      <IconDenied size={14} />
      <p>
        Refused by the module and logged. {refusalText(row.reason)}
        <code className="outcome-code">{row.reason}</code>
      </p>
    </div>
  );
}

function ItemDecision({ item, status, material, trail }: { item: WorkItem; status: SeatStatus; material: boolean; trail: AuditLog[] }) {
  const { person } = useSeat();
  const { conn } = useSeatConnection();
  const [text, setText] = useState('');
  const [since, setSince] = useState<number | null>(null);
  const outcome = useOutcome(trail, since);
  useEffect(() => {
    setText('');
    setSince(null);
  }, [item.id]);
  const open = item.state === 'PROPOSED' || item.state === 'NEEDS_INFO';
  const seated = status === 'seated';
  const go = async (fn: (c: NonNullable<typeof conn>) => Promise<void>) => {
    if (!conn) return;
    setSince(Date.now());
    await fn(conn).catch(() => undefined);
  };
  const reason = text.trim() || `Reviewed in the dashboard by ${person.name}`;

  return (
    <footer className="decide">
      <SeatHint status={status} />
      {seated && material && person.costCapRole === 'human_controller' && open && item.state === 'PROPOSED' && (
        <p className="decide-hint tone-hold">Above materiality: the module will refuse a Controller approval and log the attempt.</p>
      )}
      {open && item.state === 'NEEDS_INFO' ? (
        <>
          <label className="field">
            <span>Your answer (name one category, or the cap effect)</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} disabled={!seated} />
          </label>
          <div className="decide-actions">
            <button className="btn btn--primary" disabled={!seated || !text.trim()} onClick={() => go((c) => c.reducers.answer({ workItemId: item.id, answer: text.trim() }))}>
              Send answer
            </button>
          </div>
        </>
      ) : open ? (
        <>
          <label className="field">
            <span>Reason (a rejection needs one; the analyst learns from it)</span>
            <input value={text} onChange={(e) => setText(e.target.value)} disabled={!seated} placeholder={`Reviewed in the dashboard by ${person.name}`} />
          </label>
          <div className="decide-actions">
            <button className="btn btn--primary" disabled={!seated} onClick={() => go((c) => c.reducers.approve({ workItemId: item.id, reason }))}>
              <IconApproved size={14} /> Approve
            </button>
            <button className="btn" disabled={!seated || !text.trim()} onClick={() => go((c) => c.reducers.reject({ workItemId: item.id, reason: text.trim() }))}>
              <IconDenied size={14} /> Reject
            </button>
          </div>
        </>
      ) : (
        <p className="decide-hint">Decided: {item.decidedReason ?? item.state.toLowerCase()}</p>
      )}
      <Outcome row={outcome} />
    </footer>
  );
}

// ---------------------------------------------------------------- policy

function PolicyWhy({ policy, status }: { policy: Policy; status: SeatStatus }) {
  const cc = useCostCap();
  const { person } = useSeat();
  const { conn } = useSeatConnection();
  const [text, setText] = useState('');
  const [since, setSince] = useState<number | null>(null);
  const entry = cc.rulebook.get(policy.rulebookEntryId);
  const pattern = parseJson<Record<string, unknown>>(policy.pattern, {});
  const children = cc.policies.filter((p) => p.parentPolicyId === policy.id);
  const parent = policy.parentPolicyId !== undefined ? cc.policyById.get(policy.parentPolicyId) : undefined;
  const trail = cc.auditBySubject.get(policy.policyKey) ?? [];
  const outcome = useOutcome(trail, since);
  const seated = status === 'seated';
  const isHead = person.costCapRole === 'human_head_of_cost_cap';
  useEffect(() => {
    setText('');
    setSince(null);
  }, [policy.id]);
  const go = async (fn: (c: NonNullable<typeof conn>) => Promise<void>) => {
    if (!conn) return;
    setSince(Date.now());
    await fn(conn).catch(() => undefined);
  };

  return (
    <aside className="why">
      <header className="why-head">
        <span className="flag flag--hold">
          <IconWaiting size={13} /> {policy.state === 'PROPOSED' ? 'Waiting for the Head of Cost Cap' : policy.state.toLowerCase()}
        </span>
        <h2 className="mono">{policy.policyKey}</h2>
        <p className="why-sub">
          Drafted by the Policy Learner from {policy.precedentCount} 2025 precedents · in force from {policy.effectiveFrom}
        </p>
      </header>
      <section className="why-sec">
        <h3>When a line matches</h3>
        <ul className="chips">
          {Object.entries(pattern).map(([k, v]) => (
            <li key={k} className="chip mono">
              {k.replace(/_/g, ' ')} {k.endsWith('regex') ? '~' : '='} {String(v)}
            </li>
          ))}
        </ul>
        <p className="why-proposal">
          then <strong>{categoryName(policy.categoryCode)}</strong>
          {entry && <span className={`treat treat--${TREATMENT[entry.treatment]?.tone}`}>{TREATMENT[entry.treatment]?.label}</span>}
        </p>
        {parent && (
          <p className="muted">
            An exception under <span className="mono">{parent.policyKey}</span>: it takes precedence on the lines it matches.
          </p>
        )}
        {children.length > 0 && (
          <p className="muted">
            {children.length} exception{children.length > 1 ? 's' : ''} refine it: {children.map((c) => `${categoryName(c.categoryCode)}`).join(', ')}.
          </p>
        )}
      </section>
      <section className="why-sec">
        <h3>Rationale</h3>
        <p className="why-reason">{policy.rationale}</p>
      </section>
      {entry && (
        <blockquote className="reg">
          <cite>
            {entry.article} · {entry.title}
          </cite>
          <p>{entry.text.length > 520 ? `${entry.text.slice(0, 520)}…` : entry.text}</p>
        </blockquote>
      )}
      <footer className="decide">
        <SeatHint status={status} />
        {seated && !isHead && <p className="decide-hint tone-hold">Only the Head of Cost Cap may approve a policy; the module will refuse and log any other seat.</p>}
        {policy.state === 'PROPOSED' && (
          <>
            <label className="field">
              <span>Reason</span>
              <input value={text} onChange={(e) => setText(e.target.value)} disabled={!seated} placeholder="Matches 2025 practice and the 2026 rule" />
            </label>
            <div className="decide-actions">
              <button
                className="btn btn--primary"
                disabled={!seated}
                onClick={() => go((c) => c.reducers.approvePolicy({ policyId: policy.id, reason: text.trim() || `Approved in the dashboard by ${person.name}` }))}
              >
                <IconApproved size={14} /> Approve policy
              </button>
              <button className="btn" disabled={!seated || !text.trim()} onClick={() => go((c) => c.reducers.rejectPolicy({ policyId: policy.id, reason: text.trim() }))}>
                <IconDenied size={14} /> Reject
              </button>
            </div>
          </>
        )}
        <Outcome row={outcome} />
      </footer>
    </aside>
  );
}

// ---------------------------------------------------------------- revenue entry

function EntryWhy({ entry }: { entry: Parked }) {
  const rev = useRevenue();
  const { person } = useSeat();
  const [why, setWhy] = useState<EntryWhyData | null>(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setWhy(null);
    setResult(null);
    setText('');
    void rev.why(entry.je_id).then((w) => live && setWhy(w));
    return () => {
      live = false;
    };
  }, [entry.je_id, rev.why]);
  const approver = person.revenue;
  const canAct = approver && entry.needs.includes(approver.role);
  const act = async (decision: 'approve' | 'reject') => {
    if (!approver) return;
    try {
      setResult(await rev.approve(entry.je_id, approver.approver, approver.role, decision, text.trim()));
    } catch (e) {
      setResult(`Refused: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const failed = (why?.checks ?? []).filter((c) => c.result !== 'pass');

  return (
    <aside className="why">
      <header className="why-head">
        <span className="flag flag--hold">
          <IconWaiting size={13} /> Parked for {entry.needs.map((n) => (n === 'cfo' ? 'CFO' : 'Controller')).join(' and ')}
        </span>
        <h2>{tidyMemo(entry.memo)}</h2>
        <p className="why-sub mono">
          {usd(entry.total_cents, { cents: true })} · {entry.kind.replace(/_/g, ' ')} · {entry.je_id} · revenue desk
        </p>
        <p className="why-material">{revenueReason(entry.reason)}</p>
      </header>
      {why ? (
        <>
          <section className="why-sec">
            <h3>
              <IconAgent size={14} /> Why the revenue desk booked it this way
            </h3>
            <p className="why-reason">{revenueReason(why.text)}</p>
          </section>
          <section className="why-sec">
            <h3>Journal lines</h3>
            <ul className="lines mono">
              {why.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </section>
          <section className="why-sec">
            <h3>Kernel checks, re-performed from source</h3>
            <ul className="checks">
              {why.checks.map((c) => (
                <li key={c.check_id} className={c.result === 'pass' ? 'check check--pass' : 'check check--fail'} title={c.reason ?? c.result}>
                  {c.result === 'pass' ? <IconApproved size={12} /> : <IconDenied size={12} />}
                  {c.check_id}
                </li>
              ))}
            </ul>
            {failed.length > 0 && (
              <p className="muted">
                {failed.map((c) => `${c.check_id} holds it for a person: ${revenueReason(c.reason ?? c.result)}`).join(' · ')}
              </p>
            )}
          </section>
          <section className="why-sec">
            <h3>Evidence</h3>
            <ul className="evidence">
              {why.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <p className="muted why-sec">Reading the entry…</p>
      )}
      <footer className="decide">
        {!approver && <p className="decide-hint">Take the Controller or CFO seat to approve revenue entries.</p>}
        {approver && !canAct && <p className="decide-hint">{person.title} is not one of the approvals this entry still needs.</p>}
        <label className="field">
          <span>Reason</span>
          <input value={text} onChange={(e) => setText(e.target.value)} disabled={!canAct} />
        </label>
        <div className="decide-actions">
          <button className="btn btn--primary" disabled={!canAct || rev.busy !== null} onClick={() => act('approve')}>
            <IconApproved size={14} /> Approve as {person.name}
          </button>
          <button className="btn" disabled={!canAct || rev.busy !== null} onClick={() => act('reject')}>
            <IconDenied size={14} /> Reject
          </button>
        </div>
        {result && <p className="outcome">{result}</p>}
      </footer>
    </aside>
  );
}

export { ROLE_LABEL, abs };
