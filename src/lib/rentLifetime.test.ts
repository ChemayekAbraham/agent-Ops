import { describe, expect, it } from 'vitest';
import { FUNNEL_STAGES, classifyRepayment, normalizeLifetime, pct, stagePassRate } from './rentLifetime';

const NOW = new Date('2026-10-16T09:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const base = { status: 'repaying', total_repayment: 300_000, amount_repaid: 0 };

describe('classifyRepayment mirrors the SQL rule', () => {
  it('never_paid needs the landlord paid more than 30 days ago (29 days is too_early)', () => {
    expect(classifyRepayment({ ...base, landlord_paid_at: daysAgo(31) }, NOW)).toBe('never_paid');
    expect(classifyRepayment({ ...base, landlord_paid_at: daysAgo(30.01) }, NOW)).toBe('never_paid');
    expect(classifyRepayment({ ...base, landlord_paid_at: daysAgo(29) }, NOW)).toBe('too_early');
    expect(classifyRepayment({ ...base, landlord_paid_at: daysAgo(30) }, NOW)).toBe('too_early');
    expect(classifyRepayment({ ...base, landlord_paid_at: daysAgo(0) }, NOW)).toBe('too_early');
  });
  it('full when amount_repaid >= total_repayment (and when the status is completed)', () => {
    expect(classifyRepayment({ ...base, amount_repaid: 300_000, landlord_paid_at: daysAgo(90) }, NOW)).toBe('full');
    expect(classifyRepayment({ ...base, amount_repaid: 350_000, landlord_paid_at: daysAgo(90) }, NOW)).toBe('full');
    expect(classifyRepayment({ ...base, status: 'completed', amount_repaid: 0, landlord_paid_at: daysAgo(90) }, NOW)).toBe('full');
    // a total of 0 never counts as fully repaid by the amount rule
    expect(classifyRepayment({ status: 'repaying', total_repayment: 0, amount_repaid: 0, landlord_paid_at: daysAgo(5) }, NOW)).toBe('too_early');
  });
  it('partial when 0 < amount_repaid < total_repayment', () => {
    expect(classifyRepayment({ ...base, amount_repaid: 1, landlord_paid_at: daysAgo(2) }, NOW)).toBe('partial');
    expect(classifyRepayment({ ...base, amount_repaid: 299_999, landlord_paid_at: daysAgo(200) }, NOW)).toBe('partial');
  });
  it('the four buckets sum to financed (every financed request lands in exactly one)', () => {
    const financed = [
      { ...base, amount_repaid: 300_000, landlord_paid_at: daysAgo(80) },
      { ...base, status: 'completed', landlord_paid_at: daysAgo(80) },
      { ...base, amount_repaid: 10, landlord_paid_at: daysAgo(10) },
      { ...base, amount_repaid: 10, landlord_paid_at: daysAgo(100) },
      { ...base, landlord_paid_at: daysAgo(31) },
      { ...base, landlord_paid_at: daysAgo(3) },
      { ...base, status: 'rejected', landlord_paid_at: daysAgo(45) },
      { ...base, status: 'cancelled', amount_repaid: 5, landlord_paid_at: daysAgo(1) },
    ];
    const counts = { full: 0, partial: 0, never_paid: 0, too_early: 0 };
    for (const f of financed) counts[classifyRepayment(f, NOW)] += 1;
    expect(counts.full + counts.partial + counts.never_paid + counts.too_early).toBe(financed.length);
    expect(counts).toEqual({ full: 2, partial: 3, never_paid: 2, too_early: 1 });
  });
});

describe('pct', () => {
  it('returns 0 when the whole is 0 (or not a usable number)', () => {
    expect(pct(5, 0)).toBe(0);
    expect(pct(0, 0)).toBe(0);
    expect(pct(5, -1)).toBe(0);
    expect(pct(Number.NaN, 10)).toBe(0);
    expect(pct(5, Number.POSITIVE_INFINITY)).toBe(0);
  });
  it('is a one-decimal percentage otherwise', () => {
    expect(pct(1, 4)).toBe(25);
    expect(pct(489, 1329)).toBe(36.8);
    expect(pct(1329, 6577)).toBe(20.2);
    expect(pct(0, 10)).toBe(0);
    expect(pct(10, 10)).toBe(100);
  });
});

describe('stagePassRate', () => {
  const rows = FUNNEL_STAGES.map((stage, i) => ({ stage, count: [2540, 2152, 1976, 1906, 1902, 1855, 1742, 1329][i] }));
  it('compares a row with the one before it, the first row with submitted', () => {
    expect(stagePassRate(rows, 0, 6577)).toBe(38.6);
    expect(stagePassRate(rows, 1, 6577)).toBe(84.7);
    expect(stagePassRate(rows, 7, 6577)).toBe(76.3);
  });
  it('is 0 for an empty previous row, a zero submitted count or an index out of range', () => {
    expect(stagePassRate(rows.map((r, i) => (i === 1 ? { ...r, count: 0 } : r)), 2, 100)).toBe(0);
    expect(stagePassRate(rows, 0, 0)).toBe(0);
    expect(stagePassRate(rows, 9, 100)).toBe(0);
    expect(stagePassRate(rows, -1, 100)).toBe(0);
  });
});

describe('normalizeLifetime', () => {
  it('types the answer as returned and always gives the eight funnel rows in order', () => {
    const d = normalizeLifetime({
      submitted: 6577, funded: 1742, financed: 1329,
      stage_funnel: [{ stage: 'financed', count: 1329 }, { stage: 'service_center', count: 2540 }],
      outcomes: { rejected: 668 }, repayment: { full: 489, partial: 773, never_paid: 22, too_early: 45 },
      money: { total_repayment: '1007310368.00', amount_repaid: 614908410 },
    });
    expect(d.stage_funnel.map((r) => r.stage)).toEqual([...FUNNEL_STAGES]);
    expect(d.stage_funnel[0].count).toBe(2540);
    expect(d.stage_funnel[1].count).toBe(0);
    expect(d.stage_funnel[7].count).toBe(1329);
    expect(d.outcomes.rejected).toBe(668);
    expect(d.outcomes.cancelled).toBe(0);
    expect(d.money.total_repayment).toBe(1007310368);
    expect(d.repayment.full + d.repayment.partial + d.repayment.never_paid + d.repayment.too_early).toBe(d.financed);
    expect(normalizeLifetime(null).submitted).toBe(0);
  });
});
