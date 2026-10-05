import { describe, it, expect } from 'vitest';
import { calculateRentRepayment } from '@/lib/rentCalculations';

/**
 * REGRESSION CONTRACT — Welile Rent Repayment Formula
 *
 * Total Repayment = (Rent × 1.33^n) + Registration Fee   where n = days/30
 * Registration Fee = 10,000 if Rent ≤ 200,000 else 20,000
 * Daily Payment   = ceil(Total Repayment / Days)
 *
 * If you need to change any number in this table, you are changing the
 * platform-wide rent pricing rules. Get explicit approval first.
 */

type Row = { rent: number; days: 30 | 60 | 90; total: number; daily: number };

const REFERENCE_TABLE: Row[] = [
  { rent: 50000,  days: 30, total: 76500,    daily: 2550  },
  { rent: 50000,  days: 60, total: 98445,    daily: 1641  },
  { rent: 50000,  days: 90, total: 127632,   daily: 1418  },
  { rent: 100000, days: 30, total: 143000,   daily: 4767  },
  { rent: 100000, days: 60, total: 186890,   daily: 3115  },
  { rent: 100000, days: 90, total: 245264,   daily: 2725  },
  { rent: 150000, days: 30, total: 209500,   daily: 6984  },
  { rent: 150000, days: 60, total: 275335,   daily: 4589  },
  { rent: 150000, days: 90, total: 362895,   daily: 4033  },
  { rent: 200000, days: 30, total: 276000,   daily: 9200  },
  { rent: 200000, days: 60, total: 363780,   daily: 6063  },
  { rent: 200000, days: 90, total: 480527,   daily: 5340  },
  { rent: 250000, days: 30, total: 352500,   daily: 11750 },
  { rent: 250000, days: 60, total: 462225,   daily: 7704  },
  { rent: 250000, days: 90, total: 608159,   daily: 6758  },
  { rent: 300000, days: 30, total: 419000,   daily: 13967 },
  { rent: 300000, days: 60, total: 550670,   daily: 9178  },
  { rent: 300000, days: 90, total: 725791,   daily: 8065  },
  { rent: 400000, days: 30, total: 552000,   daily: 18400 },
  { rent: 400000, days: 60, total: 727560,   daily: 12126 },
  { rent: 400000, days: 90, total: 961055,   daily: 10678 },
  { rent: 500000, days: 30, total: 685000,   daily: 22834 },
  { rent: 500000, days: 60, total: 904450,   daily: 15074 },
  { rent: 500000, days: 90, total: 1196319,  daily: 13293 },
];

describe('Welile rent repayment formula — reference table', () => {
  for (const row of REFERENCE_TABLE) {
    it(`Rent ${row.rent} / ${row.days} days → total ${row.total}, daily ${row.daily}`, () => {
      const r = calculateRentRepayment(row.rent, row.days);
      // Allow 1 UGX rounding tolerance (matches DB trigger tolerance).
      expect(Math.abs(r.totalRepayment - row.total)).toBeLessThanOrEqual(1);
      expect(Math.abs(r.dailyRepayment - row.daily)).toBeLessThanOrEqual(1);
    });
  }

  it('uses 10,000 registration fee for rent ≤ 200,000', () => {
    expect(calculateRentRepayment(200000, 30).requestFee).toBe(10000);
  });

  it('uses 20,000 registration fee for rent > 200,000', () => {
    expect(calculateRentRepayment(200001, 30).requestFee).toBe(20000);
  });
});