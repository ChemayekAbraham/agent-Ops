import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useEffect } from 'react';

// A dashboard that counts how many times it is built, standing in for the Tenant Ops hub and the Calling Center in it.
const built = vi.fn();
const removed = vi.fn();
vi.mock('@/components/executive/TenantOpsHub', () => ({
  TenantOpsHub: function TenantOpsHub() {
    useEffect(() => { built(); return () => removed(); }, []);
    return <div data-testid="hub-contents">Calling Center</div>;
  },
}));
vi.mock('@/components/mission/MissionBanner', () => ({ MissionBanner: () => null }));
vi.mock('@/components/budget/BudgetDepartmentNotificationBell', () => ({ BudgetDepartmentNotificationBell: () => null }));
vi.mock('@/pages/NotFound', () => ({ default: () => <div data-testid="not-found" /> }));
vi.mock('@/components/common/ScreenLoader', () => ({ default: () => <div data-testid="screen-loader" /> }));

type AuthState = { user: { id: string } | null; roles: string[]; loading: boolean };
let auth: AuthState = { user: { id: 'u-1' }, roles: ['supporter', 'tenant_ops'], loading: false };
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));

let reads = 0;
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.is = () => { reads += 1; return Promise.resolve({ data: [{ permitted_dashboard: 'tenant-ops' }], error: null }); };
      return chain;
    },
  },
}));

import ExecutiveHub from './ExecutiveHub';
import { clearStaffPermissionAnswers } from '@/hooks/useStaffPermissions';

const tree = () => (
  <MemoryRouter initialEntries={['/executive-hub?tab=tenant-ops']}>
    <ExecutiveHub />
  </MemoryRouter>
);

describe('ExecutiveHub keeps its dashboard while the sign-in is re-confirmed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reads = 0;
    clearStaffPermissionAnswers();
    auth = { user: { id: 'u-1' }, roles: ['supporter', 'tenant_ops'], loading: false };
  });

  it('shows the loading page only until the first permission answer, then builds the dashboard once', async () => {
    const { rerender } = render(tree());
    expect(screen.getByTestId('screen-loader')).toBeInTheDocument();
    expect(await screen.findByTestId('hub-contents')).toBeInTheDocument();
    expect(built).toHaveBeenCalledTimes(1);

    // the tab becomes visible again, five times, each handing over a fresh copy of the same user and roles
    for (let i = 0; i < 5; i += 1) {
      auth = { ...auth, user: { id: 'u-1' }, roles: ['supporter', 'tenant_ops'] };
      rerender(tree());
      expect(screen.queryByTestId('screen-loader')).not.toBeInTheDocument();
      expect(screen.getByTestId('hub-contents')).toBeInTheDocument();
    }
    await act(async () => { await Promise.resolve(); });
    // never torn down, never built a second time, no new permission read
    expect(built).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    expect(reads).toBe(1);
  });

  it('a background refresh (the roles are asked about again) swaps quietly, with the dashboard staying put', async () => {
    const { rerender } = render(tree());
    await screen.findByTestId('hub-contents');
    auth = { ...auth, roles: ['supporter', 'tenant_ops', 'agent_ops'] };
    rerender(tree());
    expect(screen.queryByTestId('screen-loader')).not.toBeInTheDocument();
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByTestId('hub-contents')).toBeInTheDocument();
    expect(removed).not.toHaveBeenCalled();
  });
});
