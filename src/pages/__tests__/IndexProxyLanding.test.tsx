/**
 * The site root (also the installed app's start page) sends a signed-in proxy agent who has never collected rent to
 * the proxy agent dashboard instead of their agent or funder dashboard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const state = vi.hoisted(() => ({
  auth: { user: { id: 'u1' } as { id: string } | null, role: 'supporter' as string | null, loading: false },
  answer: false,
  resolve: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => state.auth }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/components/common/ScreenLoader', () => ({ default: () => <p>loading</p> }));
vi.mock('@/lib/proxyLanding', async () => {
  const actual = await vi.importActual<typeof import('@/lib/proxyLanding')>('@/lib/proxyLanding');
  return {
    ...actual,
    resolveProxyLanding: (userId: string) => { state.resolve(userId); return Promise.resolve(state.answer); },
  };
});

import Index from '@/pages/Index';

function At() {
  const l = useLocation();
  return <p data-testid="at">{l.pathname}</p>;
}
async function openRoot() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="*" element={<At />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  state.auth = { user: { id: 'u1' }, role: 'supporter', loading: false };
  state.answer = false;
  state.resolve.mockClear();
});

describe('site root: proxy agents with no collections', () => {
  it('funder landing → proxy agent dashboard', async () => {
    state.answer = true;
    await openRoot();
    expect(screen.getByTestId('at').textContent).toBe('/dashboard/agent/proxy');
    expect(state.resolve).toHaveBeenCalledWith('u1');
  });

  it('agent landing → proxy agent dashboard', async () => {
    state.answer = true;
    state.auth.role = 'agent';
    await openRoot();
    expect(screen.getByTestId('at').textContent).toBe('/dashboard/agent/proxy');
  });

  it('not a proxy agent (or has collected) → the usual dashboard', async () => {
    state.answer = false;
    await openRoot();
    expect(screen.getByTestId('at').textContent).toBe('/dashboard/funder');
  });

  it('a fresh cached answer redirects without a lookup', async () => {
    localStorage.setItem('welile_proxy_landing_u1', JSON.stringify({ v: true, at: Date.now() }));
    await openRoot();
    expect(screen.getByTestId('at').textContent).toBe('/dashboard/agent/proxy');
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it('staff landing (employee) is never replaced and needs no lookup', async () => {
    state.answer = true;
    state.auth.role = 'employee';
    await openRoot();
    expect(screen.getByTestId('at').textContent).not.toBe('/dashboard/agent/proxy');
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it('a Home Screen chosen in Settings is respected', async () => {
    state.answer = true;
    localStorage.setItem('welile_app_preferences', JSON.stringify({ defaultRole: 'supporter' }));
    await openRoot();
    expect(screen.getByTestId('at').textContent).toBe('/dashboard/funder');
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it('a stored deep link still wins', async () => {
    state.answer = true;
    sessionStorage.setItem('welile_post_auth_redirect', '/cfo/assets/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b');
    await openRoot();
    expect(screen.getByTestId('at').textContent).toBe('/cfo/assets/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b');
  });
});
