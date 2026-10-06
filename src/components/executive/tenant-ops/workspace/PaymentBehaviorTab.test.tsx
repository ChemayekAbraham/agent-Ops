import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

const pdfMock = vi.fn();
vi.mock('@/lib/tenantPaymentBehaviorPdf', () => ({ generatePaymentBehaviorPdf: (...a: unknown[]) => pdfMock(...a) }));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastLoading = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a), loading: (...a: unknown[]) => toastLoading(...a) } }));

import PaymentBehaviorTab from './PaymentBehaviorTab';
import {
  byDimensionFixture, overviewFixture, timingFixture, trendFixture, watchlistFixture,
} from './payment-behavior/paymentBehavior.fixtures';

type Args = Record<string, unknown>;

// What Tenant Ops Home would report for the same dates. Defaults agree with the fixture's billed and counted money.
const HOME_MATCHING = { expected: 227715911, collected: 88191948 };
let homeFigures = { ...HOME_MATCHING };

function install() {
  rpcMock.mockImplementation((fn: string, args: Args) => {
    const ok = (data: unknown) => Promise.resolve({ data, error: null });
    switch (fn) {
      case 'ops_tenant_ops_home_range': return ok({ ...homeFigures });
      case 'tops_payment_behaviour_options':
        return ok({ agents: [{ id: 'agent-1', name: 'SHAFEEQ SSENABULYA' }], regions: ['Central', 'Western'], districts: [{ region: 'Central', district: 'Wakiso' }], cadences: ['daily', 'weekly'] });
      case 'tops_payment_behaviour_overview_v2': return ok(overviewFixture);
      case 'tops_payment_behaviour_summary_v2': return ok(overviewFixture.summary);
      case 'tops_payment_behaviour_trend_v2': return ok(trendFixture);
      case 'tops_payment_behaviour_timing_v2': return ok(timingFixture);
      case 'tops_payment_behaviour_by_v2': return ok({ dimension: args.p_dimension, rows: byDimensionFixture[args.p_dimension as keyof typeof byDimensionFixture] });
      case 'tops_payment_behaviour_watchlist_v2': return ok(watchlistFixture);
      default: return ok(null);
    }
  });
}

function wrapperAt(url: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}
const wrapper = wrapperAt('/executive-hub?tab=tenant-ops&view=tenant-operations-workspace');
const callsTo = (fn: string) => rpcMock.mock.calls.filter((c) => c[0] === fn).map((c) => c[1] as Args);

describe('PaymentBehaviorTab', () => {
  beforeEach(() => { vi.clearAllMocks(); homeFigures = { ...HOME_MATCHING }; install(); });

  it('leads with the share of paying tenants who paid themselves, straight from the server', async () => {
    render(<PaymentBehaviorTab />, { wrapper });
    expect(await screen.findByText('5.1%')).toBeInTheDocument();
    expect(screen.getByTestId('headline-self-pct')).toHaveTextContent('5.1%');
    expect(screen.getAllByText(/38/).length).toBeGreaterThan(0);
    expect(screen.getByText('+4.7 pts vs the previous 30 days (0.4%)')).toBeInTheDocument();
    expect(screen.getAllByText('Observed').length).toBeGreaterThan(0);
  });

  it('shows the counted money like Home, with paid ahead as a quiet line underneath', async () => {
    render(<PaymentBehaviorTab />, { wrapper });
    await screen.findByText('5.1%');
    expect(screen.getByTestId('paid-ahead-note')).toHaveTextContent(
      'Paid ahead / above the bill: UGX 56,356,078 (1,333 payments). Not counted as collected, same as Home.',
    );
    expect(screen.getAllByText('UGX 1,757,731').length).toBeGreaterThan(0);   // self, counted
    expect(screen.getAllByText('UGX 86,389,448').length).toBeGreaterThan(0);  // agents, counted
  });

  it('opens on this month by default and sends one date range and no filters to every read', async () => {
    render(<PaymentBehaviorTab />, { wrapper });
    await screen.findByText('5.1%');
    for (const fn of ['tops_payment_behaviour_overview_v2', 'tops_payment_behaviour_trend_v2', 'tops_payment_behaviour_timing_v2']) {
      const a = callsTo(fn)[0];
      expect(a).toMatchObject({ p_agent_id: null, p_region: null, p_district: null, p_cadence: null });
      expect(typeof a.p_start).toBe('string');
    }
    expect(callsTo('tops_payment_behaviour_overview_v2')[0].p_start).toBe(callsTo('tops_payment_behaviour_trend_v2')[0].p_start);
  });

  it('opens on the range named in the URL (pb_range / pb_from / pb_to)', async () => {
    render(<PaymentBehaviorTab />, { wrapper: wrapperAt('/executive-hub?pb_range=custom&pb_from=2026-09-29&pb_to=2026-10-05') });
    await screen.findByText('5.1%');
    const a = callsTo('tops_payment_behaviour_overview_v2')[0];
    expect(new Date(a.p_start as string).getDate()).toBe(29);
    expect(new Date(a.p_end as string).getDate()).toBe(5);
  });

  it('shows the other sections: trend with a labelled estimate, timeliness, segments, early warning', async () => {
    const user = userEvent.setup();
    render(<PaymentBehaviorTab />, { wrapper });
    await screen.findByText('5.1%');

    await user.click(screen.getByRole('tab', { name: 'Trends' }));
    expect(await screen.findByText('Where self-pay may be heading')).toBeInTheDocument();
    expect(screen.getByText('Estimate')).toBeInTheDocument();
    expect(screen.getByText(/Low confidence/)).toBeInTheDocument();
    expect(screen.getByText('4.9%')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Timeliness' }));
    expect(await screen.findByText('On time versus late')).toBeInTheDocument();
    expect(screen.getAllByText('61.3%').length).toBeGreaterThan(0);
    expect(screen.getByText(/Day-by-day detail is partial/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Segments' }));
    expect(await screen.findByTestId('segment-self_reliant')).toHaveTextContent('12');
    expect(screen.getByText('Sandra Diana Amolo')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Early warning' }));
    expect(await screen.findByText('Ntege Dorothy')).toBeInTheDocument();
    expect(screen.getAllByText('Gone quiet').length).toBeGreaterThan(1);   // the sign's tile and this row's chip
    expect(callsTo('tops_payment_behaviour_watchlist_v2')[0]).toMatchObject({ p_min_score: 2, p_limit: 20, p_offset: 0 });
  });

  it('narrows every section when a breakdown row is focused', async () => {
    const user = userEvent.setup();
    render(<PaymentBehaviorTab />, { wrapper });
    await screen.findByText('5.1%');
    await user.click(screen.getByRole('tab', { name: 'Breakdowns' }));
    expect(callsTo('tops_payment_behaviour_by_v2').some((a) => a.p_dimension === 'agent')).toBe(true);

    const focus = (await screen.findAllByRole('button', { name: /Focus on SHAFEEQ SSENABULYA/ }))[0];
    await user.click(focus);
    await waitFor(() => expect(callsTo('tops_payment_behaviour_overview_v2').some((a) => a.p_agent_id === 'agent-1')).toBe(true));
    expect(callsTo('tops_payment_behaviour_trend_v2').some((a) => a.p_agent_id === 'agent-1')).toBe(true);
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /clear filters/i })).toBeDisabled());
  });

  it('builds the PDF from the same filters and reports the result', async () => {
    const user = userEvent.setup();
    pdfMock.mockResolvedValue(undefined);
    render(<PaymentBehaviorTab />, { wrapper });
    await screen.findByText('5.1%');
    await user.click(screen.getByRole('button', { name: /download pdf report/i }));
    await waitFor(() => expect(pdfMock).toHaveBeenCalledTimes(1));
    const [data, meta] = pdfMock.mock.calls[0] as [{ overview: unknown; byDimension: Record<string, unknown[]>; watchlist: unknown }, { filters: Record<string, unknown>; periodLabel: string }];
    expect(data.overview).toBeTruthy();
    expect(Object.keys(data.byDimension).sort()).toEqual(['agent', 'cadence', 'cohort', 'district', 'region', 'rent_band']);
    expect(meta.filters).toEqual({ agent: null, region: null, district: null, cadence: null });
    expect((meta as unknown as { homeCheck: { filtered: boolean; check: { status: string } } }).homeCheck).toMatchObject({ filtered: false, check: { status: 'match' } });
    expect(meta.periodLabel).toMatch(/ to /);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Report ready', expect.anything()));
  });

  it('shows a readable message when the data cannot load', async () => {
    rpcMock.mockImplementation((fn: string) => Promise.resolve(fn === 'tops_payment_behaviour_overview_v2'
      ? { data: null, error: { message: 'not authorized' } } : { data: null, error: null }));
    render(<PaymentBehaviorTab />, { wrapper });
    expect(await screen.findByText('Could not load Tenant Payment Behavior')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download pdf report/i })).toBeDisabled();
  });

  it('never uses the words loan, lender, ROI or interest', async () => {
    const user = userEvent.setup();
    const { container } = render(<PaymentBehaviorTab />, { wrapper });
    await screen.findByText('5.1%');
    for (const tab of ['Trends', 'Timeliness', 'Segments', 'Breakdowns', 'Early warning', 'Method']) {
      await user.click(screen.getByRole('tab', { name: tab }));
      await waitFor(() => expect(within(container).getAllByRole('tabpanel').length).toBeGreaterThan(0));
    }
    expect(container.textContent).not.toMatch(/\b(loan|lender|ROI|interest)\b/i);
  });
});

describe('PaymentBehaviorTab: check against Tenant Ops Home', () => {
  beforeEach(() => { vi.clearAllMocks(); homeFigures = { ...HOME_MATCHING }; install(); });

  it('reads Home for the same dates as the tab and says "Matches Home" when the figures agree', async () => {
    render(<PaymentBehaviorTab />, { wrapper });
    expect(await screen.findByText('Matches Home')).toBeInTheDocument();
    const strip = screen.getByTestId('home-check');
    expect(strip).toHaveAttribute('data-state', 'match');
    expect(within(strip).getAllByText('UGX 227,715,911')).toHaveLength(2);   // Expected on Home, billed on the tab
    expect(within(strip).getAllByText('UGX 88,191,948')).toHaveLength(2);    // Collected on Home, counted on the tab
    expect(within(strip).getAllByText('UGX 139,523,963')).toHaveLength(2);   // Short on both
    expect(within(strip).getByText('39%')).toBeInTheDocument();              // Home shows a whole number
    expect(within(strip).getByText('38.7%')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const home = callsTo('ops_tenant_ops_home_range')[0];
    const tab = callsTo('tops_payment_behaviour_overview_v2')[0];
    expect(home).toEqual({ p_start: tab.p_start, p_end: tab.p_end });
  });

  it('warns, and logs both sets of figures, when the tab differs from Home by more than UGX 1', async () => {
    homeFigures = { expected: 227715911, collected: 87191948 };   // Home shows UGX 1,000,000 less collected
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<PaymentBehaviorTab />, { wrapper });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('These figures differ from Tenant Ops Home by UGX 1,000,000. Home is the reference.');
    expect(screen.getByTestId('home-check')).toHaveAttribute('data-state', 'differ');
    expect(screen.queryByText('Matches Home')).not.toBeInTheDocument();
    // Both sides were read again once before the warning was trusted.
    expect(callsTo('ops_tenant_ops_home_range').length).toBeGreaterThanOrEqual(2);
    expect(callsTo('tops_payment_behaviour_overview_v2').length).toBeGreaterThanOrEqual(2);

    await waitFor(() => expect(warn).toHaveBeenCalled());
    const [label, detail] = warn.mock.calls.find((c) => String(c[0]).includes('differ from Tenant Ops Home'))! as [string, { home: { collected: number }; tab: { collected: number } }];
    expect(label).toContain('Home is the reference');
    expect(detail.home.collected).toBe(87191948);
    expect(detail.tab.collected).toBe(88191948);
    warn.mockRestore();
  });

  it('puts the check in the PDF with its status', async () => {
    homeFigures = { expected: 227715911, collected: 87191948 };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    pdfMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PaymentBehaviorTab />, { wrapper });
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: /download pdf report/i }));
    await waitFor(() => expect(pdfMock).toHaveBeenCalledTimes(1));
    const meta = pdfMock.mock.calls[0][1] as { homeCheck: { filtered: boolean; check: { status: string; maxUgxDiff: number } } };
    expect(meta.homeCheck.filtered).toBe(false);
    expect(meta.homeCheck.check).toMatchObject({ status: 'differ', maxUgxDiff: 1000000 });
  });

  it('replaces the strip with a plain explanation when a filter is on, and stops asking Home', async () => {
    const user = userEvent.setup();
    render(<PaymentBehaviorTab />, { wrapper });
    await screen.findByText('Matches Home');
    await user.click(screen.getByRole('tab', { name: 'Breakdowns' }));
    await user.click((await screen.findAllByRole('button', { name: /Focus on SHAFEEQ SSENABULYA/ }))[0]);
    await user.click(screen.getByRole('tab', { name: 'Overview' }));

    const strip = await screen.findByTestId('home-check');
    await waitFor(() => expect(strip).toHaveAttribute('data-state', 'filtered'));
    expect(strip).toHaveTextContent("Filtered view: Home figures cover all tenants and can't be compared.");
    expect(strip).not.toHaveTextContent('no recorded location');   // an agent filter alone does not drop tenants
    expect(screen.queryByText('Matches Home')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains that region and district filters leave out tenants with no recorded location', async () => {
    const user = userEvent.setup();
    render(<PaymentBehaviorTab />, { wrapper });
    await screen.findByText('Matches Home');
    await user.click(screen.getByRole('tab', { name: 'Breakdowns' }));
    await user.click(screen.getByRole('tab', { name: 'Region' }));
    await user.click((await screen.findAllByRole('button', { name: /Focus on Central/ }))[0]);
    await user.click(screen.getByRole('tab', { name: 'Overview' }));

    const strip = await screen.findByTestId('home-check');
    await waitFor(() => expect(strip).toHaveAttribute('data-state', 'filtered'));
    expect(strip).toHaveTextContent("Filtered view: Home figures cover all tenants and can't be compared.");
    expect(strip).toHaveTextContent('Region and district filters leave out tenants with no recorded location');
  });
});
