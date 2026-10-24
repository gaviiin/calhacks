// Shared matcher conformance (SCHEMA.md section 10, defect 11): every case in
// rulebook/pattern_conformance.json must hold for the module's matcher. The agents' Python
// matcher runs the same file, so an item one side matches, the other side matches too.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileMemoRegex, memoRegexMatches, nfkc, normaliseMemo, parsePattern } from '../src/util';

interface Conformance {
  match_cases: Array<{ memo_regex: string; memo: string; expected: boolean; why: string }>;
  rejected_regexes: Array<{ memo_regex: string; reason: string }>;
  pattern_acceptance: Array<{ pattern: Record<string, unknown>; accepted: boolean; reason?: string }>;
}

const FILE = fileURLToPath(new URL('../../../rulebook/pattern_conformance.json', import.meta.url));
const table = JSON.parse(readFileSync(FILE, 'utf8')) as Conformance;

// The file's own rule is "memo and memo_regex are NFKC-normalised". One case contradicts it:
// the Kelvin sign (U+212A) NFKC-normalises to ASCII K, so "kelvin" matches "KELVIN probe" on
// both sides, while the file expects false. The module follows the rule, and this entry
// documents the contradiction; it self-heals once the shared file is corrected (expected: true).
const CONTRADICTS_OWN_RULE = new Set(['kelvin|KELVIN probe|false']);

const label = (c: { memo_regex: string; memo: string }) => `${JSON.stringify(c.memo_regex)} vs ${JSON.stringify(c.memo)}`;

describe('rulebook/pattern_conformance.json', () => {
  it('has the three sections', () => {
    expect(table.match_cases.length).toBeGreaterThan(0);
    expect(table.rejected_regexes.length).toBeGreaterThan(0);
    expect(table.pattern_acceptance.length).toBeGreaterThan(0);
  });

  for (const c of table.match_cases) {
    const key = `${c.memo_regex}|${c.memo}|${c.expected}`;
    if (CONTRADICTS_OWN_RULE.has(key)) {
      it(`match_case ${label(c)}: the file says ${c.expected}, but NFKC maps the Kelvin sign to K`, () => {
        expect(nfkc(c.memo)).toBe('KELVIN probe');
        expect(memoRegexMatches(c.memo_regex, c.memo)).toBe(true);
      });
      continue;
    }
    it(`match_case ${label(c)} -> ${c.expected} (${c.why})`, () => {
      expect(memoRegexMatches(c.memo_regex, c.memo)).toBe(c.expected);
    });
  }

  for (const r of table.rejected_regexes) {
    it(`rejected_regex ${JSON.stringify(r.memo_regex.length > 40 ? `${r.memo_regex.slice(0, 40)}…` : r.memo_regex)} (${r.reason})`, () => {
      expect(() => compileMemoRegex(r.memo_regex)).toThrow();
      expect(() => parsePattern(JSON.stringify({ memo_regex: r.memo_regex }))).toThrow();
    });
  }

  for (const p of table.pattern_acceptance) {
    it(`pattern ${JSON.stringify(p.pattern)} accepted=${p.accepted}${p.reason ? ` (${p.reason})` : ''}`, () => {
      const parse = () => parsePattern(JSON.stringify(p.pattern));
      if (p.accepted) expect(parse).not.toThrow();
      else expect(parse).toThrow();
    });
  }
});

describe('matcher rules beyond the shared table', () => {
  it('normalises, strips and truncates the memo to 500 code points', () => {
    expect(normaliseMemo('  ｃanteen  \n')).toBe('canteen');
    const long = 'a'.repeat(600);
    expect(normaliseMemo(long)).toHaveLength(500);
    expect(memoRegexMatches('a{501}', long)).toBe(false);
    expect(memoRegexMatches('^a{500}$', long)).toBe(true);
    // Code points, not UTF-16 units: 500 two-byte characters survive whole.
    expect([...normaliseMemo('é'.repeat(600))]).toHaveLength(500);
  });

  it('matches case-insensitively with ASCII classes and no u flag', () => {
    expect(memoRegexMatches('CANTEEN', 'grove canteen')).toBe(true);
    expect(memoRegexMatches('\\w+', 'ÿ')).toBe(false);
    expect(memoRegexMatches('^\\W$', 'ÿ')).toBe(true);
    expect(compileMemoRegex('x').flags).toBe('i');
  });

  it('rejects nested quantifiers but not lazy, escaped or bracketed ones', () => {
    for (const bad of ['(a+)+', '(?:a*)*', '(a+)?', '(a{2,})+', '((a)+)+', '(ab?)*', '(a|b+){2}']) {
      expect(() => compileMemoRegex(bad), bad).toThrow('nested quantifiers');
    }
    for (const ok of ['(a+)', '(ab)+', 'a+?', '(\\+)+', '([+*])+', '(a+)b+', '(a)+(b)+', '\\d{1,3}', '(?:x|y)+z*']) {
      expect(() => compileMemoRegex(ok), ok).not.toThrow();
    }
  });

  it('rejects inline flags, lookbehind, named groups and Python-only syntax', () => {
    expect(() => compileMemoRegex('(?i)a')).toThrow('inline flags');
    expect(() => compileMemoRegex('(?-i:a)')).toThrow('inline flags');
    expect(() => compileMemoRegex('(?<=a)b')).toThrow('lookbehind and named groups');
    expect(() => compileMemoRegex('(?<!a)b')).toThrow('lookbehind and named groups');
    expect(() => compileMemoRegex('(?<n>a)')).toThrow('lookbehind and named groups');
    expect(() => compileMemoRegex('(?P<n>a)')).toThrow('inline flags');
    expect(() => compileMemoRegex('(?:a)')).not.toThrow();
    expect(() => compileMemoRegex('(?=a)')).not.toThrow();
    expect(() => compileMemoRegex('(?!a)')).not.toThrow();
  });

  it('rejects an empty pattern and keeps the typed-key checks', () => {
    expect(() => parsePattern('{}')).toThrow('at least one non-null key');
    expect(() => parsePattern('{"vendor_id":null}')).toThrow('at least one non-null key');
    expect(() => parsePattern('{"vendor":"x"}')).toThrow('unknown key');
    expect(() => parsePattern('{"related_party":"yes"}')).toThrow('must be a boolean');
    expect(parsePattern('{"vendor_id":"ven-001","memo_regex":"canteen"}')).toEqual({ vendor_id: 'ven-001', memo_regex: 'canteen' });
  });
});
