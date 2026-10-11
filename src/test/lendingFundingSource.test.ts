import { describe, expect, it } from 'vitest';
import { fundingSourceMeta, FUNDING_SOURCE_META } from '@/components/vouch/agent/lendingHelpers';

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
