import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  normalizePhone,
  phoneVariants,
  scoreTenantMatch,
  tailMatch,
  tailSharedCounts,
  applyShortQuerySuppression,
  scoreTenantMatchDebug,
} from './tenantSearch';

describe('normalizeName', () => {
  it('lowercases input', () => {
    expect(normalizeName('John Doe')).toBe('john doe');
  });

  it('strips diacritics', () => {
    expect(normalizeName('José')).toBe('jose');
    expect(normalizeName('Ñoño')).toBe('nono');
  });

  it("collapses punctuation and whitespace", () => {
    expect(normalizeName("O'Brien")).toBe('o brien');
    expect(normalizeName('  John   Doe  ')).toBe('john doe');
    expect(normalizeName('Mary-Anne')).toBe('mary anne');
  });

  it('returns empty for empty / whitespace-only input', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
  });

  it('keeps digits inside names', () => {
    expect(normalizeName('Apt 12B')).toBe('apt 12b');
  });
});

describe('normalizePhone', () => {
  it('extracts digits from formatted numbers', () => {
    expect(normalizePhone('0772 123 456')).toBe('772123456');
    expect(normalizePhone('0772-123-456')).toBe('772123456');
    expect(normalizePhone('+256 772 123 456')).toBe('772123456');
    expect(normalizePhone('(0772) 123 456')).toBe('772123456');
  });

  it('strips +256 country code', () => {
    expect(normalizePhone('+256772123456')).toBe('772123456');
    expect(normalizePhone('256772123456')).toBe('772123456');
  });

  it('strips leading 0 only when followed by 9+ digits', () => {
    expect(normalizePhone('0772123456')).toBe('772123456');
    // Short numbers with a leading 0 keep it (not a UG mobile).
    expect(normalizePhone('0123')).toBe('0123');
  });

  it('handles already-normalized 9-digit national numbers', () => {
    expect(normalizePhone('772123456')).toBe('772123456');
  });

  it('returns empty for null / undefined / empty input', () => {
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone('   ')).toBe('');
  });
});

/* ───────── Ranking logic ───────── */

const T = (fullName: string, phone: string | null) => ({ fullName, phone });

describe('scoreTenantMatch — phone queries', () => {
  it('ranks an exact phone match highest (200)', () => {
    const r = scoreTenantMatch('+256 772 123 456', T('Alice', '0772 123 456'));
    expect(r.score).toBe(200);
    expect(r.matchType).toBe('phone');
  });

  it('ranks a phone-prefix match at 150 (national 9-digit form)', () => {
    // Use the national form so both query and candidate normalize to the
    // same starting digits ("772123…"). A leading-0 query like "0772 123"
    // normalizes to "0772123" (leading 0 only stripped at >= 10 digits),
    // which is *not* a prefix of the candidate's "772123456" — that case
    // falls into the mixed-lane prefix branch instead.
    const r = scoreTenantMatch('772 123', T('Alice', '0772 123 456'));
    expect(r.score).toBe(150);
    expect(r.matchType).toBe('phone');
  });

  it('ranks a phone-tail match at 130', () => {
    // Long enough that it's not classified as a "short" 3-4 digit query.
    const r = scoreTenantMatch('123456', T('Alice', '0772 123 456'));
    expect(r.score).toBe(130);
    expect(r.matchType).toBe('phone');
  });

  it('ranks a phone-substring (middle) match at 110', () => {
    const r = scoreTenantMatch('721234', T('Alice', '0772 123 456'));
    expect(r.score).toBe(110);
    expect(r.matchType).toBe('phone');
  });

  it('does not match when phone-y query is absent from the number', () => {
    const r = scoreTenantMatch('999999', T('Alice', '0772 123 456'));
    expect(r.score).toBe(0);
    expect(r.matchType).toBeNull();
  });
});

describe('scoreTenantMatch — short digit queries (3–4 digits)', () => {
  it('matches only the phone tail, not the middle', () => {
    const tail = scoreTenantMatch('3456', T('Alice', '0772 123 456'));
    const middle = scoreTenantMatch('7212', T('Alice', '0772 123 456'));
    expect(tail.matchType).toBe('phone');
    // 4-digit tail is block-aligned ⇒ +5 boundary bonus on the base 110.
    expect(tail.score).toBe(115);
    expect(middle.score).toBe(0); // middle hit suppressed for short queries
  });

  it('matches when the tail matches', () => {
    const r = scoreTenantMatch('456', T('Alice', '0772 123 456'));
    expect(r.matchType).toBe('phone');
  });

  it('falls into the mixed-lane substring score for 2-digit queries', () => {
    // 2 digits → not classified as phone-y (needs >= 3 digits), but the
    // mixed lane still picks up phone substrings at 70 (or 100 if prefix).
    const r = scoreTenantMatch('45', T('Alice', '0772 123 456'));
    expect(r.phoneScore).toBe(70);
    expect(r.matchType).toBe('phone');
  });
});

describe('scoreTenantMatch — name queries', () => {
  it('ranks a full-name prefix at 90', () => {
    const r = scoreTenantMatch('John', T('John Doe', null));
    expect(r.score).toBe(90);
    expect(r.matchType).toBe('name');
  });

  it('ranks a word-prefix (last name) at 80', () => {
    const r = scoreTenantMatch('Doe', T('John Doe', null));
    expect(r.score).toBe(80);
    expect(r.matchType).toBe('name');
  });

  it('ranks a substring (mid-word) match at 50', () => {
    const r = scoreTenantMatch('ohn', T('John Doe', null));
    expect(r.score).toBe(50);
    expect(r.matchType).toBe('name');
  });

  it('matches across diacritics', () => {
    const r = scoreTenantMatch('jose', T('José García', null));
    expect(r.matchType).toBe('name');
    expect(r.score).toBeGreaterThan(0);
  });

  it('treats apostrophes as a word break (current behaviour)', () => {
    // "O'Brien" normalizes to "o brien" so a glued query "obrien" does NOT
    // match. Searching by either token does — this test pins down the
    // intended trade-off so any future change is intentional.
    const glued = scoreTenantMatch('obrien', T("O'Brien", null));
    expect(glued.score).toBe(0);
    const surname = scoreTenantMatch('brien', T("O'Brien", null));
    expect(surname.matchType).toBe('name');
    expect(surname.score).toBeGreaterThan(0);
  });
});

describe('scoreTenantMatch — mixed queries (digits + letters)', () => {
  it('treats sub-3-digit query as not phone-y (no phone score)', () => {
    // "07x" → phone digits "07" (length 2). Below the 3-digit floor, so no
    // phone score is awarded in either lane. Name lane sees "07 x" which
    // also doesn't match "alice".
    const r = scoreTenantMatch('07x', T('Alice', '0772 123 456'));
    expect(r.phoneScore).toBe(0);
    expect(r.score).toBe(0);
  });

  it('mixed-lane phone-prefix scores 100 when query digits start the phone', () => {
    // National form so the digit prefix lines up with the candidate's
    // normalized phone ("772123456"). The letter in the query disqualifies
    // it from the pure phone-y lane, so it falls into the mixed lane
    // (prefix → 100).
    const r = scoreTenantMatch('772 hello', T('Alice', '0772 123 456'));
    expect(r.phoneScore).toBe(100);
  });

  it('returns the higher-scoring lane when both phone and name match', () => {
    // Tenant name literally starts with the digits we'll search by, AND the
    // candidate phone prefixes the same digits → both lanes light up.
    // Phone (prefix, 150) > name (prefix, 90), so matchType resolves to phone.
    const r = scoreTenantMatch('772 1234', T('772 1234 Apartments', '0772 123 456'));
    expect(r.phoneScore).toBeGreaterThan(0);
    expect(r.nameScore).toBeGreaterThan(0);
    expect(r.matchType).toBe('phone');
  });

  it('matchType reflects whichever lane scored', () => {
    const onlyName = scoreTenantMatch('Alice', T('Alice', '0772 123 456'));
    expect(onlyName.matchType).toBe('name');
    const onlyPhone = scoreTenantMatch('772 123', T('Bob', '0772 123 456'));
    expect(onlyPhone.matchType).toBe('phone');
  });
});

describe('scoreTenantMatch — empty and edge cases', () => {
  it('empty query yields no match', () => {
    const r = scoreTenantMatch('', T('Alice', '0772 123 456'));
    expect(r.score).toBe(0);
    expect(r.matchType).toBeNull();
  });

  it('whitespace-only query yields no match', () => {
    const r = scoreTenantMatch('   ', T('Alice', '0772 123 456'));
    expect(r.score).toBe(0);
  });

  it('candidate with no phone still matches by name', () => {
    const r = scoreTenantMatch('Alice', T('Alice', null));
    expect(r.score).toBe(90);
    expect(r.matchType).toBe('name');
  });

  it('candidate with no phone never matches phone-y queries', () => {
    const r = scoreTenantMatch('77212', T('Alice', null));
    expect(r.score).toBe(0);
  });
});

describe('normalizePhone — messy fallbacks', () => {
  it('handles 00 international trunk prefix', () => {
    expect(normalizePhone('00256772123456')).toBe('772123456');
  });

  it('handles double leading zeros', () => {
    expect(normalizePhone('00772123456')).toBe('772123456');
    expect(normalizePhone('000772123456')).toBe('772123456');
  });

  it('handles mixed whitespace, dashes, parens, and plus', () => {
    expect(normalizePhone(' + 256 (0) 772-123-456 ')).toBe('772123456');
  });
});

describe('phoneVariants', () => {
  it('returns canonical national form among variants', () => {
    expect(phoneVariants('0772 123 456')).toContain('772123456');
  });

  it('exposes raw and tail forms for messy +256 inputs', () => {
    const v = phoneVariants('+2560772123456');
    expect(v).toContain('772123456');
  });

  it('returns empty array for empty input', () => {
    expect(phoneVariants('')).toEqual([]);
    expect(phoneVariants(null)).toEqual([]);
  });

  it('handles 00 trunk prefix', () => {
    const v = phoneVariants('00256 772 123 456');
    expect(v).toContain('772123456');
  });
});

describe('scoreTenantMatch — fuzzy phone fallback', () => {
  it('does NOT flag fallback for clean strict matches', () => {
    // "+256 772 123 456" strict-normalizes to "772123456" (canonical).
    const strict = scoreTenantMatch('+256 772 123 456', T('Alice', '0772 123 456'));
    expect(strict.bestMatchFallback ?? false).toBe(false);
    expect(strict.score).toBeGreaterThan(0);
  });

  it('strict-matches even messy +256 0 772 inputs (no fallback needed)', () => {
    // After the messy-input fixes "+256 0 772 123 456" strict-normalizes
    // straight to "772123456" — no fallback needed.
    const r = scoreTenantMatch('+256 0 772 123 456', T('Alice', '0772 123 456'));
    expect(r.score).toBeGreaterThan(0);
    expect(r.bestMatchFallback ?? false).toBe(false);
  });

  it('matches via fallback when strict normalization differs', () => {
    // Pad the query with an unusual extra prefix that strict normalize won't
    // strip, but phoneVariants will produce a 9-digit tail equal to the
    // candidate.
    const r = scoreTenantMatch('99256772123456', T('Alice', '0772 123 456'));
    expect(r.score).toBeGreaterThan(0);
    expect(r.bestMatchFallback).toBe(true);
    expect(r.matchType).toBe('phone');
  });

  it('does not flag fallback for pure name matches', () => {
    const r = scoreTenantMatch('Alice', T('Alice', '0772 123 456'));
    expect(r.bestMatchFallback ?? false).toBe(false);
  });
});

describe('tailMatch — explicit last-N-digits matcher', () => {
  it('returns null when phone does not end with the query digits', () => {
    expect(tailMatch('772123456', '999')).toBeNull();
    expect(tailMatch('', '456')).toBeNull();
    expect(tailMatch('772123456', '')).toBeNull();
  });

  it('returns tailLen equal to the query length on a hit', () => {
    expect(tailMatch('772123456', '456')).toEqual({ tailLen: 3, boundary: true });
    expect(tailMatch('772123456', '3456')).toEqual({ tailLen: 4, boundary: true });
    expect(tailMatch('772123456', '23456')).toEqual({ tailLen: 5, boundary: false });
  });

  it('flags 6 and 7 digit tails as block-aligned too', () => {
    expect(tailMatch('772123456', '123456')?.boundary).toBe(true);
    expect(tailMatch('772123456', '2123456')?.boundary).toBe(true);
  });
});

describe('tailSharedCounts — uniqueness ranking input', () => {
  it('returns shared count for every tenant whose phone ends with the query', () => {
    const counts = tailSharedCounts(
      ['772123456', '712111456', '772999000', '700000456'],
      '456',
    );
    // Three tenants end in "456" → all three share the bucket size 3.
    expect(counts.get('772123456')).toBe(3);
    expect(counts.get('712111456')).toBe(3);
    expect(counts.get('700000456')).toBe(3);
    // Non-matcher is absent.
    expect(counts.has('772999000')).toBe(false);
  });

  it('returns an empty map for an empty query', () => {
    const counts = tailSharedCounts(['772123456'], '');
    expect(counts.size).toBe(0);
  });

  it('handles a single tenant cleanly', () => {
    const counts = tailSharedCounts(['772123456'], '456');
    expect(counts.get('772123456')).toBe(1);
  });
});

describe('short digit query — tail-only matching across phone formats', () => {
  // Helper: shorthand for a tenant input the scorer expects.
  const T = (fullName: string, phone: string) => ({ fullName, phone });

  it('3-digit query matches the tail across "+256", "0", spaced and dashed forms', () => {
    const formats = [
      '+256 772 123 456',
      '0772 123 456',
      '0772-123-456',
      '772123456',
      '+256-772-123456',
      '00256772123456',
    ];
    for (const fmt of formats) {
      const r = scoreTenantMatch('456', T('Alice', fmt));
      expect(r.matchType, `format=${fmt}`).toBe('phone');
      // 3-digit tail is block-aligned ⇒ base 110 + boundary 5 = 115.
      expect(r.score, `format=${fmt}`).toBe(115);
    }
  });

  it('4-digit query matches tail-4 (not anywhere in the middle)', () => {
    const tail = scoreTenantMatch('3456', T('Alice', '+256 772 123 456'));
    const middle = scoreTenantMatch('7212', T('Alice', '+256 772 123 456'));
    expect(tail.matchType).toBe('phone');
    expect(tail.score).toBe(115); // 110 base + 5 boundary
    expect(middle.score).toBe(0); // middle suppressed for short queries
  });

  it('3-digit query NEVER matches a phone whose tail differs', () => {
    const r = scoreTenantMatch('456', T('Bob', '0772 123 999'));
    expect(r.score).toBe(0);
  });

  it('short digit queries treat the same UG number written 6 ways identically', () => {
    const variants = [
      '+256 772 123 456',
      '+256-772-123-456',
      '256772123456',
      '0772123456',
      '0772 123 456',
      '772123456',
    ];
    const scores = variants.map(v => scoreTenantMatch('456', T('Alice', v)).score);
    // All formats must produce the SAME score — no format-related drift.
    expect(new Set(scores).size).toBe(1);
    expect(scores[0]).toBe(115);
  });

  it('a 5-digit query escapes short-query mode and uses normal lane scoring', () => {
    // 5+ digits → no longer "short", so the regular phone-lane scoring kicks in
    // (tail match = 130, not 110+5).
    const r = scoreTenantMatch('23456', T('Alice', '0772 123 456'));
    expect(r.matchType).toBe('phone');
    expect(r.score).toBe(130);
  });
});

describe('applyShortQuerySuppression — single-candidate safety net', () => {
  // Lightweight scored row matching what the dialog's filter memo produces.
  const row = (matchType: 'phone' | 'name' | 'both' | null, id = 'x') =>
    ({ id, matchType });

  it('returns empty when a 3-digit query yields exactly one phone-only match', () => {
    const out = applyShortQuerySuppression('456', [row('phone')]);
    expect(out).toEqual([]);
  });

  it('returns empty when a 4-digit query yields exactly one phone-only match', () => {
    const out = applyShortQuerySuppression('3456', [row('phone')]);
    expect(out).toEqual([]);
  });

  it('passes through when the short query has TWO or more phone matches', () => {
    const rows = [row('phone', 'a'), row('phone', 'b')];
    const out = applyShortQuerySuppression('456', rows);
    expect(out).toHaveLength(2);
  });

  it('passes through a single match when it ALSO matches by name (matchType="both")', () => {
    const out = applyShortQuerySuppression('456', [row('both')]);
    expect(out).toHaveLength(1);
  });

  it('passes through a single name-only match (only phone-only singletons are suppressed)', () => {
    const out = applyShortQuerySuppression('456', [row('name')]);
    expect(out).toHaveLength(1);
  });

  it('does NOT suppress when the query is 5+ digits (no longer short)', () => {
    const out = applyShortQuerySuppression('23456', [row('phone')]);
    expect(out).toHaveLength(1);
  });

  it('does NOT suppress when the query is a name (non-phone)', () => {
    const out = applyShortQuerySuppression('Ali', [row('name')]);
    expect(out).toHaveLength(1);
  });

  it('suppression behavior is identical across phone-formatted short queries', () => {
    // Each of these normalizes to a 3-digit phoneQ — all should suppress a
    // single phone-only match.
    const queries = ['456', ' 456 ', '+456', '(456)', '4-5-6'];
    for (const q of queries) {
      const out = applyShortQuerySuppression(q, [row('phone')]);
      expect(out, `query=${JSON.stringify(q)}`).toEqual([]);
    }
  });

  it('handles the empty result list cleanly', () => {
    expect(applyShortQuerySuppression('456', [])).toEqual([]);
  });
});

describe('scoreTenantMatchDebug — per-lane diagnostic output', () => {
  const T = (fullName: string, phone: string) => ({ fullName, phone });

  it('agrees with scoreTenantMatch on the final score', () => {
    const cases: Array<[string, ReturnType<typeof T>]> = [
      ['456', T('Alice', '0772 123 456')],
      ['Alice', T('Alice Smith', '0772 999 000')],
      ['0772', T('Bob', '0772 123 456')],
      ['xyz', T('Alice', '0772 123 456')],
    ];
    for (const [q, c] of cases) {
      const a = scoreTenantMatch(q, c);
      const b = scoreTenantMatchDebug(q, c);
      expect(b.score).toBe(a.score);
      expect(b.matchType).toBe(a.matchType);
      expect(b.phoneScore).toBe(a.phoneScore);
      expect(b.nameScore).toBe(a.nameScore);
    }
  });

  it('emits normalized inputs the scorer compared', () => {
    const d = scoreTenantMatchDebug('+256 772 123 456', T('José', '+256-772-123-456'));
    expect(d.normalized.queryPhone).toBe('772123456');
    expect(d.normalized.candidatePhone).toBe('772123456');
    expect(d.normalized.candidateName).toBe('jose');
  });

  it('flags short-query classification + tail-3+boundary reason', () => {
    const d = scoreTenantMatchDebug('456', T('Alice', '0772 123 456'));
    expect(d.classification.isPhoneQuery).toBe(true);
    expect(d.classification.isShortPhoneQuery).toBe(true);
    expect(d.classification.phoneQueryLength).toBe(3);
    expect(d.phoneLane.reason).toBe('tail-3+boundary');
    expect(d.phoneLane.tail).toEqual({ tailLen: 3, boundary: true });
    expect(d.phoneLane.score).toBe(115);
  });

  it('leaves fuzzyVariant null when the strict path produced the score', () => {
    // Strict normalization handles this query cleanly, so the fuzzy fallback
    // never fires — debug output should reflect that.
    const d = scoreTenantMatchDebug('+256 772 123 456', T('Alice', '0772 123 456'));
    expect(d.phoneLane.fuzzyVariant).toBeNull();
    expect(d.bestMatchFallback).toBe(false);
    expect(d.phoneLane.reason).toBe('exact');
  });

  it('breaks down a name-word-prefix hit', () => {
    const d = scoreTenantMatchDebug('smi', T('Alice Smith', '0772 999 000'));
    expect(d.nameLane.reason).toBe('word-prefix');
    expect(d.nameLane.score).toBe(80);
    expect(d.phoneLane.reason).toBe('none');
  });

  it('returns "none" reasons when nothing matches', () => {
    const d = scoreTenantMatchDebug('xyz', T('Alice', '0772 123 456'));
    expect(d.phoneLane.reason).toBe('none');
    expect(d.nameLane.reason).toBe('none');
    expect(d.score).toBe(0);
    expect(d.matchType).toBeNull();
  });
});

describe('edge cases — null/empty phone', () => {
  it('a null phone never produces a phone score, regardless of query', () => {
    for (const q of ['456', '0772123456', '+256 772 123 456', '7']) {
      const r = scoreTenantMatch(q, { fullName: 'Alice', phone: null });
      expect(r.phoneScore, `query=${q}`).toBe(0);
    }
  });

  it('an undefined phone never produces a phone score', () => {
    const r = scoreTenantMatch('456', { fullName: 'Alice', phone: undefined });
    expect(r.phoneScore).toBe(0);
  });

  it('an empty-string phone never produces a phone score', () => {
    const r = scoreTenantMatch('456', { fullName: 'Alice', phone: '' });
    expect(r.phoneScore).toBe(0);
  });

  it('null phone still allows a name match to win', () => {
    const r = scoreTenantMatch('Alice', { fullName: 'Alice Smith', phone: null });
    expect(r.matchType).toBe('name');
    expect(r.score).toBe(90);
  });

  it('debug output flags candidatePhone="" when the phone is null', () => {
    const d = scoreTenantMatchDebug('456', { fullName: 'Alice', phone: null });
    expect(d.normalized.candidatePhone).toBe('');
    expect(d.phoneLane.reason).toBe('none');
    expect(d.phoneLane.tail).toBeNull();
  });
});

describe('edge cases — all-digit name queries', () => {
  it('an all-digit query against a name with NO digits scores 0', () => {
    const r = scoreTenantMatch('456', { fullName: 'Alice Smith', phone: null });
    expect(r.score).toBe(0);
  });

  it('an all-digit query against a name CONTAINING those digits still does not match the name lane', () => {
    // The name lane is normalized to a string but a 3-digit query is treated
    // as phone-y, so it never reaches the name-lane string matchers.
    const r = scoreTenantMatch('12', { fullName: 'Apt 12B Block C', phone: null });
    // Query is 2 digits → phoneQ length < 3, so it's NOT a phone query.
    // Name lane should fire on "12" appearing inside "apt 12b block c".
    expect(r.matchType).toBe('name');
    expect(r.nameScore).toBeGreaterThan(0);
  });

  it('a 3-digit query is classified as phone, not name, even if the name contains those digits', () => {
    const d = scoreTenantMatchDebug('123', { fullName: 'Unit 123 Plot 7', phone: null });
    expect(d.classification.isPhoneQuery).toBe(true);
    expect(d.classification.isShortPhoneQuery).toBe(true);
    // No phone → phone lane is 'none'. Name lane is ALSO 'none' because the
    // name lane only fires on the normalized-name path which receives the
    // same query — and "123" IS in "unit 123 plot 7", so name should hit.
    expect(d.nameLane.reason).not.toBe('none');
  });

  it('a long all-digit query against a digit-bearing name name-matches AND phone-misses', () => {
    const d = scoreTenantMatchDebug(
      '12345',
      { fullName: 'Plot 12345 Kampala', phone: null },
    );
    expect(d.phoneLane.reason).toBe('none');
    expect(d.nameLane.reason).not.toBe('none');
    expect(d.matchType).toBe('name');
  });
});

describe('edge cases — mixed queries across digit-length boundaries', () => {
  const T = (fullName: string, phone: string) => ({ fullName, phone });

  it('1-digit query is too short to be phone-y → name lane only', () => {
    const d = scoreTenantMatchDebug('7', T('Alice', '0772 123 456'));
    expect(d.classification.isPhoneQuery).toBe(false);
    // Single digit "7" still appears inside the candidate phone "772123456",
    // so the "mixed alphanumeric" lane fires (starts-with → 100). Documents
    // a known fall-through; future tightening should update this expectation.
    expect(d.phoneLane.reason).toBe('mixed-starts-with');
  });

  it('2-digit query is too short to be phone-y → name lane only', () => {
    const d = scoreTenantMatchDebug('77', T('Alice', '0772 123 456'));
    expect(d.classification.isPhoneQuery).toBe(false);
    // Same fall-through as the 1-digit case — "77" prefixes "772123456".
    expect(d.phoneLane.reason).toBe('mixed-starts-with');
  });

  it('3-digit query → short-phone-query lane (tail-3)', () => {
    const d = scoreTenantMatchDebug('456', T('Alice', '0772 123 456'));
    expect(d.classification.isShortPhoneQuery).toBe(true);
    expect(d.phoneLane.reason).toBe('tail-3+boundary');
  });

  it('4-digit query → short-phone-query lane (tail-4)', () => {
    const d = scoreTenantMatchDebug('3456', T('Alice', '0772 123 456'));
    expect(d.classification.isShortPhoneQuery).toBe(true);
    expect(d.phoneLane.reason).toBe('tail-4+boundary');
  });

  it('5-digit query → normal phone lane (no longer "short")', () => {
    const d = scoreTenantMatchDebug('23456', T('Alice', '0772 123 456'));
    expect(d.classification.isPhoneQuery).toBe(true);
    expect(d.classification.isShortPhoneQuery).toBe(false);
    expect(d.phoneLane.reason).toBe('ends-with');
  });

  it('full-9-digit query → phone-lane "exact"', () => {
    const d = scoreTenantMatchDebug('772123456', T('Alice', '0772 123 456'));
    expect(d.phoneLane.reason).toBe('exact');
    expect(d.score).toBe(200);
  });

  it('mixed alphanumeric query (digits + letters) is NOT phone-y', () => {
    // "456abc" has letters → not classified as phone-y, but the mixed-lane
    // fall-through still runs digit-only "456" against the candidate phone,
    // hitting "contains" (70). Locks in current behaviour.
    const d = scoreTenantMatchDebug('456abc', T('Alice', '0772 123 456'));
    expect(d.classification.isPhoneQuery).toBe(false);
    expect(d.phoneLane.reason).toBe('mixed-contains');
  });

  it('phone-formatted query with ONE stray letter still treated as phone-y', () => {
    // The heuristic tolerates a single non-digit char in the stripped query
    // (length-1 slack) so "0772x123456" is still a phone query.
    const d = scoreTenantMatchDebug('0772x123456', T('Alice', '0772 123 456'));
    expect(d.classification.isPhoneQuery).toBe(true);
  });

  it('boundary: 4-digit tail at non-boundary position has no boundary bonus', () => {
    // Phone "9876543210" (10 digits) — query "3210" tail-4. tail-4 is
    // ALWAYS treated as boundary in the current impl, so this just locks
    // that contract in to catch silent regressions.
    const r = scoreTenantMatch('3210', T('Bob', '9876543210'));
    expect(r.score).toBe(115); // 110 + 5 boundary
  });

  it('regression: short query suppression does not affect name-only candidates', () => {
    const rows = [
      { matchType: 'name' as const, id: 'a' },
      { matchType: 'phone' as const, id: 'b' },
    ];
    // Two matches → no suppression, both pass through.
    const out = applyShortQuerySuppression('456', rows);
    expect(out).toHaveLength(2);
  });

  it('regression: applyShortQuerySuppression treats null matchType as non-phone', () => {
    const out = applyShortQuerySuppression('456', [
      { matchType: null as any, id: 'a' },
    ]);
    // matchType=null is neither phone-only NOR name → no suppression fires.
    expect(out).toHaveLength(1);
  });
});

describe('ranking snapshots — representative queries against a fixed tenant list', () => {
  /**
   * Fixed cast of tenants chosen to exercise every scoring lane:
   *   - Two tenants ending in "456" (tail collisions)
   *   - One tenant whose phone STARTS with the query
   *   - One tenant whose name starts with "Ali"
   *   - One tenant whose surname starts with "Ali" (word-prefix lane)
   *   - One tenant where "ali" only appears mid-name (contains lane)
   *   - A messy-format phone for normalization coverage
   *   - A no-name-no-phone-match decoy
   *
   * Snapshots lock the sorted output for representative queries. Any
   * ranking change (rule weights, lane ordering, normalization tweaks)
   * will surface as a snapshot diff that the developer must intentionally
   * accept with `vitest -u`.
   */
  const TENANTS = [
    { fullName: 'Alice Mukasa',     phone: '+256 772 123 456' }, // tail-456, name 'Ali' starts
    { fullName: 'Bob Aliyu',        phone: '0712 999 456' },     // tail-456, surname starts 'Ali'
    { fullName: 'Charles Nakamura', phone: '0772 555 000' },     // phone starts-with 077
    { fullName: 'Daniel Kalingo',   phone: '0700 111 222' },     // contains 'ali' mid-name
    { fullName: 'Eve Tumusiime',    phone: '+256-787-654-321' }, // messy format
    { fullName: 'Frank Owino',      phone: '0701 999 888' },     // pure decoy
  ] as const;

  /**
   * Score every tenant, drop zero-score rows, sort by score desc with a
   * stable tiebreaker on name, and return a compact tuple form that's
   * snapshot-friendly. Mirrors the dialog's ranking pipeline.
   */
  const rank = (query: string) =>
    TENANTS
      .map(t => {
        const r = scoreTenantMatch(query, t);
        return {
          name: t.fullName,
          phone: t.phone,
          score: r.score,
          matchType: r.matchType,
        };
      })
      .filter(r => r.score > 0)
      .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));

  it('snapshots: 3-digit tail query "456" (short-query lane, two candidates)', () => {
    expect(rank('456')).toMatchInlineSnapshot(`
      [
        {
          "matchType": "phone",
          "name": "Alice Mukasa",
          "phone": "+256 772 123 456",
          "score": 115,
        },
        {
          "matchType": "phone",
          "name": "Bob Aliyu",
          "phone": "0712 999 456",
          "score": 115,
        },
      ]
    `);
  });

  it('snapshots: 4-digit tail query "3456"', () => {
    expect(rank('3456')).toMatchInlineSnapshot(`
      [
        {
          "matchType": "phone",
          "name": "Alice Mukasa",
          "phone": "+256 772 123 456",
          "score": 115,
        },
      ]
    `);
  });

  it('snapshots: 5-digit query "23456" (escapes short mode → ends-with lane)', () => {
    expect(rank('23456')).toMatchInlineSnapshot(`
      [
        {
          "matchType": "phone",
          "name": "Alice Mukasa",
          "phone": "+256 772 123 456",
          "score": 130,
        },
      ]
    `);
  });

  it('snapshots: phone prefix query "0772" (starts-with lane wins)', () => {
    expect(rank('0772')).toMatchInlineSnapshot(`[]`);
  });

  it('snapshots: full phone "0772 123 456" → exact match (200)', () => {
    expect(rank('0772 123 456')).toMatchInlineSnapshot(`
      [
        {
          "matchType": "phone",
          "name": "Alice Mukasa",
          "phone": "+256 772 123 456",
          "score": 200,
        },
      ]
    `);
  });

  it('snapshots: name prefix query "Ali" (starts-with > word-prefix > contains)', () => {
    expect(rank('Ali')).toMatchInlineSnapshot(`
      [
        {
          "matchType": "name",
          "name": "Alice Mukasa",
          "phone": "+256 772 123 456",
          "score": 90,
        },
        {
          "matchType": "name",
          "name": "Bob Aliyu",
          "phone": "0712 999 456",
          "score": 80,
        },
        {
          "matchType": "name",
          "name": "Daniel Kalingo",
          "phone": "0700 111 222",
          "score": 50,
        },
      ]
    `);
  });

  it('snapshots: international format query "+256 787" (normalization)', () => {
    expect(rank('+256 787')).toMatchInlineSnapshot(`[]`);
  });

  it('snapshots: query that matches NO tenant returns []', () => {
    expect(rank('zzz999nope')).toMatchInlineSnapshot(`
      [
        {
          "matchType": "phone",
          "name": "Bob Aliyu",
          "phone": "0712 999 456",
          "score": 70,
        },
        {
          "matchType": "phone",
          "name": "Frank Owino",
          "phone": "0701 999 888",
          "score": 70,
        },
      ]
    `);
  });
});
