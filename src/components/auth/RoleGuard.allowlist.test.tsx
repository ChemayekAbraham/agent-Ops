import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Dashboard allowlist (2026-10-21): a staff route opens only for someone who
 * holds an allowed role AND has an active staff_permissions row for it.
 * Routes that admit a public role are never allowlisted.
 */

type AuthState = { user: { id: string } | null; roles: string[]; loading: boolean };
let auth: AuthState = { user: { id: 'u-1' }, roles: [], loading: false };
let grants: string[] = [];

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useRoleAccessRequests', () => ({ useRoleAccessRequests: () => ({ requests: [], requestRole: vi.fn(), loading: false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/auth/PhoneVerificationGate', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/common/StalledLoaderWatchdog', () => ({ default: () => <div data-testid="signing-in" /> }));
vi.mock('@/pages/NotFound', () => ({ default: () => <div data-testid="not-found" /> }));
vi.mock('@/lib/loginTelemetry', () => ({ loginTelemetry: { mark: vi.fn(), start: () => vi.fn(), setUserId: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.insert = () => Promise.resolve({ error: null });
      chain.is = () => Promise.resolve({ data: grants.map((g) => ({ permitted_dashboard: g })), error: null });
      return chain;
    },
  },
}));

import RoleGuard from './RoleGuard';
import { clearStaffPermissionAnswers } from '@/hooks/useStaffPermissions';
import type { AppRole } from '@/hooks/useAuth';

const Page = () => <div data-testid="page">page</div>;
const guard = (props: { allowedRoles: string[]; requiredPermission?: string | string[]; skipAllowlist?: boolean }) =>
  render(
    <MemoryRouter>
      <RoleGuard {...props} allowedRoles={props.allowedRoles as AppRole[]}><Page /></RoleGuard>
    </MemoryRouter>,
  );

describe('RoleGuard dashboard allowlist', () => {
  beforeEach(() => {
    clearStaffPermissionAnswers();
    grants = [];
    auth = { user: { id: 'u-1' }, roles: [], loading: false };
  });

  it('explicit key: the role alone is not enough', async () => {
    auth.roles = ['cfo'];
    guard({ allowedRoles: ['cfo', 'super_admin'], requiredPermission: 'cfo' });
    expect(await screen.findByTestId('not-found')).toBeInTheDocument();
  });

  it('explicit key: role plus grant opens it', async () => {
    auth.roles = ['cfo'];
    grants = ['cfo'];
    guard({ allowedRoles: ['cfo', 'super_admin'], requiredPermission: 'cfo' });
    expect(await screen.findByTestId('page')).toBeInTheDocument();
  });

  it('a list of keys: any one grant is enough', async () => {
    auth.roles = ['manager'];
    grants = ['agent-ops'];
    guard({ allowedRoles: ['manager'], requiredPermission: ['coo', 'agent-ops'] });
    expect(await screen.findByTestId('page')).toBeInTheDocument();
  });

  it('staff-only route without a key: needs the grant for the role it is entered with', async () => {
    auth.roles = ['cmo'];
    guard({ allowedRoles: ['cmo', 'cfo', 'manager', 'super_admin'] });
    expect(await screen.findByTestId('not-found')).toBeInTheDocument();
  });

  it('staff-only route without a key: role plus that role\'s grant opens it', async () => {
    auth.roles = ['cmo'];
    grants = ['cmo'];
    guard({ allowedRoles: ['cmo', 'cfo', 'manager', 'super_admin'] });
    expect(await screen.findByTestId('page')).toBeInTheDocument();
  });

  it('staff-only route without a key: a grant for another dashboard does not count', async () => {
    auth.roles = ['cmo'];
    grants = ['cfo'];
    guard({ allowedRoles: ['cmo', 'cfo', 'manager', 'super_admin'] });
    expect(await screen.findByTestId('not-found')).toBeInTheDocument();
  });

  it('super_admin and cto bypass the allowlist', async () => {
    auth.roles = ['cto'];
    guard({ allowedRoles: ['cto', 'cfo'] });
    expect(await screen.findByTestId('page')).toBeInTheDocument();
  });

  it('a route open to a public role is never allowlisted (normal users unaffected)', async () => {
    auth.roles = ['tenant'];
    guard({ allowedRoles: ['tenant', 'agent', 'manager'] });
    expect(await screen.findByTestId('page')).toBeInTheDocument();
  });

  it('skipAllowlist keeps a staff route role-only (e.g. /platform-users)', async () => {
    auth.roles = ['hr'];
    guard({ allowedRoles: ['hr', 'super_admin'], skipAllowlist: true });
    expect(await screen.findByTestId('page')).toBeInTheDocument();
  });
});
