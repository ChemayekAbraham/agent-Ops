import { describe, expect, it } from 'vitest';
import { countActiveFunderFilters } from '@/components/funder-new/utils';
import type { FunderNewFilters } from '@/components/funder-new/types';

const base: FunderNewFilters = {
  search: '',
  location: '',
  amount: 'all',
  sort: 'recommended',
  rentMin: null,
  rentMax: null,
  radiusKm: 'all',
  withinFloat: false,
};

describe('countActiveFunderFilters', () => {
  it('counts nothing when every filter is at its default', () => {
    expect(countActiveFunderFilters(base)).toBe(0);
  });

  it('counts every switched-on filter separately', () => {
    expect(countActiveFunderFilters({ ...base, search: 'nakawa' })).toBe(1);
    expect(countActiveFunderFilters({ ...base, search: 'nakawa', radiusKm: 5 })).toBe(2);
    expect(
      countActiveFunderFilters({
        ...base,
        amount: 'under_300k',
        rentMin: 100000,
        rentMax: 300000,
        withinFloat: true,
      }),
    ).toBe(4);
  });

  it('never counts sort, blank text or whitespace-only text', () => {
    expect(countActiveFunderFilters({ ...base, sort: 'nearest' })).toBe(0);
    expect(countActiveFunderFilters({ ...base, search: '   ', location: '' })).toBe(0);
  });
});
