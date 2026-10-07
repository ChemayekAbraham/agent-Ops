import { describe, it, expect } from 'vitest';
import { spiroLeaseSchedule } from '@/lib/spiroBikeLease';

describe('Bike Repayment Plan Schedule calculation', () => {
  it('correctly calculates reducing balance schedule for 23 months at UGX 145,000', () => {
    const schedule = spiroLeaseSchedule(23, 145000);

    expect(schedule.months).toBe(23);
    expect(schedule.base).toBe(145000);
    expect(schedule.total).toBe(632200);
    expect(schedule.rows).toHaveLength(23);

    // Month 1
    const m1 = schedule.rows[0];
    expect(m1.month).toBe(1);
    expect(m1.openingPrincipal).toBe(145000);
    expect(Math.round(m1.feeDue)).toBe(40600); // 28% of 145,000
    expect(m1.days).toBe(30);
    expect(m1.daily).toBe(1563);

    // Month 23 (Final month)
    const m23 = schedule.rows[22];
    expect(m23.month).toBe(23);
    expect(m23.daily).toBe(269);
    expect(Math.round(m23.closingPrincipal)).toBe(0);
  });

  it('handles 9-month repayment plan correctly', () => {
    const schedule = spiroLeaseSchedule(9, 145000);

    expect(schedule.months).toBe(9);
    expect(schedule.rows).toHaveLength(9);
    expect(schedule.rows[0].month).toBe(1);
    expect(schedule.rows[8].month).toBe(9);
    expect(schedule.rows[0].daily).toBeGreaterThan(schedule.rows[8].daily);
    expect(Math.round(schedule.rows[8].closingPrincipal)).toBe(0);
  });
});
