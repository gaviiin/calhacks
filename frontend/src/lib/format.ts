// Money arrives as USD minor units (cost cap desk, bigint from SpacetimeDB) or cents (revenue desk,
// number from the API). Both are hundredths of a dollar.

export type Minor = bigint | number;

const num = (v: Minor) => (typeof v === 'bigint' ? Number(v) : v);

export function usd(v: Minor, opts: { cents?: boolean } = {}): string {
  const dollars = num(v) / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.cents ? 2 : 0,
  });
}

/** $19.6m, $636k, $4,352: the compact form the desk speaks in. */
export function usdShort(v: Minor): string {
  const d = num(v) / 100;
  const a = Math.abs(d);
  const sign = d < 0 ? '−' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}bn`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}m`;
  if (a >= 1e4) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function clock(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function dayTime(d: Date): string {
  return d.toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** Category codes read as words: COMPETITION_TRAVEL -> Competition travel. */
export function categoryName(code: string | undefined | null): string {
  if (!code) return '—';
  if (code === 'ALLOCATED') return 'Split across categories';
  const words = code.replace(/^ADJ_/, 'Adjustment: ').replace(/_/g, ' ').toLowerCase();
  return words
    .replace(/\bf1\b/g, 'F1')
    .replace(/\bpu\b/g, 'PU')
    .replace(/\bfx\b/g, 'FX')
    .replace(/\bfia\b/g, 'FIA')
    .replace(/\bhr\b/g, 'HR')
    .replace(/\bbcdr\b/g, 'BCDR')
    .replace(/\bnon f1\b/gi, 'Non-F1')
    .replace(/^./, (c) => c.toUpperCase());
}

export function parseJson<T>(s: string | undefined | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

const ROLE_WORDS: Record<string, string> = {
  ai_cap_analyst: 'Cap Analyst',
  ai_policy_learner: 'Policy Learner',
  human_controller: 'Controller',
  human_head_of_cost_cap: 'Head of Cost Cap',
  gateway: 'ERP gateway',
  sync: 'sync job',
  auto_approver: 'standing-approval job',
  red_team: 'red team',
  admin: 'bootstrap admin',
  none: 'unseated identity',
};

const ACTION_WORDS: Record<string, string> = {
  approve: 'approve it',
  reject: 'reject it',
  answer: 'answer it',
  post: 'post to the ERP',
  propose: 'propose a classification',
  ask: 'ask a question',
  lock_period: 'lock the month',
  propose_policy: 'propose a policy',
  approve_policy: 'approve a policy',
  reject_policy: 'reject a policy',
  grant_autonomy: 'grant a policy autonomy',
  upsert_gl_line: 'write ledger lines',
};

/** The module's refusal codes ("materiality: |amount_usd_minor| 226787601 >= ...; role_not_permitted: ...")
 * as sentences that name the problem and who can act instead. */
export function refusalText(reason: string): string {
  const parts = reason.split(/;\s*(?=[a-z_]+:)/);
  return parts
    .map((p) => {
      const [code, ...rest] = p.split(':');
      const body = rest.join(':').trim();
      switch (code.trim()) {
        case 'materiality': {
          const m = body.match(/(\d+)\s*>=\s*materiality_usd_minor\s*(\d+)/);
          return m
            ? `${usdShort(Number(m[1]))} is above the ${usdShort(Number(m[2]))} materiality line, so only the Head of Cost Cap may approve it.`
            : 'Above materiality: only the Head of Cost Cap may approve it.';
        }
        case 'role_not_permitted': {
          const m = body.match(/role '([^']+)' may not (\w+) on (\w+)/);
          if (!m) return body;
          const who = ROLE_WORDS[m[1]] ?? m[1];
          if (m[2] === 'claim_role') return `This identity already holds the ${who} seat: one identity, one seat.`;
          return `The ${who} may not ${ACTION_WORDS[m[2]] ?? `${m[2].replace(/_/g, ' ')} a ${m[3].replace(/_/g, ' ')}`}.`;
        }
        case 'separation_of_duties':
          return 'Nobody may approve a proposal they made themselves.';
        case 'invalid_transition': {
          const m = body.match(/(\w+) in state (\w+) has no '(\w+)' transition/);
          if (!m) return body;
          if (m[1] === 'role_invite') return 'That seat code has already been used.';
          return `It is already ${m[2].toLowerCase().replace(/_/g, ' ')}, so there is nothing to ${ACTION_WORDS[m[3]] ?? m[3].replace(/_/g, ' ')}.`;
        }
        case 'period_not_ready':
          return 'The month cannot be locked while work items are still open.';
        case 'cap_limit_exceeded':
          return 'Posting it would take the category past its limit under the regulations.';
        default:
          return p.trim();
      }
    })
    .join(' ');
}

/** Revenue memos read as the desk speaks: arrows, compact sums, no doubled sponsor id. */
export function tidyMemo(memo: string): string {
  return memo
    .replace(/\s->\s/g, ' → ')
    .replace(/\$([\d,]{9,})\.\d{2}/g, (_m, d: string) => usdShort(Number(d.replace(/,/g, '')) * 100))
    .replace(/\b([a-z]+) (?=([A-Z][a-z]+))/g, (m, id: string, next: string) => (id === next.toLowerCase() ? '' : m));
}
