import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useEffect } from 'react';

const built = vi.fn();
const removed = vi.fn();
function Page() {
  useEffect(() => { built(); return () => removed(); }, []);
  return <div data-testid="page">CFO page</div>;
}

type AuthState = { user: { id: string } | null; roles: string[]; loading: boolean };
let auth: AuthState = { user: { id: 'u-1' }, roles: ['supporter', 'cfo'], loading: false };
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useRoleAccessRequests', () => ({ useRoleAccessRequests: () => ({ requests: [], requestRole: vi.fn(), loading: false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/auth/PhoneVerificationGate', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/common/StalledLoaderWatchdog', () => ({ default: () => <div data-testid="signing-in" /> }));
vi.mock('@/pages/NotFound', () => ({ default: () => <div data-testid="not-found" /> }));
vi.mock('@/lib/loginTelemetry', () => ({ loginTelemetry: { mark: vi.fn(), start: () => vi.fn(), setUserId: vi.fn() } }));

let reads = 0;
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.insert = () => Promise.resolve({ error: null });
      chain.is = () => { if (table === 'staff_permissions') reads += 1; return Promise.resolve({ data: [{ permitted_dashboard: 'cfo' }], error: null }); };
      return chain;
    },
  },
}));

import RoleGuard from './RoleGuard';
import { clearStaffPermissionAnswers } from '@/hooks/useStaffPermissions';

const tree = () => (
  <MemoryRouter>
    <RoleGuard allowedRoles={['cfo', 'super_admin']} requiredPermission="cfo"><Page /></RoleGuard>
  </MemoryRouter>
);

describe('RoleGuard with a required permission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reads = 0;
    clearStaffPermissionAnswers();
    auth = { user: { id: 'u-1' }, roles: ['supporter', 'cfo'], loading: false };
  });

  it('waits for the first permission answer, then keeps the page through repeated sign-in re-confirmations', async () => {
    const { rerender } = render(tree());
    expect(screen.getByTestId('signing-in')).toBeInTheDocument();
    expect(await screen.findByTestId('page')).toBeInTheDocument();

    for (let i = 0; i < 5; i += 1) {
      auth = { ...auth, user: { id: 'u-1' }, roles: ['supporter', 'cfo'] };
      rerender(tree());
      expect(screen.queryByTestId('signing-in')).not.toBeInTheDocument();
      expect(screen.getByTestId('page')).toBeInTheDocument();
    }
    await act(async () => { await Promise.resolve(); });
    expect(built).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    expect(reads).toBe(1);
  });

  it('still shows the not-found page to someone without the grant', async () => {
    auth = { user: { id: 'u-2' }, roles: ['supporter', 'super_admin_not'], loading: false };
    render(tree());
    expect(await screen.findByTestId('not-found')).toBeInTheDocument();
    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
  });
});
