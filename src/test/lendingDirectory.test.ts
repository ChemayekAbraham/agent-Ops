import { describe, expect, it } from 'vitest';
import { lendingDirectoryRange, sanitizeLocationTerm } from '@/lib/lendingDirectory';

describe('lending directory pagination', () => {
  it('shows exactly five users on each page', () => {
    expect(lendingDirectoryRange(0)).toEqual([0, 4]);
    expect(lendingDirectoryRange(1)).toEqual([5, 9]);
    expect(lendingDirectoryRange(2)).toEqual([10, 14]);
  });
});

describe('lending directory location filter term', () => {
  it('keeps plain place names intact', () => {
    expect(sanitizeLocationTerm('Kampala')).toBe('Kampala');
  });

  it('strips characters that would break the PostgREST or() filter', () => {
    expect(sanitizeLocationTerm('kampala, central (%)')).toBe('kampala central');
  });

  it('collapses repeated whitespace', () => {
    expect(sanitizeLocationTerm('  bexley   village ')).toBe('bexley village');
  });
});