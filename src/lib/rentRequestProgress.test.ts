import { describe, expect, it } from 'vitest';
import { daysSince, describeRentRequestProgress, type TenantRentRequestRow } from './rentRequestProgress';

const base: TenantRentRequestRow = {
  id: 'r1',
  status: 'pending',
  rent_amount: 300000,
  total_repayment: 419000,
  daily_repayment: 13967,
  duration_days: 30,
  created_at: '2026-11-14T07:52:49Z',
  service_center_reviewed_at: null,
  coo_reviewed_at: null,
  approved_at: null,
  funded_at: null,
  disbursed_at: null,
  rejected_at: null,
};
const states = (status: string, extra: Partial<TenantRentRequestRow> = {}) =>
  describeRentRequestProgress({ ...base, status, ...extra }).steps.map((s) => `${s.key}:${s.state}`);

describe('describeRentRequestProgress — every production status', () => {
  it('pending and service-centre review are both "checking your details"', () => {
    const expected = ['sent:done', 'checking:current', 'approval:upcoming', 'paid:upcoming', 'repaying:upcoming'];
    expect(states('pending')).toEqual(expected);
    expect(states('service_center_review')).toEqual(expected);
    expect(describeRentRequestProgress(base).headline).toBe('Request received');
  });

  it('partner-ops approved waits for final approval', () => {
    expect(states('partner_ops_approved')).toEqual(['sent:done', 'checking:done', 'approval:current', 'paid:upcoming', 'repaying:upcoming']);
  });

  it('COO approved is paying the landlord', () => {
    const p = describeRentRequestProgress({ ...base, status: 'coo_approved' });
    expect(p.headline).toBe('Approved — paying your landlord');
    expect(p.steps.find((s) => s.key === 'paid')?.state).toBe('current');
  });

  it('funded and repaying are an active Rent Plan with the daily amount', () => {
    const funded = describeRentRequestProgress({ ...base, status: 'funded', funded_at: '2026-11-20T08:00:00Z' });
    expect(funded.phase).toBe('active');
    expect(funded.detail).toContain('UGX 13,967');
    expect(funded.steps.find((s) => s.key === 'paid')).toMatchObject({ state: 'done', at: '2026-11-20T08:00:00Z' });
    expect(states('repaying').at(-1)).toBe('repaying:current');
  });

  it('completed marks every step done', () => {
    expect(states('completed').every((s) => s.endsWith(':done'))).toBe(true);
  });

  it('rejected, cancelled and withdrawn stop after the check, never look approved', () => {
    for (const status of ['rejected', 'cancelled', 'deleted_by_agent']) {
      const p = describeRentRequestProgress({ ...base, status, rejected_at: '2026-11-15T09:00:00Z' });
      expect(p.phase).toBe('stopped');
      expect(p.steps.map((s) => s.state)).toEqual(['done', 'stopped']);
    }
    expect(describeRentRequestProgress({ ...base, status: 'rejected' }).headline).toBe('Your request was not approved');
  });

  it('an unknown future status shows as being checked, not approved', () => {
    expect(states('some_new_review_stage')[1]).toBe('checking:current');
  });

  it('does not invent dates for steps not reached', () => {
    const p = describeRentRequestProgress({ ...base, status: 'pending', funded_at: '2026-11-20T08:00:00Z' });
    expect(p.steps.find((s) => s.key === 'paid')?.at).toBeNull();
  });
});

describe('daysSince', () => {
  it('counts whole days', () => {
    const sent = '2026-11-14T07:52:49Z';
    expect(daysSince(sent, Date.parse('2026-11-14T20:00:00Z'))).toBe(0);
    expect(daysSince(sent, Date.parse('2026-11-16T08:00:00Z'))).toBe(2);
  });
});
