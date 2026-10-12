import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TenantRentIntakeQueue } from '@/components/agent/TenantRentIntakeQueue';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'agent-1' } }) }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('@/lib/haptics', () => ({ hapticTap: vi.fn() }));
vi.mock('@/components/agent/AgentRentRequestDialog', () => ({ default: () => null }));

const row = { id: 'request-1', tenant_id: 'tenant-1', tenant_name: 'Test tenant', rent_amount: 100000,
  landlord_name: 'Test landlord', landlord_phone: '', status: 'submitted', created_at: '2026-10-01T00:00:00Z' };

function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TenantRentIntakeQueue />
  </QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  const query = { select: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [row], error: null }) };
  mocks.from.mockReturnValue(query);
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition: vi.fn((success) => success({ coords: { latitude: 0.3, longitude: 32.5 } })) } });
});

describe('Service Centre tenant Claim', () => {
  it('uses only live RPC arguments and opens Mine after confirmed success', async () => {
    mocks.rpc.mockResolvedValue({ data: { request_id: row.id, status: 'claimed' }, error: null });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Claim', exact: true }));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Request claimed — find it in Mine'));
    expect(mocks.rpc).toHaveBeenCalledWith('tenant_rent_intake_decide', {
      p_request_id: row.id, p_action: 'claim', p_reason: null, p_latitude: 0.3, p_longitude: 32.5,
    });
    expect(screen.getByRole('button', { name: 'Mine' })).toHaveAttribute('data-state', null);
    expect(screen.queryByRole('button', { name: 'Claim', exact: true })).not.toBeInTheDocument();
  });

  it('keeps server rejection visible on the row and does not report success', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'This request has already been claimed' } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Claim', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This request has already been claimed');
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('shows location failure without sending a claim', async () => {
    navigator.geolocation.getCurrentPosition = vi.fn((_success, failure) => failure?.({ code: 1 } as GeolocationPositionError));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Claim', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Turn on location to claim');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('rejects empty success responses instead of pretending the request was claimed', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Claim', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The update could not be confirmed');
    expect(mocks.success).not.toHaveBeenCalled();
  });
});