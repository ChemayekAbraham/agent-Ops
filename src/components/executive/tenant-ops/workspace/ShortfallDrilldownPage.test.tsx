import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

const downloadCsvMock = vi.fn();
vi.mock('@/lib/csvExport', () => ({ downloadCsv: (...a: unknown[]) => downloadCsvMock(...a) }));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

import ShortfallDrilldownPage from './ShortfallDrilldownPage';

type RpcArgs = Record<string, unknown>;

function planRow(i: number, overrides: Record<string, unknown> = {}) {
  return {
    rent_request_id: `rr-${i}`, plan_code: `plan${String(i).padStart(4, '0')}`,
    tenant_id: `t-${i}`, tenant_name: `Tenant ${i}`, tenant_phone: '+256772236357',
    agent_id: 'agent-1', agent_name: 'Agent One', agent_phone: '+256757229748',
    service_centre_id: null, service_centre: 'No service centre', district: 'Wakiso',
    expected_ugx: 5000, collected_ugx: 0, short_ugx: 5000,
    days_behind: null, periods_behind: null, cadence: 'daily', cadence_label: null,
    oldest_unpaid_due: null, last_paid_at: '2026-10-04T09:57:06+00:00',
    ...overrides,
  };
}

function breakdownRow(key: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    group_key: key, group_name: name, parent_name: null, plan_count: 3, tenant_count: 3,
    expected_ugx: 15000, collected_ugx: 0, short_ugx: 15000, short_pct: 100,
    avg_days_behind: null, max_days_behind: null, oldest_unpaid_due: null, ...extra,
  };
}

interface Scenario { home: { expected: number; collected: number }; totalCount: number; totalShort: number }

function install(s: Scenario) {
  rpcMock.mockImplementation((fn: string, args: RpcArgs) => {
    if (fn === 'ops_tenant_ops_home_range') {
      return Promise.resolve({ data: { expected: s.home.expected, collected: s.home.collected }, error: null });
    }
    if (fn === 'tops_shortfall_breakdown') {
      const rows: Record<string, unknown[]> = {
        tenant: [
          breakdownRow('t-1', 'Atimango Joyce', { parent_name: '+256772236357' }),
          breakdownRow('t-2', 'Babirye Florence', { parent_name: '+256754679678' }),
        ],
        agent: [breakdownRow('agent-1', 'Agent One', { plan_count: 230, short_ugx: 1150000 })],
        service_centre: [breakdownRow('none', 'No service centre')],
        area: [breakdownRow('50', 'Wakiso', { parent_name: 'Central' })],
        ageing: [breakdownRow('not_scheduled', 'Not scheduled')],
      };
      return Promise.resolve({ data: rows[args.p_group as string] ?? [], error: null });
    }
    if (fn === 'tops_shortfall_detail') {
      if (args.p_group === null) {
        return Promise.resolve({ data: { total_count: s.totalCount, total_short_ugx: s.totalShort, rows: [] }, error: null });
      }
      const total = 230;
      const offset = args.p_offset as number;
      const limit = args.p_limit as number;
      const n = Math.max(0, Math.min(limit, total - offset));
      const rows = Array.from({ length: n }, (_, k) => {
        const i = offset + k;
        if (i === 0) return planRow(i, { days_behind: 3, periods_behind: 3, cadence_label: '3 days' });
        if (i === 1) return planRow(i, { days_behind: 14, periods_behind: 2, cadence: 'weekly', cadence_label: '2 weeks' });
        return planRow(i);
      });
      return Promise.resolve({ data: { total_count: total, total_short_ugx: 1150000, rows }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const callsTo = (fn: string) => rpcMock.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as RpcArgs);

describe('ShortfallDrilldownPage — header', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the RPC shortfall total, coverage, Rent Plans short and tenants short for the chosen range', async () => {
    install({ home: { expected: 1000000, collected: 400000 }, totalCount: 397, totalShort: 600000 });
    render(<ShortfallDrilldownPage />, { wrapper });

    expect(await screen.findByText('397')).toBeInTheDocument();           // Rent Plans short
    expect(screen.getByText('40%')).toBeInTheDocument();                  // coverage, same formula as Tenant Ops Home
    expect(screen.getByText(/600,000/)).toBeInTheDocument();              // total short, straight from the RPC
    await waitFor(() => expect(screen.getByText('Tenants short').parentElement?.parentElement).toHaveTextContent('2'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();          // expected − collected = 600,000 = total short
  });

  it('warns when expected minus collected does not match the shortfall total', async () => {
    install({ home: { expected: 1000000, collected: 300000 }, totalCount: 397, totalShort: 600000 });
    render(<ShortfallDrilldownPage />, { wrapper });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/differs from the shortfall total/i);
    expect(alert).toHaveTextContent(/700,000/);
    expect(alert).toHaveTextContent(/600,000/);
  });

  it('queries every RPC for the same range', async () => {
    install({ home: { expected: 1000, collected: 400 }, totalCount: 1, totalShort: 600 });
    render(<ShortfallDrilldownPage />, { wrapper });
    await screen.findAllByText('Atimango Joyce');
    const home = callsTo('ops_tenant_ops_home_range')[0];
    const breakdown = callsTo('tops_shortfall_breakdown')[0];
    const totals = callsTo('tops_shortfall_detail')[0];
    expect(typeof home.p_start).toBe('string');
    expect(breakdown.p_start).toBe(home.p_start);
    expect(breakdown.p_end).toBe(home.p_end);
    expect(totals.p_start).toBe(home.p_start);
    expect(totals.p_end).toBe(home.p_end);
  });

  it('never uses the words loan, ROI or interest', async () => {
    install({ home: { expected: 1000, collected: 400 }, totalCount: 1, totalShort: 600 });
    const { container } = render(<ShortfallDrilldownPage />, { wrapper });
    await screen.findAllByText('Atimango Joyce');
    expect(container.textContent).not.toMatch(/\bloan|\bROI\b|interest|lender/i);
    expect(container.textContent).toMatch(/Rent Plan/);
  });
});

describe('ShortfallDrilldownPage — tabs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('each tab asks for its own grouping, and Districts defaults to district level', async () => {
    install({ home: { expected: 1000, collected: 400 }, totalCount: 1, totalShort: 600 });
    const user = userEvent.setup();
    render(<ShortfallDrilldownPage />, { wrapper });
    await screen.findAllByText('Atimango Joyce');

    await user.click(screen.getByRole('tab', { name: 'Agents' }));
    expect(await screen.findAllByText('Agent One')).not.toHaveLength(0);
    expect(callsTo('tops_shortfall_breakdown').some((a) => a.p_group === 'agent')).toBe(true);

    await user.click(screen.getByRole('tab', { name: 'Service centres' }));
    expect((await screen.findAllByText('No service centre')).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('tab', { name: 'Districts' }));
    expect((await screen.findAllByText('Wakiso')).length).toBeGreaterThan(0);
    const area = callsTo('tops_shortfall_breakdown').find((a) => a.p_group === 'area');
    expect(area?.p_area_level).toBe('district');

    await user.click(screen.getByRole('tab', { name: 'Ageing' }));
    expect((await screen.findAllByText('Not scheduled')).length).toBeGreaterThan(0);
    expect(callsTo('tops_shortfall_breakdown').some((a) => a.p_group === 'ageing')).toBe(true);
  });
});

describe('ShortfallDrilldownPage — Rent Plan sheet', () => {
  beforeEach(() => vi.clearAllMocks());

  async function openAgent(user: ReturnType<typeof userEvent.setup>) {
    install({ home: { expected: 1000, collected: 400 }, totalCount: 1, totalShort: 600 });
    render(<ShortfallDrilldownPage />, { wrapper });
    await screen.findAllByText('Atimango Joyce');
    await user.click(screen.getByRole('tab', { name: 'Agents' }));
    const row = await screen.findByLabelText('Open Rent Plans for Agent One');
    await user.click(row);
    return await screen.findByRole('dialog');
  }

  it('opens the paged list for that group, showing days for daily and weeks for weekly Rent Plans', async () => {
    const user = userEvent.setup();
    const dialog = await openAgent(user);

    await within(dialog).findByText('Tenant 0');
    const call = callsTo('tops_shortfall_detail').find((a) => a.p_group === 'agent');
    expect(call).toMatchObject({ p_group: 'agent', p_group_key: 'agent-1', p_limit: 25, p_offset: 0, p_sort: 'short_ugx', p_dir: 'desc' });
    expect(within(dialog).getByText('3 days')).toBeInTheDocument();
    expect(within(dialog).getByText('2 weeks')).toBeInTheDocument();
    expect(within(dialog).getByText(/Page 1 of 10 · 230 Rent Plans/)).toBeInTheDocument();
  });

  it('searches on the server (debounced) and goes back to page one', async () => {
    const user = userEvent.setup();
    const dialog = await openAgent(user);
    await within(dialog).findByText('Tenant 0');

    await user.type(within(dialog).getByLabelText('Search Rent Plans'), '0772236357');
    await waitFor(
      () => expect(callsTo('tops_shortfall_detail').some((a) => a.p_search === '0772236357')).toBe(true),
      { timeout: 3000 },
    );
    const searched = callsTo('tops_shortfall_detail').filter((a) => a.p_search === '0772236357');
    expect(searched.every((a) => a.p_offset === 0)).toBe(true);
    // not one request per keystroke
    expect(callsTo('tops_shortfall_detail').filter((a) => typeof a.p_search === 'string').length).toBeLessThanOrEqual(2);
  });

  it('pages through the server result', async () => {
    const user = userEvent.setup();
    const dialog = await openAgent(user);
    await within(dialog).findByText('Tenant 0');

    await user.click(within(dialog).getByRole('button', { name: /next/i }));
    await waitFor(() => expect(callsTo('tops_shortfall_detail').some((a) => a.p_group === 'agent' && a.p_offset === 25)).toBe(true));
    expect(await within(dialog).findByText(/Page 2 of 10/)).toBeInTheDocument();
  });

  it('flips the sort direction on the server', async () => {
    const user = userEvent.setup();
    const dialog = await openAgent(user);
    await within(dialog).findByText('Tenant 0');

    await user.click(within(dialog).getByRole('button', { name: /sorted high to low/i }));
    await waitFor(() => expect(callsTo('tops_shortfall_detail').some((a) => a.p_group === 'agent' && a.p_dir === 'asc')).toBe(true));
  });

  it('exports every matching Rent Plan, not just the visible page', async () => {
    const user = userEvent.setup();
    const dialog = await openAgent(user);
    await within(dialog).findByText('Tenant 0');

    await user.click(within(dialog).getByRole('button', { name: /export csv/i }));
    await waitFor(() => expect(downloadCsvMock).toHaveBeenCalledTimes(1));

    const [filename, headers, rows] = downloadCsvMock.mock.calls[0] as [string, string[], unknown[][]];
    expect(filename).toMatch(/^Welile_Shortfall_Agent_Agent-One_\d{8}-\d{8}\.csv$/);
    expect(headers).toContain('Short (UGX)');
    expect(headers).toContain('Behind');
    expect(rows).toHaveLength(230);
    // 230 rows at 200 per page = two export calls on top of the visible page
    expect(callsTo('tops_shortfall_detail').filter((a) => a.p_limit === 200).map((a) => a.p_offset)).toEqual([0, 200]);
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('230'));
    // first row carries the server-built label
    expect(rows[0]).toContain('3 days');
  });

  it('reports an export failure instead of failing silently', async () => {
    const user = userEvent.setup();
    const dialog = await openAgent(user);
    await within(dialog).findByText('Tenant 0');

    const base = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation((fn: string, args: RpcArgs) =>
      fn === 'tops_shortfall_detail' && args.p_limit === 200
        ? Promise.resolve({ data: null, error: new Error('boom') })
        : base(fn, args));
    await user.click(within(dialog).getByRole('button', { name: /export csv/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('boom'));
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });
});
