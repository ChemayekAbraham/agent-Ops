import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A borrower who opens "My Wallet" from the Supporter dashboard (the Financial Hub) sees their Special Advance. */

vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/hooks/wallet/usePartnerWalletHub', () => ({
  usePartnerWalletHub: () => ({
    data: { totalAvailable: 300_000, withdrawableAmount: 300_000, floatAmount: 0, roiAmount: 0, transactions: [] },
    isLoading: false, error: null, refetch: vi.fn(),
  }),
}));
vi.mock('@/components/wallet/UnifiedWalletHeroCard', () => ({ UnifiedWalletHeroCard: () => <div>hero</div> }));
vi.mock('@/components/supporter/FunderQuickActions', () => ({ FunderQuickActions: () => null }));
vi.mock('@/components/supporter/MerchantCodePills', () => ({ MerchantCodePills: () => null }));

import FunderWalletHubSection from '@/components/supporter/FunderWalletHubSection';

const advance = {
  id: '11111111-1111-1111-1111-111111111111', reference: 'SA-000001', status: 'disbursed', principal: 500_000, access_fee: 140_000,
  total_repayable: 640_000, payout_date: '2026-11-01', settled_at: null,
  position: { outstanding: 640_000, total_paid: 0, overdue_amount: 0, overdue_instalments: 0,
    instalments: [{ number: 1, due_date: '2026-12-01', amount: 640_000, paid: 0, outstanding: 640_000, status: 'due' }] },
  repayments: [],
};

afterEach(cleanup);

describe('Supporter Financial Hub: Special Advances', () => {
  it('shows the borrower\'s Special Advance with Pay from Wallet', async () => {
    mocks.rpc.mockResolvedValue({ data: { wallet_available: 300_000, advances: [advance] }, error: null });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><FunderWalletHubSection open onOpenChange={() => {}} /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('My Special Advances')).toBeInTheDocument();
    expect(screen.getByText('SA-000001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pay from Wallet/ })).toBeEnabled();
    expect(mocks.rpc).toHaveBeenCalledWith('special_advance_my_advances', undefined);
  });
});
