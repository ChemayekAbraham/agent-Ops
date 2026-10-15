import { describe, it, expect } from 'vitest';
import { allocateBonus, splitEqually } from './bonusMath';

describe('bonus allocation rounding', () => {
  it('splits UGX 100 three ways at 33.333% to sum 100', () => {
    const r = allocateBonus(100, [
      { staff_id: 'a', percentage: 33.333 },
      { staff_id: 'b', percentage: 33.333 },
      { staff_id: 'c', percentage: 33.334 },
    ]);
    expect(r.a + r.b + r.c).toBe(100);
    expect(r.c).toBe(34);
  });

  it('leaves the unallocated share when total % is under 100', () => {
    const r = allocateBonus(1_000_000, [{ staff_id: 'a', percentage: 40 }]);
    expect(r.a).toBe(400_000);
  });

  it('equal split totals exactly 100%', () => {
    const s = splitEqually(3);
    expect(Math.round(s.reduce((a, b) => a + b, 0) * 1000)).toBe(100_000);
  });
});
