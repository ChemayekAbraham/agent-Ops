import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
vi.mock('recharts', () => {
  const Stub = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { CartesianGrid: Stub, Line: Stub, LineChart: Stub, ResponsiveContainer: Stub, Tooltip: Stub, XAxis: Stub, YAxis: Stub };
});
vi.mock('@/components/executive/tenant-ops/workspace/TenantSelfPaymentWeeklyTrend', () => ({
  TenantSelfPaymentWeeklyTrend: () => null,
}));

import { WeeklyPerformanceTab } from './WeeklyPerformanceTab';

const metrics = {
  total_active_tenants: 789, paying_tenants: 409, non_paying_tenants: 380, new_tenants_added: 69,
  payment_rate_pct: 51.8, self_payment_tenants: 31, dormant_20_plus_count: 208, landlord_not_paid_count: 98,
};
const performance = (changed: boolean) => ({
  week_start: '2026-10-07', week_end: '2026-10-13', is_current_week_open: true,
  counting: 'amclock', first_amclock_week: '2026-10-07', counting_changed_this_week: changed,
  current: metrics,
  previous: { ...metrics, week_start: '2026-09-30', week_end: '2026-10-06', counting: 'old', landlord_not_paid_count: null },
  delta: {
    total_active_tenants: -44, paying_tenants: 47, non_paying_tenants: -91, new_tenants_added: 10,
    payment_rate_pct: 8.3, self_payment_tenants: 8, self_payment_increase_pct: 34.8,
    dormant_20_plus_count: 58, landlord_not_paid_count: null,
  },
});
const historyRow = (week_start: string, counting: 'old' | 'amclock', changed = false) => ({
  week_start, week_end: week_start, captured_at: '2026-10-14T00:10:00Z', counting, counting_changed: changed,
  total_active_tenants: 1, paying_tenants: 1, non_paying_tenants: 0, new_tenants_added: 0,
  payment_rate_pct: 100, self_payment_tenants: 0, dormant_20_plus_count: 0,
  landlord_not_paid_count: counting === 'old' ? null : 3,
});

function setup(changed: boolean, history: unknown[]) {
  rpc.mockImplementation((name: string) =>
    Promise.resolve({
      data: name === 'get_tenant_ops_weekly_performance_amclock' ? performance(changed) : history,
      error: null,
    }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WeeklyPerformanceTab />
    </QueryClientProvider>,
  );
}

describe('WeeklyPerformanceTab on the landlord-paid clock', () => {
  beforeEach(() => rpc.mockReset());

  it('reads only the _amclock functions', async () => {
    setup(false, []);
    await screen.findByTestId('weekly-clock-note');
    const names = rpc.mock.calls.map((c) => c[0]);
    expect(names).toContain('get_tenant_ops_weekly_performance_amclock');
    expect(names).toContain('get_tenant_ops_weekly_history_amclock');
    expect(names).not.toContain('get_tenant_ops_weekly_performance');
    expect(names).not.toContain('get_tenant_ops_weekly_history');
  });

  it('says where the clock starts and how many plans are not counted as owing', async () => {
    setup(false, []);
    const note = await screen.findByTestId('weekly-clock-note');
    expect(note.textContent).toContain('Counted from the day after the landlord was paid');
    expect(screen.getByTestId('weekly-landlord-not-paid').textContent).toBe(
      'Landlord not paid yet: 98 plans (not counted as owing)',
    );
    expect(screen.queryByTestId('weekly-counting-changed')).toBeNull();
  });

  it('flags the week the counting changed on the figures and in the history', async () => {
    setup(true, [historyRow('2026-10-07', 'amclock', true), historyRow('2026-09-30', 'old')]);
    const flag = await screen.findByTestId('weekly-counting-changed');
    expect(flag.textContent).toBe('Counting changed this week - earlier weeks used the old start date');
    const marks = await screen.findAllByTestId('history-counting-changed');
    expect(marks).toHaveLength(1);
  });
});
