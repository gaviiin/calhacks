import { useEffect, useMemo, useState } from 'react';
import type { AgentStep, AuditLog, Policy, WorkItem } from '../cost_cap_bindings/types';
import { abs, needsHead, proposedCapEffect, useCostCap } from '../lib/costcap';
import { categoryName, clock, parseJson, refusalText, revenueReason, tidyMemo, usd, usdShort } from '../lib/format';
import { useRevenue, type Parked, type Question, type Why as EntryWhyData } from '../lib/revenue';
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
  if (entry.kind === 'question') return <QuestionWhy question={entry.question} />;
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
              <IconAgent size={14} /> New scenario: no approved rule covered this line, so Claude{model ? ` (${model})` : ''} drafted this for a person
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

/** The rule a person's decision would teach: this line's account and vendor (or department), and for
 * a controller, only lines inside the materiality line (they may not delegate more than they hold). */
function useLesson(item: WorkItem) {
  const cc = useCostCap();
  const { person } = useSeat();
  return useMemo(() => {
    const gl = cc.glLines.get(item.subjectRef);
    if (!gl || item.kind !== 'classification') return null;
    const vendor = gl.vendorId ? cc.vendors.get(gl.vendorId) : undefined;
    const controller = person.costCapRole === 'human_controller';
    const bound = Number(cc.materiality) - 1;
    const pattern = {
      account_code: gl.accountCode,
      ...(gl.vendorId ? { vendor_id: gl.vendorId } : { department_id: gl.departmentId }),
      ...(controller ? { min_amount_usd_minor: -bound, max_amount_usd_minor: bound } : {}),
    };
    const who = vendor?.name ?? gl.departmentId.replace('dept-', '') + ' department';
    const start = `${item.periodKey}-01`;
    const end = `${item.periodKey}-28`;
    const entries = [...cc.rulebook.values()]
      .filter((e) => e.effectiveFrom <= start && (!e.effectiveTo || e.effectiveTo >= end))
      .sort((a, b) => categoryName(a.categoryCode).localeCompare(categoryName(b.categoryCode)));
    return { pattern, scope: `${who} on account ${gl.accountCode}${controller ? `, lines under ${usdShort(cc.materiality)}` : ''}`, entries };
  }, [cc, item.subjectRef, item.kind, item.periodKey, person.costCapRole]);
}

function useTeachOutcome(since: number | null) {
  const cc = useCostCap();
  const { identityHex } = useSeatConnection();
  return useMemo(() => {
    if (since === null || !identityHex) return null;
    return (
      cc.audit
        .filter((a) => a.action === 'teach_policy' && a.actor.toHexString() === identityHex && a.at.toDate().getTime() >= since - 2000)
        .sort((a, b) => Number(b.id - a.id))[0] ?? null
    );
  }, [cc.audit, since, identityHex]);
}

function ItemDecision({ item, status, material, trail }: { item: WorkItem; status: SeatStatus; material: boolean; trail: AuditLog[] }) {
  const { person } = useSeat();
  const { conn } = useSeatConnection();
  const lesson = useLesson(item);
  const proposed = item.proposedCategoryCode && item.proposedCategoryCode !== 'ALLOCATED' ? item.proposedCategoryCode : '';
  const [text, setText] = useState('');
  const [category, setCategory] = useState(proposed);
  const [remember, setRemember] = useState(false);
  const [since, setSince] = useState<number | null>(null);
  const outcome = useOutcome(trail, since);
  const taught = useTeachOutcome(since);
  // a new line resets the bar; the same line changing state (just decided) keeps its outcome on screen
  useEffect(() => {
    setText('');
    setCategory(proposed);
    // a line no rule covered is the case worth remembering
    setRemember(item.proposalSource === 'llm' || item.state === 'NEEDS_INFO');
    setSince(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);
  const open = item.state === 'PROPOSED' || item.state === 'NEEDS_INFO';
  const asking = item.state === 'NEEDS_INFO';
  const seated = status === 'seated';
  const reason = text.trim() || `Reviewed in the dashboard by ${person.name}`;
  const entry = lesson?.entries.find((e) => e.categoryCode === category);
  const canRemember = !!lesson && item.proposedCategoryCode !== 'ALLOCATED';
  const go = async (fn: (c: NonNullable<typeof conn>) => Promise<void>, teachAs?: string) => {
    if (!conn) return;
    setSince(Date.now());
    await fn(conn).catch(() => undefined);
    const e = lesson?.entries.find((x) => x.categoryCode === teachAs);
    if (remember && canRemember && teachAs && e && lesson) {
      await conn.reducers
        .teachPolicy({ workItemId: item.id, categoryCode: teachAs, rulebookEntryId: e.id, pattern: JSON.stringify(lesson.pattern), reason })
        .catch(() => undefined);
    }
  };
  const named = (t: string) => (category ? `${t} Category: ${categoryName(category)} (${category}).` : t);

  return (
    <footer className="decide">
      <SeatHint status={status} />
      {seated && material && person.costCapRole === 'human_controller' && open && !asking && (
        <p className="decide-hint tone-hold">Above materiality: the module will refuse a Controller approval and log the attempt.</p>
      )}
      {open ? (
        <>
          <label className="field">
            <span>{asking ? 'Your answer' : 'Reason (a rejection needs one; the analyst learns from it)'}</span>
            {asking ? (
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} disabled={!seated} />
            ) : (
              <input value={text} onChange={(e) => setText(e.target.value)} disabled={!seated} placeholder={`Reviewed in the dashboard by ${person.name}`} />
            )}
          </label>
          {lesson && (asking || remember || category !== proposed) && (
            <label className="field">
              <span>{asking ? 'Category' : 'The right category'}</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} disabled={!seated}>
                <option value="">Choose a category</option>
                {lesson.entries.map((e) => (
                  <option key={e.id} value={e.categoryCode}>
                    {categoryName(e.categoryCode)} ({e.treatment === 'RELEVANT' ? 'inside the cap' : e.treatment === 'EXCLUDED' ? 'excluded' : 'adjustment'})
                  </option>
                ))}
              </select>
            </label>
          )}
          {canRemember && (
            <label className="remember">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={!seated} />
              <span>
                Remember: {lesson!.scope} {category ? `→ ${categoryName(category)}` : ''} from now on, without asking
              </span>
            </label>
          )}
          <div className="decide-actions">
            {asking ? (
              <button
                className="btn btn--primary"
                disabled={!seated || !text.trim() || (remember && !entry)}
                onClick={() => go((c) => c.reducers.answer({ workItemId: item.id, answer: named(text.trim()) }), category)}
              >
                Send answer
              </button>
            ) : (
              <>
                <button
                  className="btn btn--primary"
                  disabled={!seated || category !== proposed}
                  title={category !== proposed ? 'Approving keeps the proposed category; reject to correct it' : undefined}
                  onClick={() => go((c) => c.reducers.approve({ workItemId: item.id, reason }), proposed)}
                >
                  <IconApproved size={14} /> Approve
                </button>
                <button
                  className="btn"
                  disabled={!seated || !text.trim() || (remember && (!entry || category === proposed))}
                  onClick={() => go((c) => c.reducers.reject({ workItemId: item.id, reason: named(text.trim()) }), category)}
                >
                  <IconDenied size={14} /> Reject{category && category !== proposed ? ` as ${categoryName(category)}` : ''}
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <p className="decide-hint">Decided: {item.decidedReason ?? item.state.toLowerCase()}</p>
      )}
      <Outcome row={outcome} />
      {taught && (taught.allowed ? (
        <p className="outcome outcome--ok">
          <IconApproved size={14} /> Remembered as rule {taught.subjectId}: lines like this are decided without asking from now on.
        </p>
      ) : (
        <Outcome row={taught} />
      ))}
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
        {policy.state === 'APPROVED' && (
          <div className="standing">
            <p>
              {policy.autonomy === 'GRANTED'
                ? 'Standing approval: lines this policy decides are approved without a person, at any amount.'
                : `Standing approval ${policy.autonomy === 'SUSPENDED' ? 'suspended by a newer version' : 'taken back'}: a person approves its lines.`}
            </p>
            {seated && isHead && (
              <button
                className="btn"
                onClick={() =>
                  go((c) =>
                    policy.autonomy === 'GRANTED'
                      ? c.reducers.revokeAutonomy({ policyId: policy.id, reason: text.trim() || `Reviewing its lines (${person.name})` })
                      : c.reducers.grantAutonomy({
                          policyId: policy.id,
                          evidence: JSON.stringify({ reviewed_in: 'dashboard', by: person.name }),
                          reason: text.trim() || `Lines reviewed (${person.name})`,
                        })
                  )
                }
              >
                {policy.autonomy === 'GRANTED' ? 'Take standing approval back' : 'Give standing approval back'}
              </button>
            )}
          </div>
        )}
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
  const done = entry.approved_roles ?? [];
  const remaining = entry.needs.filter((r) => !done.includes(r));
  const canAct = approver && remaining.includes(approver.role);
  const roleName = (r: string) => (r === 'cfo' ? 'CFO' : r === 'controller' ? 'Controller' : r);
  const act = async (decision: 'approve' | 'reject') => {
    if (!approver) return;
    try {
      const status = await rev.approve(entry.je_id, approver.approver, approver.role, decision, text.trim());
      setResult(
        status.startsWith('parked')
          ? `Your ${decision === 'approve' ? 'approval' : 'rejection'} is recorded; it still needs ${remaining.filter((r) => r !== approver.role).map(roleName).join(' and ') || 'another approver'}.`
          : status.startsWith('posted')
            ? 'Approved and posted to the books.'
            : status
      );
    } catch (e) {
      setResult(`Refused: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const failed = (why?.checks ?? []).filter((c) => c.result !== 'pass');

  return (
    <aside className="why">
      <header className="why-head">
        <span className="flag flag--hold">
          <IconWaiting size={13} /> {done.length ? `${done.map(roleName).join(' and ')} approved; waiting for ${remaining.map(roleName).join(' and ')}` : `Parked for ${entry.needs.map(roleName).join(' and ')}`}
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
        {approver && !canAct && (
          <p className="decide-hint">
            {done.includes(approver.role) ? `${person.title} has already approved it.` : `${person.title} is not one of the approvals this entry still needs.`} Waiting for{' '}
            {remaining.map(roleName).join(' and ')}.
          </p>
        )}
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

// ---------------------------------------------------------------- revenue question

function QuestionWhy({ question }: { question: Question }) {
  const rev = useRevenue();
  const { person } = useSeat();
  const [text, setText] = useState('');
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => {
    setText('');
    setResult(null);
  }, [question.q_id]);
  const canAct = person.revenue?.role === question.to_role;
  const send = async () => {
    try {
      await rev.answer(question.q_id, text.trim());
      setResult('Answered. The revenue desk applies it now, and to every later case of this clause.');
    } catch (e) {
      setResult(`Not sent: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <aside className="why">
      <header className="why-head">
        <span className="flag flag--hold">
          <IconQuestion size={13} /> Question for the {question.to_role === 'cfo' ? 'CFO' : 'Controller'}
        </span>
        <h2>{question.text}</h2>
        <p className="why-sub mono">
          {question.subject} · asked {question.asked_at.replace('T', ' ').slice(0, 16)} · revenue desk
        </p>
      </header>
      <section className="why-sec">
        <h3>
          <IconAgent size={14} /> Why it asks
        </h3>
        <p className="why-reason">
          The contract does not settle this case on its own, so the revenue desk books nothing until a person rules. One ruling is
          enough: it becomes the rule for this clause, and later cases are booked without asking.
        </p>
      </section>
      <footer className="decide">
        {!canAct && <p className="decide-hint">Take the {question.to_role === 'cfo' ? 'CFO' : 'Controller'} seat to answer.</p>}
        <label className="field">
          <span>Your ruling</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} disabled={!canAct} />
        </label>
        <div className="decide-actions">
          <button className="btn btn--primary" disabled={!canAct || !text.trim() || rev.busy !== null} onClick={send}>
            Send ruling as {person.name}
          </button>
        </div>
        {result && <p className="outcome">{result}</p>}
      </footer>
    </aside>
  );
}

export { ROLE_LABEL, abs };
