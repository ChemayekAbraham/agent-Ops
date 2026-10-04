/**
 * Integration tests for the parallel + retry login flow in
 * `useAuthForm.handleSignInSubmit`.
 *
 * These tests mock every external dependency the hook touches
 * (router, AuthContext signIn, Supabase RPC, toast, OTP, geolocation,
 * duplicate-check) and then drive a full submit via the public
 * `handleSubmit` API. They assert two things the human cares about:
 *
 *  1. Phase 1 fires the 3 placeholder sign-ins IN PARALLEL — a typical
 *     login on slow-mobile (each signIn ~800ms, RPC ~1500ms) MUST
 *     finish near the slowest single leg, not the sum of the legs.
 *  2. Invalid credentials short-circuit fast (no retries), while a
 *     transient network failure on the winning leg is retried with
 *     exponential backoff and eventually succeeds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import React from 'react';

// ── Controllable test doubles ────────────────────────────────────────
const signInMock = vi.fn();
const rpcMock = vi.fn();
const toastMock = vi.fn();
const navigateMock = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(''), vi.fn()],
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signIn: signInMock,
    signUpWithoutRole: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
    resetPassword: vi.fn(),
    user: null,
    roles: [],
  }),
}));

vi.mock('@/hooks/usePhoneDuplicateCheck', () => ({
  usePhoneDuplicateCheck: () => ({
    isDuplicate: false,
    isChecking: false,
    duplicateMessage: null,
  }),
}));

vi.mock('@/hooks/useOtpVerification', () => ({
  useOtpVerification: () => ({
    otpSent: false,
    otpVerified: false,
    otpLoading: false,
    otpError: null,
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
    resetOtp: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock('@/hooks/useGeolocation', () => ({
  getLocationData: () => Promise.resolve(null),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: any[]) => rpcMock(...args),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    })),
  },
}));

// Helpers --------------------------------------------------------------
const delayed = <T,>(value: T, ms: number) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

async function flushAll() {
  // Drain pending microtasks AND timers triggered by retry backoff.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

async function loadHook() {
  const mod = await import('@/hooks/useAuthForm');
  return mod.useAuthForm;
}

function fakeFormEvent(): React.FormEvent {
  return { preventDefault: () => {} } as unknown as React.FormEvent;
}

beforeEach(() => {
  signInMock.mockReset();
  rpcMock.mockReset();
  toastMock.mockReset();
  navigateMock.mockReset();
  try { localStorage.clear(); } catch { /* noop */ }
});

describe('useAuthForm — parallel login performance', () => {
  it('runs the 3 placeholder sign-ins in PARALLEL (total ≈ slowest leg, not sum of legs)', async () => {
    const useAuthForm = await loadHook();
    // Each signIn takes 800ms. Sequential ⇒ ~2400ms. Parallel ⇒ ~800ms.
    // Only one leg succeeds; the others "fail" with wrong-creds (no retry).
    signInMock.mockImplementation((email: string) => {
      const ms = 800;
      if (email === '256712345678@welile.user') {
        return delayed({ error: null }, ms);
      }
      return delayed({ error: { message: 'Invalid login credentials' } }, ms);
    });
    // RPC slow-mobile — 1500ms. Parallel kickoff should make this NOT
    // gate the winning phase-1 leg.
    rpcMock.mockReturnValue(delayed({ data: [] }, 1500));

    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.setPhone('+256712345678');
      result.current.setPassword('hunter2');
    });

    const t0 = performance.now();
    await act(async () => {
      await result.current.handleSubmit(fakeFormEvent());
    });
    const total = performance.now() - t0;

    // All 3 phase-1 placeholders must have been awaited concurrently.
    expect(signInMock).toHaveBeenCalledTimes(3);
    // Parallelism: total within a generous fudge of the slowest single
    // leg (800ms) + jsdom overhead. Sequential would be ≥ 2400ms.
    expect(total).toBeLessThan(1500);

    // Persisted metrics confirm the winner came from phase1, not phase2.
    const raw = localStorage.getItem('welile_last_login_metrics');
    expect(raw).toBeTruthy();
    const metrics = JSON.parse(raw!);
    expect(metrics.success).toBe(true);
    expect(metrics.winnerPhase).toBe('phase1');
    expect(metrics.attempts).toBe(3);
    expect(metrics.phase1Ms).toBeLessThan(1300);
  });

  it('completes a typical slow-mobile login in under the 1600ms target', async () => {
    const useAuthForm = await loadHook();
    // Slow-mobile profile: signIn 800ms each, RPC 1500ms.
    signInMock.mockImplementation((email: string) => {
      const ms = 800;
      if (email === '0712345678@welile.user') {
        return delayed({ error: null }, ms);
      }
      return delayed({ error: { message: 'Invalid login credentials' } }, ms);
    });
    rpcMock.mockReturnValue(delayed({ data: [] }, 1500));

    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.setPhone('+256712345678');
      result.current.setPassword('hunter2');
    });

    const t0 = performance.now();
    await act(async () => {
      await result.current.handleSubmit(fakeFormEvent());
    });
    const total = performance.now() - t0;

    expect(total).toBeLessThan(1600);
    const metrics = JSON.parse(localStorage.getItem('welile_last_login_metrics')!);
    expect(metrics.success).toBe(true);
    expect(metrics.totalMs).toBeLessThan(1600);
  });

  it('does NOT retry on Invalid login credentials (fast fail, no extra attempts)', async () => {
    const useAuthForm = await loadHook();
    signInMock.mockResolvedValue({ error: { message: 'Invalid login credentials' } });
    rpcMock.mockReturnValue(delayed({ data: [] }, 50));

    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.setPhone('+256712345678');
      result.current.setPassword('wrong');
    });

    await act(async () => {
      await result.current.handleSubmit(fakeFormEvent());
    });

    // Phase 1 = 3 @welile.user placeholders. Phase 2 falls through to
    // the 3 @welile.agent fallbacks (always tried even when RPC returns
    // []). That's 6 total, with each email called exactly once because
    // "Invalid login credentials" is non-transient ⇒ NO retries.
    expect(signInMock).toHaveBeenCalledTimes(6);
    const uniqueEmails = new Set(signInMock.mock.calls.map(c => c[0]));
    expect(uniqueEmails.size).toBe(6);
    const metrics = JSON.parse(localStorage.getItem('welile_last_login_metrics')!);
    expect(metrics.success).toBe(false);
    // `retries` is only set when withRetry actually re-fires. Must be 0/undefined.
    expect(metrics.retries ?? 0).toBe(0);
  });

  it('retries with exponential backoff on transient network failure, then succeeds', async () => {
    const useAuthForm = await loadHook();
    // Winning placeholder fails once with a transient "Failed to fetch",
    // then succeeds on retry. The other two stay wrong-creds (no retry).
    const winning = '256712345678@welile.user';
    const winningCalls: number[] = [];
    signInMock.mockImplementation((email: string) => {
      if (email === winning) {
        winningCalls.push(Date.now());
        if (winningCalls.length === 1) {
          return delayed({ error: { message: 'Failed to fetch' } }, 50);
        }
        return delayed({ error: null }, 50);
      }
      return delayed({ error: { message: 'Invalid login credentials' } }, 50);
    });
    rpcMock.mockReturnValue(delayed({ data: [] }, 50));

    const { result } = renderHook(() => useAuthForm());
    act(() => {
      result.current.setPhone('+256712345678');
      result.current.setPassword('hunter2');
    });

    await act(async () => {
      await result.current.handleSubmit(fakeFormEvent());
      await flushAll();
    });

    // Winning leg must have been called at least twice (1 transient
    // failure + 1 successful retry). Other two legs: 1 call each.
    const winnerAttempts = signInMock.mock.calls.filter(c => c[0] === winning).length;
    expect(winnerAttempts).toBeGreaterThanOrEqual(2);

    const metrics = JSON.parse(localStorage.getItem('welile_last_login_metrics')!);
    expect(metrics.success).toBe(true);
    expect(metrics.retries ?? 0).toBeGreaterThanOrEqual(1);
    expect(metrics.winnerEmail).toBe(winning);
  });
});