import { describe, it, expect } from 'vitest';
import { trendGrowthPct } from '@/components/executive/partner-ops/PromissoryKpiDetailSheet';

describe('promissory trend growth shown in the chart tooltip', () => {
  it('reports the increase over the previous period', () => {
    expect(trendGrowthPct(200, 250)).toBe(25);
    expect(trendGrowthPct(603_750, 1_207_500)).toBeCloseTo(100.0, 1);
  });
  it('reports a decrease as a negative percentage', () => {
    expect(trendGrowthPct(250, 200)).toBe(-20);
    expect(trendGrowthPct(1_000_000, 0)).toBe(-100);
  });
  it('gives no percentage when there is nothing to compare with', () => {
    expect(trendGrowthPct(0, 500)).toBeNull();
    expect(trendGrowthPct(-5, 500)).toBeNull();
    expect(trendGrowthPct(Number.NaN, 500)).toBeNull();
    expect(trendGrowthPct(500, Number.NaN)).toBeNull();
  });
});
