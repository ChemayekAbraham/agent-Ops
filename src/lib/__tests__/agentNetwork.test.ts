import { describe, expect, it } from 'vitest';
import { networkErrorMessage, networkRangeParams, normalizeNetworkOverview } from '../agentNetwork';

describe('networkRangeParams', () => {
  const day = (s: string) => new Date(`${s}T00:00:00`);
  it('sends the calendar days the picker shows', () => {
    expect(networkRangeParams(day('2026-10-01'), day('2026-10-15'), '2026-10-15')).toEqual({ p_start: '2026-10-01', p_end: '2026-10-15' });
    expect(networkRangeParams(day('2026-10-14'), new Date('2026-10-14T23:59:59'), '2026-10-15')).toEqual({ p_start: '2026-10-14', p_end: '2026-10-14' });
  });
  it('never asks for a future Kampala day (the server refuses it) and never starts after the end', () => {
    expect(networkRangeParams(day('2026-10-10'), day('2026-10-20'), '2026-10-15')).toEqual({ p_start: '2026-10-10', p_end: '2026-10-15' });
    expect(networkRangeParams(day('2026-10-18'), day('2026-10-20'), '2026-10-15')).toEqual({ p_start: '2026-10-15', p_end: '2026-10-15' });
  });
});

describe('normalizeNetworkOverview', () => {
  it('reads a zero payload: every figure 0, every list empty', () => {
    const z = normalizeNetworkOverview({});
    expect(z.counts).toEqual({ agents: 0, with_service_centres: 0, with_bikes: 0, with_smartphone_plan: 0, with_smartphone_tenants: 0, with_subagents: 0, posted_requests: 0, approved_agents: 0 });
    expect(z.approved).toEqual({ agents: 0, requests: 0, amount: 0, receivables_outstanding: 0 });
    expect(z.top_portfolios).toEqual([]);
    expect(z.top_collection_rate).toEqual([]);
    expect(z.default_rate_ascending).toEqual([]);
    expect(normalizeNetworkOverview(null).counts.agents).toBe(0);
    expect(normalizeNetworkOverview('x').approved.amount).toBe(0);
  });
  it('keeps every figure and the order exactly as returned (no sums, rates or sorting)', () => {
    const d = normalizeNetworkOverview({
      range: { start: '2026-09-16', end: '2026-10-15', min_expected: 50000 },
      counts: { agents: 770, with_service_centres: 53, with_bikes: 2, with_smartphone_plan: 34, with_smartphone_tenants: 240, with_subagents: 166, posted_requests: 254, approved_agents: 124 },
      approved: { agents: 73, requests: 348, amount: 197940001, receivables_outstanding: 232937315 },
      top_portfolios: [{ agent_id: 'a', name: 'B', phone: '+256700000001', portfolio: 5, plans: 9 }, { agent_id: 'b', name: 'A', phone: '', portfolio: 9, plans: 1 }],
      top_collection_rate: [{ agent_id: 'a', name: 'B', phone: null, collected: 1, expected: 1000, rate_pct: 315.6 }],
      default_rate_ascending: [{ agent_id: 'a', name: 'B', phone: 'x', outstanding: 10, defaulted: 5, default_rate_pct: 0.1, plans: 2 }],
    });
    expect(d.counts.agents).toBe(770);
    expect(d.approved.amount).toBe(197940001);
    expect(d.top_portfolios.map((r) => r.agent_id)).toEqual(['a', 'b']); // not re-sorted although b is larger
    expect(d.top_portfolios[1].phone).toBeNull();
    expect(d.top_collection_rate[0].rate_pct).toBe(315.6); // not 1 / 1000
    expect(d.default_rate_ascending[0].default_rate_pct).toBe(0.1); // not 5 / 10
    expect(d.range).toEqual({ start: '2026-09-16', end: '2026-10-15', min_expected: 50000 });
  });
  it('turns numeric text into numbers and names a missing agent', () => {
    const d = normalizeNetworkOverview({ counts: { agents: '12' }, top_portfolios: [{ agent_id: 'a', portfolio: '1500.00', plans: '3' }] });
    expect(d.counts.agents).toBe(12);
    expect(d.top_portfolios[0]).toMatchObject({ portfolio: 1500, plans: 3, name: 'Unnamed agent', phone: null });
  });
});

describe('networkErrorMessage', () => {
  it('words the errors', () => {
    expect(networkErrorMessage({ message: 'not_authorized' })).toBe('You do not have access to the Agent Network figures.');
    expect(networkErrorMessage({ code: '42501', message: 'x' })).toBe('You do not have access to the Agent Network figures.');
    expect(networkErrorMessage({ message: 'auth_required' })).toBe('Your session expired. Sign in again and retry.');
    expect(networkErrorMessage({ message: 'RANGE_FUTURE: p_end is a future Kampala day' })).toBe('Pick a range that ends today or earlier.');
    expect(networkErrorMessage(new Error('boom'))).toBe('boom');
    expect(networkErrorMessage(null)).not.toBe('');
  });
});
