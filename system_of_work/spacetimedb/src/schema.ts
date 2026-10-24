// Tables for the cost_cap_desk system of work (SCHEMA.md section 6).
// TypeScript keys are camelCase; the module's default SnakeCase case-conversion
// policy makes every database column snake_case (period_key, amount_usd_minor, ...),
// and table names are given explicitly in snake_case.
import { schema, table, t } from 'spacetimedb/server';

const role = table(
  { name: 'role', public: true },
  {
    identity: t.identity().primaryKey(),
    role: t.string(),
    label: t.string(),
  }
);

// `code` holds the SHA-256 hex digest of the invite code, never the code itself:
// the table is public, so storing the plaintext would let any reader claim the role.
const roleInvite = table(
  { name: 'role_invite', public: true },
  {
    code: t.string().primaryKey(),
    role: t.string(),
    label: t.string(),
    used: t.bool(),
  }
);

const setting = table(
  { name: 'setting', public: true },
  {
    key: t.string().primaryKey(),
    value: t.string(),
  }
);

const period = table(
  { name: 'period', public: true },
  {
    key: t.string().primaryKey(),
    locked: t.bool(),
    lockedBy: t.option(t.identity()),
    lockedAt: t.option(t.timestamp()),
  }
);

const rulebookEntry = table(
  { name: 'rulebook_entry', public: true },
  {
    id: t.string().primaryKey(),
    categoryCode: t.string().index('btree'),
    treatment: t.string(),
    ruleVersion: t.string(),
    article: t.string(),
    effectiveFrom: t.string(),
    effectiveTo: t.option(t.string()),
    title: t.string(),
    text: t.string(),
    capLimitUsdMinor: t.option(t.i64()),
  }
);

const glLine = table(
  { name: 'gl_line', public: true },
  {
    id: t.string().primaryKey(),
    rawRef: t.string(),
    postedDate: t.string(),
    periodKey: t.string().index('btree'),
    accountId: t.string(),
    accountCode: t.string(),
    departmentId: t.string(),
    vendorId: t.option(t.string()),
    billId: t.option(t.string()),
    amountMinor: t.i64(),
    currency: t.string(),
    fxRateE6: t.i64(), // the host's SnakeCase policy names this column fx_rate_e_6
    amountUsdMinor: t.i64(),
    memo: t.string(),
    erpCategoryCode: t.string(),
    entity: t.string(),
    correctionOf: t.option(t.string()),
    syncedAt: t.timestamp(),
  }
);

const billLine = table(
  {
    name: 'bill_line',
    public: true,
    // Option columns take no inline .index(); declared here instead.
    indexes: [{ accessor: 'glLineId', algorithm: 'btree', columns: ['glLineId'] }],
  },
  {
    id: t.string().primaryKey(),
    rawRef: t.string(),
    billId: t.string().index('btree'),
    glLineId: t.option(t.string()),
    lineNo: t.u32(),
    description: t.string(),
    amountMinor: t.i64(),
    billText: t.string(),
    vendorId: t.string(),
    bankIbanOnBill: t.string(),
  }
);

const vendor = table(
  { name: 'vendor', public: true },
  {
    id: t.string().primaryKey(),
    rawRef: t.string(),
    name: t.string(),
    country: t.string(),
    relatedParty: t.bool(),
    relatedPartyEntity: t.option(t.string()),
    bankIban: t.string(),
    categoryHint: t.option(t.string()),
  }
);

const fairValue = table(
  { name: 'fair_value', public: true },
  {
    id: t.string().primaryKey(),
    rawRef: t.string(),
    counterpartyVendorId: t.string().index('btree'),
    item: t.string(),
    contractValueMinor: t.i64(),
    fairValueMinor: t.i64(),
    currency: t.string(),
    effectiveFrom: t.string(),
    basis: t.string(),
  }
);

const workItem = table(
  { name: 'work_item', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    kind: t.string(),
    subjectRef: t.string().index('btree'),
    periodKey: t.string().index('btree'),
    amountUsdMinor: t.i64(),
    state: t.string().index('btree'),
    proposedBy: t.option(t.identity()),
    proposedCategoryCode: t.option(t.string()),
    proposedRulebookEntryId: t.option(t.string()),
    proposedPolicyId: t.option(t.u64()),
    reason: t.string(),
    evidenceRefs: t.string(),
    question: t.option(t.string()),
    answer: t.option(t.string()),
    decidedBy: t.option(t.identity()),
    decidedReason: t.option(t.string()),
    erpEntryId: t.option(t.string()),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    // SCHEMA section 10. Who answered the last question (separation of duties at approve/reject).
    answeredBy: t.option(t.identity()),
    // propose: signed cap effect for ADJUSTMENT treatments (absent otherwise) and the proposal's
    // provenance: deterministic | llm | human_text ("" until proposed).
    capEffectUsdMinor: t.option(t.i64()),
    proposalSource: t.string(),
    // Reversals: the POSTED item this one backs out (also its subject_ref). Set at post on the
    // reversed item once its cap effect has been subtracted.
    reversesItemId: t.option(t.u64()),
    superseded: t.bool(),
    // What post actually booked, so a later reversal backs out exactly that.
    postedCapEffectUsdMinor: t.option(t.i64()),
    postedTreatment: t.option(t.string()),
  }
);

const policy = table(
  { name: 'policy', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    policyKey: t.string().index('btree'),
    version: t.u32(),
    categoryCode: t.string(),
    rulebookEntryId: t.string(),
    pattern: t.string(),
    rationale: t.string(),
    evidenceRefs: t.string(),
    precedentCount: t.u32(),
    effectiveFrom: t.string(),
    effectiveTo: t.option(t.string()),
    state: t.string(),
    proposedBy: t.identity(),
    decidedBy: t.option(t.identity()),
    decidedReason: t.option(t.string()),
    createdAt: t.timestamp(),
    decidedAt: t.option(t.timestamp()),
    // Earned autonomy (SCHEMA sections 2, 10). autonomy: NONE | GRANTED | REVOKED | SUSPENDED.
    // autonomy_by/_reason/_at describe the latest grant or revoke; autonomy_evidence
    // keeps the sandbox record JSON of the latest grant.
    autonomy: t.string(),
    autonomyBy: t.option(t.identity()),
    autonomyEvidence: t.string(),
    autonomyReason: t.option(t.string()),
    autonomyAt: t.option(t.timestamp()),
  }
);

const precedent = table(
  { name: 'precedent', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    workItemId: t.u64().index('btree'),
    patternSummary: t.string(),
    categoryCode: t.string(),
    decidedBy: t.identity(),
    reason: t.string(),
    at: t.timestamp(),
  }
);

const auditLog = table(
  { name: 'audit_log', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    at: t.timestamp(),
    actor: t.identity(),
    actorRole: t.string(),
    action: t.string(),
    resourceKind: t.string(),
    subjectId: t.string().index('btree'),
    allowed: t.bool(),
    fromState: t.string(),
    toState: t.string(),
    reason: t.string(),
    diff: t.string(),
    evidence: t.string(),
    policyId: t.option(t.u64()),
    policyVersion: t.option(t.u32()),
  }
);

// Everything an agent does between transitions (SCHEMA section 6b). Append-only.
const agentStep = table(
  {
    name: 'agent_step',
    public: true,
    indexes: [{ accessor: 'workItemId', algorithm: 'btree', columns: ['workItemId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    runId: t.string().index('btree'),
    actor: t.identity(),
    actorRole: t.string(),
    step: t.u32(),
    kind: t.string(),
    name: t.string(),
    input: t.string(),
    outputDigest: t.string(),
    outputExcerpt: t.string(),
    workItemId: t.option(t.u64()),
    model: t.option(t.string()),
    at: t.timestamp(),
  }
);

const capPosition = table(
  { name: 'cap_position', public: true },
  {
    periodKey: t.string().primaryKey(),
    relevantUsdMinor: t.i64(),
    excludedUsdMinor: t.i64(),
    pendingUsdMinor: t.i64(),
    postedItems: t.u32(),
    updatedAt: t.timestamp(),
  }
);

const spacetimedb = schema({
  role,
  roleInvite,
  setting,
  period,
  rulebookEntry,
  glLine,
  billLine,
  vendor,
  fairValue,
  workItem,
  policy,
  precedent,
  auditLog,
  capPosition,
  agentStep,
});

export default spacetimedb;
