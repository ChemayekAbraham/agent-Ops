import { describe, expect, it } from 'vitest';
import { evaluateUsageMatching as ev } from './usageReportMatching';

const long = 'a clear written explanation';

describe('usage report amount matching', () => {
  it('exact match is clean', () => {
    const r = ev({ approved: 100000, used: 100000, receiptTotal: 100000 });
    expect(r.flagged).toBe(false);
    expect(r.problems).toEqual([]);
  });
  it('receipt vs used mismatch needs an explanation', () => {
    const r = ev({ approved: 100000, used: 100000, receiptTotal: 90000, unspentExplanation: long, refundStatus: 'pending' });
    expect(r.mismatch).toBe(true);
    expect(r.receiptVsUsed).toBe(-10000);
    expect(r.problems.some(p => p.includes('receipt total differs'))).toBe(true);
    expect(ev({ approved: 100000, used: 100000, receiptTotal: 90000, mismatchExplanation: long, unspentExplanation: long, refundStatus: 'pending' }).problems).toEqual([]);
  });
  it('unspent balance needs explanation, refund status and refund proof when made', () => {
    const base = { approved: 100000, used: 70000, receiptTotal: 70000 };
    expect(ev(base).problems.length).toBe(2);
    expect(ev({ ...base, unspentExplanation: long, refundStatus: 'made' }).problems).toEqual(['Attach proof of the refund.']);
    expect(ev({ ...base, unspentExplanation: long, refundStatus: 'made', refundEvidenceCount: 1 }).problems).toEqual([]);
    expect(ev({ ...base, unspentExplanation: long, refundStatus: 'not_required' }).problems.length).toBe(1);
    expect(ev(base).unspent).toBe(30000);
  });
  it('overspend needs an explanation', () => {
    const r = ev({ approved: 100000, used: 120000, receiptTotal: 120000 });
    expect(r.hasOverspend).toBe(true);
    expect(r.overspend).toBe(20000);
    expect(ev({ approved: 100000, used: 120000, receiptTotal: 120000, overspendExplanation: long }).problems).toEqual([]);
  });
  it('missing receipt total blocks', () => {
    expect(ev({ approved: 1, used: 1, receiptTotal: null }).problems.length).toBe(1);
  });
});
