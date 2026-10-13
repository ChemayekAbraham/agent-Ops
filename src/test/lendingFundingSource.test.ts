import { describe, expect, it } from 'vitest';
import { fundingSourceMeta, FUNDING_SOURCE_META, normalizeFundingSource } from '@/components/vouch/agent/lendingHelpers';

describe('funding-source normalization (history filter)', () => {
  it('maps only withdrawable to withdrawable; everything else to float', () => {
    expect(normalizeFundingSource('withdrawable')).toBe('withdrawable');
    expect(normalizeFundingSource('float')).toBe('float');
    expect(normalizeFundingSource(undefined)).toBe('float');
    expect(normalizeFundingSource(null)).toBe('float');
    expect(normalizeFundingSource('legacy_value')).toBe('float');
  });
});

describe('lending funding-source labels', () => {
  it('labels float-funded loans as Operational float', () => {
    expect(fundingSourceMeta('float').label).toBe('Operational float');
    expect(fundingSourceMeta('float')).toBe(FUNDING_SOURCE_META.float);
  });

  it('labels withdrawable-funded loans as My own money', () => {
    expect(fundingSourceMeta('withdrawable').label).toBe('My own money');
    expect(fundingSourceMeta('withdrawable')).toBe(FUNDING_SOURCE_META.withdrawable);
  });

  it('falls back to Operational float for unknown or missing sources', () => {
    expect(fundingSourceMeta(undefined).label).toBe('Operational float');
    expect(fundingSourceMeta(null).label).toBe('Operational float');
    expect(fundingSourceMeta('legacy_value').label).toBe('Operational float');
  });

  it('gives the two sources distinct labels', () => {
    expect(FUNDING_SOURCE_META.float.label).not.toBe(FUNDING_SOURCE_META.withdrawable.label);
  });
});

import { filterPayments, paymentStatusOf } from '@/lib/lendingRepaymentPdf';
describe('repayment PDF filters', () => {
  const rows = [
    { created_at: '2026-10-01T08:00:00Z' },
    { created_at: '2026-10-10T08:00:00Z' },
    { created_at: '2026-10-20T08:00:00Z' },
  ];
  it('classifies on-time vs late against the due date', () => {
    expect(paymentStatusOf('2026-10-10T08:00:00Z', '2026-10-10')).toBe('on_time');
    expect(paymentStatusOf('2026-10-20T08:00:00Z', '2026-10-10')).toBe('late');
  });
  it('filters by date range and status', () => {
    expect(filterPayments(rows, '2026-10-05', '', 'all', '2026-10-10')).toHaveLength(2);
    expect(filterPayments(rows, '', '', 'late', '2026-10-10')).toHaveLength(1);
    expect(filterPayments(rows, '2026-10-01', '2026-10-10', 'on_time', '2026-10-10')).toHaveLength(2);
  });
});
