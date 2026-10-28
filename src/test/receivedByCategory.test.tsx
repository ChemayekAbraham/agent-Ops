import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ReceivedByCategory from "@/components/cfo/ReceivedByCategory";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

const totalsRpc = vi.fn();
const pageRpc = vi.fn();
const breakdownRpc = vi.fn();

const TOTALS = [
  { category_key: 'partner', category_label: 'Partner Products and Services', nature: 'supporter_funding', amount: 1490187977, tx_count: 2600 },
  { category_key: 'land', category_label: 'Land Products and Services', nature: 'tenant_repayment', amount: 100180658, tx_count: 8100 },
  { category_key: 'agent', category_label: 'Agent Products and Services', nature: 'agent_repayment', amount: 46325502, tx_count: 6087 },
  { category_key: 'fees', category_label: 'Fees and Service Income', nature: 'fee_income', amount: 9409016, tx_count: 6200 },
  { category_key: 'capital', category_label: 'Share Capital', nature: 'share_capital', amount: 290000, tx_count: 12 },
  { category_key: 'other_income', category_label: 'Other Income', nature: 'other_income', amount: 48000, tx_count: 2639 },
];

// Production figures for October 2026, read from the live database.
const SPLIT = [
  { product_key: 'advance', product_label: 'Agent advance repayments', amount: 45616725, tx_count: 5894 },
  { product_key: 'smartphone', product_label: 'Smartphone recoveries', amount: 571004, tx_count: 142 },
  { product_key: 'bike', product_label: 'Bike recoveries', amount: 137773, tx_count: 51 },
];

const ROW = {
  id: '11111111-1111-4111-8111-111111111111', transaction_date: '2026-10-28T08:00:00Z', created_at: '2026-10-28T08:00:00Z',
  category_key: 'agent', category_label: 'Agent Products and Services', ledger_category: 'agent_advance_repayment',
  amount: 1000, description: 'Principal share of repayment', reference_id: null, counterparty: 'PRISCILLA LOLEM',
  counterparty_phone: '+256767923127', approved_by: null, source_table: 'agent_advances',
  transaction_group_id: null, classification: 'production', total_matched: 1,
};

describe('ReceivedByCategory (Money In)', () => {
  it('asks the server once for the chosen period and never invents a projection read', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'get_cfo_received_by_category_totals') return totalsRpc();
      if (name === 'get_cfo_received_by_category_page') return pageRpc();
      if (name === 'get_cfo_received_agent_products_breakdown') return breakdownRpc();
      return Promise.resolve({ data: [], error: null });
    });
    totalsRpc.mockResolvedValue({ data: TOTALS, error: null });
    pageRpc.mockResolvedValue({ data: [ROW], error: null });
    breakdownRpc.mockResolvedValue({ data: SPLIT, error: null });

    render(<ReceivedByCategory />);

    // The page reads the server's own breakdown for the period it shows.
    await waitFor(() => expect(totalsRpc).toHaveBeenCalledWith(
      'get_cfo_received_by_category_totals',
      expect.objectContaining({ p_from: expect.any(String), p_to: expect.any(String) }),
    ));
    // And the transaction list is fetched for the same window.
    await waitFor(() => expect(pageRpc).toHaveBeenCalledWith(
      'get_cfo_received_by_category_page',
      expect.objectContaining({ p_from: expect.any(String), p_to: expect.any(String) }),
    ));
    // The removed "next 7 days" projection must not sneak back in: no 28-day average read
    // is issued behind the scenes, and only the three report reads happen.
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
    const names = rpc.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toEqual([
      'get_cfo_received_by_category_totals',
      'get_cfo_received_by_category_page',
      'get_cfo_received_agent_products_breakdown',
    ]);
    expect(screen.queryByText(/Projected Money In/i)).toBeNull();
    expect(screen.getByText(/All received transactions/i)).toBeTruthy();
    // Genuine income is reported separately from the grand total.
    expect(screen.getByText(/genuine income/i)).toBeTruthy();
  });

  it('sends the chosen category, with no product type until one is picked', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'get_cfo_received_by_category_totals') return totalsRpc();
      if (name === 'get_cfo_received_by_category_page') return pageRpc();
      if (name === 'get_cfo_received_agent_products_breakdown') return breakdownRpc();
      return Promise.resolve({ data: [], error: null });
    });
    totalsRpc.mockResolvedValue({ data: TOTALS, error: null });
    pageRpc.mockResolvedValue({ data: [ROW], error: null });
    breakdownRpc.mockResolvedValue({ data: SPLIT, error: null });

    render(<ReceivedByCategory />);
    await screen.findByText('All received transactions');
    fireEvent.click(screen.getByRole('button', { name: /Agent Products and Services/ }));

    await waitFor(() => expect(pageRpc).toHaveBeenCalledWith(
      'get_cfo_received_by_category_page',
      expect.objectContaining({ p_category: 'agent', p_type: null }),
    ));
  });

  it('filters the agent list by recovery type and shows the server counts', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'get_cfo_received_by_category_totals') return totalsRpc();
      if (name === 'get_cfo_received_by_category_page') return pageRpc();
      if (name === 'get_cfo_received_agent_products_breakdown') return breakdownRpc();
      return Promise.resolve({ data: [], error: null });
    });
    totalsRpc.mockResolvedValue({ data: TOTALS, error: null });
    pageRpc.mockResolvedValue({ data: [ROW], error: null });
    breakdownRpc.mockResolvedValue({ data: SPLIT, error: null });

    render(<ReceivedByCategory />);
    await screen.findByText('All received transactions');

    // No type control while every category is shown.
    expect(screen.queryByRole('group', { name: 'Recovery type' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Agent Products and Services/ }));

    const bar = await screen.findByRole('group', { name: 'Recovery type' });
    // Counts come from the server split, so the pills and the tile always agree.
    expect(within(bar).getByRole('button', { name: /Smartphone recoveries/ }).textContent).toContain('142');
    expect(within(bar).getByRole('button', { name: /Bike recoveries/ }).textContent).toContain('51');

    fireEvent.click(within(bar).getByRole('button', { name: /Bike recoveries/ }));
    await waitFor(() => expect(pageRpc).toHaveBeenCalledWith(
      'get_cfo_received_by_category_page',
      expect.objectContaining({ p_category: 'agent', p_type: 'bike' }),
    ));
    // The same period is kept when the type changes.
    expect(pageRpc.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      p_from: expect.any(String), p_to: expect.any(String), p_offset: 0,
    }));
  });

  it('drops the type filter when another category is chosen', async () => {
    rpc.mockImplementation((name: string) => {
      if (name === 'get_cfo_received_by_category_totals') return totalsRpc();
      if (name === 'get_cfo_received_by_category_page') return pageRpc();
      if (name === 'get_cfo_received_agent_products_breakdown') return breakdownRpc();
      return Promise.resolve({ data: [], error: null });
    });
    totalsRpc.mockResolvedValue({ data: TOTALS, error: null });
    pageRpc.mockResolvedValue({ data: [ROW], error: null });
    breakdownRpc.mockResolvedValue({ data: SPLIT, error: null });

    render(<ReceivedByCategory />);
    await screen.findByText('All received transactions');
    fireEvent.click(screen.getByRole('button', { name: /Agent Products and Services/ }));
    const bar = await screen.findByRole('group', { name: 'Recovery type' });
    fireEvent.click(within(bar).getByRole('button', { name: /Smartphone recoveries/ }));
    await waitFor(() => expect(pageRpc).toHaveBeenCalledWith(
      'get_cfo_received_by_category_page',
      expect.objectContaining({ p_type: 'smartphone' }),
    ));

    fireEvent.click(screen.getByRole('button', { name: /Land Products and Services/ }));
    await waitFor(() => expect(pageRpc).toHaveBeenCalledWith(
      'get_cfo_received_by_category_page',
      expect.objectContaining({ p_category: 'land', p_type: null }),
    ));
    expect(screen.queryByRole('group', { name: 'Recovery type' })).toBeNull();
  });
});
