import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { CashPositionBreakdowns } from '@/components/cfo/CashPositionBreakdowns';

// Concrete per-method figures: Received = 2,700,000 across 10; Paid = 2,500,000 across 10.
const receivedTotals: Record<string, { amount: number; count: number }> = {
  mobile_money: { amount: 2_000_000, count: 7 },
  bank_transfer: { amount: 400_000, count: 2 },
  cash: { amount: 300_000, count: 1 },
};
const paidTotals: Record<string, { amount: number; count: number }> = {
  mobile_money: { amount: 1_500_000, count: 5 },
  bank_transfer: { amount: 900_000, count: 3 },
  cash: { amount: 100_000, count: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (name: string, args: any = {}) => {
    if (name === 'get_cfo_money_drilldown_totals') {
      const table = args.p_kind === 'paid_out' ? paidTotals : receivedTotals;
      const t = table[args.p_method];
      return { data: t ? [{ confirmed_amount: t.amount, confirmed_count: t.count }] : [], error: null };
    }
    return { data: [], error: null };
  });
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<CashPositionBreakdowns />, { wrapper });
}

describe('Cash Position Received by / Paid by totals', () => {
  it('shows a Total row that sums the payment-method rows in each panel', async () => {
    renderPanel();
    const rows = await screen.findAllByRole('button', { name: /^Total/ });
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('UGX 2,700,000');
    expect(rows[0].textContent).toContain('10 transactions');
    expect(rows[1].textContent).toContain('UGX 2,500,000');
    expect(rows[1].textContent).toContain('10 transactions');
  });

  it('opens the unfiltered report when a Total row is clicked', async () => {
    renderPanel();
    const rows = await screen.findAllByRole('button', { name: /^Total/ });
    fireEvent.click(rows[0]);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_money_received_page',
      expect.objectContaining({ p_method: null })));
  });

  it('keeps each method row filtered to its own payment method', async () => {
    renderPanel();
    const mobile = await screen.findByRole('button', { name: /Mobile Money/ });
    fireEvent.click(mobile);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_money_received_page',
      expect.objectContaining({ p_method: 'mobile_money' })));
  });
});
