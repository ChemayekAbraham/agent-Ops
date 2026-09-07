import { describe, it, expect } from 'vitest';
import { directFundingDailyChargeSchedule } from '@/lib/directFundingDailyChargeSchedule';

describe('directFundingDailyChargeSchedule', () => {
  it('matches the reference doc worked example for a 143,000 / 30-day schedule', () => {
    const rows = directFundingDailyChargeSchedule(143000, 30);
    expect(rows).toHaveLength(30);
    expect(rows[0]).toEqual({ day: 1, cumulativeDue: 4766.6667, cashCharged: 4767 });
    expect(rows[1]).toEqual({ day: 2, cumulativeDue: 9533.3333, cashCharged: 4766 });
    expect(rows[2]).toEqual({ day: 3, cumulativeDue: 14300, cashCharged: 4767 });
    expect(rows[29]).toEqual({ day: 30, cumulativeDue: 143000, cashCharged: 4767 });
  });

  it('sums to the exact total with the doc-specified 10 low / 20 high day split', () => {
    const rows = directFundingDailyChargeSchedule(143000, 30);
    const total = rows.reduce((sum, r) => sum + r.cashCharged, 0);
    expect(total).toBe(143000);
    expect(rows.filter((r) => r.cashCharged === 4766)).toHaveLength(10);
    expect(rows.filter((r) => r.cashCharged === 4767)).toHaveLength(20);
  });

  it('needs no low/high split when the total divides evenly (second house example)', () => {
    const rows = directFundingDailyChargeSchedule(352500, 30);
    const total = rows.reduce((sum, r) => sum + r.cashCharged, 0);
    expect(total).toBe(352500);
    expect(new Set(rows.map((r) => r.cashCharged)).size).toBe(1);
    expect(rows[0].cashCharged).toBe(11750);
  });
});
