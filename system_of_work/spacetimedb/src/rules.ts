// The permission model as data: the roles matrix and the state machines.
// transition() reads these; nothing else decides who may do what.

export type Role =
  | 'none' // an identity with no row in `role`
  | 'admin'
  | 'sync'
  | 'ai_cap_analyst'
  | 'ai_policy_learner'
  | 'human_controller'
  | 'human_head_of_cost_cap'
  | 'gateway'
  | 'auto_approver'
  | 'red_team';

export const ASSIGNABLE_ROLES: readonly Role[] = [
  'admin',
  'sync',
  'ai_cap_analyst',
  'ai_policy_learner',
  'human_controller',
  'human_head_of_cost_cap',
  'gateway',
  'auto_approver',
  'red_team',
];

export type ResourceKind =
  | 'role'
  | 'role_invite'
  | 'setting'
  | 'rulebook_entry'
  | 'period'
  | 'gl_line'
  | 'bill_line'
  | 'vendor'
  | 'fair_value'
  | 'work_item'
  | 'policy';

export type Action =
  | 'bootstrap_admin'
  | 'create_role_invite'
  | 'claim_role'
  | 'set_setting'
  | 'load_rulebook_entry'
  | 'lock_period'
  | 'sync_upsert'
  | 'propose'
  | 'ask'
  | 'answer'
  | 'approve'
  | 'reject'
  | 'post'
  | 'propose_policy'
  | 'approve_policy'
  | 'reject_policy'
  | 'grant_autonomy'
  | 'revoke_autonomy'
  // Written by the module itself (never called): a sync correction or a superseding policy
  // version moved an open work item back to NEW (SCHEMA section 10).
  | 'reopen';

type Grants = Partial<Record<ResourceKind, readonly Action[]>>;

// role -> resource -> allowed actions (the deck's ROLES dict). No role but
// `gateway` can post; `red_team` can do nothing; `none` can only claim an invite.
// `auto_approver` can approve, and transition() further limits it to standing approvals.
export const ROLES: Record<Role, Grants> = {
  none: { role_invite: ['claim_role'] },
  admin: {
    role_invite: ['create_role_invite'],
    rulebook_entry: ['load_rulebook_entry'],
    setting: ['set_setting'],
  },
  sync: {
    gl_line: ['sync_upsert'],
    bill_line: ['sync_upsert'],
    vendor: ['sync_upsert'],
    fair_value: ['sync_upsert'],
  },
  ai_cap_analyst: { work_item: ['propose', 'ask'] },
  ai_policy_learner: { policy: ['propose_policy'] },
  human_controller: { work_item: ['approve', 'reject', 'answer'] },
  human_head_of_cost_cap: {
    work_item: ['approve', 'reject', 'answer'],
    policy: ['approve_policy', 'reject_policy', 'grant_autonomy', 'revoke_autonomy'],
    period: ['lock_period'],
  },
  gateway: { work_item: ['post'] },
  auto_approver: { work_item: ['approve'] },
  red_team: {},
};

export function can(role: string, resource: ResourceKind, action: Action): boolean {
  const grants = (ROLES as Record<string, Grants | undefined>)[role];
  return grants?.[resource]?.includes(action) ?? false;
}

export type Machine = 'work_item' | 'policy' | 'autonomy' | 'period' | 'role_invite';

// machine -> from state -> action -> to state. A missing entry is an invalid transition.
// 'ABSENT' is the pseudo-state of a row that does not exist yet.
export const TRANSITIONS: Record<Machine, Record<string, Partial<Record<Action, string>>>> = {
  work_item: {
    NEW: { propose: 'PROPOSED', ask: 'NEEDS_INFO' },
    PROPOSED: { ask: 'NEEDS_INFO', approve: 'APPROVED', reject: 'REJECTED' },
    NEEDS_INFO: { answer: 'NEW' },
    REJECTED: { propose: 'PROPOSED' },
    APPROVED: { post: 'POSTED' },
    POSTED: {},
  },
  policy: {
    ABSENT: { propose_policy: 'PROPOSED' },
    PROPOSED: { approve_policy: 'APPROVED', reject_policy: 'REJECTED' },
    APPROVED: {},
    REJECTED: {},
  },
  // policy.autonomy; granting also requires policy.state = APPROVED (a guard in transition()).
  // SUSPENDED is set by the module when a higher version of the same policy_key is approved;
  // the head may re-grant (or revoke) it.
  autonomy: {
    NONE: { grant_autonomy: 'GRANTED' },
    GRANTED: { revoke_autonomy: 'REVOKED' },
    REVOKED: { grant_autonomy: 'GRANTED' },
    SUSPENDED: { grant_autonomy: 'GRANTED', revoke_autonomy: 'REVOKED' },
  },
  period: {
    OPEN: { lock_period: 'LOCKED' },
    LOCKED: {},
  },
  role_invite: {
    ABSENT: { create_role_invite: 'UNUSED' },
    UNUSED: { claim_role: 'USED' },
    USED: {},
  },
};

// The state an action aims at, used as to_state on a denied audit row.
export const ACTION_TARGET: Partial<Record<Action, string>> = {
  propose: 'PROPOSED',
  ask: 'NEEDS_INFO',
  answer: 'NEW',
  approve: 'APPROVED',
  reject: 'REJECTED',
  post: 'POSTED',
  propose_policy: 'PROPOSED',
  approve_policy: 'APPROVED',
  reject_policy: 'REJECTED',
  grant_autonomy: 'GRANTED',
  revoke_autonomy: 'REVOKED',
  lock_period: 'LOCKED',
  create_role_invite: 'UNUSED',
  claim_role: 'USED',
};

// Actions refused on items whose period is locked (SCHEMA section 3).
export const PERIOD_LOCKED_ACTIONS: readonly Action[] = ['propose', 'approve', 'post'];

// At or above materiality, only the head of cost cap may decide (SCHEMA section 2:
// the controller may approve, reject, answer only below materiality).
export const MATERIALITY_ACTIONS: readonly Action[] = ['approve', 'reject', 'answer'];
export const MATERIALITY_ROLE: Role = 'human_head_of_cost_cap';

export const TREATMENTS = ['EXCLUDED', 'RELEVANT', 'ADJUSTMENT'] as const;

// propose.proposalSource (SCHEMA section 10). Only `deterministic` proposals may be auto-approved.
export const PROPOSAL_SOURCES = ['deterministic', 'llm', 'human_text'] as const;
export const DETERMINISTIC_SOURCE = 'deterministic';

// gl_line fields whose change on re-sync reopens an open work item (order = audit reason order).
export const REOPEN_FIELDS = [
  'amount_usd_minor',
  'amount_minor',
  'currency',
  'account_code',
  'vendor_id',
  'department_id',
  'memo',
  'posted_date',
  'period_key',
] as const;
// gl_line fields whose change on re-sync of a POSTED line creates a reversal.
export const REVERSAL_FIELDS = ['amount_usd_minor', 'account_code', 'period_key', 'vendor_id', 'department_id', 'memo'] as const;

export const SETTING_KEYS = {
  materiality: 'materiality_usd_minor',
  cap: 'cap_usd_minor',
  capYear: 'cap_year',
} as const;
export const INTEGER_SETTINGS: readonly string[] = [
  SETTING_KEYS.materiality,
  SETTING_KEYS.cap,
  SETTING_KEYS.capYear,
];

export const PATTERN_KEYS = [
  'vendor_id',
  'account_code',
  'department_id',
  'memo_regex',
  'related_party',
  'min_amount_usd_minor',
  'max_amount_usd_minor',
  // Tier 1 (SCHEMA section 11.2). description_regex matches bill line descriptions under the
  // same rules as memo_regex; entity and erp_category_code are exact matches on the gl line.
  'description_regex',
  'entity',
  'erp_category_code',
] as const;

// ---------- Tier 1: allocations (SCHEMA section 11.1) ----------

// proposeAllocations writes this marker into proposed_category_code / proposed_rulebook_entry_id;
// the split itself lives in the allocation table. post records it as posted_treatment.
export const ALLOCATED = 'ALLOCATED';
export const ALLOCATION_BASES = ['bill_line', 'share', 'cap_limit', 'cap_limit_excess'] as const;
// Categories that may be apportioned by a department share (D5.1.1.h.c, e.ii); RELEVANT is
// allowed on a share basis only as the complement of one of these. Everything else must be
// Directly Attributable, so a share basis is denied as apportionment_not_permitted.
export const APPORTIONABLE: readonly string[] = ['NON_F1', 'HERITAGE'];
export const RELEVANT_CATEGORY = 'RELEVANT';

// The standing-approval job: may approve only under a policy with autonomy GRANTED.
export const AUTONOMOUS_ROLE: Role = 'auto_approver';

// agent_step (SCHEMA section 6b).
export const STEP_KINDS = [
  'run_start',
  'read',
  'tool_call',
  'model_call',
  'decision',
  'note',
  'error',
  'run_end',
] as const;
// Byte limits (UTF-8). Oversize values are cut and end with TRUNCATION_MARKER.
export const STEP_LIMITS = {
  input: 8 * 1024,
  outputExcerpt: 2 * 1024,
  outputDigest: 128,
  runId: 256,
  name: 256,
  model: 256,
} as const;
export const TRUNCATION_MARKER = '…[truncated]';
