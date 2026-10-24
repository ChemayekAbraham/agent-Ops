import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { PartnerPaidOutstandingPanel } from '@/components/cfo/PartnerPaidOutstandingPanel';

const ca = (count: number, amount: number) => ({ count, amount });
const summary = {
  as_at: '2026-10-24T08:00:00Z',
  period: { from: '2026-10-01', to: '2026-10-24', outstanding_due_to: '2026-10-24' },
  paid: {
    returns_cash: { ...ca(779, 970432577), payees: 25, reversed: ca(0, 0), to_partner_wallet: ca(29, 61923995), to_other_wallet: ca(748, 907691082), not_linked_to_portfolio: ca(2, 817500) },
    returns_reinvested: { ...ca(318, 277131443), portfolios: 304 },
    commissions: [
      { key: 'registration_bonus', label: 'Registration bonus', rule: 'UGX 1,500 per eligible verified promissory note', historical_paid_only: false, paid: { count: 2049, payees: 80, amount: 3073500 }, unpaid: ca(0, 0) },
      { key: 'fulfilment_commission', label: 'Fulfilment commission', rule: '2% of principal', historical_paid_only: false, paid: { count: 78, payees: 30, amount: 2949860 }, unpaid: ca(0, 0) },
      { key: 'topup_commission', label: 'Subsequent top-up commission', rule: '1% of each eligible top-up', historical_paid_only: false, paid: { count: 37, payees: 20, amount: 554950 }, unpaid: ca(0, 0) },
      { key: 'recalculation_topup', label: 'Historical recalculation top-ups (paid 2 Oct 2026)', rule: 'Historical', historical_paid_only: true, paid: { count: 4, payees: 4, amount: 11600 }, unpaid: ca(0, 0) },
      { key: 'lead_override', label: 'Proxy Agent lead override (shown separately)', rule: 'UGX 1,000 per verified note', historical_paid_only: false, paid: { count: 2717, payees: 2, amount: 2717000 }, unpaid: ca(0, 0) },
    ],
    commission_totals: { commissions_paid: 6578310, commissions_unpaid_confirmed: 0, lead_override_paid: 2717000, lead_override_unpaid_confirmed: 0, recalculation_topups_paid_historical: 11600, unpaid_in_payables: 0 },
  },
  outstanding: {
    returns: { ...ca(1570, 1793586284.4), by_status: { overdue: ca(54, 6636722), due_in_period: ca(40, 42877835.9), later: ca(1476, 1744071726.5) }, by_mode: { cash_payout: ca(1133, 1383374864.15), compounding: ca(437, 410211420.25) } },
    commissions_unpaid: ca(0, 0),
    pending_not_owed: [{ key: 'unconfirmed_deposits', label: 'Deposits awaiting confirmation as top-ups', status: 'Eligibility and amount not confirmed' }],
  },
  reconciliation: { partner_payables_total: 1793586284.4, returns_plus_unpaid_commissions: 1793586284.4, other_partner_lines: 0, ties_out: true, commission_unpaid_matches_report: true, possible_double_return_credits: { pairs: 1, second_credit_amount: 112500 } },
  basis: { paid: '', outstanding: '' },
};
const itemsPage = (offset: number) => ({
  component: 'returns_cash', status: 'all', total_count: 120, limit: 50, offset,
  items: Array.from({ length: offset === 100 ? 20 : 50 }, (_, i) => ({ ledger_id: `l${offset + i}`, date: '2026-10-05T09:00:00Z', partner: 'Partner One', portfolio: 'PF1', paid_to: 'Proxy Agent', amount: 1000, status: 'credited' })),
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PartnerPaidOutstandingPanel /></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation((fn: string, args: Record<string, unknown>) =>
    Promise.resolve(fn === 'get_partner_paid_outstanding' ? { data: summary, error: null } : { data: itemsPage(Number(args.p_offset)), error: null }));
});
afterEach(() => cleanup());

describe('Partner Products and Services — Paid & Outstanding panel', () => {
  it('asks the server for the current month by default and shows paid, reinvested and outstanding figures', async () => {
    setup();
    await screen.findByText('Partner Returns paid in cash');
    const [fn, args] = mocks.rpc.mock.calls[0];
    expect(fn).toBe('get_partner_paid_outstanding');
    expect(String(args.p_from)).toMatch(/^\d{4}-\d{2}-01$/);
    expect(args.p_to).toBeTruthy();
    for (const label of ['Registration bonus', 'Fulfilment commission', 'Subsequent top-up commission', 'Proxy Agent lead override (shown separately)',
      'Partner Returns reinvested (compounding, not cash)', 'Partner Returns — overdue', 'Commissions confirmed unpaid', 'Total outstanding']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // total paid = cash Returns + commissions (server figures); reinvested is not added
    const paidRow = screen.getByText('Total paid (cash Returns + commissions)').closest('tr')!;
    expect(paidRow.textContent).toContain((970432577 + 6578310).toLocaleString());
    expect(screen.getByRole('status').textContent).toContain('Reconciled');
    expect(screen.getByRole('status').textContent).toContain('possible double Return credit');
    expect(screen.getByText('Deposits awaiting confirmation as top-ups')).toBeTruthy();
  });

  it('drills down to the records and pages through them', async () => {
    setup();
    const row = (await screen.findByText('Partner Returns paid in cash')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'View records' }));
    await screen.findByText(/Partner Returns paid in cash — 120 record\(s\)/);
    const call = mocks.rpc.mock.calls.find(([f]) => f === 'get_partner_paid_outstanding_items')!;
    expect(call[1]).toMatchObject({ p_component: 'returns_cash', p_status: 'all', p_limit: 50, p_offset: 0 });
    expect(screen.getByText('Showing 1–50 of 120.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Showing 51–100 of 120.');
  });

  it('refuses a From date after the To date without calling the server again', async () => {
    setup();
    await screen.findByText('Partner Returns paid in cash');
    const calls = mocks.rpc.mock.calls.length;
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-10-30' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-10-01' } });
    expect(screen.getByRole('alert').textContent).toContain('From date is after the To date');
    expect(mocks.rpc.mock.calls.length).toBe(calls);
  });

  it('All time asks for no date limits', async () => {
    setup();
    await screen.findByText('Partner Returns paid in cash');
    fireEvent.click(screen.getByRole('button', { name: 'All time' }));
    await waitFor(() => expect(mocks.rpc.mock.calls.some(([f, a]) => f === 'get_partner_paid_outstanding' && a.p_from === null && a.p_to === null)).toBe(true));
  });

  it('shows an error state instead of figures when the server fails', async () => {
    mocks.rpc.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'boom', code: '57014' } }));
    setup();
    await screen.findByText(/Could not load paid and outstanding amounts/);
    expect(screen.queryByText('Total outstanding')).toBeNull();
  });
});
