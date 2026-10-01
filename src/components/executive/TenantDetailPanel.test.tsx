/**
 * Switch Landlord button placement and independence from the existing
 * Switch Agent (Transfer) flow in the Classic Tenant Profile. Heavy child
 * components and the data-fetching layer are mocked so this stays a focused
 * test of the switcher wiring, not a full integration test of the whole
 * (very large) Tenant Profile panel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'officer-1' } }) }));

vi.mock('@/components/ops/RepaymentPauseControl', () => ({ RepaymentPauseControl: () => null }));
vi.mock('@/components/ops/PaymentPeriodControl', () => ({ PaymentPeriodControl: () => null }));
vi.mock('./CallCentreSmartphonePanel', () => ({ CallCentreSmartphonePanel: () => null }));
vi.mock('./RentPlanHistoryPanel', () => ({ RentPlanHistoryPanel: () => null }));

vi.mock('@/components/shared/TenantAssignAgentDialog', () => ({
  default: ({ open }: { open: boolean }) => (
    <div data-testid="agent-dialog" data-open={String(open)} />
  ),
}));
vi.mock('@/components/shared/TenantAssignLandlordDialog', () => ({
  default: ({ open }: { open: boolean }) => (
    <div data-testid="landlord-dialog" data-open={String(open)} />
  ),
}));

const REQUEST_ROW = {
  id: 'rr-1',
  status: 'repaying',
  rent_amount: 300000,
  amount_repaid: 50000,
  daily_repayment: 5000,
  repayment_frequency: 'daily',
  duration_days: 60,
  access_fee: 0,
  request_fee: 0,
  total_repayment: 300000,
  registration_type: 'agent',
  created_at: '2026-09-01T00:00:00.000Z',
  landlord_id: 'landlord-1',
  agent_id: 'agent-1',
  assigned_agent_id: 'agent-1',
  house_listing_id: null,
};

function chain(data: any) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    or: () => builder,
    is: () => builder,
    in: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve({ data: Array.isArray(data) ? data[0] ?? null : data, error: null }),
    then: (resolve: any) => resolve({ data, error: null }),
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'profiles') return chain([
        { id: 'tenant-1', full_name: 'Jane Doe', phone: '0700000000' },
        { id: 'agent-1', full_name: 'Agent Smith', phone: '0722222222' },
      ]);
      if (table === 'rent_requests') return chain([REQUEST_ROW]);
      if (table === 'wallet_transactions') return chain([]);
      if (table === 'agent_collections') return chain([]);
      if (table === 'landlords') return chain([{ id: 'landlord-1', name: 'Old Landlord', phone: '0711111111' }]);
      return chain([]);
    },
    rpc: (fn: string) => {
      if (fn === 'get_tenant_transfer_history') return Promise.resolve({ data: [], error: null });
      if (fn === 'get_tenant_landlord_transfer_history') return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

import { TenantDetailPanel } from './TenantDetailPanel';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('TenantDetailPanel — Switch Landlord button', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a Switch Landlord button immediately beside the existing Transfer button', async () => {
    render(<TenantDetailPanel tenantId="tenant-1" tenantName="Jane Doe" onBack={() => {}} />, { wrapper });

    await screen.findByRole('button', { name: /transfer/i });
    expect(screen.getByRole('button', { name: /transfer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /switch landlord/i })).toBeInTheDocument();
  });

  it('clicking Transfer opens only the agent dialog, not the landlord dialog', async () => {
    render(<TenantDetailPanel tenantId="tenant-1" tenantName="Jane Doe" onBack={() => {}} />, { wrapper });

    await screen.findByRole('button', { name: /transfer/i });
    fireEvent.click(screen.getByRole('button', { name: /transfer/i }));

    await waitFor(() => expect(screen.getByTestId('agent-dialog')).toHaveAttribute('data-open', 'true'));
    expect(screen.getByTestId('landlord-dialog')).toHaveAttribute('data-open', 'false');
  });

  it('clicking Switch Landlord opens only the landlord dialog, not the agent dialog', async () => {
    render(<TenantDetailPanel tenantId="tenant-1" tenantName="Jane Doe" onBack={() => {}} />, { wrapper });

    await screen.findByRole('button', { name: /switch landlord/i });
    fireEvent.click(screen.getByRole('button', { name: /switch landlord/i }));

    await waitFor(() => expect(screen.getByTestId('landlord-dialog')).toHaveAttribute('data-open', 'true'));
    expect(screen.getByTestId('agent-dialog')).toHaveAttribute('data-open', 'false');
  });
});
