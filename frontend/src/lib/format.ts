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
