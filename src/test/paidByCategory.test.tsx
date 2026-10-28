import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { PaidByCategory } from '@/components/cfo/PaidByCategory';

const totals = [
  { category_key: 'budget', category_label: 'Operational Expenses', sort_order: 1, amount: 1000, tx_count: 10, pct: 10 },
  { category_key: 'agent', category_label: 'Agent Products and Services', sort_order: 3, amount: 2000, tx_count: 20, pct: 20 },
  { category_key: 'partner', category_label: 'Partner Products and Services', sort_order: 4, amount: 4000, tx_count: 40, pct: 40 },
  { category_key: 'landlord', category_label: 'Landlord Products and Services', sort_order: 5, amount: 3000, tx_count: 30, pct: 30 },
  { category_key: 'tenant', category_label: 'Tenant Products and Services', sort_order: 6, amount: 0, tx_count: 0, pct: 0 },
  { category_key: 'marketing', category_label: 'Marketing Expenses', sort_order: 7, amount: 0, tx_count: 0, pct: 0 },
  { category_key: 'rnd', category_label: 'Product Research & Development', sort_order: 8, amount: 0, tx_count: 0, pct: 0 },
];

const pageRows = (n: number, totalMatched: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `row-${i}`, transaction_date: '2026-10-28T09:00:00+00:00', created_at: '2026-10-28T09:00:00+00:00',
    category_key: 'landlord', category_label: 'Landlord Products and Services', ledger_category: 'rent_disbursement',
    amount: 1000, description: 'Rent facilitation', reference_id: 'REF-1',
    counterparty: 'Test Landlord', counterparty_phone: '0770000000', approved_by: 'Sarah Approver',
    source_table: 'rent_requests', classification: 'production', total_matched: totalMatched,
  }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (name: string, args: any = {}) => {
    if (name === 'get_cfo_paid_by_category_totals') return { data: totals, error: null };
    if (name === 'get_cfo_paid_by_category_page') {
      const offset = args.p_offset ?? 0;
      const rows = offset === 0 ? pageRows(2, 52) : pageRows(0, 52);
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  });
});

function renderReport() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<PaidByCategory />, { wrapper });
}

const flat = (n: Element) => (n.textContent ?? '').replace(/[\s\u00a0\u202f]/g, '');

/** Today, as seen in Kampala — the same clock the report uses. */
const kampalaToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());


describe('CFO Paid by Category', () => {
  it('shows the seven server categories with totals, counts and share of the grand total', async () => {
    renderReport();
    // Category tiles only render once the server totals load.
    await screen.findByTitle('Partner Products and Services');
    for (const t of totals) {
      expect(screen.getByTitle(t.category_label)).toBeInTheDocument();
    }
    // The agent category is "Agent Products and Services"; the old "Agent Commissions"
    // wording must never come back from the server.
    expect(screen.queryByTitle('Agent Commissions')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent Commissions')).not.toBeInTheDocument();
    await waitFor(() => {
      const grandTile = screen.getByText('Grand total paid').closest('div');
      if (!grandTile) throw new Error('Grand total tile missing');
      expect(flat(grandTile)).toMatch(/UGX10[,.\u00a0\u202f]?000/);
    });
    const landlordTile = screen.getByTitle('Landlord Products and Services').closest('button');
    if (!landlordTile) throw new Error('Landlord category tile missing');
    expect(flat(landlordTile)).toMatch(/30transactions·30\.00%oftotal/);
  });

  it('filters the transaction table to the clicked category', async () => {
    renderReport();
    fireEvent.click(await screen.findByTitle('Landlord Products and Services'));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_paid_by_category_page',
      expect.objectContaining({ p_category: 'landlord', p_offset: 0 })));
  });

  it('shows agent commission payouts with Type "Agent Commission", never "Agent Commission Payable"', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_cfo_paid_by_category_totals') return { data: totals, error: null };
      if (name === 'get_cfo_paid_by_category_page') {
        return {
          data: [{
            id: 'row-ac', transaction_date: '2026-10-28T09:00:00+00:00', created_at: '2026-10-28T09:00:00+00:00',
            category_key: 'agent', category_label: 'Agent Products and Services', ledger_category: 'agent_commission_payable',
            amount: 5000, description: 'Commission payout', reference_id: 'REF-AC',
            counterparty: 'Test Agent', counterparty_phone: '0770000001', approved_by: null,
            source_table: 'withdrawal_requests', classification: 'production', total_matched: 1,
          }],
          error: null,
        };
      }
      return { data: [], error: null };
    });
    renderReport();
    await screen.findByTitle('Agent Products and Services');
    expect(await screen.findByText('Agent Commission')).toBeInTheDocument();
    expect(screen.queryByText('Agent Commission Payable')).not.toBeInTheDocument();
  });

  it('shows the wallet recipient in Paid to and the staff approver in Approved by', async () => {
    renderReport();
    await screen.findByTitle('Landlord Products and Services');
    // The recipient keeps their own column…
    const recipients = await screen.findAllByText('Test Landlord');
    expect(recipients.length).toBe(2);
    // …and the approver appears only under the new "Approved by" column.
    expect(screen.getByText('Approved by')).toBeInTheDocument();
    const approvers = await screen.findAllByText('Sarah Approver');
    expect(approvers.length).toBe(2);
  });

  it('pages the transaction table from the server', async () => {
    renderReport();
    await screen.findByTitle('Landlord Products and Services');
    const landlordRows = await screen.findAllByText('Test Landlord', {}, { timeout: 4000 });
    expect(landlordRows.length).toBe(2);
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(next).not.toBeDisabled();
    fireEvent.click(next);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_paid_by_category_page',
      expect.objectContaining({ p_offset: 50 })));
  });
  it('reads the breakdown once, for the picked period only — no estimate or payables read', async () => {
    renderReport();
    await screen.findByTitle('Partner Products and Services');
    const reads = mocks.rpc.mock.calls.filter(c => c[0] === 'get_cfo_paid_by_category_totals');
    expect(reads).toHaveLength(1);
    // The single read is the default period: All time, Kampala dates.
    const today = kampalaToday();
    expect(reads[0][1]).toEqual({ p_from: '2020-01-01', p_to: today });
    // Nothing else asks for a 28-day average window (the removed next-7-days estimate).
    const windows = reads.map(c => `${c[1].p_from}..${c[1].p_to}`);
    expect(windows).toEqual([`2020-01-01..${today}`]);
    // The payables schedule that fed the removed panel is never read either.
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_payables_due_range', expect.anything());
    expect(screen.queryByText(/expected out — next 7 days/)).not.toBeInTheDocument();
  });

  it('opens on All time and switches to a picked period', async () => {
    renderReport();
    await screen.findByTitle('Partner Products and Services');
    // All time is the default, shown as the pressed segment.
    const allTime = screen.getByRole('button', { name: 'All time' });
    expect(allTime).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/All time \(Kampala days\)/)).toBeInTheDocument();

    // Picking Last 7 days re-reads the same report for that window.
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    const today = kampalaToday();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_paid_by_category_totals',
      expect.objectContaining({ p_to: today })));
    const reads = mocks.rpc.mock.calls.filter(c => c[0] === 'get_cfo_paid_by_category_totals');
    expect(reads.at(-1)?.[1].p_from).not.toBe('2020-01-01');
    expect(allTime).toHaveAttribute('aria-pressed', 'false');
  });
});

