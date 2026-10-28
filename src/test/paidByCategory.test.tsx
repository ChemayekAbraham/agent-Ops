import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { PaidByCategory } from '@/components/cfo/PaidByCategory';

const totals = [
  { category_key: 'budget', category_label: 'Operational Expenses', sort_order: 1, amount: 1000, tx_count: 10, pct: 10 },
  { category_key: 'landlord_float', category_label: 'Landlord Float', sort_order: 2, amount: 3000, tx_count: 30, pct: 30 },
  { category_key: 'agent', category_label: 'Agent Commissions', sort_order: 3, amount: 2000, tx_count: 20, pct: 20 },
  { category_key: 'partner', category_label: 'Partner Products and Services', sort_order: 4, amount: 4000, tx_count: 40, pct: 40 },
  { category_key: 'landlord', category_label: 'Land Products and Services', sort_order: 5, amount: 0, tx_count: 0, pct: 0 },
  { category_key: 'marketing', category_label: 'Marketing Expenses', sort_order: 6, amount: 0, tx_count: 0, pct: 0 },
  { category_key: 'rnd', category_label: 'Product Research & Development', sort_order: 7, amount: 0, tx_count: 0, pct: 0 },
];

const pageRows = (n: number, totalMatched: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `row-${i}`, transaction_date: '2026-10-28T09:00:00+00:00', created_at: '2026-10-28T09:00:00+00:00',
    category_key: 'landlord_float', category_label: 'Landlord Float', ledger_category: 'rent_disbursement',
    amount: 1000, description: 'Rent facilitation', reference_id: 'REF-1',
    counterparty: 'Test Landlord', counterparty_phone: '0770000000',
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

describe('CFO Paid by Category', () => {
  it('shows all seven categories with totals, counts and share of the grand total', async () => {
    renderReport();
    // Category tiles only render once the server totals load.
    await screen.findByTitle('Partner Products and Services');
    for (const t of totals) {
      expect(screen.getByTitle(t.category_label)).toBeInTheDocument();
    }
    await waitFor(() => {
      const grandTile = screen.getByText('Grand total paid').closest('div')!;
      expect(flat(grandTile)).toMatch(/UGX10[,.\u00a0\u202f]?000/);
    });
    const landlordTile = screen.getByTitle('Landlord Float');
    expect(flat(landlordTile)).toMatch(/30transactions·30\.00%oftotal/);
  });

  it('filters the transaction table to the clicked category', async () => {
    renderReport();
    fireEvent.click(await screen.findByTitle('Landlord Float'));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_paid_by_category_page',
      expect.objectContaining({ p_category: 'landlord_float', p_offset: 0 })));
  });

  it('pages the transaction table from the server', async () => {
    renderReport();
    await screen.findByTitle('Landlord Float');
    const landlordRow = await screen.findByText('Test Landlord', {}, { timeout: 4000 });
    expect(landlordRow).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(next).not.toBeDisabled();
    fireEvent.click(next);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_paid_by_category_page',
      expect.objectContaining({ p_offset: 50 })));
  });
});
