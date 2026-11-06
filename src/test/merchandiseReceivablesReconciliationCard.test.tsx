import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MerchandiseReceivablesReconciliation } from '@/components/merchandise/MerchandiseReceivablesReconciliation';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: mocks }));

// production figures, read-only check 2026-11-04
const base = {
  as_at: '2026-11-04T12:00:00Z',
  orders: [
    { sale_id: 's-stock', item_name: 'Press Jacket', category: 'boutique', order_status: 'issued', issued: true, customer_id: 'c1', customer: 'Natukunda Esther',
      phone: null, quantity: 1, price: 55000, paid: 0, sale_date: '2026-09-25', account: 'A12', ledger_receivable: 0, plan_balance: 85801,
      not_in_ledger: 85801, awaiting_recognition: 55000, no_customer_account: false, note: 'awaiting_recognition' },
    { sale_id: 's-phone', item_name: 'Welile Smartphone', category: 'smart_phone', order_status: 'approved', issued: true, customer_id: 'c2', customer: 'JOEL KAYONGO',
      phone: null, quantity: 1, price: 165000, paid: 18788, sale_date: '2026-10-01', account: 'A12', ledger_receivable: 154789, plan_balance: 238612,
      not_in_ledger: 83823, awaiting_recognition: 0, no_customer_account: false, note: 'future_charges' },
  ],
  orphan_plans: [{ plan_id: 'p1', item_name: 'Press Jacket', customer_id: 'c3', customer: 'Saka Homi Melvin', status: 'active', plan_balance: 53700, ledger_receivable: 53700, account: 'A12' }],
  awaiting_issue: { count: 63, value: 2040530000 },
  totals: { issued_orders: 63, issued_value: 13775000, plan_balance_issued: 21139535.44, ledger_issued: 12175165.44, awaiting_recognition: 1015000,
    not_in_ledger_other: 7949370, ledger_not_issued: 0, ledger_orphan_plans: 108700, ledger_total: 12283865.44 },
  balance_sheet: null,
};
const withBs = { ...base, balance_sheet: { a12: 11174793.44, a13: 1109072, total: 12283865.44, difference: 0 } };

function renderCard(category?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MerchandiseReceivablesReconciliation category={category} /></QueryClientProvider>);
}
const ugx = (n: string) => new RegExp(n.replace(/[.,]/g, '.'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation((_fn: string, args: { p_with_balance_sheet: boolean }) =>
    Promise.resolve({ data: args.p_with_balance_sheet ? withBs : base, error: null }));
});

describe('Merchandise receivables reconciliation card', () => {
  it('reads the reconciliation (fast) and the balance-sheet tie (separately)', async () => {
    renderCard();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_merchandise_receivables_reconciliation', { p_with_balance_sheet: false }));
    expect(mocks.rpc).toHaveBeenCalledWith('get_merchandise_receivables_reconciliation', { p_with_balance_sheet: true });
  });
  it('bridges plan balances to the receivable and ties to A12 + A13', async () => {
    renderCard();
    expect(await screen.findByText('Reconciled')).toBeInTheDocument();
    expect(screen.getByText(/Plan balances on 63 issued orders/)).toBeInTheDocument();
    expect(screen.getByText('Receivable on issued orders')).toBeInTheDocument();
    expect(screen.getByText(/Plans with no order record \(1\)/)).toBeInTheDocument();
    expect(screen.getByText('Balance sheet: A12 + A13')).toBeInTheDocument();
    expect(screen.getAllByText(ugx('12,283,865')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Awaiting issue \(not a receivable yet\): 63 orders/)).toBeInTheDocument();
  });
  it('shows a difference when the books and the balance sheet disagree', async () => {
    mocks.rpc.mockImplementation((_fn: string, args: { p_with_balance_sheet: boolean }) =>
      Promise.resolve({ data: args.p_with_balance_sheet ? { ...withBs, balance_sheet: { ...withBs.balance_sheet, difference: 5000 } } : base, error: null }));
    renderCard();
    expect(await screen.findByText(/Difference/)).toBeInTheDocument();
  });
  it('lists the items for CFO review', async () => {
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: /Items for CFO review \(2\)/ }));
    expect(screen.getByText('Company stock awaiting recognition')).toBeInTheDocument();
    expect(screen.getByText('Plan with no order record')).toBeInTheDocument();
  });
  it('shows the category line on the Agent Products page', async () => {
    renderCard('smart_phone');
    expect(await screen.findByText(/Smart phones:/)).toBeInTheDocument();
    expect(screen.getByText(/receivable .*154,789 on 1 issued order/)).toBeInTheDocument();
  });
});
