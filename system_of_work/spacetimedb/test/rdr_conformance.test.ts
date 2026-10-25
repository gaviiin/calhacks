// Shared Ripple-Down Rule conformance (SCHEMA.md section 11.2): every case in
// rulebook/rdr_conformance.json must resolve the same way in the module as in the agents' Python
// resolver. Each case is loaded into real tables (policy, gl_line, bill_line) of a fresh in-memory
// module and resolved through resolve(ctx, line, period, billLineId?), the function the module's
// validation uses.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Timestamp } from 'spacetimedb';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as mod from '../src/index';
import { resolve } from '../src/rdr';

interface CasePolicy {
  id: number;
  policy_key: string;
  version: number;
  category_code: string;
  rulebook_entry_id: string;
  pattern: Record<string, unknown>;
  parent_policy_id: number | null;
  state: string;
  effective_from: string;
  effective_to: string | null;
}
interface Case {
  name: string;
  policies: CasePolicy[];
  line: {
    id: string;
    vendor_id: string | null;
    account_code: string;
    department_id: string;
    memo: string;
    amount_usd_minor: number;
    entity: string;
    erp_category_code: string;
    bill_lines: { id: string; description: string }[];
  };
  period: string;
  context?: { bill_line_id?: string };
  expected: { result: 'category' | 'none' | 'conflict'; category_code?: string; policy_id?: number };
}

const FILE = fileURLToPath(new URL('../../../rulebook/rdr_conformance.json', import.meta.url));
const table = JSON.parse(readFileSync(FILE, 'utf8')) as { cases: Case[] };

function load(c: Case) {
  const h = createModuleTestHarness(spacetimedb, mod);
  h.clock.set(new Timestamp(1_773_446_400_000_000n));
  h.withReducerTx(TestAuth.internal(), ctx => {
    // Insert parents first so explicit ids are used as given.
    for (const p of [...c.policies].sort((a, b) => a.id - b.id)) {
      const row = ctx.db.policy.insert({
        id: BigInt(p.id),
        policyKey: p.policy_key,
        version: p.version,
        categoryCode: p.category_code,
        rulebookEntryId: p.rulebook_entry_id,
        pattern: JSON.stringify(p.pattern),
        rationale: c.name,
        evidenceRefs: '[]',
        precedentCount: 0,
        effectiveFrom: p.effective_from,
        effectiveTo: p.effective_to ?? undefined,
        state: p.state,
        proposedBy: ctx.sender,
        decidedBy: undefined,
        decidedReason: undefined,
        createdAt: ctx.timestamp,
        decidedAt: undefined,
        autonomy: 'NONE',
        autonomyBy: undefined,
        autonomyEvidence: '',
        autonomyReason: undefined,
        autonomyAt: undefined,
        parentPolicyId: p.parent_policy_id === null ? undefined : BigInt(p.parent_policy_id),
        cornerstones: '[]',
        flipReport: '{}',
      });
      expect(row.id).toBe(BigInt(p.id));
    }
    const l = c.line;
    ctx.db.glLine.insert({
      id: l.id,
      rawRef: `gl_line:${l.id}:1`,
      postedDate: `${c.period}-15`,
      periodKey: c.period,
      accountId: `acct-${l.account_code}`,
      accountCode: l.account_code,
      departmentId: l.department_id,
      vendorId: l.vendor_id ?? undefined,
      billId: l.bill_lines.length ? 'bill-1' : undefined,
      amountMinor: BigInt(l.amount_usd_minor),
      currency: 'USD',
      fxRateE6: 1_000_000n,
      amountUsdMinor: BigInt(l.amount_usd_minor),
      memo: l.memo,
      erpCategoryCode: l.erp_category_code,
      entity: l.entity,
      correctionOf: undefined,
      syncedAt: ctx.timestamp,
    });
    l.bill_lines.forEach((b, i) =>
      ctx.db.billLine.insert({
        id: b.id,
        rawRef: `bill_line:${b.id}:1`,
        billId: 'bill-1',
        glLineId: l.id,
        lineNo: i + 1,
        description: b.description,
        amountMinor: 0n,
        billText: '',
        vendorId: l.vendor_id ?? '',
        bankIbanOnBill: '',
      })
    );
  });
  return h;
}

describe('rulebook/rdr_conformance.json', () => {
  it('has cases', () => expect(table.cases.length).toBeGreaterThan(0));

  for (const c of table.cases) {
    it(`${c.name} -> ${c.expected.result}${c.expected.category_code ? ` ${c.expected.category_code} (pol ${c.expected.policy_id})` : ''}`, () => {
      const h = load(c);
      const res = h.withReducerTx(TestAuth.internal(), ctx =>
        resolve(ctx, ctx.db.glLine.id.find(c.line.id)!, c.period, c.context?.bill_line_id)
      );
      expect(res.result).toBe(c.expected.result);
      if (c.expected.result === 'category' && res.result === 'category') {
        expect(res.categoryCode).toBe(c.expected.category_code);
        expect(res.policyId).toBe(BigInt(c.expected.policy_id!));
      }
    });
  }
});
