import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));
vi.mock('@/hooks/useAgentExpectedSplit', () => ({ useOwnExpectedSplit: vi.fn() }));
vi.mock('@/hooks/useAgentCapacityMap', () => ({
  DAILY_ELIGIBILITY_THRESHOLD: 0.5,
  useAgentCapacityMap: vi.fn(),
}));
vi.mock('@/lib/rentCalculations', () => ({ formatUGX: vi.fn() }));

import { getTenantCoveragePresentation } from './AgentDailyCapacityStrip';

describe('Tenant-reach presentation (not posting authorization)', () => {
  it('NSUBUGA: yesterday carries 100% while eight more tenants are needed today', () => {
    expect(getTenantCoveragePresentation({ tenants_due: 17, tenants_paid_today: 1, coverage_today: 1 / 17, coverage_yesterday: 1 }))
      .toEqual({ progressPct: 100, todayRemaining: 8, yesterdayCarrying: true, bestDay: 'yesterday' });
  });
  it('reports six more tenants for a blocked six-tenant shortfall', () => {
    const result = getTenantCoveragePresentation({ tenants_due: 20, tenants_paid_today: 4, coverage_today: 0.2, coverage_yesterday: 0.1 });
    expect(result.todayRemaining).toBe(6);
    expect(result.progressPct).toBe(20);
    expect(result.yesterdayCarrying).toBe(false);
  });
  it('uses today when it is better, without adding the two days together', () => {
    const result = getTenantCoveragePresentation({ tenants_due: 10, tenants_paid_today: 5, coverage_today: 0.5, coverage_yesterday: 0.4 });
    expect(result.progressPct).toBe(50);
    expect(result.todayRemaining).toBe(0);
    expect(result.bestDay).toBe('today');
  });
  it('needs no tenants when none owe', () => {
    expect(getTenantCoveragePresentation({ tenants_due: 0, tenants_paid_today: 0, coverage_today: 0, coverage_yesterday: 0 }).todayRemaining).toBe(0);
  });
});