import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  AGENT_VETTING_NOT_APPLICABLE,
  agentVettingApplicability,
  agentVettingRedirect,
  hasEnabledAgentRole,
} from '@/hooks/agentVettingAccess';

const rpc = vi.fn();
const invoke = vi.fn();
const captureGps = vi.fn();
const auth = {
  user: { id: 'user-1' } as { id: string } | null,
  session: { access_token: 'jwt' } as { access_token?: string } | null,
  loading: false,
  rolesResolved: true,
  roles: ['agent', 'supporter'] as string[],
  enabledRoles: ['supporter'] as string[],
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => auth,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
  },
}));

vi.mock('@/lib/captureGps', () => ({
  captureGps: (...args: unknown[]) => captureGps(...args),
}));

vi.mock('@/components/agent-vetting/VettingMap', () => ({ default: () => null }));
vi.mock('@/components/location/UgLocationPicker', () => ({ UgLocationPicker: () => null }));
vi.mock('@/components/wallet/IdentityPhotoCapture', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useAgentVetting } from '@/hooks/useAgentVetting';
import AgentVettingBanner from '@/components/agent-vetting/AgentVettingBanner';
import AgentVerification from '@/pages/agent/AgentVerification';

const VETTING_RPCS = [
  'get_my_agent_vetting',
  'agent_vetting_confirm_phone',
  'agent_vetting_confirm_email',
  'agent_vetting_save_residence',
  'agent_vetting_capture_gps',
  'agent_vetting_save_details',
  'agent_vetting_parent_id_link_state',
  'agent_vetting_request_parent_id_link',
  'submit_agent_vetting',
] as const;

function vettingCalls() {
  return rpc.mock.calls.filter(([name]) => VETTING_RPCS.includes(name));
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const agentRecord = {
  status: 'unverified',
  phone: { value: '+256771234567', verified_at: null },
  parent_agent: { id: 'parent-1', name: 'Parent Agent', phone: '+256700000001' },
};

describe('agent vetting role helpers', () => {
  it('treats only an enabled agent row as permission', () => {
    expect(hasEnabledAgentRole(['agent', 'supporter'])).toBe(true);
    expect(hasEnabledAgentRole(['supporter'])).toBe(false);
    expect(hasEnabledAgentRole([])).toBe(false);
    expect(hasEnabledAgentRole(null)).toBe(false);
    expect(hasEnabledAgentRole(undefined)).toBe(false);
  });

  it('stays loading until the real role list is known, then not-applicable or ready', () => {
    expect(agentVettingApplicability({ ready: false, allowed: false })).toBe('loading');
    expect(agentVettingApplicability({ ready: true, allowed: false })).toBe('not_applicable');
    expect(agentVettingApplicability({ ready: true, allowed: true })).toBe('ready');
    expect(agentVettingRedirect('loading')).toBeNull();
    expect(agentVettingRedirect('ready')).toBeNull();
    expect(agentVettingRedirect('not_applicable')).toBe('/dashboard');
  });
});

describe('useAgentVetting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpc.mockReset();
    invoke.mockReset();
    captureGps.mockReset();
    auth.user = { id: 'user-1' };
    auth.session = { access_token: 'jwt' };
    auth.loading = false;
    auth.rolesResolved = true;
    auth.roles = ['agent', 'supporter'];
    auth.enabledRoles = ['supporter'];
    captureGps.mockResolvedValue({ latitude: 0.35, longitude: 32.58, accuracy: 12 });
    rpc.mockImplementation((fn: string) => {
      if (fn === 'get_my_agent_vetting') return Promise.resolve({ data: agentRecord, error: null });
      if (fn === 'agent_vetting_parent_id_link_state') {
        return Promise.resolve({ data: { found: true, has_parent: true, status: 'active' }, error: null });
      }
      if (fn === 'submit_agent_vetting') return Promise.resolve({ data: { success: true }, error: null });
      return Promise.resolve({ data: { success: true }, error: null });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call agent vetting RPCs for a synthetic agent role', async () => {
    const { result } = renderHook(() => useAgentVetting(), { wrapper: wrapperFor(client()) });
    await act(async () => { await vi.advanceTimersByTimeAsync(150_000); });
    window.dispatchEvent(new Event('focus'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vettingCalls()).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
    expect(captureGps).not.toHaveBeenCalled();
    expect(result.current.applicability).toBe('not_applicable');
    expect(result.current.vetting).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it.each(['tenant', 'landlord', 'supporter', 'employee'] as const)(
    'does not call get_my_agent_vetting for a signed-in %s',
    async (role) => {
      auth.roles = ['agent', role];
      auth.enabledRoles = [role];
      const { result } = renderHook(() => useAgentVetting(), { wrapper: wrapperFor(client()) });
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(vettingCalls()).toHaveLength(0);
      expect(result.current.applicability).toBe('not_applicable');
      expect(result.current.error).toBeNull();
    },
  );

  it('does not call while the real enabled-role list is still loading', async () => {
    auth.loading = true;
    auth.rolesResolved = false;
    auth.roles = ['agent'];
    auth.enabledRoles = ['agent'];
    const { result } = renderHook(() => useAgentVetting(), { wrapper: wrapperFor(client()) });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(vettingCalls()).toHaveLength(0);
    expect(result.current.applicability).toBe('loading');
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('does not call when roles are unresolved even if loading has finished', async () => {
    auth.loading = false;
    auth.rolesResolved = false;
    auth.enabledRoles = ['agent'];
    renderHook(() => useAgentVetting(), { wrapper: wrapperFor(client()) });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(vettingCalls()).toHaveLength(0);
  });

  it('calls get_my_agent_vetting for a real enabled agent and ignores the synthetic list', async () => {
    auth.roles = ['agent', 'supporter'];
    auth.enabledRoles = ['agent', 'supporter'];
    const { result } = renderHook(() => useAgentVetting(), { wrapper: wrapperFor(client()) });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(rpc.mock.calls.filter(([name]) => name === 'get_my_agent_vetting')).toHaveLength(1);
    expect(rpc.mock.calls.filter(([name]) => name === 'agent_vetting_parent_id_link_state')).toHaveLength(1);
    expect(result.current.applicability).toBe('ready');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.vetting?.parent_agent?.id).toBe('parent-1');
    expect(result.current.parentIdLink?.status).toBe('active');
  });

  it('does not submit, save, or send a code unless the caller is a real agent', async () => {
    const { result } = renderHook(() => useAgentVetting(), { wrapper: wrapperFor(client()) });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await expect(result.current.submit()).rejects.toThrow(AGENT_VETTING_NOT_APPLICABLE);
    await expect(result.current.sendPhoneCode()).rejects.toThrow(AGENT_VETTING_NOT_APPLICABLE);
    await expect(result.current.sendEmailCode('a@b.com')).rejects.toThrow(AGENT_VETTING_NOT_APPLICABLE);
    await expect(result.current.saveResidence({ district: 'Jinja', village: 'Road' })).rejects.toThrow(AGENT_VETTING_NOT_APPLICABLE);
    expect(vettingCalls()).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
    expect(captureGps).not.toHaveBeenCalled();
  });

  it('still submits for a real agent', async () => {
    auth.enabledRoles = ['agent'];
    const { result } = renderHook(() => useAgentVetting(), { wrapper: wrapperFor(client()) });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let submitted: unknown;
    await act(async () => {
      submitted = await result.current.submit();
    });
    expect(submitted).toEqual({ success: true });
    const submits = rpc.mock.calls.filter(([name]) => name === 'submit_agent_vetting');
    expect(submits).toHaveLength(1);
    expect(submits[0]?.[1]).toMatchObject({ p_lat: 0.35, p_lng: 32.58, p_accuracy_m: 12 });
  });
});

describe('agent vetting surfaces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpc.mockReset();
    invoke.mockReset();
    auth.user = { id: 'user-1' };
    auth.session = { access_token: 'jwt' };
    auth.loading = false;
    auth.rolesResolved = true;
    auth.roles = ['agent', 'supporter'];
    auth.enabledRoles = ['supporter'];
    rpc.mockResolvedValue({ data: agentRecord, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderBanner() {
    return render(
      createElement(QueryClientProvider, { client: client() },
        createElement(MemoryRouter, null, createElement(AgentVettingBanner))),
    );
  }

  it('hides the dashboard banner for a synthetic agent and does not poll', async () => {
    renderBanner();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.queryByText('Verify your agent account')).toBeNull();
    expect(vettingCalls()).toHaveLength(0);
  });

  it('shows the dashboard banner for a real agent who is not verified yet', async () => {
    auth.enabledRoles = ['agent'];
    renderBanner();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Verify your agent account')).toBeTruthy();
    expect(rpc.mock.calls.filter(([name]) => name === 'get_my_agent_vetting')).toHaveLength(1);
  });

  it('redirects the verification route for a non-agent', async () => {
    render(
      createElement(QueryClientProvider, { client: client() },
        createElement(MemoryRouter, { initialEntries: ['/dashboard/agent/verification'] },
          createElement(Routes, null,
            createElement(Route, { path: '/dashboard/agent/verification', element: createElement(AgentVerification) }),
            createElement(Route, { path: '/dashboard', element: createElement('p', null, 'Home dashboard') }),
          ))),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Home dashboard')).toBeTruthy();
    expect(screen.queryByText('Agent verification')).toBeNull();
    expect(vettingCalls()).toHaveLength(0);
  });
});
