import { describe, expect, it } from 'vitest';
import { calculateAccessFeeSimple, calculateRegistrationFee, installmentCount } from '@/lib/agentAdvanceCalculations';
import {
  SPECIAL_ADVANCE_FREQUENCIES,
  SPECIAL_ADVANCE_RATE_PRESETS,
  SPECIAL_ADVANCE_TERMS,
  previewSpecialAdvance,
  rateLabel,
  specialAdvanceAccessFee,
  validateSpecialAdvanceInput,
  type SpecialAdvanceInput,
} from '@/lib/specialAdvancePreview';

const ISSUE = '2026-01-01';
const base: SpecialAdvanceInput = { principal: 500_000, ratePercent: 28, rateBasis: 'monthly', termDays: 7, frequency: 'daily', issueYmd: ISSUE };
const run = (over: Partial<SpecialAdvanceInput>) => {
  const p = previewSpecialAdvance({ ...base, ...over });
  if (!p) throw new Error('expected a preview');
  return p;
};

describe('Special Advance preview — approved options (2026-10-27)', () => {
  it('offers exactly 1%/day, 15%/month and 28%/month presets, and 7/14/30-day terms', () => {
    expect(SPECIAL_ADVANCE_RATE_PRESETS.map((p) => rateLabel(p.ratePercent, p.basis))).toEqual(['1% per day', '15% per month', '28% per month']);
    expect(SPECIAL_ADVANCE_TERMS).toEqual([7, 14, 30]);
    expect(SPECIAL_ADVANCE_FREQUENCIES.map((f) => f.value)).toEqual(['daily', 'weekly', 'monthly']);
  });

  it('monthly rates are prorated by days on short terms, never charged as a full month', () => {
    expect(specialAdvanceAccessFee(500_000, 28, 'monthly', 7)).toBe(32_667); // not 140,000
    expect(specialAdvanceAccessFee(500_000, 28, 'monthly', 14)).toBe(65_333);
    expect(specialAdvanceAccessFee(500_000, 28, 'monthly', 30)).toBe(140_000);
    expect(specialAdvanceAccessFee(500_000, 15, 'monthly', 14)).toBe(35_000);
    // Same formula the server uses for existing advances.
    expect(specialAdvanceAccessFee(500_000, 28, 'monthly', 7)).toBe(calculateAccessFeeSimple(500_000, 7, 0.28));
  });

  it('daily rates accrue simply (principal × rate × days), never compounded', () => {
    expect(specialAdvanceAccessFee(500_000, 1, 'daily', 14)).toBe(70_000);
    expect(specialAdvanceAccessFee(500_000, 1, 'daily', 30)).toBe(150_000); // compounded would be 173,924
    expect(specialAdvanceAccessFee(123_457, 1, 'daily', 7)).toBe(8_642); // 8,641.99 rounds to the nearest shilling
  });

  it('Example A: 500,000 @ 28%/month · 7 days · daily', () => {
    const p = run({});
    expect([p.accessFee, p.registrationFee, p.totalRepayable]).toEqual([32_667, 20_000, 552_667]);
    expect([p.instalments, p.instalmentAmount, p.finalInstalmentAmount]).toEqual([7, 78_953, 78_949]);
    expect([p.firstDueYmd, p.finalDueYmd]).toEqual(['2026-01-02', '2026-01-08']);
  });

  it('Example B: 500,000 @ 28%/month · 14 days · weekly', () => {
    const p = run({ termDays: 14, frequency: 'weekly' });
    expect([p.accessFee, p.totalRepayable]).toEqual([65_333, 585_333]);
    expect(p.schedule.map((s) => [s.dueYmd, s.amount])).toEqual([['2026-01-08', 292_667], ['2026-01-15', 292_666]]);
  });

  it('Example C: 500,000 @ 15%/month · 30 days · weekly — last due date capped at the term end', () => {
    const p = run({ ratePercent: 15, termDays: 30, frequency: 'weekly' });
    expect([p.accessFee, p.totalRepayable, p.instalments]).toEqual([75_000, 595_000, 5]);
    expect(p.schedule.map((s) => s.amount)).toEqual([119_000, 119_000, 119_000, 119_000, 119_000]);
    expect(p.schedule.map((s) => s.dueYmd)).toEqual(['2026-01-08', '2026-01-15', '2026-01-22', '2026-01-29', '2026-01-31']);
  });

  it('Example D: 500,000 @ 1%/day · 14 days · daily', () => {
    const p = run({ ratePercent: 1, rateBasis: 'daily', termDays: 14 });
    expect([p.accessFee, p.totalRepayable]).toEqual([70_000, 590_000]);
    expect([p.instalments, p.instalmentAmount, p.finalInstalmentAmount]).toEqual([14, 42_143, 42_141]);
  });

  it('Example E: 200,000 @ 1%/day · 7 days · monthly frequency — one instalment at the term end', () => {
    const p = run({ principal: 200_000, ratePercent: 1, rateBasis: 'daily', frequency: 'monthly' });
    expect([p.accessFee, p.registrationFee, p.totalRepayable]).toEqual([14_000, 10_000, 224_000]);
    expect(p.schedule.map((s) => [s.dueYmd, s.amount])).toEqual([['2026-01-08', 224_000]]);
  });

  it('Example F: custom 20% per month · custom 21 days · weekly', () => {
    const p = run({ principal: 300_000, ratePercent: 20, termDays: 21, frequency: 'weekly' });
    expect([p.accessFee, p.totalRepayable]).toEqual([42_000, 362_000]);
    expect(p.schedule.map((s) => [s.dueYmd, s.amount])).toEqual([['2026-01-08', 120_667], ['2026-01-15', 120_667], ['2026-01-22', 120_666]]);
  });

  it('Example G: custom 0.5% per day · custom 45 days · daily', () => {
    const p = run({ principal: 1_000_000, ratePercent: 0.5, rateBasis: 'daily', termDays: 45 });
    expect([p.accessFee, p.registrationFee, p.totalRepayable]).toEqual([225_000, 20_000, 1_245_000]);
    expect([p.instalments, p.instalmentAmount, p.finalInstalmentAmount]).toEqual([45, 27_667, 27_652]);
    expect(p.finalDueYmd).toBe('2026-02-15');
  });

  it('the same number means different fees on different bases — basis is part of the agreement', () => {
    expect(run({ ratePercent: 1, rateBasis: 'daily', termDays: 30 }).accessFee).toBe(150_000);
    expect(run({ ratePercent: 1, rateBasis: 'monthly', termDays: 30 }).accessFee).toBe(5_000);
  });

  it('carries the agreed rate, basis, term and frequency through to the preview', () => {
    expect(run({ ratePercent: 15, termDays: 14, frequency: 'weekly' })).toMatchObject({ ratePercent: 15, rateBasis: 'monthly', termDays: 14, frequency: 'weekly' });
  });

  it('registration fee boundary is 200,000 inclusive (unchanged rule)', () => {
    expect(run({ principal: 200_000 }).registrationFee).toBe(calculateRegistrationFee(200_000));
    expect(run({ principal: 200_000 }).registrationFee).toBe(10_000);
    expect(run({ principal: 200_001 }).registrationFee).toBe(20_000);
  });

  it('instalment counts match installmentCount for preset and custom terms', () => {
    for (const f of SPECIAL_ADVANCE_FREQUENCIES) {
      for (const d of [1, 7, 10, 14, 21, 30, 45, 90]) {
        expect(run({ frequency: f.value, termDays: d }).instalments).toBe(installmentCount(d, f.value));
      }
    }
  });

  it('every schedule sums exactly to the total and splits in waterfall order', () => {
    for (const f of SPECIAL_ADVANCE_FREQUENCIES) {
      for (const d of [7, 14, 21, 30, 45]) {
        for (const [r, b] of [[1, 'daily'], [15, 'monthly'], [28, 'monthly'], [0.75, 'daily'], [17.5, 'monthly']] as const) {
          const p = run({ principal: 345_678, ratePercent: r, rateBasis: b, termDays: d, frequency: f.value });
          const sum = (k: 'amount' | 'accessFee' | 'registrationFee' | 'principal') => p.schedule.reduce((a, s) => a + s[k], 0);
          expect(sum('amount')).toBe(p.totalRepayable);
          expect(sum('accessFee')).toBe(p.accessFee);
          expect(sum('registrationFee')).toBe(p.registrationFee);
          expect(sum('principal')).toBe(p.principal);
          expect(p.schedule.at(-1)?.balanceAfter).toBe(0);
          p.schedule.forEach((s) => expect(s.accessFee + s.registrationFee + s.principal).toBe(s.amount));
          const lastAccess = p.schedule.map((s) => s.accessFee > 0).lastIndexOf(true);
          const firstReg = p.schedule.findIndex((s) => s.registrationFee > 0);
          const lastReg = p.schedule.map((s) => s.registrationFee > 0).lastIndexOf(true);
          const firstPrin = p.schedule.findIndex((s) => s.principal > 0);
          expect(firstReg).toBeGreaterThanOrEqual(lastAccess);
          expect(firstPrin).toBeGreaterThanOrEqual(lastReg);
        }
      }
    }
  });

  it('rejects invalid input instead of assuming a rate, basis or term', () => {
    const ok = { ...base };
    expect(validateSpecialAdvanceInput(ok)).toEqual([]);
    expect(validateSpecialAdvanceInput({ ...ok, rateBasis: undefined })).toEqual(['rateBasis']);
    expect(validateSpecialAdvanceInput({ ...ok, ratePercent: undefined })).toEqual(['rate']);
    expect(validateSpecialAdvanceInput({ ...ok, ratePercent: 101 })).toEqual(['rate']);
    expect(validateSpecialAdvanceInput({ ...ok, principal: 1000.5 })).toEqual(['principal']);
    expect(validateSpecialAdvanceInput({ ...ok, termDays: 0 })).toEqual(['term']);
    expect(validateSpecialAdvanceInput({ ...ok, termDays: 10.5 })).toEqual(['term']);
    expect(validateSpecialAdvanceInput({ ...ok, termDays: 366 })).toEqual(['term']);
    expect(validateSpecialAdvanceInput({ ...ok, frequency: 'biweekly' as never })).toEqual(['frequency']);
    expect(validateSpecialAdvanceInput({ ...ok, issueYmd: '01/01/2026' })).toEqual(['issueDate']);
    expect(previewSpecialAdvance({ ...ok, rateBasis: undefined as never })).toBeNull();
  });

  it('enforces the CFO limits (2026-10-27): rate > 0, ≤ 1%/day or ≤ 28%/month, 2 decimals; term 1–90; principal ≥ 10,000', () => {
    const ok = { ...base };
    expect(validateSpecialAdvanceInput({ ...ok, ratePercent: 0 })).toEqual(['rate']); // 0% not permitted
    expect(validateSpecialAdvanceInput({ ...ok, ratePercent: 28 })).toEqual([]);
    expect(validateSpecialAdvanceInput({ ...ok, ratePercent: 28.01 })).toEqual(['rate']);
    expect(validateSpecialAdvanceInput({ ...ok, ratePercent: 1, rateBasis: 'daily' })).toEqual([]);
    expect(validateSpecialAdvanceInput({ ...ok, ratePercent: 1.01, rateBasis: 'daily' })).toEqual(['rate']);
    expect(validateSpecialAdvanceInput({ ...ok, ratePercent: 12.345 })).toEqual(['rate']);
    expect(validateSpecialAdvanceInput({ ...ok, ratePercent: 0.07 })).toEqual([]); // 0.07 × 100 is not exactly 7 in floating point
    expect(validateSpecialAdvanceInput({ ...ok, termDays: 90 })).toEqual([]);
    expect(validateSpecialAdvanceInput({ ...ok, termDays: 91 })).toEqual(['term']);
    expect(validateSpecialAdvanceInput({ ...ok, principal: 10_000 })).toEqual([]);
    expect(validateSpecialAdvanceInput({ ...ok, principal: 9_999 })).toEqual(['principal']);
  });

  it('rounds exact half shillings up, without floating-point error (matches the server)', () => {
    expect(specialAdvanceAccessFee(10_000, 20.13, 'monthly', 5)).toBe(336); // 335.5 exactly; floats gave 335
    expect(specialAdvanceAccessFee(10_100, 0.5, 'daily', 1)).toBe(51);      // 50.5
    expect(specialAdvanceAccessFee(10_100, 15, 'monthly', 1)).toBe(51);     // 50.5
  });
});
