import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { ReceivedByCategory } from '@/components/cfo/ReceivedByCategory';

const totals = [
  { category_key: 'partner', category_label: 'Partner Products and Services', sort_order: 1, amount: 8000, tx_count: 8, pct: 80, nature: 'capital' },
  { category_key: 'landlord', category_label: 'Land Products and Services', sort_order: 2, amount: 1500, tx_count: 5, pct: 15, nature: 'recovery' },
  { category_key: 'fee', category_label: 'Fees', sort_order: 3, amount: 500, tx_count: 2, pct: 5, nature: 'income' },
];

const pageRows = (n: number, totalMatched: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `row-${i}`, transaction_date: '2026-10-28T09:00:00+00:00', created_at: '2026-10-28T09:00:00+00:00',
    category_key: 'partner', category_label: 'Partner Products and Services', ledger_category: 'partner_funding',
    amount: 1000, description: 'Portfolio funding', reference_id: 'REF-9',
    counterparty: 'Test Supporter', counterparty_phone: '0770000009', approved_by: 'Sarah Approver',
    source_table: 'partner_portfolios', classification: 'production', total_matched: totalMatched,
  }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (name: string, args: any = {}) => {
    if (name === 'get_cfo_received_by_category_totals') return { data: totals, error: null };
    if (name === 'get_cfo_received_by_category_page') {
      const offset = args.p_offset ?? 0;
      return { data: offset === 0 ? pageRows(2, 34) : pageRows(0, 34), error: null };
    }
    return { data: [], error: null };
  });
});

function renderReport() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<ReceivedByCategory />, { wrapper });
}

const flat = (n: Element) => (n.textContent ?? '').replace(/[\s\u00a0\u202f]/g, '');

/** Today and the first of the current month, as seen in Kampala. */
const kampalaToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

describe('CFO Money In', () => {
  it('reads the breakdown once, for the picked period only — no separate estimate read', async () => {
    renderReport();
    await screen.findByTitle('Partner Products and Services');
    const reads = mocks.rpc.mock.calls.filter(c => c[0] === 'get_cfo_received_by_category_totals');
    expect(reads).toHaveLength(1);
    // The single read is the period the user picked: this month, Kampala dates.
    const today = kampalaToday();
    expect(reads[0][1]).toEqual({ p_from: `${today.slice(0, 7)}-01`, p_to: today });
    // Nothing else asks for a 28-day average window (the removed next-7-days estimate).
    const windows = reads.map(c => `${c[1].p_from}..${c[1].p_to}`);
    expect(windows).toEqual([`${today.slice(0, 7)}-01..${today}`]);
  });

  it('shows each category with the server total, count, share and money type', async () => {
    renderReport();
    await screen.findByTitle('Land Products and Services');
    const grandTile = screen.getByText('Grand total received').closest('div')!;
    expect(flat(grandTile)).toMatch(/UGX10[,.\u00a0\u202f]?000/);
    expect(flat(grandTile)).toContain('genuineincomeUGX500');
    const landTile = screen.getByTitle('Land Products and Services').closest('button')!;
    expect(flat(landTile)).toMatch(/5transactions·15\.00%oftotal/);
    expect(flat(landTile)).toContain('Recovery—notincome');
  });

  it('filters the transaction table to the clicked category', async () => {
    renderReport();
    fireEvent.click(await screen.findByTitle('Fees'));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_received_by_category_page',
      expect.objectContaining({ p_category: 'fee', p_offset: 0 })));
  });

  it('names the wallet payer under Received from and the approver under Approved by', async () => {
    renderReport();
    await screen.findByTitle('Partner Products and Services');
    expect((await screen.findAllByText('Test Supporter')).length).toBe(2);
    expect(screen.getByText('Approved by')).toBeInTheDocument();
    expect((await screen.findAllByText('Sarah Approver')).length).toBe(2);
  });
});
