import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { CashPositionDownloadReports } from '@/components/cfo/CashPositionDownloadReports';

// Same concrete figures the Cash Position breakdown panels show: Received 2,700,000 / Paid 2,500,000 across 10 each.
const receivedTotals: Record<string, { amount: number; count: number }> = {
  'Operational float': { amount: 2_000_000, count: 7 },
  'Personal deposit': { amount: 400_000, count: 2 },
  'Rent repayment': { amount: 300_000, count: 1 },
};
const paidTotals: Record<string, { amount: number; count: number }> = {
  'Landlord': { amount: 1_500_000, count: 5 },
  'Commission': { amount: 900_000, count: 3 },
  'Wallet withdrawal': { amount: 100_000, count: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (name: string, args: any = {}) => {
    if (name === 'get_cfo_money_drilldown_totals') {
      const table = args.p_kind === 'paid_out' ? paidTotals : receivedTotals;
      const t = table[args.p_type];
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
  it('shows both reports with the money-source breakdown and the totals', async () => {
    renderDialog();
    // Both section totals resolve once the per-source breakdown queries settle.
    expect(await screen.findByText('UGX 2,700,000')).toBeInTheDocument();
    expect(screen.getByText('UGX 2,500,000')).toBeInTheDocument();
    // Received section shows the source rows
    const receivedSection = screen.getByLabelText('Received Money Report');
    expect(receivedSection.textContent).toContain('Operational float');
    expect(receivedSection.textContent).toContain('Personal deposit');
    expect(receivedSection.textContent).toContain('Rent repayment');
    // Payout section shows its sources
    const paidSection = screen.getByLabelText('Payout Money Report');
    expect(paidSection.textContent).toContain('Landlord float');
    expect(paidSection.textContent).toContain('Agent commission');
  });

  it('opens the payout full report as an all-sources, all-time report that reconciles to the figures shown', async () => {
    renderDialog();
    await screen.findByText('UGX 2,500,000');
    const paidSection = screen.getByLabelText('Payout Money Report');
    fireEvent.click(within(paidSection).getByRole('button', { name: /Open full report/ }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_money_paid_out_page',
      expect.objectContaining({ p_type: null })));
  });

  it('exports each breakdown as a CSV that carries the source rows and totals', async () => {
    const urls: string[] = [];
    const clicks: HTMLAnchorElement[] = [];
    vi.stubGlobal('URL', { ...URL, createObjectURL: (u: string) => { urls.push(u); return u; } });
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicks.push(this); };
    try {
      renderDialog();
      await screen.findByText('UGX 2,700,000');
      const receivedSection = screen.getByLabelText('Received Money Report');
      fireEvent.click(within(receivedSection).getByRole('button', { name: /Export breakdown CSV/ }));
      await waitFor(() => expect(clicks.length).toBe(1));
      const name = clicks[0].download;
      expect(name).toMatch(/^received-money-report_breakdown_/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
