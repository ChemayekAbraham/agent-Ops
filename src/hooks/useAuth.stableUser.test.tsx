import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

type Handler = (event: string, session: unknown) => void;
let handler: Handler | null = null;

const mkUser = (over: Record<string, unknown> = {}) => ({
  id: 'u-1', email: 'ops@welile.com', email_confirmed_at: '2026-01-01T00:00:00Z', aud: 'authenticated',
  app_metadata: { provider: 'email' }, user_metadata: { full_name: 'Ops One' }, updated_at: '2026-10-01T08:00:00Z', ...over,
});
const mkSession = (over: Record<string, unknown> = {}, user = mkUser()) => ({
  access_token: 'tok-1', refresh_token: 'ref-1', expires_at: 2_000_000_000, token_type: 'bearer', user, ...over,
});

vi.mock('@/integrations/supabase/client', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    c.select = () => c; c.eq = () => c; c.maybeSingle = () => Promise.resolve({ data: null });
    return c;
  };
  return {
    supabase: {
      auth: {
        onAuthStateChange: (cb: Handler) => { handler = cb; return { data: { subscription: { unsubscribe: vi.fn() } } }; },
        getSession: () => Promise.resolve({ data: { session: JSON.parse(JSON.stringify(mkSession())) }, error: null }),
        getUser: () => Promise.resolve({ data: { user: mkUser() } }),
        refreshSession: () => Promise.resolve({ data: { session: null }, error: null }),
        signOut: () => Promise.resolve({}),
      },
      from: () => chain(),
      rpc: () => Promise.resolve({ data: false, error: null }),
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    },
  };
});
vi.mock('@/lib/sessionCache', () => ({
  setCachedSession: vi.fn(), clearSessionCache: vi.fn(), clearAllAuthStorage: vi.fn(),
  getPreloadedSession: () => null, getPreloadedRoles: () => null,
}));
vi.mock('@/lib/staleSessionDetector', () => ({
  installStaleSessionDetector: vi.fn(), STALE_SESSION_EVENTS: { rehydrated: 'welile:rehydrated' }, isSignOutSuppressed: () => false,
}));
vi.mock('@/lib/loginTelemetry', () => ({ loginTelemetry: { mark: vi.fn(), start: () => vi.fn(), setUserId: vi.fn() } }));
vi.mock('@/lib/errorReporting', () => ({ setReportingTags: vi.fn() }));
vi.mock('@/hooks/auth/roleManager', () => ({
  DEFAULT_ROLES: ['supporter'],
  fetchUserRoles: async (_uid: string, _role: unknown, setRoles: (r: string[]) => void, _setRole: unknown, setResolved: (b: boolean) => void) => {
    setRoles(['supporter', 'tenant_ops']);   // a new array every time, as in the real hook
    setResolved(true);
  },
  addRoleForUser: vi.fn(),
}));
vi.mock('@/hooks/auth/authOperations', () => ({
  signOutUser: vi.fn(), signUp: vi.fn(), signUpWithoutRole: vi.fn(), signIn: vi.fn(), signInWithGoogle: vi.fn(),
  signInWithApple: vi.fn(), resetPassword: vi.fn(),
}));

import { AuthProvider, useAuth } from './useAuth';

const seen: { user: unknown; session: unknown; roles: unknown }[] = [];
function Probe(): ReactNode {
  const { user, session, roles } = useAuth();
  seen.push({ user, session, roles });
  return null;
}

const last = () => seen[seen.length - 1];

describe('AuthProvider hands out the same user object when nothing has changed', () => {
  beforeEach(() => { seen.length = 0; handler = null; });

  it('a repeated SIGNED_IN for the same person and token keeps the same user, session and roles', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(last()?.user).toBeTruthy());
    await waitFor(() => expect(handler).not.toBeNull());
    const user = last().user;
    const session = last().session;
    const roles = last().roles;

    // five tab returns: the library announces "signed in" with a freshly parsed copy each time
    for (let i = 0; i < 5; i += 1) {
      await act(async () => { handler!('SIGNED_IN', JSON.parse(JSON.stringify(mkSession()))); });
    }
    expect(last().user).toBe(user);
    expect(last().session).toBe(session);
    expect(last().roles).toBe(roles);
  });

  it('a renewed token replaces the session but keeps the same user object', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(last()?.user).toBeTruthy());
    await waitFor(() => expect(handler).not.toBeNull());
    const user = last().user;
    const session = last().session;

    await act(async () => { handler!('TOKEN_REFRESHED', JSON.parse(JSON.stringify(mkSession({ access_token: 'tok-2' })))); });
    expect(last().session).not.toBe(session);
    expect((last().session as { access_token: string }).access_token).toBe('tok-2');
    expect(last().user).toBe(user);
  });

  it('changed user data, or another person, is a real change', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(last()?.user).toBeTruthy());
    await waitFor(() => expect(handler).not.toBeNull());
    const user = last().user;

    await act(async () => { handler!('USER_UPDATED', mkSession({}, mkUser({ updated_at: '2026-10-07T09:00:00Z' }))); });
    expect(last().user).not.toBe(user);
    expect((last().user as { updated_at: string }).updated_at).toBe('2026-10-07T09:00:00Z');

    await act(async () => { handler!('SIGNED_IN', mkSession({}, mkUser({ id: 'u-2' }))); });
    expect((last().user as { id: string }).id).toBe('u-2');
  });
});
