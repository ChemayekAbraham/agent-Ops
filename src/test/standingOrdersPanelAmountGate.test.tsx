import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StandingOrderRow } from '@/hooks/useStandingOrders';

const mocks = vi.hoisted(() => ({
  auth: { role: 'supporter', roles: ['supporter'] as string[] },
  rpc: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: vi.fn(), functions: { invoke: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mocks.auth }));

const order: StandingOrderRow = {
  id: '00000000-0000-0000-0000-000000000010', amount: 100000, updated_at: '2026-10-23T01:00:00Z',
  target_user_id: 'recipient', target_name: 'Panel Recipient', target_phone: null, target_missing: false,
  category_id: 'lunch_allowance', sub_category: null, reason: 'Fixture', frequency: 'daily',
  day_of_month: null, day_of_week: null, interval_days: null, enabled: true,
  created_at: '2026-10-01', next_run_at: '2026-10-24', last_run_at: '2026-10-23', last_run_status: 'failed', last_run_error: 'fixture',
  consecutive_failures: 1, health: 'failing',
};
vi.mock('@/hooks/useStandingOrders', () => ({
  useStandingOrders: () => ({ data: [order], isLoading: false, isFetching: false, refetch: vi.fn() }),
  useSetStandingOrderEnabled: () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

import { StandingOrdersPanel } from '@/components/cfo/StandingOrdersPanel';

function setup(role: string, roles: string[]) {
  mocks.auth = { role, roles };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><StandingOrdersPanel /></QueryClientProvider>);
}
// Production-like backend: the amount dialog must stay preview-only.
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('VITE_SUPABASE_URL', 'https://byrzshwlentqvktcksem.supabase.co'); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('standing order "Change amount" visibility follows the account roles, not the active role', () => {
  it('shows it to a CFO account whose active role is still Supporter', () => {
    setup('supporter', ['supporter', 'cfo']);
    expect(screen.getByRole('button', { name: 'Change amount' })).toBeTruthy();
  });

  it('shows it to a super-admin account whatever role is active', () => {
    setup('employee', ['employee', 'supporter', 'super_admin']);
    expect(screen.getByRole('button', { name: 'Change amount' })).toBeTruthy();
  });

  it('hides it from an account without CFO or super admin', () => {
    setup('manager', ['manager', 'supporter', 'employee', 'cto']);
    expect(screen.queryByRole('button', { name: 'Change amount' })).toBeNull();
  });

  it('opens the increase/decrease dialog in preview-only mode, with saving disabled and no save call', () => {
    setup('supporter', ['supporter', 'cfo']);
    fireEvent.click(screen.getByRole('button', { name: 'Change amount' }));
    expect(screen.getByRole('note').textContent).toContain('Preview only');
    expect(screen.getByRole('button', { name: 'Increase' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decrease' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Change amount (UGX)'), { target: { value: '25000' } });
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'Preview amount correction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    const save = screen.getByRole('button', { name: 'Saving disabled' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
