import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import TenantAssignLandlordDialog from './TenantAssignLandlordDialog';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const ELIGIBLE = {
  id: 'landlord-new',
  name: 'New Landlord',
  phone: '0700000002',
  property_address: 'Plot 5',
  district: 'Kampala',
  village: 'Bukoto',
  verified: true,
  payout_ready: true,
  eligible: true,
  block_reason: null,
};

const BLOCKED = {
  id: 'landlord-blocked',
  name: 'Blocked Landlord',
  phone: '0700000003',
  property_address: null,
  district: null,
  village: null,
  verified: true,
  payout_ready: false,
  eligible: false,
  block_reason: 'This rent plan has an unpaid landlord float allocation that needs a payout-ready landlord.',
};

function baseProps(overrides: Partial<React.ComponentProps<typeof TenantAssignLandlordDialog>> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    rentRequestId: 'rr-1',
    tenantId: 'tenant-1',
    tenantName: 'Jane Doe',
    currentLandlordId: 'landlord-old',
    currentLandlordName: 'Old Landlord',
    currentLandlordPhone: '0711111111',
    rentPlanStatus: 'repaying',
    houseListingId: null,
    onSaved: vi.fn(),
    ...overrides,
  };
}

describe('TenantAssignLandlordDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'list_eligible_landlords_for_rent_request') {
        return Promise.resolve({ data: [ELIGIBLE, BLOCKED], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('searches via list_eligible_landlords_for_rent_request, never the raw landlords table', async () => {
    render(<TenantAssignLandlordDialog {...baseProps()} />, { wrapper });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith(
      'list_eligible_landlords_for_rent_request',
      expect.objectContaining({ p_rent_request_id: 'rr-1' }),
    ));
  });

  it('blocks review when no landlord is selected or reason is too short, and makes no RPC call', async () => {
    render(<TenantAssignLandlordDialog {...baseProps()} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: /review switch/i }));

    expect(await screen.findByText(/pick a landlord to switch to/i)).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalledWith('ops_transfer_tenant_landlord', expect.anything());
  });

  it('an ineligible (blocked) landlord cannot be selected, and review is blocked', async () => {
    render(<TenantAssignLandlordDialog {...baseProps()} />, { wrapper });

    fireEvent.click(screen.getByPlaceholderText(/search landlords/i));
    const blockedOption = await screen.findByRole('button', { name: /blocked landlord/i });
    expect(blockedOption).toBeDisabled();
    fireEvent.click(blockedOption);

    fireEvent.click(screen.getByRole('button', { name: /review switch/i }));
    expect(await screen.findByText(/pick a landlord to switch to/i)).toBeInTheDocument();
  });

  it('short reason blocks review/confirmation', async () => {
    render(<TenantAssignLandlordDialog {...baseProps()} />, { wrapper });

    fireEvent.click(screen.getByPlaceholderText(/search landlords/i));
    fireEvent.click(await screen.findByRole('button', { name: /new landlord/i }));
    fireEvent.change(screen.getByPlaceholderText(/property sold/i), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /review switch/i }));

    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalledWith('ops_transfer_tenant_landlord', expect.anything());
  });

  it('the review step makes no mutation call; only the final confirm button does', async () => {
    render(<TenantAssignLandlordDialog {...baseProps()} />, { wrapper });

    fireEvent.click(screen.getByPlaceholderText(/search landlords/i));
    fireEvent.click(await screen.findByRole('button', { name: /new landlord/i }));
    fireEvent.change(screen.getByPlaceholderText(/property sold/i), { target: { value: 'Property sold to new owner' } });
    fireEvent.click(screen.getByRole('button', { name: /review switch/i }));

    expect(await screen.findByText(/confirm landlord switch\?/i)).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalledWith('ops_transfer_tenant_landlord', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: /^confirm landlord switch$/i }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith(
      'ops_transfer_tenant_landlord',
      expect.objectContaining({ p_rent_request_id: 'rr-1', p_new_landlord_id: 'landlord-new', p_reason: 'Property sold to new owner' }),
    ));
  });

  it('prevents duplicate submission while the request is in flight', async () => {
    let resolveRpc: (v: any) => void = () => {};
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'list_eligible_landlords_for_rent_request') return Promise.resolve({ data: [ELIGIBLE], error: null });
      if (fn === 'ops_transfer_tenant_landlord') return new Promise((resolve) => { resolveRpc = resolve; });
      return Promise.resolve({ data: null, error: null });
    });

    render(<TenantAssignLandlordDialog {...baseProps()} />, { wrapper });
    fireEvent.click(screen.getByPlaceholderText(/search landlords/i));
    fireEvent.click(await screen.findByRole('button', { name: /new landlord/i }));
    fireEvent.change(screen.getByPlaceholderText(/property sold/i), { target: { value: 'Property sold to new owner' } });
    fireEvent.click(screen.getByRole('button', { name: /review switch/i }));
    const confirmBtn = await screen.findByRole('button', { name: /confirm landlord switch/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(confirmBtn).toBeDisabled());
    fireEvent.click(confirmBtn);
    expect(rpcMock).toHaveBeenCalledTimes(2); // search + exactly one transfer call

    resolveRpc({ data: { success: true, allocation_updated: false, pending_otps_cancelled: 0 }, error: null });
  });

  it('on success, invalidates tenant-detail and the landlord history query, and closes', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'list_eligible_landlords_for_rent_request') return Promise.resolve({ data: [ELIGIBLE], error: null });
      if (fn === 'ops_transfer_tenant_landlord') return Promise.resolve({ data: { success: true, allocation_updated: false, pending_otps_cancelled: 0 }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    render(<TenantAssignLandlordDialog {...baseProps({ onOpenChange, onSaved })} />, { wrapper });

    fireEvent.click(screen.getByPlaceholderText(/search landlords/i));
    fireEvent.click(await screen.findByRole('button', { name: /new landlord/i }));
    fireEvent.change(screen.getByPlaceholderText(/property sold/i), { target: { value: 'Property sold to new owner' } });
    fireEvent.click(screen.getByRole('button', { name: /review switch/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm landlord switch/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a server validation error stays visible and does not show success', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'list_eligible_landlords_for_rent_request') return Promise.resolve({ data: [ELIGIBLE], error: null });
      if (fn === 'ops_transfer_tenant_landlord') return Promise.resolve({ data: null, error: { message: 'This rent plan already has a partially or fully paid landlord allocation and cannot be switched' } });
      return Promise.resolve({ data: null, error: null });
    });
    const onSaved = vi.fn();
    render(<TenantAssignLandlordDialog {...baseProps({ onSaved })} />, { wrapper });

    fireEvent.click(screen.getByPlaceholderText(/search landlords/i));
    fireEvent.click(await screen.findByRole('button', { name: /new landlord/i }));
    fireEvent.change(screen.getByPlaceholderText(/property sold/i), { target: { value: 'Property sold to new owner' } });
    fireEvent.click(screen.getByRole('button', { name: /review switch/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm landlord switch/i }));

    expect(await screen.findByText(/partially or fully paid landlord allocation/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
