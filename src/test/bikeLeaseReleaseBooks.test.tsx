import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BikeLeaseReleaseBooks, bikeReleaseDifference } from '@/components/executive/agent-ops/BikeLeaseReleaseBooks';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: mocks }));

// production, read-only 2026-11-04: PIUS MATA's Spiro lease (a3228b88)
const PIUS = { id: 'a3228b88-6f28-459b-9ef4-48bfd11d3e44', disbursed_amount: 710000, valuation_amount: 500000, amount_outstanding: 1313244,
  cfo_disbursed_at: '2026-09-10T04:34:49Z' };
const recon = {
  as_at: '2026-11-04T12:00:00Z', orphan_plans: [], awaiting_issue: { count: 0, value: 0 }, balance_sheet: null,
  totals: { issued_orders: 1, issued_value: 500000, plan_balance_issued: 1313244, ledger_issued: 477807, awaiting_recognition: 0,
    not_in_ledger_other: 835437, ledger_not_issued: 0, ledger_orphan_plans: 0, ledger_total: 477807 },
  orders: [{ sale_id: PIUS.id, item_name: 'Welile Spiro Bike', category: 'motor_bike', order_status: 'approved', issued: true, customer_id: 'c',
    customer: 'PIUS MATA', phone: null, quantity: 1, price: 500000, paid: 96756, sale_date: '2026-09-09', account: 'A13', ledger_receivable: 477807,
    plan_balance: 1313244, not_in_ledger: 835437, awaiting_recognition: 0, no_customer_account: false, note: 'bike_paid_differs_from_value' }],
};
function renderIt(row = PIUS) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><BikeLeaseReleaseBooks row={row} /></QueryClientProvider>);
}
const has = (n: string) => new RegExp(n.replace(/,/g, '.'));
beforeEach(() => { vi.clearAllMocks(); mocks.rpc.mockResolvedValue({ data: recon, error: null }); });

describe('Motorbikes: release and books', () => {
  it('difference = paid out - bike value, only for released leases', () => {
    expect(bikeReleaseDifference(PIUS)).toBe(210000);
    expect(bikeReleaseDifference({ ...PIUS, disbursed_amount: 500000 })).toBe(0);
    expect(bikeReleaseDifference({ ...PIUS, cfo_disbursed_at: null })).toBe(0);
  });
  it('shows what was paid out, the bike value, the A13 receivable and the plan balance, and flags the 210,000', async () => {
    renderIt();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_merchandise_receivables_reconciliation', { p_with_balance_sheet: false }));
    expect(screen.getByText('Paid out at release').nextSibling?.textContent).toMatch(has('710,000'));
    expect(screen.getByText('Bike value the lease is priced on').nextSibling?.textContent).toMatch(has('500,000'));
    await waitFor(() => expect(screen.getByText('Receivable on the balance sheet (A13)').nextSibling?.textContent).toMatch(has('477,807')));
    expect(screen.getByText(/Plan balance the agent repays/).nextSibling?.textContent).toMatch(has('1,313,244'));
    expect(screen.getByText(/more was paid out than the bike value/)).toBeTruthy();
  });
  it('shows nothing for a lease not yet released, and does not query', () => {
    const { container } = renderIt({ ...PIUS, cfo_disbursed_at: null });
    expect(container.textContent).toBe('');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('no warning when the release equals the bike value', async () => {
    renderIt({ ...PIUS, disbursed_amount: 500000 });
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    expect(screen.queryByText(/was paid out than the bike value/)).toBeNull();
  });
});
