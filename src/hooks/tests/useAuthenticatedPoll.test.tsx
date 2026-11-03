import { render, renderHook, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import {
  AuthRequiredError,
  hasUsableUserSession,
  isUnauthenticatedRpcError,
  requireUserSession,
  sessionHasUsableAccessToken,
  useAuthenticatedPoll,
} from '@/hooks/useAuthenticatedPoll';

const getSession = vi.fn();
const auth = {
  user: null as { id: string } | null,
  session: null as { access_token?: string; expires_at?: number } | null,
  loading: true,
  roles: ['tenant'] as string[],
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => auth,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: () => getSession() } },
}));

function wrap(path = '/') {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
  );
}

describe('sessionHasUsableAccessToken', () => {
  const now = 1_700_000_000_000;

  it('rejects a missing session and an expired access token', () => {
    expect(sessionHasUsableAccessToken(null, now)).toBe(false);
    expect(sessionHasUsableAccessToken({ access_token: '' }, now)).toBe(false);
    expect(sessionHasUsableAccessToken({ access_token: 'jwt', expires_at: now / 1000 - 1 }, now)).toBe(false);
  });

  it('accepts a token that has not expired', () => {
    expect(sessionHasUsableAccessToken({ access_token: 'jwt', expires_at: now / 1000 + 60 }, now)).toBe(true);
    expect(sessionHasUsableAccessToken({ access_token: 'jwt' }, now)).toBe(true);
  });
});

describe('isUnauthenticatedRpcError', () => {
  it('matches a missing user JWT and ignores ordinary failures', () => {
    expect(isUnauthenticatedRpcError(new AuthRequiredError())).toBe(true);
    expect(isUnauthenticatedRpcError({ status: 401, message: 'JWT expired' })).toBe(true);
    expect(isUnauthenticatedRpcError({ code: 'PGRST301', message: 'JWT expired' })).toBe(true);
    expect(isUnauthenticatedRpcError({
      code: '42501',
      message: 'permission denied for function hr_pay_pending_prompt',
    })).toBe(true);
    expect(isUnauthenticatedRpcError({ code: '42501', message: 'Not authorized' })).toBe(false);
    expect(isUnauthenticatedRpcError(new Error('timeout'))).toBe(false);
  });
});

describe('hasUsableUserSession', () => {
  beforeEach(() => { getSession.mockReset(); });

  it('is false when getSession has no user JWT', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(hasUsableUserSession()).resolves.toBe(false);
  });

  it('is true when getSession returns an unexpired access token', async () => {
    getSession.mockResolvedValue({
      data: { session: { access_token: 'jwt', expires_at: Math.floor(Date.now() / 1000) + 600 } },
      error: null,
    });
    await expect(hasUsableUserSession()).resolves.toBe(true);
  });

  it('requireUserSession throws before an RPC when the user JWT is missing', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(requireUserSession()).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe('useAuthenticatedPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    auth.user = null;
    auth.session = null;
    auth.loading = true;
    auth.roles = ['tenant'];
    getSession.mockReset();
    getSession.mockResolvedValue({
      data: { session: { access_token: 'jwt', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      error: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call the loader for a signed-out or still-loading visitor', async () => {
    const load = vi.fn();
    renderHook(() => useAuthenticatedPoll(load, 1_000), { wrapper: wrap() });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(load).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('loads once a user session is ready, and stops after sign-out', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    auth.loading = false;
    auth.user = { id: 'staff-1' };
    auth.session = { access_token: 'jwt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    const { rerender } = renderHook(() => useAuthenticatedPoll(load, 1_000), { wrapper: wrap() });
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(load).toHaveBeenCalledTimes(2);

    auth.user = null;
    auth.session = null;
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not call the loader when the live session has no usable access token', async () => {
    const load = vi.fn();
    auth.loading = false;
    auth.user = { id: 'staff-1' };
    auth.session = { access_token: 'stale' };
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    renderHook(() => useAuthenticatedPoll(load, 1_000), { wrapper: wrap() });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getSession).toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('waits for an optional role and then polls', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    auth.loading = false;
    auth.user = { id: 'cto-1' };
    auth.session = { access_token: 'jwt' };
    auth.roles = ['tenant'];
    const { rerender } = renderHook(
      () => useAuthenticatedPoll(load, 5_000, { roles: ['cto', 'super_admin'] }),
      { wrapper: wrap() },
    );
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();

    auth.roles = ['cto', 'tenant'];
    rerender();
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('re-checks on navigation after the first path', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    auth.loading = false;
    auth.user = { id: 'staff-1' };
    auth.session = { access_token: 'jwt' };

    function Probe() {
      useAuthenticatedPoll(load, 60_000, { onNavigate: true });
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate('/hr/pay')}>go</button>;
    }

    const { getByRole } = render(<Probe />, { wrapper: wrap('/') });
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => { getByRole('button').click(); });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
