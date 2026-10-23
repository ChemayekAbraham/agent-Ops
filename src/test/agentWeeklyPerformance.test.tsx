import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentWeekProgress, groupProgress, nextResultDay, parseWeeklyPerformance, shortDay } from '@/lib/weeklyPerformance';

// Shape returned by get_my_weekly_performance (numerics as strings, like PostgREST jsonb).
const fixture = {
  agent_id: 'agent-1',
  settings: { in_window_required_pct: '0.50', expired_required_pct: '0.20', all_expired_required_pct: '0.70', enforced: true },
  current_week: {
    week_start: '2026-10-22', week_end: '2026-10-28', today: '2026-10-23', days_elapsed: 2, days_left: 5, book: 'mixed',
    in_window_due_so_far: '67834', in_window_collected: '20000', in_window_plans: 1, in_window_projected_due: '237419',
    expired_due_so_far: '820880', expired_collected: '0', expired_plans: 24, expired_projected_due: '2873080',
    in_window_required_pct: '0.50', expired_required_pct: '0.20',
  },
  weeks: [
    { week_start: '2026-10-15', week_end: '2026-10-21', is_judged: true, book: 'mixed',
      in_window_due: '237419', in_window_collected: '22000', in_window_plans: 1, in_window_pct: '0.0927', in_window_required_pct: '0.50',
      expired_due: '1231320', expired_collected: '19000', expired_plans: 24, expired_pct: '0.0154', expired_required_pct: '0.20',
      passes: false, reason: 'Last week (15 Oct to 21 Oct) you collected 9.2% of what your current Rent Plans were due (UGX 22,000 of UGX 237,419). You need 50%.' },
    { week_start: '2026-10-08', week_end: '2026-10-14', is_judged: false, book: 'none',
      in_window_due: 0, in_window_collected: 0, in_window_plans: 0, in_window_pct: null, in_window_required_pct: null,
      expired_due: 0, expired_collected: 0, expired_plans: 0, expired_pct: null, expired_required_pct: null, passes: true, reason: null },
  ],
  plans: [
    { rent_request_id: 'rr-1', tenant_id: 't-1', tenant_name: 'Fixture Tenant', tenant_phone: '+256700000001', expired: false,
      due_so_far: '67834', collected: '20000', paid_raw: '20000', daily_due: '33917' },
    { rent_request_id: 'rr-2', tenant_id: 't-2', tenant_name: 'Old Plan Tenant', tenant_phone: null, expired: true,
      due_so_far: '34000', collected: '0', paid_raw: '0', daily_due: '17000' },
  ],
};

describe('weeklyPerformance maths', () => {
  it('targets and remaining follow required × due, compared on amounts', () => {
    const g = groupProgress(237419, 22000, 0.5);
    expect(g.target).toBe(118710);
    expect(g.remaining).toBe(96710);
    expect(g.met).toBe(false);
    expect(groupProgress(100, 50, 0.5).met).toBe(true);
    expect(groupProgress(100, 49.99, 0.5).met).toBe(false);
    expect(groupProgress(0, 0, null).met).toBe(true);
    expect(groupProgress(1000, 5000, 0.5).ratio).toBe(1);
  });
  it('measures this week against the projected full week', () => {
    const p = parseWeeklyPerformance(fixture);
    const live = currentWeekProgress(p.current_week);
    expect(live.current.due).toBe(237419);
    expect(live.expired.target).toBe(Math.ceil(0.2 * 2873080));
    expect(live.onTrack).toBe(false);
  });
  it('formats days without timezone drift', () => {
    expect(shortDay('2026-10-15')).toBe('15 Oct');
    expect(nextResultDay('2026-10-28')).toBe('Thursday 29 Oct');
  });
});

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: vi.fn(), functions: { invoke: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'agent-1' } }) }));

import AgentWeeklyPerformancePage from '@/pages/agent/AgentWeeklyPerformance';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Weekly Performance page', () => {
  it('shows the posting status, both groups, tenants and history from the RPC', async () => {
    mocks.rpc.mockResolvedValue({ data: fixture, error: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AgentWeeklyPerformancePage /></MemoryRouter></QueryClientProvider>);

    await waitFor(() => expect(screen.getByText('You cannot post new Rent Plans')).toBeTruthy());
    expect(mocks.rpc).toHaveBeenCalledWith('get_my_weekly_performance', { p_weeks: 6 });
    expect(screen.getByText(/you collected 9.2% of what your current Rent Plans were due/)).toBeTruthy();
    expect(screen.getAllByText('Current Rent Plans').length).toBe(2);
    expect(screen.getAllByText('Expired Rent Plans').length).toBe(2);
    expect(screen.getByText('Fixture Tenant')).toBeTruthy();
    expect(screen.getByLabelText('Call Fixture Tenant')).toBeTruthy();
    expect(screen.getByText('Decides this week')).toBeTruthy();
    expect(screen.getByText('Nothing was due')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expired' }));
    expect(screen.queryByText('Fixture Tenant')).toBeNull();
    expect(screen.getByText('Old Plan Tenant')).toBeTruthy();

    // Regulatory wording
    expect(document.body.textContent).not.toMatch(/\b(loan|lender|interest|ROI)\b/i);
  });

  it('shows an error with a retry when the read fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AgentWeeklyPerformancePage /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Could not load your performance')).toBeTruthy());
  });
});
