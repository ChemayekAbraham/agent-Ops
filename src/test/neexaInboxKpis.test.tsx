import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), invoke: vi.fn(), rpc: vi.fn(), channel: vi.fn(), removeChannel: vi.fn(), handlers: [] as { filter: { event: string; table: string }; callback: (payload: { new: unknown }) => void }[] }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { ...mocks, functions: { invoke: mocks.invoke } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'staff' } }) }));
import { useNeexaInbox, formatNeexaVolume, isNeexaKpiAccessDenied, NeexaKpiAccessError } from '@/hooks/useNeexaInbox';
import { KpiRow } from '@/components/cmo/NeexaInbox';

const kpiPayload = {
  came_in_users: 12, came_in_new_signups: 5, referred_signups: 9,
  active_partners: 7, active_portfolios: 8, active_volume: 750000,
  pending_partners: 3, pending_portfolios: 4, pending_agreements: 4, pending_volume: 1200000,
  currency: 'UGX', as_of: '2026-10-21T08:00:00Z',
};
const conversation = { id: '10', platform: 'email', title: 'Customer', last_inbound_at: null, last_message_at: '2026-10-21T07:00:00Z' };
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.length = 0;
  mocks.from.mockImplementation(table => {
    const result = () => ({ data: table === 'neexa_conversations' ? [conversation] : [], error: null });
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), range: vi.fn(() => Promise.resolve(result())) };
    return query;
  });
  mocks.invoke.mockResolvedValue({ data: { synced: 0, pages: 1, complete: true }, error: null });
  mocks.channel.mockImplementation(() => {
    const channel = { on: vi.fn((_type, filter, callback) => { mocks.handlers.push({ filter, callback }); return channel; }), subscribe: vi.fn().mockReturnThis() };
    return channel;
  });
  mocks.rpc.mockResolvedValue({ data: kpiPayload, error: null });
});
describe('Neexa inbox KPIs', () => {
  it('formats volumes as UGX with thousands separators', () => {
    expect(formatNeexaVolume(750000)).toBe('UGX 750,000');
    expect(formatNeexaVolume(1234567)).toBe('UGX 1,234,567');
    expect(formatNeexaVolume(0)).toBe('UGX 0');
    expect(formatNeexaVolume(NaN)).toBe('UGX 0');
  });
  it('loads KPI figures through the RPC', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useNeexaInbox(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.kpis).toEqual(kpiPayload));
    expect(result.current.kpisHidden).toBe(false);
    expect(result.current.kpisError).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith('get_neexa_inbox_kpis');
  });
  it('hides the row on a 403 / not_authorized denial', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '403', message: 'not_authorized' } });
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useNeexaInbox(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.kpisHidden).toBe(true));
    expect(result.current.kpis).toBeNull();
  });
  it('shows a retryable error for any other failure', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'boom' } });
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useNeexaInbox(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.kpisError).toBe('boom'));
    expect(result.current.kpisHidden).toBe(false);
  });
  it('classifies permission denials without changing ordinary failures', () => {
    expect(isNeexaKpiAccessDenied({ code: '42501', message: 'permission denied' })).toBe(true);
    expect(isNeexaKpiAccessDenied({ code: 'P0001', message: 'not_authorized' })).toBe(true);
    expect(isNeexaKpiAccessDenied({ code: 'P0001', message: 'boom' })).toBe(false);
    expect(new NeexaKpiAccessError('hidden')).toBeInstanceOf(Error);
  });
  it('renders card 1 from referred sign-ups and the countersign sub-lines', () => {
    const inbox = { kpis: kpiPayload, kpisLoading: false, kpisHidden: false, refetchKpis: vi.fn() } as unknown as ReturnType<typeof useNeexaInbox>;
    render(<MemoryRouter><KpiRow inbox={inbox} canOpenPartnerOnboarding={false} /></MemoryRouter>);
    expect(screen.getByText('Referred by Neexa')).toBeInTheDocument();
    // Card 1 is referred_signups (9), not came_in_users (12).
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.queryByText('12')).not.toBeInTheDocument();
    expect(screen.getByText('12 came in via Neexa links · 5 new sign-ups')).toBeInTheDocument();
    expect(screen.getByText('Contract amount of active Neexa Supporters')).toBeInTheDocument();
    expect(screen.getByText('Agreement awaiting countersign')).toBeInTheDocument();
    expect(screen.getByText('4 agreements awaiting countersign')).toBeInTheDocument();
    expect(screen.getByText('UGX 1,200,000')).toBeInTheDocument();
  });
});
