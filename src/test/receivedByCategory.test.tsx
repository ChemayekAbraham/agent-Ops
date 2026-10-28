import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ReceivedByCategory from "@/components/cfo/ReceivedByCategory";

/** Each case gets a fresh cache, so reads from one test never leak into the next. */
function renderReport() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<ReceivedByCategory />, { wrapper });
}

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

const totalsRpc = vi.fn();
const pageRpc = vi.fn();
const breakdownRpc = vi.fn();

// October 2026 production figures, read from the live database. `nature`, `sort_order`
// and `pct` are columns the server's own summary read returns.
const TOTALS = [
  { category_key: 'partner', category_label: 'Partner Products and Services', nature: 'capital', sort_order: 1, amount: 1490187977, tx_count: 2600, pct: 90.51 },
  { category_key: 'land', category_label: 'Tenant Products and Services', nature: 'recovery', sort_order: 2, amount: 100180658, tx_count: 8100, pct: 6.08 },
  { category_key: 'agent', category_label: 'Agent Products and Services', nature: 'recovery', sort_order: 3, amount: 46325502, tx_count: 6087, pct: 2.81 },
  { category_key: 'fees', category_label: 'Revenue', nature: 'income', sort_order: 4, amount: 9409016, tx_count: 6200, pct: 0.57 },
  { category_key: 'other_income', category_label: 'Other Income', nature: 'income', sort_order: 5, amount: 48000, tx_count: 2639, pct: 0.00 },
  { category_key: 'capital', category_label: 'Share Capital', nature: 'capital', sort_order: 6, amount: 290000, tx_count: 12, pct: 0.02 },
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
    rpc.mockImplementation((name: string, args: unknown) => {
      if (name === 'get_cfo_received_by_category_totals') return totalsRpc(name, args);
      if (name === 'get_cfo_received_by_category_page') return pageRpc(name, args);
      if (name === 'get_cfo_received_agent_products_breakdown') return breakdownRpc(name, args);
      return Promise.resolve({ data: [], error: null });
    });
    totalsRpc.mockResolvedValue({ data: TOTALS, error: null });
    pageRpc.mockResolvedValue({ data: [ROW], error: null });
    breakdownRpc.mockResolvedValue({ data: SPLIT, error: null });

    renderReport();

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
    expect(screen.getAllByText(/genuine income/i).length).toBeGreaterThan(0);
  });

  it('sends the chosen category, with no product type until one is picked', async () => {
    rpc.mockImplementation((name: string, args: unknown) => {
      if (name === 'get_cfo_received_by_category_totals') return totalsRpc(name, args);
      if (name === 'get_cfo_received_by_category_page') return pageRpc(name, args);
      if (name === 'get_cfo_received_agent_products_breakdown') return breakdownRpc(name, args);
      return Promise.resolve({ data: [], error: null });
    });
    totalsRpc.mockResolvedValue({ data: TOTALS, error: null });
    pageRpc.mockResolvedValue({ data: [ROW], error: null });
    breakdownRpc.mockResolvedValue({ data: SPLIT, error: null });

    renderReport();
    await screen.findByText('All received transactions');
    fireEvent.click(await screen.findByRole('button', { name: /Agent Products and Services/ }));

    await waitFor(() => expect(pageRpc).toHaveBeenCalledWith(
      'get_cfo_received_by_category_page',
      expect.objectContaining({ p_category: 'agent', p_type: null }),
    ));
  });

  it('filters the agent list by recovery type and shows the server counts', async () => {
    rpc.mockImplementation((name: string, args: unknown) => {
      if (name === 'get_cfo_received_by_category_totals') return totalsRpc(name, args);
      if (name === 'get_cfo_received_by_category_page') return pageRpc(name, args);
      if (name === 'get_cfo_received_agent_products_breakdown') return breakdownRpc(name, args);
      return Promise.resolve({ data: [], error: null });
    });
    totalsRpc.mockResolvedValue({ data: TOTALS, error: null });
    pageRpc.mockResolvedValue({ data: [ROW], error: null });
    breakdownRpc.mockResolvedValue({ data: SPLIT, error: null });

    renderReport();
    await screen.findByText('All received transactions');

    // No type control while every category is shown.
    expect(screen.queryByRole('group', { name: 'Recovery type' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /Agent Products and Services/ }));

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
    rpc.mockImplementation((name: string, args: unknown) => {
      if (name === 'get_cfo_received_by_category_totals') return totalsRpc(name, args);
      if (name === 'get_cfo_received_by_category_page') return pageRpc(name, args);
      if (name === 'get_cfo_received_agent_products_breakdown') return breakdownRpc(name, args);
      return Promise.resolve({ data: [], error: null });
    });
    totalsRpc.mockResolvedValue({ data: TOTALS, error: null });
    pageRpc.mockResolvedValue({ data: [ROW], error: null });
    breakdownRpc.mockResolvedValue({ data: SPLIT, error: null });

    renderReport();
    await screen.findByText('All received transactions');
    fireEvent.click(await screen.findByRole('button', { name: /Agent Products and Services/ }));
    const bar = await screen.findByRole('group', { name: 'Recovery type' });
    fireEvent.click(within(bar).getByRole('button', { name: /Smartphone recoveries/ }));
    await waitFor(() => expect(pageRpc).toHaveBeenCalledWith(
      'get_cfo_received_by_category_page',
      expect.objectContaining({ p_type: 'smartphone' }),
    ));

    fireEvent.click(await screen.findByRole('button', { name: /Tenant Products and Services/ }));
    await waitFor(() => expect(pageRpc).toHaveBeenCalledWith(
      'get_cfo_received_by_category_page',
      expect.objectContaining({ p_category: 'land', p_type: null }),
    ));
    expect(screen.queryByRole('group', { name: 'Recovery type' })).toBeNull();
  });
});
