/**
 * Asset QR deep links survive Google/Apple sign-in.
 *
 * A signed-out scan lands on /auth?redirect=/cfo/assets/<uuid>. Phone/password sign-in honours that on /auth, but
 * OAuth returns to the site root and loses the query. The login hook keeps the validated path in the existing
 * `welile_post_auth_redirect` session key before leaving for the provider, and the root route (Index) restores it
 * once signed in — falling back to the role dashboard only when there is no valid stored path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const state = vi.hoisted(() => ({
  search: '',
  google: vi.fn(),
  apple: vi.fn(),
  auth: { user: null as { id: string } | null, roles: [] as string[], role: null as string | null, rolesResolved: false, loading: false },
}));

vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return {
    ...actual,
    // Only the login hook test needs these stubbed; Index tests render a real MemoryRouter.
    useNavigate: () => vi.fn(),
    useSearchParams: () => [new URLSearchParams(state.search), vi.fn()],
  };
});
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signIn: vi.fn(), signUpWithoutRole: vi.fn(), resetPassword: vi.fn(),
    signInWithGoogle: state.google, signInWithApple: state.apple,
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
vi.mock('@/components/common/ScreenLoader', () => ({ default: () => <p>loading</p> }));

import { useAuthForm } from '@/hooks/useAuthForm';
import Index from '@/pages/Index';
import { roleToSlug } from '@/lib/roleRoutes';
import { POST_AUTH_REDIRECT_KEY, peekPostAuthRedirect, stashPostAuthRedirect } from '@/lib/returnPath';

const ASSET = '/cfo/assets/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const UNSAFE: Array<[string, string]> = [
  ['another site', '//evil.example/x'],
  ['a backslash host', '/\\evil.example/x'],
  ['an absolute URL', 'https://evil.example/x'],
  ['a script URL', 'javascript:alert(1)'],
  ['a non-returnable page', '/auth'],
  ['a relative path', 'cfo/assets/x'],
];

const stored = () => sessionStorage.getItem(POST_AUTH_REDIRECT_KEY);

beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  state.search = '';
  state.google = vi.fn().mockResolvedValue({ error: null });
  state.apple = vi.fn().mockResolvedValue({ error: null });
  state.auth = { user: null, roles: [], role: null, rolesResolved: false, loading: false };
});

describe('login hook: keeps the asset link before leaving for Google/Apple', () => {
  it.each([
    ['Google', 'handleGoogleSignIn', () => state.google],
    ['Apple', 'handleAppleSignIn', () => state.apple],
  ] as const)('%s: stores the validated ?redirect= before the provider call', async (_name, handler, provider) => {
    state.search = `redirect=${encodeURIComponent(ASSET)}`;
    let atCall: string | null = null;
    provider().mockImplementation(async () => { atCall = stored(); return { error: null }; });
    const { result } = renderHook(() => useAuthForm());
    await act(async () => { await result.current[handler](); });
    expect(provider()).toHaveBeenCalledTimes(1);
    expect(atCall).toBe(ASSET); // in place before the page leaves for the provider
    expect(stored()).toBe(ASSET);
  });

  it.each(UNSAFE)('Google and Apple: an unsafe redirect (%s) is never stored', async (_label, bad) => {
    state.search = `redirect=${encodeURIComponent(bad)}`;
    const { result } = renderHook(() => useAuthForm());
    await act(async () => { await result.current.handleGoogleSignIn(); });
    await act(async () => { await result.current.handleAppleSignIn(); });
    expect(stored()).toBeNull();
  });

  it('without ?redirect= nothing is stored and an existing value from another flow is left alone', async () => {
    const { result } = renderHook(() => useAuthForm());
    await act(async () => { await result.current.handleGoogleSignIn(); });
    expect(stored()).toBeNull();
    sessionStorage.setItem(POST_AUTH_REDIRECT_KEY, '/oauth/consent?x=1');
    await act(async () => { await result.current.handleAppleSignIn(); });
    expect(stored()).toBe('/oauth/consent?x=1');
  });
});

function LocationProbe() {
  const l = useLocation();
  return <p data-testid="at">{`${l.pathname}${l.search}`}</p>;
}

function renderRoot() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('root route after Google/Apple sign-in', () => {
  const CFO = { user: { id: 'cfo-1' }, roles: ['cfo'], role: 'cfo', rolesResolved: true, loading: false };

  it('returns a signed-in user to the exact asset details page and consumes the stored link', () => {
    sessionStorage.setItem(POST_AUTH_REDIRECT_KEY, ASSET);
    state.auth = CFO;
    renderRoot();
    expect(screen.getByTestId('at').textContent).toBe(ASSET);
    expect(stored()).toBeNull(); // one sign-in only
  });

  it('end to end: scan → Google sign-in on /auth → provider returns to / → exact asset page', async () => {
    state.search = `redirect=${encodeURIComponent(ASSET)}`;
    const { result, unmount } = renderHook(() => useAuthForm());
    await act(async () => { await result.current.handleGoogleSignIn(); });
    unmount(); // the page leaves for Google
    state.search = '';
    state.auth = CFO; // back at the site root, signed in
    renderRoot();
    expect(screen.getByTestId('at').textContent).toBe(ASSET);
  });

  it('waits for auth to finish loading and does not consume the link early', () => {
    sessionStorage.setItem(POST_AUTH_REDIRECT_KEY, ASSET);
    state.auth = { ...CFO, loading: true };
    renderRoot();
    expect(screen.getByText('loading')).toBeTruthy();
    expect(stored()).toBe(ASSET);
  });

  it('signed out: the stored link is kept for after sign-in and the visitor goes to /welcome', () => {
    sessionStorage.setItem(POST_AUTH_REDIRECT_KEY, ASSET);
    renderRoot();
    expect(screen.getByTestId('at').textContent).toBe('/welcome');
    expect(stored()).toBe(ASSET);
  });

  it.each(UNSAFE)('an unsafe stored link (%s) is ignored and the role dashboard is used', (_label, bad) => {
    sessionStorage.setItem(POST_AUTH_REDIRECT_KEY, bad);
    state.auth = CFO;
    renderRoot();
    expect(screen.getByTestId('at').textContent).toBe(roleToSlug('cfo'));
  });

  it('no stored link: normal role dashboard fallback', () => {
    state.auth = CFO;
    renderRoot();
    expect(screen.getByTestId('at').textContent).toBe(roleToSlug('cfo'));
  });
});

describe('post-auth redirect helpers', () => {
  it('stores only safe, returnable in-app paths', () => {
    for (const [, bad] of UNSAFE) stashPostAuthRedirect(bad);
    expect(stored()).toBeNull();
    stashPostAuthRedirect(ASSET);
    expect(peekPostAuthRedirect()).toBe(ASSET);
    expect(stored()).toBe(ASSET); // peeking does not consume
  });

  it('peek rejects a tampered stored value', () => {
    sessionStorage.setItem(POST_AUTH_REDIRECT_KEY, '//evil.example');
    expect(peekPostAuthRedirect()).toBeNull();
  });
});
