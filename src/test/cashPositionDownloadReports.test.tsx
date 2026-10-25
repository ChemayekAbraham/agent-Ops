import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { CashPositionDownloadReports } from '@/components/cfo/CashPositionDownloadReports';

// Same concrete figures the Cash Position breakdown panels show: Received 2,700,000 / Paid 2,500,000 across 10 each.
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

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<CashPositionDownloadReports open onOpenChange={() => {}} />, { wrapper });
}

describe('Cash Position payout & received money reports dialog', () => {
  it('shows both reports with the payment-method breakdown and the totals', async () => {
    renderDialog();
    expect(await screen.findByText('Received Money Report')).toBeInTheDocument();
    expect(screen.getByText('Payout Money Report')).toBeInTheDocument();
    // Received section totals
    const receivedSection = screen.getByLabelText('Received Money Report');
    expect(receivedSection.textContent).toContain('UGX 2,700,000');
    expect(receivedSection.textContent).toContain('Mobile Money');
    expect(receivedSection.textContent).toContain('Bank Transfer');
    expect(receivedSection.textContent).toContain('Cash');
    // Paid section totals
    const paidSection = screen.getByLabelText('Payout Money Report');
    expect(paidSection.textContent).toContain('UGX 2,500,000');
  });

  it('opens the payout full report as an all-methods, all-time report that reconciles to the figures shown', async () => {
    renderDialog();
    const paidSection = await screen.findByLabelText('Payout Money Report');
    fireEvent.click(within(paidSection).getByRole('button', { name: /Open full report/ }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_money_paid_out_page',
      expect.objectContaining({ p_method: null })));
  });

  it('exports each breakdown as a CSV that carries the method rows and totals', async () => {
    const urls: string[] = [];
    const clicks: HTMLAnchorElement[] = [];
    vi.stubGlobal('URL', { ...URL, createObjectURL: (u: string) => { urls.push(u); return u; } });
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicks.push(this); };
    try {
      renderDialog();
      const receivedSection = await screen.findByLabelText('Received Money Report');
      fireEvent.click(within(receivedSection).getByRole('button', { name: /Export breakdown CSV/ }));
      await waitFor(() => expect(clicks.length).toBe(1));
      const name = clicks[0].download;
      expect(name).toMatch(/^received-money-report_breakdown_/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { within } from '@testing-library/react';
