import type { Policy, WorkItem } from '../cost_cap_bindings/types';
import { abs, needsHead, type CostCapData } from '../lib/costcap';
import { tidyMemo } from '../lib/format';
import type { Parked, Queue, Question } from '../lib/revenue';
import type { RaceData } from '../lib/race';
import type { RaceActions, RaceCloses, RaceEffects, RacePlans, RaceQuestions } from '../module_bindings/types';

// Everything that waits for a person, from both desks, in one list.

export type InboxItem =
  | { kind: 'item'; key: string; desk: 'cost'; item: WorkItem; needs: string; amount: number; title: string; sub: string }
  | { kind: 'policy'; key: string; desk: 'cost'; policy: Policy; needs: string; amount: number; title: string; sub: string }
  | { kind: 'entry'; key: string; desk: 'revenue'; entry: Parked; needs: string; amount: number; title: string; sub: string }
  | { kind: 'question'; key: string; desk: 'revenue'; question: Question; needs: string; amount: number; title: string; sub: string }
  | { kind: 'race'; key: string; desk: 'race'; race: RaceInbox; needs: string; amount: number; title: string; sub: string };

/** What race day leaves for a person: a damage question, an action that waits, a line Jev was unsure of, the close. */
export type RaceInbox =
  | { type: 'question'; question: RaceQuestions }
  | { type: 'action'; action: RaceActions }
  | { type: 'effect'; effect: RaceEffects }
  | { type: 'close'; close: RaceCloses }
  | { type: 'plan'; plan: RacePlans };

const ROLE: Record<string, string> = {
  team_principal: 'Team Principal', chief_mechanic: 'Chief Mechanic', sporting_director: 'Sporting Director', logistics: 'Head of Logistics',
  technical_director: 'Technical Director', head_of_cost_cap: 'Head of Cost Cap', cfo: 'CFO', controller: 'Controller',
};
const role = (r: string) => ROLE[r] ?? r.replace(/_/g, ' ');

export function raceInboxItems(race: Pick<RaceData, 'questions' | 'actions' | 'effects' | 'closes' | 'plans'>): InboxItem[] {
  const out: InboxItem[] = [];
  for (const p of race.plans) {
    if (p.status !== 'draft') continue;
    out.push({ kind: 'race', key: `race-p:${p.planKey}`, desk: 'race', race: { type: 'plan', plan: p }, needs: 'Chief of Staff',
      amount: 0, title: `Approve the response plan: ${p.summary.split(';')[0]}`, sub: `${p.precedented} on precedent · ${p.novel} novel` });
  }
  for (const q of race.questions) {
    if (q.status !== 'open') continue;
    out.push({ kind: 'race', key: `race-q:${q.questionKey}`, desk: 'race', race: { type: 'question', question: q }, needs: role(q.routeRole),
      amount: Number(q.expectedLossCents), title: q.prompt, sub: q.incidentKey });
  }
  for (const a of race.actions) {
    if (a.status !== 'awaiting_approval') continue;
    out.push({ kind: 'race', key: `race-a:${a.actionKey}`, desk: 'race', race: { type: 'action', action: a }, needs: role(a.ownerRole),
      amount: 0, title: a.title, sub: a.kind.replace(/_/g, ' ') });
  }
  for (const e of race.effects) {
    if (e.status !== 'needs_person') continue;
    out.push({ kind: 'race', key: `race-e:${e.effectKey}`, desk: 'race', race: { type: 'effect', effect: e }, needs: 'Head of Racing Finance',
      amount: Number(e.midCents), title: e.memo, sub: `account ${e.bucket} · Jev unsure` });
  }
  for (const c of race.closes) {
    if (c.status !== 'draft') continue;
    out.push({ kind: 'race', key: `race-c:${c.closeKey}`, desk: 'race', race: { type: 'close', close: c }, needs: 'CFO', amount: 0,
      title: 'Approve the sealed weekend and send the briefs', sub: `root ${c.rootHash.slice(0, 10)}…` });
  }
  return out;
}

export function inboxItems(cc: CostCapData, queue: Queue | null, race?: Pick<RaceData, 'questions' | 'actions' | 'effects' | 'closes' | 'plans'>): InboxItem[] {
  const out: InboxItem[] = race ? raceInboxItems(race) : [];
  for (const w of cc.workItems) {
    if (w.state !== 'PROPOSED' && w.state !== 'NEEDS_INFO') continue;
    const gl = cc.glLines.get(w.subjectRef);
    const vendor = gl?.vendorId ? cc.vendors.get(gl.vendorId) : undefined;
    out.push({
      kind: 'item',
      key: `item:${w.id}`,
      desk: 'cost',
      item: w,
      needs: w.state === 'NEEDS_INFO' ? 'Controller or Head of Cost Cap' : needsHead(w, cc.materiality) ? 'Head of Cost Cap' : 'Controller',
      amount: Number(abs(w.amountUsdMinor)),
      title: gl?.memo ?? w.subjectRef,
      sub: [vendor?.name, gl ? `account ${gl.accountCode}` : null, w.subjectRef].filter(Boolean).join(' · '),
    });
  }
  for (const p of cc.policies) {
    if (p.state !== 'PROPOSED') continue;
    out.push({
      kind: 'policy',
      key: `policy:${p.id}`,
      desk: 'cost',
      policy: p,
      needs: 'Head of Cost Cap',
      amount: 0,
      title: p.policyKey,
      sub: `${p.precedentCount} precedents from 2025`,
    });
  }
  for (const e of queue?.parked ?? []) {
    out.push({
      kind: 'entry',
      key: `entry:${e.je_id}`,
      desk: 'revenue',
      entry: e,
      needs: e.needs.map((n) => (n === 'cfo' ? 'CFO' : n === 'controller' ? 'Controller' : n)).join(' + '),
      amount: e.total_cents,
      title: tidyMemo(e.memo),
      sub: e.je_id,
    });
  }
  for (const q of queue?.questions ?? []) {
    out.push({
      kind: 'question',
      key: `question:${q.q_id}`,
      desk: 'revenue',
      question: q,
      needs: q.to_role === 'cfo' ? 'CFO' : 'Controller',
      amount: 0,
      title: q.text,
      sub: q.subject,
    });
  }
  const rank = (i: InboxItem) =>
    i.kind === 'race' ? -1 : i.kind === 'entry' ? 0 : i.kind === 'question' || (i.kind === 'item' && i.item.state === 'NEEDS_INFO') ? 2 : i.kind === 'policy' ? 3 : 1;
  return out.sort((a, b) => rank(a) - rank(b) || b.amount - a.amount);
}

/** The entry for a key: from the inbox while it waits, else straight from the module (a line
 * someone just decided stays open with its outcome). */
export function resolveEntry(key: string | null, inbox: InboxItem[], cc: CostCapData): InboxItem | null {
  if (!key) return null;
  const hit = inbox.find((i) => i.key === key);
  if (hit) return hit;
  if (key.startsWith('item:')) {
    const w = cc.itemById.get(BigInt(key.slice(5)));
    return w
      ? { kind: 'item', key, desk: 'cost', item: w, needs: needsHead(w, cc.materiality) ? 'Head of Cost Cap' : 'Controller', amount: Number(abs(w.amountUsdMinor)), title: '', sub: '' }
      : null;
  }
  if (key.startsWith('policy:')) {
    const p = cc.policyById.get(BigInt(key.slice(7)));
    return p ? { kind: 'policy', key, desk: 'cost', policy: p, needs: 'Head of Cost Cap', amount: 0, title: '', sub: '' } : null;
  }
  return null;
}
