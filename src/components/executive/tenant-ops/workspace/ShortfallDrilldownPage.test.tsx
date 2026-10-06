import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { parseISO } from 'date-fns';
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
import { resolveRange } from '@/components/executive/shared/OpsDateRangeFilter';
import { SHORTFALL_BREAKDOWN_RPC, SHORTFALL_DETAIL_RPC } from '@/hooks/tenantOpsWorkspace/shortfallRpcNames';

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
    if (fn === SHORTFALL_BREAKDOWN_RPC) {
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
    if (fn === SHORTFALL_DETAIL_RPC) {
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

function LocationProbe() {
  const { search } = useLocation();
  return <div data-testid="url-search">{search}</div>;
}

function wrapperAt(url: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <LocationProbe />
          {children}
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}
const wrapper = wrapperAt('/executive-hub?tab=tenant-ops&view=collection-shortfall');

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
    const breakdown = callsTo(SHORTFALL_BREAKDOWN_RPC)[0];
    const totals = callsTo(SHORTFALL_DETAIL_RPC)[0];
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
    expect(callsTo(SHORTFALL_BREAKDOWN_RPC).some((a) => a.p_group === 'agent')).toBe(true);

    await user.click(screen.getByRole('tab', { name: 'Service centres' }));
    expect((await screen.findAllByText('No service centre')).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('tab', { name: 'Districts' }));
    expect((await screen.findAllByText('Wakiso')).length).toBeGreaterThan(0);
    const area = callsTo(SHORTFALL_BREAKDOWN_RPC).find((a) => a.p_group === 'area');
    expect(area?.p_area_level).toBe('district');

    await user.click(screen.getByRole('tab', { name: 'Ageing' }));
    expect((await screen.findAllByText('Not scheduled')).length).toBeGreaterThan(0);
    expect(callsTo(SHORTFALL_BREAKDOWN_RPC).some((a) => a.p_group === 'ageing')).toBe(true);
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
    const call = callsTo(SHORTFALL_DETAIL_RPC).find((a) => a.p_group === 'agent');
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
      () => expect(callsTo(SHORTFALL_DETAIL_RPC).some((a) => a.p_search === '0772236357')).toBe(true),
      { timeout: 3000 },
    );
    const searched = callsTo(SHORTFALL_DETAIL_RPC).filter((a) => a.p_search === '0772236357');
    expect(searched.every((a) => a.p_offset === 0)).toBe(true);
    // not one request per keystroke
    expect(callsTo(SHORTFALL_DETAIL_RPC).filter((a) => typeof a.p_search === 'string').length).toBeLessThanOrEqual(2);
  });

  it('pages through the server result', async () => {
    const user = userEvent.setup();
    const dialog = await openAgent(user);
    await within(dialog).findByText('Tenant 0');

    await user.click(within(dialog).getByRole('button', { name: /next/i }));
    await waitFor(() => expect(callsTo(SHORTFALL_DETAIL_RPC).some((a) => a.p_group === 'agent' && a.p_offset === 25)).toBe(true));
    expect(await within(dialog).findByText(/Page 2 of 10/)).toBeInTheDocument();
  });

  it('flips the sort direction on the server', async () => {
    const user = userEvent.setup();
    const dialog = await openAgent(user);
    await within(dialog).findByText('Tenant 0');

    await user.click(within(dialog).getByRole('button', { name: /sorted high to low/i }));
    await waitFor(() => expect(callsTo(SHORTFALL_DETAIL_RPC).some((a) => a.p_group === 'agent' && a.p_dir === 'asc')).toBe(true));
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
    expect(callsTo(SHORTFALL_DETAIL_RPC).filter((a) => a.p_limit === 200).map((a) => a.p_offset)).toEqual([0, 200]);
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
      fn === SHORTFALL_DETAIL_RPC && args.p_limit === 200
        ? Promise.resolve({ data: null, error: new Error('boom') })
        : base(fn, args));
    await user.click(within(dialog).getByRole('button', { name: /export csv/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('boom'));
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });
});


describe('ShortfallDrilldownPage — range carried in the URL', () => {
  beforeEach(() => vi.clearAllMocks());

  const homeCall = () => callsTo('ops_tenant_ops_home_range')[0];

  it('opens on the preset named in sf_range, using the same range Tenant Ops Home resolves', async () => {
    install({ home: { expected: 1000, collected: 400 }, totalCount: 1, totalShort: 600 });
    render(<ShortfallDrilldownPage />, { wrapper: wrapperAt('/?view=collection-shortfall&sf_range=five') });
    await screen.findAllByText('Atimango Joyce');
    const five = resolveRange('five');
    expect(homeCall().p_start).toBe(five.start.toISOString());
    expect(homeCall().p_end).toBe(five.end.toISOString());
    expect(callsTo(SHORTFALL_BREAKDOWN_RPC)[0].p_start).toBe(five.start.toISOString());
    expect(screen.getByText(/in the last 5 days/)).toBeInTheDocument();
  });

  it('opens on a custom range from sf_from / sf_to (a "7 days" window)', async () => {
    install({ home: { expected: 1000, collected: 400 }, totalCount: 1, totalShort: 600 });
    render(<ShortfallDrilldownPage />, {
      wrapper: wrapperAt('/?view=collection-shortfall&sf_range=custom&sf_from=2026-09-29&sf_to=2026-10-05'),
    });
    await screen.findAllByText('Atimango Joyce');
    const custom = resolveRange('custom', { from: parseISO('2026-09-29'), to: parseISO('2026-10-05') });
    expect(homeCall().p_start).toBe(custom.start.toISOString());
    expect(homeCall().p_end).toBe(custom.end.toISOString());
    expect(callsTo(SHORTFALL_DETAIL_RPC)[0].p_start).toBe(custom.start.toISOString());
    expect(callsTo(SHORTFALL_DETAIL_RPC)[0].p_end).toBe(custom.end.toISOString());
  });

  it.each([
    ['missing', '/?view=collection-shortfall'],
    ['unknown preset', '/?view=collection-shortfall&sf_range=forever'],
    ['custom with no usable date', '/?view=collection-shortfall&sf_range=custom&sf_from=not-a-date'],
  ])('falls back to Today when sf_range is %s', async (_label, url) => {
    install({ home: { expected: 1000, collected: 400 }, totalCount: 1, totalShort: 600 });
    render(<ShortfallDrilldownPage />, { wrapper: wrapperAt(url) });
    await screen.findAllByText('Atimango Joyce');
    const today = resolveRange('today');
    expect(homeCall().p_start).toBe(today.start.toISOString());
  });

  it('writes a changed range back to the URL without losing the other parameters', async () => {
    install({ home: { expected: 1000, collected: 400 }, totalCount: 1, totalShort: 600 });
    const user = userEvent.setup();
    render(<ShortfallDrilldownPage />, { wrapper: wrapperAt('/executive-hub?tab=tenant-ops&view=collection-shortfall&sf_range=today') });
    await screen.findAllByText('Atimango Joyce');

    // desktop pill buttons are in the DOM alongside the mobile dropdown
    await user.click(screen.getAllByRole('button', { name: 'Yesterday' })[0]);
    await waitFor(() => expect(screen.getByTestId('url-search').textContent).toContain('sf_range=yesterday'));
    const search = screen.getByTestId('url-search').textContent ?? '';
    expect(search).toContain('tab=tenant-ops');
    expect(search).toContain('view=collection-shortfall');
    expect(search).not.toContain('sf_range=today');
    const yesterday = resolveRange('yesterday');
    await waitFor(() => expect(callsTo('ops_tenant_ops_home_range').some((a) => a.p_start === yesterday.start.toISOString())).toBe(true));
  });
});

describe('ShortfallDrilldownPage — follow-ups', () => {
  beforeEach(() => vi.clearAllMocks());

  const latestRow = (id: string, extra: Record<string, unknown> = {}) => ({
    rent_request_id: id, followup_id: `f-${id}`, outcome: 'reached_will_pay',
    note: 'Says he will pay on Friday', promised_date: '2099-01-02',
    created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    actor_id: 'u-1', actor_name: 'Grace Namono', followup_count: 1, ...extra,
  });

  /** Opens Agent One's sheet with an extra RPC layer on top of the standard mock. */
  async function openAgentWith(
    user: ReturnType<typeof userEvent.setup>,
    extra: (fn: string, args: RpcArgs) => { data: unknown; error: unknown } | undefined,
  ) {
    install({ home: { expected: 1000, collected: 400 }, totalCount: 1, totalShort: 600 });
    const base = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation((fn: string, args: RpcArgs) => {
      const hit = extra(fn, args);
      return hit ? Promise.resolve(hit) : base(fn, args);
    });
    render(<ShortfallDrilldownPage />, { wrapper });
    await screen.findAllByText('Atimango Joyce');
    await user.click(screen.getByRole('tab', { name: 'Agents' }));
    await user.click(await screen.findByLabelText('Open Rent Plans for Agent One'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Tenant 0');
    return dialog;
  }

  it('gives every row a Call and a WhatsApp link for the tenant and for the agent', async () => {
    const user = userEvent.setup();
    const dialog = await openAgentWith(user, () => undefined);

    const tels = Array.from(dialog.querySelectorAll<HTMLAnchorElement>('a[href^="tel:"]')).map((a) => a.getAttribute('href'));
    expect(tels.slice(0, 2)).toEqual(['tel:+256772236357', 'tel:+256757229748']);   // tenant, then agent
    expect(dialog.querySelectorAll('a[href^="https://wa.me/256772236357"]').length).toBeGreaterThan(0);
    expect(dialog.querySelectorAll('a[href^="https://wa.me/256757229748"]').length).toBeGreaterThan(0);
  });

  it('shows the latest follow-up on its row and "Not followed up yet" on the others', async () => {
    const user = userEvent.setup();
    const dialog = await openAgentWith(user, (fn) =>
      fn === 'tops_shortfall_followups_latest' ? { data: [latestRow('rr-0')], error: null } : undefined);

    const line = await within(dialog).findByTestId('latest-followup');
    expect(line).toHaveTextContent('Followed up 2h ago: will pay Fri 2 Jan');
    expect(line).toHaveTextContent('Says he will pay on Friday');
    expect(line).toHaveTextContent('Grace Namono');
    expect(within(dialog).getAllByText('Not followed up yet').length).toBeGreaterThan(0);
  });

  it('flags a promise whose date has passed', async () => {
    const user = userEvent.setup();
    const dialog = await openAgentWith(user, (fn) =>
      fn === 'tops_shortfall_followups_latest' ? { data: [latestRow('rr-0', { promised_date: '2020-01-02' })], error: null } : undefined);
    expect(await within(dialog).findByText(/promise date passed/)).toBeInTheDocument();
  });

  it('records a follow-up: the note needs 10 characters, the date only shows for "will pay"', async () => {
    const user = userEvent.setup();
    const dialog = await openAgentWith(user, (fn) =>
      fn === 'tops_record_shortfall_followup' ? { data: { id: 'new' }, error: null } : undefined);

    await user.click(within(dialog).getAllByRole('button', { name: /mark followed up/i })[0]);
    const form = await screen.findByRole('dialog', { name: /mark followed up/i });
    const save = within(form).getByRole('button', { name: /save follow-up/i });
    expect(save).toBeDisabled();

    await user.click(within(form).getByLabelText(/no answer/i));
    expect(within(form).queryByLabelText(/promised payment date/i)).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText('Note'), 'too short');
    expect(save).toBeDisabled();

    await user.click(within(form).getByLabelText(/reached, will pay/i));
    const date = within(form).getByLabelText(/promised payment date/i);
    await user.type(date, '2099-01-02');
    await user.clear(within(form).getByLabelText('Note'));
    await user.type(within(form).getByLabelText('Note'), 'Will pay on Friday morning');
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(callsTo('tops_record_shortfall_followup')).toHaveLength(1));
    expect(callsTo('tops_record_shortfall_followup')[0]).toEqual({
      p_rent_request_id: 'rr-0', p_outcome: 'reached_will_pay', p_note: 'Will pay on Friday morning', p_promised_date: '2099-01-02',
    });
    expect(toastSuccess).toHaveBeenCalledWith('Follow-up saved');
  });

  it('keeps the form open and shows the server message when saving fails', async () => {
    const user = userEvent.setup();
    const dialog = await openAgentWith(user, (fn) =>
      fn === 'tops_record_shortfall_followup' ? { data: null, error: { message: 'not authorized' } } : undefined);

    await user.click(within(dialog).getAllByRole('button', { name: /mark followed up/i })[0]);
    const form = await screen.findByRole('dialog', { name: /mark followed up/i });
    await user.click(within(form).getByLabelText(/no answer/i));
    await user.type(within(form).getByLabelText('Note'), 'Phone rang out twice');
    await user.click(within(form).getByRole('button', { name: /save follow-up/i }));

    expect(await within(form).findByRole('alert')).toHaveTextContent('not authorized');
    expect(screen.getByRole('dialog', { name: /mark followed up/i })).toBeInTheDocument();
  });

  it('filters on the server: nothing extra is sent for All, p_followup for the rest, and paging resets', async () => {
    const user = userEvent.setup();
    const dialog = await openAgentWith(user, () => undefined);
    expect(callsTo(SHORTFALL_DETAIL_RPC).filter((a) => a.p_group === 'agent').every((a) => !('p_followup' in a))).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: /next/i }));
    await within(dialog).findByText(/Page 2 of/);
    await user.click(within(dialog).getByRole('button', { name: 'Promised to pay' }));
    await waitFor(() => expect(callsTo(SHORTFALL_DETAIL_RPC).some((a) => a.p_followup === 'promised' && a.p_offset === 0)).toBe(true));

    await user.click(within(dialog).getByRole('button', { name: 'Not followed up' }));
    await waitFor(() => expect(callsTo(SHORTFALL_DETAIL_RPC).some((a) => a.p_followup === 'not_followed_up')).toBe(true));
    await user.click(within(dialog).getByRole('button', { name: 'Promise date passed' }));
    await waitFor(() => expect(callsTo(SHORTFALL_DETAIL_RPC).some((a) => a.p_followup === 'promise_passed')).toBe(true));
    await user.click(within(dialog).getByRole('button', { name: 'All' }));
    expect(within(dialog).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('adds the follow-up columns to the CSV export', async () => {
    const user = userEvent.setup();
    const dialog = await openAgentWith(user, (fn, args) => {
      if (fn !== 'tops_shortfall_followups_latest') return undefined;
      const ids = args.p_rent_request_ids as string[];
      return { data: ids.includes('rr-0') ? [latestRow('rr-0')] : [], error: null };
    });

    await user.click(within(dialog).getByRole('button', { name: /export csv/i }));
    await waitFor(() => expect(downloadCsvMock).toHaveBeenCalledTimes(1));
    const [, headers, rows] = downloadCsvMock.mock.calls[0] as [string, string[], unknown[][]];
    expect(headers.slice(-6)).toEqual([
      'Last follow-up', 'Follow-up outcome', 'Follow-up note', 'Promised date', 'Followed up by', 'Follow-ups logged',
    ]);
    const first = rows.find((r) => r[headers.indexOf('Rent Plan ID')] === 'rr-0')!;
    expect(first.slice(-5)).toEqual(['Reached, will pay', 'Says he will pay on Friday', '2099-01-02', 'Grace Namono', 1]);
    const other = rows.find((r) => r[headers.indexOf('Rent Plan ID')] === 'rr-5')!;
    expect(other.slice(-5)).toEqual(['Not followed up', '', '', '', 0]);
  });
});

describe('ShortfallDrilldownPage — trend', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the trend above the tabs without touching the header figures', async () => {
    install({ home: { expected: 1000000, collected: 400000 }, totalCount: 397, totalShort: 600000 });
    const base = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation((fn: string, args: RpcArgs) =>
      fn === 'tops_shortfall_daily_trend'
        ? Promise.resolve({ data: [{ day: '2026-10-05', expected_ugx: '1000000', collected_ugx: '100000', short_ugx: '900000', short_plans: 12, covered_pct: '10.0' }], error: null })
        : base(fn, args));
    render(<ShortfallDrilldownPage />, { wrapper });

    expect(await screen.findByText('Is the shortfall improving?')).toBeInTheDocument();
    const table = await screen.findByTestId('shortfall-trend-data');
    expect(table).toHaveTextContent('900,000');                         // the trend's own figure
    expect(screen.getByText('397')).toBeInTheDocument();                // header unchanged
    expect(screen.getByText(/600,000/)).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(callsTo('tops_shortfall_daily_trend')[0]).toEqual({ p_days: 30 });
    // the trend reads no shortfall list RPC of its own
    expect(callsTo(SHORTFALL_DETAIL_RPC).every((a) => a.p_limit === 1 || a.p_limit === 25 || a.p_limit === 200)).toBe(true);
  });
});
