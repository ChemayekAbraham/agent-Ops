import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardRedirect from '@/pages/DashboardRedirect';

// --- Router mock --------------------------------------------------------
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom'
  );
  return { ...actual, useNavigate: () => mockNavigate };
});

// --- Auth mock ----------------------------------------------------------
const authState = {
  user: { id: 'u1' } as any,
  role: 'tenant' as string,
  roles: ['tenant', 'supporter', 'agent'] as string[],
  loading: false,
};
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => authState,
}));

// --- App preferences mock ----------------------------------------------
let preferredDefault = 'auto';
let agentAutoDefaultDisabled = false;
vi.mock('@/hooks/useAppPreferences', () => ({
  getPreferredDefaultRole: () => preferredDefault,
  isAgentAutoDefaultDisabled: () => agentAutoDefaultDisabled,
}));

// --- Server routing prefs mock -----------------------------------------
let serverPrefs: any = null;
vi.mock('@/lib/routingPrefsServer', () => ({
  fetchServerRoutingPrefs: vi.fn(async () => serverPrefs),
}));

// --- Sonner toast mock --------------------------------------------------
vi.mock('sonner', () => ({
  toast: { message: vi.fn() },
}));

// --- Supabase mock ------------------------------------------------------
// Configurable response for the rent_requests count probe.
let rentRequestsCount: number | null = 0;
let rentRequestsError: any = null;
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          limit: () => Promise.resolve({
            count: rentRequestsCount,
            error: rentRequestsError,
            data: null,
          }),
        }),
      }),
    }),
  },
}));

// --- helpers ------------------------------------------------------------
const flush = async () => {
  // Let any pending promise + setTimeout(0) chains resolve.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

beforeEach(() => {
  mockNavigate.mockReset();
  authState.user = { id: 'u1' };
  authState.role = 'tenant';
  authState.roles = ['tenant', 'supporter', 'agent'];
  preferredDefault = 'auto';
  agentAutoDefaultDisabled = false;
  rentRequestsCount = 0;
  rentRequestsError = null;
  serverPrefs = null;
  try { localStorage.clear(); } catch {}
  // Seed an explicit (empty-overrides) prefs blob so DashboardRedirect
  // does NOT attempt the server-side fallback path unless a test wants it.
  try {
    localStorage.setItem(
      'welile_app_preferences',
      JSON.stringify({ defaultRole: 'auto', disableAgentAutoDefault: false }),
    );
  } catch {}
});

describe('DashboardRedirect — default dashboard preference', () => {
  it('lands on user-chosen default (supporter) instead of cached auth.role (tenant)', async () => {
    preferredDefault = 'supporter';
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/funder', { replace: true });
  });

  it('explicit URL slug always wins over default preference', async () => {
    preferredDefault = 'supporter';
    render(
      <MemoryRouter initialEntries={['/dashboard/agent']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agent', { replace: true });
  });

  it('ignores default preference if user does not own that role → role picker', async () => {
    preferredDefault = 'landlord'; // user does not have landlord
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    // Preferred role is not owned, so explicit hint isn't honored, no path/query
    // hint either — flows into agent auto rule. With 0 rent requests it falls
    // back to auth.role (tenant).
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/tenant', { replace: true });
  });
});

describe('DashboardRedirect — agent auto-default rule', () => {
  it('agent role + ZERO rent requests → falls back to auth.role (tenant), not agent', async () => {
    rentRequestsCount = 0;
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/tenant', { replace: true });
  });

  it('agent role + MANY rent requests → routes to /dashboard/agent', async () => {
    rentRequestsCount = 42;
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agent', { replace: true });
  });

  it('REVOKED agent role (no longer in roles) → never routes to /dashboard/agent even if user once posted rent requests', async () => {
    authState.roles = ['tenant', 'supporter'];
    authState.role = 'tenant';
    rentRequestsCount = 99; // historical data exists
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(mockNavigate).not.toHaveBeenCalledWith('/dashboard/agent', expect.anything());
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/tenant', { replace: true });
  });

  it('opt-out (disableAgentAutoDefault=true) → skips agent rule even with rent requests', async () => {
    agentAutoDefaultDisabled = true;
    rentRequestsCount = 17;
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(mockNavigate).not.toHaveBeenCalledWith('/dashboard/agent', expect.anything());
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/tenant', { replace: true });
  });

  it('honours localStorage cache hit ("1") without hitting the DB', async () => {
    rentRequestsCount = 0; // would say "no" if queried
    localStorage.setItem('welile_has_posted_rent_request_u1', '1');
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agent', { replace: true });
  });

  it('caches the agent decision in localStorage after a DB lookup', async () => {
    rentRequestsCount = 3;
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(localStorage.getItem('welile_has_posted_rent_request_u1')).toBe('1');
  });

  it('DB error during the count → safe fallback to auth.role (not agent)', async () => {
    rentRequestsError = new Error('boom');
    rentRequestsCount = null;
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(mockNavigate).not.toHaveBeenCalledWith('/dashboard/agent', expect.anything());
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/tenant', { replace: true });
  });
});

describe('DashboardRedirect — server-side prefs fallback', () => {
  beforeEach(() => {
    // Simulate cleared localStorage so the server-side fallback path runs.
    try { localStorage.removeItem('welile_app_preferences'); } catch {}
  });

  it('uses server-stored defaultRole when local prefs are missing', async () => {
    serverPrefs = { defaultRole: 'supporter' };
    rentRequestsCount = 50; // would otherwise trigger agent rule
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/funder', { replace: true });
  });

  it('respects server-stored opt-out flag even when localStorage is empty', async () => {
    serverPrefs = { disableAgentAutoDefault: true };
    rentRequestsCount = 50;
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(mockNavigate).not.toHaveBeenCalledWith('/dashboard/agent', expect.anything());
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/tenant', { replace: true });
  });

  it('no server prefs + no local prefs → falls back to agent auto rule (with rent requests → agent)', async () => {
    serverPrefs = null;
    rentRequestsCount = 5;
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardRedirect />
      </MemoryRouter>
    );
    await flush();
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agent', { replace: true });
  });
});
