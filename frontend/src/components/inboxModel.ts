import type { Policy, WorkItem } from '../cost_cap_bindings/types';
import { abs, needsHead, type CostCapData } from '../lib/costcap';
import { tidyMemo } from '../lib/format';
import type { Parked, Queue } from '../lib/revenue';

// Everything that waits for a person, from both desks, in one list.

export type InboxItem =
  | { kind: 'item'; key: string; desk: 'cost'; item: WorkItem; needs: string; amount: number; title: string; sub: string }
  | { kind: 'policy'; key: string; desk: 'cost'; policy: Policy; needs: string; amount: number; title: string; sub: string }
  | { kind: 'entry'; key: string; desk: 'revenue'; entry: Parked; needs: string; amount: number; title: string; sub: string };

export function inboxItems(cc: CostCapData, queue: Queue | null): InboxItem[] {
  const out: InboxItem[] = [];
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
  const rank = (i: InboxItem) => (i.kind === 'entry' ? 0 : i.kind === 'item' && i.item.state === 'NEEDS_INFO' ? 2 : i.kind === 'policy' ? 3 : 1);
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
