/**
 * Deep links survive sign-in: when /auth carries an in-app ?redirect= (a scanned asset QR code opens
 * /cfo/assets/<uuid> and, signed out, lands on /auth?redirect=/cfo/assets/<uuid>), the login form hook must not send
 * the person to their role dashboard. Roles can arrive while auth is still loading; the old behaviour navigated a CFO
 * to /cfo/dashboard (which reopens the Asset Register list), unmounting /auth before it could honour the redirect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const navigateMock = vi.fn();
const state = vi.hoisted(() => ({
  search: '',
  auth: { user: null as { id: string } | null, roles: [] as string[], rolesResolved: false, loading: false },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(state.search), vi.fn()],
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signIn: vi.fn(), signUpWithoutRole: vi.fn(), signInWithGoogle: vi.fn(), signInWithApple: vi.fn(), resetPassword: vi.fn(),
    ...state.auth,
  }),
}));
vi.mock('@/hooks/usePhoneDuplicateCheck', () => ({ usePhoneDuplicateCheck: () => ({ isDuplicate: false, isChecking: false, duplicateMessage: null }) }));
vi.mock('@/hooks/useOtpVerification', () => ({
  useOtpVerification: () => ({ otpSent: false, otpVerified: false, otpLoading: false, otpError: null, sendOtp: vi.fn(), verifyOtp: vi.fn(), resetOtp: vi.fn() }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useGeolocation', () => ({ getLocationData: () => Promise.resolve(null) }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(),
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null }), update: vi.fn().mockReturnThis() })),
  },
}));

import { useAuthForm } from '@/hooks/useAuthForm';
import { roleToSlug } from '@/lib/roleRoutes';

const ASSET = '/cfo/assets/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const CFO = { user: { id: 'cfo-1' }, roles: ['cfo'], rolesResolved: true };

beforeEach(() => {
  vi.useFakeTimers();
  navigateMock.mockReset();
  state.search = '';
  state.auth = { user: null, roles: [], rolesResolved: false, loading: false };
  try { localStorage.clear(); } catch { /* noop */ }
});
afterEach(() => vi.useRealTimers());

describe('useAuthForm — post sign-in navigation with ?redirect=', () => {
  it('control: without a redirect, a signed-in CFO is sent to the role dashboard (the behaviour that used to win)', () => {
    state.auth = { ...CFO, loading: true };
    renderHook(() => useAuthForm());
    expect(navigateMock).toHaveBeenCalledWith(roleToSlug('cfo'), { replace: true });
  });

  it('roles loaded while auth is still loading: does not navigate away from /auth?redirect=<asset page>', () => {
    state.search = `redirect=${encodeURIComponent(ASSET)}`;
    state.auth = { ...CFO, loading: true };
    renderHook(() => useAuthForm());
    act(() => { vi.advanceTimersByTime(5000); });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('roles not loaded yet: the 3-second fallback does not fire either', () => {
    state.search = `redirect=${encodeURIComponent(ASSET)}`;
    state.auth = { user: { id: 'cfo-1' }, roles: [], rolesResolved: false, loading: true };
    const { rerender } = renderHook(() => useAuthForm());
    state.auth = { ...CFO, loading: true }; // roles arrive later
    rerender();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['another site', '//evil.example/x'],
    ['an absolute URL', 'https://evil.example/x'],
    ['a non-returnable page', '/auth'],
  ])('an unsafe or unusable redirect (%s) is ignored and the role dashboard is used', (_label, redirect) => {
    state.search = `redirect=${encodeURIComponent(redirect)}`;
    state.auth = { ...CFO, loading: false };
    renderHook(() => useAuthForm());
    expect(navigateMock).toHaveBeenCalledWith(roleToSlug('cfo'), { replace: true });
  });
});
