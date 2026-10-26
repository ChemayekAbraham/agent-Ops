import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const invokeMock = vi.fn();
const getSessionMock = vi.fn();
const refreshSessionMock = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
    auth: {
      getSession: () => getSessionMock(),
      refreshSession: () => refreshSessionMock(),
    },
  },
}));

vi.mock('@/lib/deviceFingerprint', () => ({
  getDeviceFingerprint: async () => 'fp-current-device',
  isValidFingerprintShape: () => true,
}));

import { useNewDeviceSignIns } from '@/hooks/useNewDeviceSignIns';

const USER_ID = 'user-123';

function sessionFor(userId: string, expiresInMs = 60 * 60 * 1000) {
  return {
    data: {
      session: {
        access_token: `token-for-${userId}`,
        expires_at: Math.floor((Date.now() + expiresInMs) / 1000),
        user: { id: userId },
      },
    },
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useNewDeviceSignIns background check', () => {
  it('does not call the edge function when there is no session (signed out)', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null }, error: null });
    refreshSessionMock.mockResolvedValue({ data: { session: null }, error: null });

    renderHook(() => useNewDeviceSignIns(USER_ID));

    await waitFor(() => expect(getSessionMock).toHaveBeenCalled());
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does not call the edge function when the cached session belongs to a different account', async () => {
    getSessionMock.mockResolvedValue(sessionFor('someone-else'));
    refreshSessionMock.mockResolvedValue({ data: { session: null }, error: null });

    renderHook(() => useNewDeviceSignIns(USER_ID));

    await waitFor(() => expect(getSessionMock).toHaveBeenCalled());
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('sends an explicit fresh token for the current account', async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_ID));
    invokeMock.mockResolvedValue({ data: { devices: [] }, error: null });

    renderHook(() => useNewDeviceSignIns(USER_ID));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    const [fn, opts] = invokeMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(fn).toBe('device-sign-in-alert');
    expect(opts.headers.Authorization).toBe(`Bearer token-for-${USER_ID}`);
  });

  it('retries once with a refreshed token on 401, then stops', async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_ID));
    refreshSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: 'refreshed-token',
          expires_at: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
          user: { id: USER_ID },
        },
      },
      error: null,
    });
    invokeMock
      .mockResolvedValueOnce({ data: null, error: { context: { status: 401 }, message: 'Not signed in' } })
      .mockResolvedValueOnce({ data: { devices: [{ device_fp: 'fp-new' }] }, error: null });

    const { result } = renderHook(() => useNewDeviceSignIns(USER_ID));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
    const secondCall = invokeMock.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(secondCall[1].headers.Authorization).toBe('Bearer refreshed-token');
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
  });

  it('stays quiet when the retry also fails (no throw, empty list)', async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_ID));
    refreshSessionMock.mockResolvedValue({ data: { session: { access_token: 'refreshed-token', expires_at: Math.floor((Date.now() + 3600000) / 1000), user: { id: USER_ID } } }, error: null });
    invokeMock.mockResolvedValue({ data: null, error: { context: { status: 401 }, message: 'Not signed in' } });

    const { result } = renderHook(() => useNewDeviceSignIns(USER_ID));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(result.current.pending).toEqual([]);
  });

  it('stops polling after a refreshed token is also rejected', async () => {
    getSessionMock.mockResolvedValue(sessionFor(USER_ID));
    refreshSessionMock.mockResolvedValue({ data: { session: { access_token: 'refreshed-token', expires_at: Math.floor((Date.now() + 3600000) / 1000), user: { id: USER_ID } } }, error: null });
    invokeMock.mockResolvedValue({ data: null, error: { context: { status: 401 } } });
    const { result } = renderHook(() => useNewDeviceSignIns(USER_ID));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    await result.current.refresh();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
