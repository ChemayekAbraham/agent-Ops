import { describe, expect, it } from 'vitest';
import { inLunchAllowanceRange, lunchAllowanceRange } from './lunchAllowancePeriod';

describe('Lunch Allowance payment periods', () => {
  const today = '2026-11-10';
  it('Today includes only the Kampala day, including its UTC boundary', () => {
    const range = lunchAllowanceRange('today', today);
    expect(range).toEqual({ start: today, end: today });
    expect(inLunchAllowanceRange('2026-11-09T21:00:00Z', range)).toBe(true);
    expect(inLunchAllowanceRange('2026-11-09T20:59:59Z', range)).toBe(false);
    expect(inLunchAllowanceRange('2026-11-10T21:00:00Z', range)).toBe(false);
  });
  it('Yesterday includes only 9 November', () => {
    const range = lunchAllowanceRange('yesterday', today);
    expect(range).toEqual({ start: '2026-11-09', end: '2026-11-09' });
    expect(inLunchAllowanceRange('2026-11-09T12:00:00Z', range)).toBe(true);
    expect(inLunchAllowanceRange('2026-11-10T00:00:00Z', range)).toBe(false);
  });
  it('Last 7 days includes today and the preceding six calendar days', () => {
    const range = lunchAllowanceRange('7days', today);
    expect(range).toEqual({ start: '2026-11-04', end: today });
    expect(inLunchAllowanceRange('2026-11-04T00:00:00Z', range)).toBe(true);
    expect(inLunchAllowanceRange('2026-11-03T12:00:00Z', range)).toBe(false);
  });
  it('Last 30 days crosses the month boundary and excludes older payments', () => {
    const range = lunchAllowanceRange('30days', today);
    expect(range).toEqual({ start: '2026-10-12', end: today });
    expect(inLunchAllowanceRange('2026-10-12T00:00:00Z', range)).toBe(true);
    expect(inLunchAllowanceRange('2026-10-11T12:00:00Z', range)).toBe(false);
  });
  it('All time does not remove older payments', () => {
    expect(lunchAllowanceRange('all', today)).toBeNull();
    expect(inLunchAllowanceRange('2026-04-01T00:00:00Z', null)).toBe(true);
  });
});