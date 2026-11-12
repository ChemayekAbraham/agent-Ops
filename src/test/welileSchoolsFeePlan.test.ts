import { describe, it, expect } from 'vitest';
import { clearEarly, dailyRate, onScheduleDays, planDaysUntil, planSummary } from '@/lib/welileSchoolsFeePlan';

describe('School Fees Plan maths (option A)', () => {
  it('daily rate is 0.66 / (days + 1)', () => {
    expect(dailyRate(76)).toBeCloseTo(0.66 / 77, 12);
    expect(dailyRate(0)).toBe(0);
  });

  it.each([60, 76, 120])('pays exactly 33%% on schedule for a %i-day plan', (days) => {
    const s = planSummary(3_000_000, days)!;
    expect(s.totalOnSchedule).toBeCloseTo(3_990_000, 4);
    expect(s.totalFacilitationFee).toBeCloseTo(990_000, 4);
  });

  it('daily payments fall as the balance falls', () => {
    const rows = onScheduleDays(3_000_000, 76);
    expect(rows[0].payment).toBeGreaterThan(rows[75].payment);
    expect(rows[0].facilitationFee).toBeCloseTo(3_000_000 * (0.66 / 77), 6);
    expect(planSummary(3_000_000, 76)!.averageDailyPayment).toBeCloseTo(3_990_000 / 76, 6);
  });

  it('clearing early costs less, and clearing on day 1 costs only one day of fee', () => {
    const half = clearEarly(3_000_000, 76, 39)!;
    expect(half.totalPaid).toBeLessThan(3_990_000);
    expect(half.saved).toBeGreaterThan(0);
    const day1 = clearEarly(3_000_000, 76, 1)!;
    expect(day1.totalPaid).toBeCloseTo(3_000_000 * (1 + 0.66 / 77), 4);
    const last = clearEarly(3_000_000, 76, 76)!;
    expect(last.saved).toBeCloseTo(0, 4);
  });

  it('plan ends 14 days before the end of term', () => {
    expect(planDaysUntil(new Date(2026, 11, 31), new Date(2026, 9, 1))).toBe(91 - 14);
    expect(planDaysUntil(new Date(2026, 9, 10), new Date(2026, 9, 1))).toBe(0);
  });
});
