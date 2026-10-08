import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

import {
  EMPTY_AWARENESS_FILTERS, awarenessFilterArgs, awarenessGapArgs, fetchAllAwarenessLog, type AwarenessFilters, type AwarenessLogRow,
} from './useAwarenessMonitoring';

const base: AwarenessFilters = { startIso: '2026-10-01T00:00:00.000Z', endIso: '2026-10-07T20:59:59.999Z', ...EMPTY_AWARENESS_FILTERS };

describe('awarenessFilterArgs', () => {
  it('sends the dates and leaves every other filter null when none is chosen', () => {
    expect(awarenessFilterArgs(base)).toEqual({
      p_from: base.startIso, p_to: base.endIso, p_team: null, p_caller: null, p_subject_type: null, p_region: null, p_district: null,
      p_result: null, p_answer_field: null, p_answer: null, p_status: null,
    });
  });

  it('passes each filter to the matching parameter and splits the answer choice into a question and an answer', () => {
    const args = awarenessFilterArgs({
      ...base, team: 'tenant_ops', caller: 'u-1', subjectType: 'landlord', result: 'answered', answer: 'aware_merchant_codes:did_not_know',
      region: 'Central', district: 'Wakiso', status: 'repaying',
    });
    expect(args).toMatchObject({
      p_team: 'tenant_ops', p_caller: 'u-1', p_subject_type: 'landlord', p_result: 'answered', p_answer_field: 'aware_merchant_codes',
      p_answer: 'did_not_know', p_region: 'Central', p_district: 'Wakiso', p_status: 'repaying',
    });
    expect(awarenessFilterArgs({ ...base, answer: 'explained:partly' })).toMatchObject({ p_answer_field: 'explained', p_answer: 'partly' });
  });

  it('ignores an answer choice it does not know rather than sending half of one', () => {
    expect(awarenessFilterArgs({ ...base, answer: 'nonsense' })).toMatchObject({ p_answer_field: null, p_answer: null });
  });
});

describe('awarenessFilterArgs: the landlord answer filters', () => {
  it('passes the consent and payment code (OTP) answers through as the answer field and answer', () => {
    expect(awarenessFilterArgs({ ...base, answer: 'landlord_consent:refuses' })).toMatchObject({ p_answer_field: 'landlord_consent', p_answer: 'refuses' });
    expect(awarenessFilterArgs({ ...base, answer: 'aware_payout_otp:knew' })).toMatchObject({ p_answer_field: 'aware_payout_otp', p_answer: 'knew' });
  });
});

describe('awarenessGapArgs', () => {
  it('sends only what the coverage gaps report can use', () => {
    const args = awarenessGapArgs({ ...base, team: 'agent_ops', caller: 'u-1', result: 'phone_off', region: 'Western', district: 'Mbarara', status: 'funded' });
    expect(args).toEqual({ p_from: base.startIso, p_to: base.endIso, p_team: 'agent_ops', p_region: 'Western', p_district: 'Mbarara', p_status: 'funded', p_outcome: null });
  });

  it('adds the outcome when one is chosen', () => {
    expect(awarenessGapArgs(base, 'rejected')).toMatchObject({ p_outcome: 'rejected' });
  });
});

describe('fetchAllAwarenessLog', () => {
  beforeEach(() => vi.clearAllMocks());
  const row = (i: number) => ({ id: `c-${i}` } as AwarenessLogRow);

  it('reads page after page until every call is in, 200 at a time', async () => {
    rpcMock.mockImplementation((_fn: string, a: Record<string, unknown>) => {
      const offset = Number(a.p_offset); const total = 450;
      const n = Math.max(0, Math.min(200, total - offset));
      return Promise.resolve({ data: { total, limit: 200, offset, rows: Array.from({ length: n }, (_v, i) => row(offset + i)) }, error: null });
    });
    const all = await fetchAllAwarenessLog({ ...base, result: 'answered' });
    expect(all.rows).toHaveLength(450);
    expect(all.truncated).toBe(false);
    expect(rpcMock.mock.calls.map((c) => (c[1] as Record<string, unknown>).p_offset)).toEqual([0, 200, 400]);
    expect(rpcMock.mock.calls.every((c) => c[0] === 'awareness_calls_log' && (c[1] as Record<string, unknown>).p_result === 'answered')).toBe(true);
  });

  it('says so when it could not get everything', async () => {
    rpcMock.mockImplementation((_fn: string, a: Record<string, unknown>) =>
      Promise.resolve({ data: { total: 500, limit: 200, offset: a.p_offset, rows: Number(a.p_offset) === 0 ? [row(1), row(2)] : [] }, error: null }));
    const all = await fetchAllAwarenessLog(base);
    expect(all.rows).toHaveLength(2);
    expect(all.total).toBe(500);
    expect(all.truncated).toBe(true);
  });

  it('stops at the first error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'not authorized' } });
    await expect(fetchAllAwarenessLog(base)).rejects.toMatchObject({ message: 'not authorized' });
  });
});
