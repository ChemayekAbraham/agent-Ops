import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), refreshSession: vi.fn(), invoke: vi.fn(), signOut: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  auth: { getSession: mocks.getSession, refreshSession: mocks.refreshSession, signOut: mocks.signOut },
  functions: { invoke: mocks.invoke },
} }));
vi.mock('@/lib/invokeEdgeFunction', () => ({ invokeEdgeFunction: vi.fn() }));
vi.mock('@/lib/sessionCache', () => ({ clearAllAuthStorage: vi.fn(), clearSessionCache: vi.fn() }));
vi.mock('@/lib/deviceFingerprint', () => ({
  getDeviceFingerprint: vi.fn(async () => 'a'.repeat(64)),
  getHardwareFingerprint: vi.fn(async () => 'b'.repeat(64)),
  isValidFingerprintShape: (fp: unknown) => typeof fp === 'string' && fp.length === 64,
}));

import { useDeviceStepUp } from '@/hooks/useDeviceStepUp';

const session = (token = 'test-current-token', expires = Date.now() / 1000 + 3600, id = 'user-a') => ({
  data: { session: { access_token: token, expires_at: expires, user: { id } } }, error: null,
});

describe('device background checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(session());
    mocks.refreshSession.mockResolvedValue(session('test-refreshed-token'));
    mocks.invoke.mockResolvedValue({ data: { required: false }, error: null });
  });

  it('never calls the server when signed out', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const { result } = renderHook(() => useDeviceStepUp('user-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and explicitly sends the fresh token', async () => {
    mocks.getSession.mockResolvedValue(session('test-expired-token', Date.now() / 1000 - 1));
    const { result } = renderHook(() => useDeviceStepUp('user-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('device-step-up', expect.objectContaining({
      headers: { Authorization: 'Bearer test-refreshed-token' },
    }));
  });

  it('retries a 401 once and preserves an existing verification requirement on failure', async () => {
    mocks.invoke.mockResolvedValueOnce({ data: { required: true, phone_masked: '*** 123' }, error: null });
    const { result } = renderHook(() => useDeviceStepUp('user-a'));
    await waitFor(() => expect(result.current.required).toBe(true));
    mocks.invoke.mockResolvedValue({ data: null, error: { context: { status: 401 } } });
    await act(async () => { await result.current.check(); });
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(result.current.required).toBe(true);
  });

  it('does not register a session belonging to another account', async () => {
    mocks.getSession.mockResolvedValue(session('test-other-token', undefined, 'user-b'));
    const { result } = renderHook(() => useDeviceStepUp('user-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('contains thrown network failures without rejecting the check', async () => {
    mocks.invoke.mockRejectedValue(new Error('Network unavailable'));
    const { result } = renderHook(() => useDeviceStepUp('user-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await expect(result.current.check()).resolves.toBeUndefined(); });
  });

  it('coalesces overlapping visibility checks', async () => {
    const { result } = renderHook(() => useDeviceStepUp('user-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.invoke.mockClear();
    await act(async () => { await Promise.all([result.current.check(), result.current.check()]); });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});