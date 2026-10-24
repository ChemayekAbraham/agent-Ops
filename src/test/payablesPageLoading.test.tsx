import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('recharts', () => {
  const Null = () => null;
  return Object.fromEntries(['ResponsiveContainer', 'PieChart', 'Pie', 'Cell', 'Tooltip', 'ComposedChart', 'CartesianGrid', 'XAxis', 'YAxis', 'Bar', 'Line'].map(n => [n, Null]));
});
import PayablesOverview from '@/pages/cfo/PayablesOverview';

function setup(path = '/cfo/payables') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><PayablesOverview /></MemoryRouter></QueryClientProvider>);
  return { ...view, client };
}
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('Payables page loading boundaries', () => {
  it('exposes the authoritative total while full details are pending, then retains category drill-down', async () => {
    let release: (value: unknown) => void = () => {};
    const details = new Promise(resolve => { release = resolve; });
    mocks.rpc.mockImplementation(async (name: string) => name === 'get_payables_breakdown' ? details : {
      data: name === 'get_payables_total' ? { total: 123456, overdue: 1000, due_today: 200, item_count: 2 } : { periods: [], actual: {} }, error: null,
    });
    const { unmount, client } = setup();
    await waitFor(() => expect(screen.getByText('UGX 123,456', { exact: false })).toBeInTheDocument());
    expect(mocks.rpc.mock.calls.filter(c => c[0] === 'get_payables_breakdown')).toHaveLength(1);
    await act(async () => release({ data: { total: 123456, categories: [{ key: 'landlord', label: 'Landlord Products', outstanding: 123456, item_count: 2, products: [{ key: 'returns', label: 'Returns', source: 'recorded', outstanding: 123456, item_count: 2, scheduled_amount: 123456, projected_amount: 0, items: [{ item_id: 'a', counterparty: 'Example Landlord', amount: 123456, due_date: '2026-10-24', due_kind: 'scheduled', source: 'recorded', status: 'pending' }] }] }], validation: { ties_out: true, difference: 0 } }, error: null }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Landlord Products/ }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: /Landlord Products/ })[0]);
    await waitFor(() => expect(screen.getAllByText('Example Landlord').length).toBeGreaterThan(0));
    expect(mocks.rpc.mock.calls.filter(c => c[0] === 'get_payables_breakdown')).toHaveLength(1);
    unmount(); client.clear();
  });

  it('requests only the selected forecast window, keeping its contract request unchanged', async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'get_payables_total'
      ? { total: 100, item_count: 1 }
      : name === 'get_payables_breakdown' ? { categories: [] }
      : name === 'get_payables_contract_schedule' ? [] : { periods: [], history: [] }, error: null }));
    const { unmount, client } = setup('/cfo/payables?cat=daily');
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_payables_contract_schedule', { p_granularity: 'day', p_periods: 7 }));
    fireEvent.click(screen.getByRole('tab', { name: 'Next 14 days' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_payables_predictive_forecast', { p_granularity: 'day', p_periods: 14 }));
    expect(mocks.rpc).toHaveBeenCalledWith('get_payables_contract_schedule', { p_granularity: 'day', p_periods: 14 });
    expect(mocks.rpc.mock.calls.filter(c => c[0] === 'get_payables_predictive_forecast').map(c => c[1])).toEqual([
      { p_granularity: 'day', p_periods: 7 }, { p_granularity: 'day', p_periods: 14 },
    ]);
    unmount(); client.clear();
  });

  it('shows only the payout report for the partner category, keeping product drill-down elsewhere', async () => {
    const product = (counterparty: string) => ({ key: 'returns', label: 'Returns', source: 'recorded', outstanding: 500, item_count: 1, scheduled_amount: 500, projected_amount: 0, items: [{ item_id: 'x1', counterparty, amount: 500, due_date: '2026-10-24', due_kind: 'scheduled', source: 'recorded', status: 'pending' }] });
    const breakdown = { as_at: '2026-10-24', total: 1000, categories: [
      { key: 'partner', label: 'Partner Products', outstanding: 500, item_count: 1, products: [product('Example Partner')] },
      { key: 'landlord', label: 'Landlord Products', outstanding: 500, item_count: 1, products: [product('Example Landlord')] },
    ], validation: { ties_out: true, difference: 0 } };
    mocks.rpc.mockImplementation(async (name: string) => name === 'get_payables_breakdown' ? { data: breakdown, error: null }
      : name === 'get_payables_total' ? { data: { total: 1000, overdue: 0, due_today: 0, item_count: 2 }, error: null }
      : name === 'get_partner_paid_outstanding' ? { data: null, error: { code: '42501', message: 'denied' } }
      : { data: { periods: [], actual: {} }, error: null });
    const partner = setup('/cfo/payables?cat=partner');
    await waitFor(() => expect(partner.getByRole('heading', { name: 'Partner Products' })).toBeInTheDocument());
    await waitFor(() => expect(partner.getByText(/Could not load paid and outstanding/)).toBeInTheDocument());
    expect(partner.queryByRole('tablist', { name: 'Payable products' })).toBeNull();
    expect(partner.queryByText('Example Partner')).toBeNull();
    partner.unmount(); partner.client.clear();
    const landlord = setup('/cfo/payables?cat=landlord');
    await waitFor(() => expect(landlord.getByRole('tablist', { name: 'Payable products' })).toBeInTheDocument());
    expect(landlord.getAllByText('Example Landlord').length).toBeGreaterThan(0);
    landlord.unmount(); landlord.client.clear();
  });
});
