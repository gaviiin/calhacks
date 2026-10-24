// Pure helpers: JSON snapshots and diffs, dates, validation, SHA-256, policy patterns.
// Nothing here touches the database.
import { SenderError } from 'spacetimedb/server';
import { PATTERN_KEYS } from './rules';

// ---------- JSON snapshots and diffs ----------

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Snapshot = Record<string, Json>;
export type Diff = Record<string, { from: Json; to: Json }>;

// Matches the host's SnakeCase policy, which also splits letter→digit (fxRateE6 → fx_rate_e_6).
export function snakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-zA-Z])(\d)/g, '$1_$2')
    .toLowerCase();
}

// bigint -> number when safe (string otherwise), Identity -> hex, Timestamp -> ISO,
// undefined -> null. Keys of plain objects become snake_case column names.
export function toJson(v: unknown): Json {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown> & {
      toHexString?: () => string;
      toISOString?: () => string;
    };
    if (typeof o.toHexString === 'function') return o.toHexString();
    if (typeof o.toISOString === 'function') return o.toISOString();
    const out: Record<string, Json> = {};
    for (const [k, val] of Object.entries(o)) out[snakeCase(k)] = toJson(val);
    return out;
  }
  return String(v);
}

export function snap(row: object | null | undefined): Snapshot | null {
  if (!row) return null;
  return toJson(row) as Snapshot;
}

// Bookkeeping columns that change on every write; the audit row's `at` covers them.
const DIFF_IGNORED = new Set(['updated_at', 'synced_at']);

export function diffSnapshots(before: Snapshot | null, after: Snapshot | null): Diff {
  const out: Diff = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    if (DIFF_IGNORED.has(k)) continue;
    const a = before ? (before[k] ?? null) : null;
    const b = after ? (after[k] ?? null) : null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b };
  }
  return out;
}

export function jsonString(v: unknown): string {
  return JSON.stringify(toJson(v));
}

// ---------- dates and periods ----------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_KEY = /^(\d{4})-(\d{2})$/;

export function requireIsoDate(field: string, v: string): string {
  const m = ISO_DATE.exec(v);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31) {
    throw new SenderError(`${field} must be an ISO date YYYY-MM-DD, got ${JSON.stringify(v)}`);
  }
  return v;
}

export function requirePeriodKey(field: string, v: string): string {
  const m = PERIOD_KEY.exec(v);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
    throw new SenderError(`${field} must be a period key YYYY-MM, got ${JSON.stringify(v)}`);
  }
  return v;
}

export function periodBounds(periodKey: string): { first: string; last: string } {
  const m = PERIOD_KEY.exec(periodKey);
  if (!m) throw new SenderError(`bad period key ${JSON.stringify(periodKey)}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return { first: `${m[1]}-${m[2]}-01`, last: `${m[1]}-${m[2]}-${String(days).padStart(2, '0')}` };
}

// A window [from, to] (to null = open-ended) covers the whole period.
export function windowCoversPeriod(from: string, to: string | undefined, periodKey: string): boolean {
  const { first, last } = periodBounds(periodKey);
  return from <= first && (to === undefined || to >= last);
}

export function windowCoversDate(from: string, to: string | undefined, date: string): boolean {
  return from <= date && (to === undefined || to >= date);
}

// ---------- validation ----------

export function requireNonEmpty(field: string, v: string): string {
  if (v.trim() === '') throw new SenderError(`${field} must not be empty`);
  return v;
}

export function isIntegerString(v: string): boolean {
  return /^-?\d+$/.test(v.trim());
}

// ---------- SHA-256 (invite codes are stored hashed in a public table) ----------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const len = bytes.length;
  const padded = (((len + 9 + 63) / 64) | 0) * 64;
  const buf = new Uint8Array(padded);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(padded - 8, Math.floor(len / 0x20000000));
  dv.setUint32(padded - 4, (len << 3) >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (k + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + k) >>> 0;
  }
  return Array.from(h, x => x.toString(16).padStart(8, '0')).join('');
}

// ---------- policy patterns ----------

export type Pattern = {
  vendor_id?: string;
  account_code?: string;
  department_id?: string;
  memo_regex?: string;
  related_party?: boolean;
  min_amount_usd_minor?: bigint;
  max_amount_usd_minor?: bigint;
};

// ---- memo matching (SCHEMA section 10, defect 11; mirrored by the agents' Python matcher
// with re.ASCII | re.IGNORECASE and the shared rulebook/pattern_conformance.json) ----

export const MEMO_REGEX_MAX_CODE_POINTS = 200;
export const MEMO_MAX_CODE_POINTS = 500;

// String.prototype.normalize is a no-op on a V8 built without ICU. Detect that once and fall
// back to the compatibility mappings that matter for memos: fullwidth ASCII, Unicode spaces,
// the Kelvin and Angstrom signs.
const NATIVE_NFKC = (() => {
  try {
    return 'ｃ'.normalize('NFKC') === 'c';
  } catch {
    return false;
  }
})();

export function nfkc(s: string): string {
  if (NATIVE_NFKC) return s.normalize('NFKC');
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xff01 && cp <= 0xff5e) out += String.fromCharCode(cp - 0xff01 + 0x21);
    else if (cp === 0x3000 || cp === 0xa0 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f) out += ' ';
    else if (cp === 0x212a) out += 'K';
    else if (cp === 0x212b) out += 'Å';
    else out += ch;
  }
  return out;
}

// Characters outside the BMP are one Python char but two JS code units; both matchers treat a
// memo containing one as matching no memo_regex, and reject a regex containing one.
export function hasAstral(s: string): boolean {
  return /[\ud800-\udfff]/.test(s);
}

export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function truncateCodePoints(s: string, max: number): string {
  let out = '';
  let n = 0;
  for (const ch of s) {
    if (n++ >= max) break;
    out += ch;
  }
  return out;
}

// NFKC, strip surrounding whitespace, cut to MEMO_MAX_CODE_POINTS.
export function normaliseMemo(memo: string): string {
  return truncateCodePoints(nfkc(memo).trim(), MEMO_MAX_CODE_POINTS);
}

const QUANTIFIER_BRACE = /^\{\d+(,\d*)?\}/;

// One pass over the regex source: refuses group syntax the two engines read differently
// (inline flags, lookbehind, named groups) and a quantifier applied to a group that itself
// contains a quantifier (catastrophic backtracking). Returns the reason, or undefined.
function memoRegexSyntaxError(src: string): string | undefined {
  const groups: boolean[] = []; // per open group: contains a quantifier
  let afterGroup = false; // the previous token closed a group ...
  let closedHadQuantifier = false; // ... that contained a quantifier
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      i += 2;
      afterGroup = false;
      continue;
    }
    if (c === '[') {
      i++;
      if (src[i] === '^') i++;
      if (src[i] === ']') i++;
      while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
      i++;
      afterGroup = false;
      continue;
    }
    if (c === '(') {
      groups.push(false);
      i++;
      if (src[i] === '?') {
        const next = src[i + 1] ?? '';
        if (next === ':' || next === '=' || next === '!') i += 2;
        else if (next === '<') return 'lookbehind and named groups are not allowed';
        else if (/[A-Za-z-]/.test(next)) return 'inline flags are not allowed (matching is always case-insensitive)';
        else return 'unsupported group syntax after "(?"';
      }
      afterGroup = false;
      continue;
    }
    if (c === ')') {
      closedHadQuantifier = groups.pop() ?? false;
      afterGroup = true;
      i++;
      continue;
    }
    let quantifierLength = 0;
    if (c === '*' || c === '+' || c === '?') quantifierLength = 1;
    else if (c === '{') quantifierLength = QUANTIFIER_BRACE.exec(src.slice(i))?.[0].length ?? 0;
    if (quantifierLength > 0) {
      if (afterGroup && closedHadQuantifier) return 'nested quantifiers are not allowed';
      for (let g = 0; g < groups.length; g++) groups[g] = true;
      i += quantifierLength;
      if (src[i] === '?') i++; // lazy modifier
      afterGroup = false;
      continue;
    }
    afterGroup = false;
    i++;
  }
  return undefined;
}

// NFKC-normalises the source, enforces the shared rules, and compiles it with the `i` flag
// and without `u` (ASCII \d \w \b semantics). Throws SenderError with the reason.
export function compileMemoRegex(src: string): RegExp {
  const body = nfkc(src);
  if (codePointLength(body) > MEMO_REGEX_MAX_CODE_POINTS) {
    throw new SenderError(`memo_regex is longer than ${MEMO_REGEX_MAX_CODE_POINTS} characters`);
  }
  if (hasAstral(body)) throw new SenderError('memo_regex must not contain characters outside the Basic Multilingual Plane');
  const syntax = memoRegexSyntaxError(body);
  if (syntax) throw new SenderError(`memo_regex rejected: ${syntax}`);
  try {
    return new RegExp(body, 'i');
  } catch (e) {
    throw new SenderError(`memo_regex does not compile as a JS RegExp: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// The one memo matcher: regex search over the normalised memo. A memo with astral characters
// matches nothing.
export function memoRegexMatches(regexSrc: string, memo: string): boolean {
  const re = compileMemoRegex(regexSrc);
  const m = normaliseMemo(memo);
  if (hasAstral(m)) return false;
  return re.test(m);
}

function toBigIntAmount(key: string, v: unknown): bigint {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && isIntegerString(v)) return BigInt(v.trim());
  throw new SenderError(`pattern.${key} must be an integer (minor units)`);
}

// Throws SenderError on malformed input: not a JSON object, unknown keys, wrong types,
// or a memo_regex the module cannot compile.
export function parsePattern(text: string): Pattern {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SenderError('pattern must be a JSON object string');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SenderError('pattern must be a JSON object string');
  }
  const out: Pattern = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(PATTERN_KEYS as readonly string[]).includes(key)) {
      throw new SenderError(`pattern has unknown key ${JSON.stringify(key)}; allowed: ${PATTERN_KEYS.join(', ')}`);
    }
    if (v === null) continue;
    switch (key) {
      case 'vendor_id':
      case 'account_code':
      case 'department_id':
      case 'memo_regex':
        if (typeof v !== 'string') throw new SenderError(`pattern.${key} must be a string`);
        out[key] = v;
        break;
      case 'related_party':
        if (typeof v !== 'boolean') throw new SenderError('pattern.related_party must be a boolean');
        out.related_party = v;
        break;
      case 'min_amount_usd_minor':
      case 'max_amount_usd_minor':
        out[key] = toBigIntAmount(key, v);
        break;
    }
  }
  if (Object.keys(out).length === 0) {
    throw new SenderError('pattern must have at least one non-null key (an empty pattern would match every line)');
  }
  if (out.memo_regex !== undefined) {
    try {
      compileMemoRegex(out.memo_regex);
    } catch (e) {
      throw new SenderError(`pattern.memo_regex ${JSON.stringify(out.memo_regex)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export type PatternSubject = {
  vendorId?: string;
  accountCode: string;
  departmentId: string;
  memo: string;
  amountUsdMinor: bigint;
  relatedParty?: boolean; // undefined when the vendor is unknown
};

// Returns the keys that fail to match (empty = match). Mirrors the agents' Python matcher.
export function patternMismatches(p: Pattern, s: PatternSubject): string[] {
  const bad: string[] = [];
  if (p.vendor_id !== undefined && s.vendorId !== p.vendor_id) bad.push('vendor_id');
  if (p.account_code !== undefined && s.accountCode !== p.account_code) bad.push('account_code');
  if (p.department_id !== undefined && s.departmentId !== p.department_id) bad.push('department_id');
  if (p.memo_regex !== undefined && !memoRegexMatches(p.memo_regex, s.memo)) bad.push('memo_regex');
  if (p.related_party !== undefined && s.relatedParty !== p.related_party) bad.push('related_party');
  if (p.min_amount_usd_minor !== undefined && s.amountUsdMinor < p.min_amount_usd_minor) bad.push('min_amount_usd_minor');
  if (p.max_amount_usd_minor !== undefined && s.amountUsdMinor > p.max_amount_usd_minor) bad.push('max_amount_usd_minor');
  return bad;
}

export function excerpt(s: string, n = 120): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ---------- agent_step helpers ----------

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

// Cuts `s` to at most `maxBytes` UTF-8 bytes, ending with `marker`, without splitting a
// code point. Values that already fit are returned unchanged.
export function truncateUtf8(s: string, maxBytes: number, marker: string): string {
  if (utf8Length(s) <= maxBytes) return s;
  const budget = maxBytes - utf8Length(marker);
  let used = 0;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out + marker;
}

// A JSON object with at least one key, or a JSON array with at least one element.
export function requireNonEmptyJson(field: string, text: string): string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new SenderError(`${field} must be JSON (an object or array), got ${JSON.stringify(excerpt(text, 60))}`);
  }
  const empty =
    v === null ||
    typeof v !== 'object' ||
    (Array.isArray(v) ? v.length === 0 : Object.keys(v as object).length === 0);
  if (empty) throw new SenderError(`${field} must be a non-empty JSON object or array`);
  return text;
}
