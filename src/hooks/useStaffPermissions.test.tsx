import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

type AuthState = { user: { id: string } | null; roles: string[]; loading: boolean };
let auth: AuthState = { user: { id: 'u-1' }, roles: ['supporter', 'tenant_ops'], loading: false };
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));

let grantRows: { permitted_dashboard: string }[] = [{ permitted_dashboard: 'tenant-ops' }];
let grantError: { message: string } | null = null;
const fetchSpy = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.is = () => {
        fetchSpy();
        return Promise.resolve(grantError ? { data: null, error: grantError } : { data: grantRows, error: null });
      };
      return chain;
    },
  },
}));

import { clearStaffPermissionAnswers, useStaffPermissions } from './useStaffPermissions';

const setAuth = (patch: Partial<AuthState>) => { auth = { ...auth, ...patch }; };

describe('useStaffPermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStaffPermissionAnswers();
    auth = { user: { id: 'u-1' }, roles: ['supporter', 'tenant_ops'], loading: false };
    grantRows = [{ permitted_dashboard: 'tenant-ops' }];
    grantError = null;
  });

  it('loads once: loading until the first answer, then the grants', async () => {
    const { result } = renderHook(() => useStaffPermissions());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasPermission('tenant-ops')).toBe(true);
    expect(result.current.hasPermission('ceo')).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a new copy of the same user does not start over: no loading, no new read, same permissions', async () => {
    const { result, rerender } = renderHook(() => useStaffPermissions());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const first = result.current.permissions;
    const seen: boolean[] = [];

    for (let i = 0; i < 5; i += 1) {
      setAuth({ user: { id: 'u-1' } });            // every tab return hands over a fresh copy
      rerender();
      seen.push(result.current.loading);
    }
    await act(async () => { await Promise.resolve(); });
    expect(seen.every((l) => l === false)).toBe(true);
    expect(result.current.permissions).toBe(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a new roles array with the same roles is not a change', async () => {
    const { result, rerender } = renderHook(() => useStaffPermissions());
    await waitFor(() => expect(result.current.loading).toBe(false));
    setAuth({ roles: ['tenant_ops', 'supporter'] });   // same roles, other order and a new array
    rerender();
    expect(result.current.loading).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a screen built again starts from the held answer, with no loading page, and refreshes quietly', async () => {
    const first = renderHook(() => useStaffPermissions());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const again = renderHook(() => useStaffPermissions());
    expect(again.result.current.loading).toBe(false);
    expect(again.result.current.hasPermission('tenant-ops')).toBe(true);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(again.result.current.loading).toBe(false);
  });

  it('a background refresh that changes the grants swaps them in quietly, never showing loading', async () => {
    const { result, rerender } = renderHook(() => useStaffPermissions());
    await waitFor(() => expect(result.current.loading).toBe(false));
    grantRows = [{ permitted_dashboard: 'tenant-ops' }, { permitted_dashboard: 'agent-ops' }];
    setAuth({ roles: ['supporter', 'tenant_ops', 'agent_ops'] });   // a role change asks again in the background
    const seen: boolean[] = [];
    rerender();
    seen.push(result.current.loading);
    await waitFor(() => expect(result.current.hasPermission('agent-ops')).toBe(true));
    seen.push(result.current.loading);
    expect(seen.every((l) => l === false)).toBe(true);
  });

  it('a refresh that fails keeps the answer already on screen', async () => {
    const { result, rerender } = renderHook(() => useStaffPermissions());
    await waitFor(() => expect(result.current.loading).toBe(false));
    grantError = { message: 'network down' };
    setAuth({ roles: ['supporter', 'tenant_ops', 'agent_ops'] });
    rerender();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(result.current.loading).toBe(false);
    expect(result.current.hasPermission('tenant-ops')).toBe(true);
  });

  it('with no answer yet, a failed lookup fails closed: only the roles\' own dashboards', async () => {
    grantError = { message: 'network down' };
    setAuth({ roles: ['supporter', 'ceo'] });
    const { result } = renderHook(() => useStaffPermissions());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasPermission('ceo')).toBe(true);        // the role's own dashboard
    expect(result.current.hasPermission('tenant-ops')).toBe(false); // never widened
  });

  it('another person is a real change: loading again, and never answered from the first person\'s grants', async () => {
    const { result, rerender } = renderHook(() => useStaffPermissions());
    await waitFor(() => expect(result.current.loading).toBe(false));
    grantRows = [];
    setAuth({ user: { id: 'u-2' }, roles: ['supporter'] });
    rerender();
    expect(result.current.hasPermission('tenant-ops')).toBe(false);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasPermission('tenant-ops')).toBe(false);
  });

  it('super admin and CTO see everything without a read', async () => {
    setAuth({ roles: ['supporter', 'super_admin'] });
    const { result } = renderHook(() => useStaffPermissions());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasPermission('anything')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
