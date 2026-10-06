import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpcMock(...a),
    from: () => ({ select: () => ({ in: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }),
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
vi.mock('@/lib/tenantOpsManagementOverviewReport', () => ({
  generateManagementOverviewPdf: vi.fn(),
  exportManagementOverviewXlsx: vi.fn(),
}));
vi.mock('@/components/executive/tenant-ops/workspace/TenantOpsQuickActions', () => ({
  TenantQuickActions: () => null,
  AgentQuickActions: () => null,
}));

import ManagementOverviewTab from './ManagementOverviewTab';

type Args = Record<string, unknown>;

const tenantRow = (i: number, over: Record<string, unknown> = {}) => ({
  tenant_id: `t-${i}`, rent_request_id: `rr-${i}`, tenant_name: `Tenant ${i}`, tenant_phone: '0700000000', district: 'Wakiso',
  rr_status: 'repaying', registration_type: null, agent_id: 'agent-1', agent_name: 'Agent One', agent_phone: null,
  rent_amount: 300000, total_amount: 1000000, daily_amount: 10000, amount_repaid: 400000, outstanding: 600000,
  expected_to_date: 500000, pct_covered: 40, term_start: '2026-09-01', term_end: '2026-12-09', term_days: 100,
  repayment_frequency: 'daily', is_live: true, last_payment_at: null, reached_on: null, days_after_cycle: 0,
  tier_key: 'not_eligible', increase_pct: 0, eligible: false, max_topup_amount: 0, max_accessible_rent: 0,
  amount_to_qualifying: 500000, amount_to_same_amount: 300000, days_left_in_cycle: 60, levels: [], ...over,
});

const period = {
  window: { start_day: '2026-10-01', end_day: '2026-10-06', asof: '2026-10-06', days: 6 },
  basis: 'Same rule as Tenant Ops Home',
  totals: {
    expected_ugx: 52450581, collected_ugx: 10109768, short_ugx: 42340813, coverage_pct: 19.3,
    paid_ahead_ugx: 5179918, paid_ahead_no_bill_ugx: 4486973, paid_ahead_above_bill_ugx: 692945, plans_billed: 700,
  },
  rows: [
    { agent_id: 'agent-1', agent_name: 'Agent One', expected_ugx: 2345000, collected_ugx: 750000, short_ugx: 1595000, coverage_pct: 37.5, plans_billed: 2, paid_ahead_ugx: 40000, paid_ahead_plans: 1 },
    { agent_id: 'agent-9', agent_name: 'Agent Nine', expected_ugx: 500000, collected_ugx: 100000, short_ugx: 400000, coverage_pct: 20, plans_billed: 1, paid_ahead_ugx: 0, paid_ahead_plans: 0 },
  ],
};

function install(opts: { total?: number; pageSize?: number; failLaterPages?: boolean } = {}) {
  const total = opts.total ?? 2;
  rpcMock.mockImplementation((fn: string, args: Args) => {
    const ok = (data: unknown) => Promise.resolve({ data, error: null });
    if (fn === 'get_tenant_topup_eligibility') {
      const offset = Number(args.p_offset ?? 0);
      const limit = Number(args.p_limit ?? 100);
      const rows = offset > 0 && opts.failLaterPages
        ? []
        : Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_v, k) => tenantRow(offset + k));
      return ok({ rules: { qualifying_pct: 90, same_amount_pct: 70, tiers: [] }, as_of: '2026-10-06', total, limit, offset, summary: {}, rows });
    }
    if (fn === 'get_agent_registration_control') {
      return ok({ as_of: '2026-10-06', rules: { enabled: true, min_active_tenants: 10, required_prev_month_pct: 70, groups: [] }, totals: {}, rows: [] });
    }
    if (fn === 'tops_agent_period_collection') return ok(period);
    return ok(null);
  });
}

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};
const calls = (fn: string) => rpcMock.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Args);

describe('ManagementOverviewTab: all-time versus period figures', () => {
  beforeEach(() => { vi.clearAllMocks(); install(); });

  it('labels every all-time figure as all time and shows the period figures separately', async () => {
    const user = userEvent.setup();
    render(<ManagementOverviewTab />, { wrapper });

    const summary = await screen.findByTestId('period-summary');
    await waitFor(() => expect(within(summary).getByText('UGX 52,450,581')).toBeInTheDocument());
    expect(within(summary).getByText('Expected this period')).toBeInTheDocument();
    expect(within(summary).getByText('UGX 10,109,768')).toBeInTheDocument();       // Collected this period, same as Home
    expect(within(summary).getByText('UGX 42,340,813')).toBeInTheDocument();       // Short this period
    expect(within(summary).getByText('UGX 5,179,918')).toBeInTheDocument();        // Paid ahead, separate
    expect(screen.getByText(/Outstanding \(whole plan\) in view/)).toBeInTheDocument();
    expect(screen.getByText(/Arrears to date in view/)).toBeInTheDocument();

    // Tenant table headers
    for (const label of ['Total expected (full cycle)', 'Total collected (all time)', 'Outstanding (whole plan)', 'Paid % (all time)', 'Left % (all time)', 'Arrears to date']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    // Agent table: period columns plus relabelled all-time columns
    await user.click(screen.getByRole('tab', { name: 'Agents' }));
    for (const label of ['Expected this period', 'Collected this period', 'Short this period', 'Portfolio % (all time)', 'Average tenant (all time)']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // The table and the phone cards are both in the page, so each figure appears more than once.
    expect((await screen.findAllByText('UGX 2,345,000')).length).toBeGreaterThan(0);  // Agent One, expected this period
    expect(screen.getAllByText('UGX 750,000').length).toBeGreaterThan(0);              // collected this period
    expect(screen.getAllByText('UGX 2,000,000').length).toBeGreaterThan(0);            // all-time total expected (2 plans of 1,000,000), kept apart
    expect(screen.getAllByText('+ UGX 40,000 paid ahead').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Agent Nine').length).toBeGreaterThan(0);               // billed in the period, no tenant row: still listed
  });

  it('asks for the period with the dates the picker resolves to, and without any agent filter', async () => {
    render(<ManagementOverviewTab />, { wrapper });
    await screen.findByTestId('period-summary');
    await waitFor(() => expect(calls('tops_agent_period_collection').length).toBeGreaterThan(0));
    const a = calls('tops_agent_period_collection')[0];
    expect(typeof a.p_start).toBe('string');
    expect(typeof a.p_end).toBe('string');
    expect(a.p_agent_id).toBeNull();
  });

  it('reads every page of the eligibility report, with no 5,000-row stop', async () => {
    install({ total: 5600 });
    render(<ManagementOverviewTab />, { wrapper });
    await waitFor(() => expect(screen.getByText('5600 of 5600')).toBeInTheDocument(), { timeout: 20000 });
    const offsets = calls('get_tenant_topup_eligibility').map((c) => c.p_offset);
    expect(offsets).toContain(5000);
    expect(offsets).toContain(5500);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  }, 30000);

  it('warns when fewer tenants were loaded than the report says exist', async () => {
    install({ total: 1100, failLaterPages: true });
    render(<ManagementOverviewTab />, { wrapper });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Only 500 of 1,100 tenants could be loaded');
  });

  it('keeps the all-time figures if the period report fails', async () => {
    const base = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation((fn: string, args: Args) => (
      fn === 'tops_agent_period_collection' ? Promise.resolve({ data: null, error: { message: 'boom' } }) : base(fn, args)
    ));
    render(<ManagementOverviewTab />, { wrapper });
    expect(await screen.findByText(/Period figures could not be loaded right now/)).toBeInTheDocument();
    expect(screen.getByText(/Tenants in view/)).toBeInTheDocument();
  });

  it('never uses the words loan, lender, ROI or interest', async () => {
    const { container } = render(<ManagementOverviewTab />, { wrapper });
    await screen.findByTestId('period-summary');
    expect(container.textContent).not.toMatch(/\b(loan|lender|ROI|interest)\b/i);
  });
});
