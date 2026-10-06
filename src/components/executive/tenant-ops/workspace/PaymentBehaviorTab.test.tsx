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

function install() {
  rpcMock.mockImplementation((fn: string, args: Args) => {
    const ok = (data: unknown) => Promise.resolve({ data, error: null });
    switch (fn) {
      case 'tops_payment_behaviour_options':
        return ok({ agents: [{ id: 'agent-1', name: 'SHAFEEQ SSENABULYA' }], regions: ['Central', 'Western'], districts: [{ region: 'Central', district: 'Wakiso' }], cadences: ['daily', 'weekly'] });
      case 'tops_payment_behaviour_overview': return ok(overviewFixture);
      case 'tops_payment_behaviour_summary': return ok(overviewFixture.summary);
      case 'tops_payment_behaviour_trend': return ok(trendFixture);
      case 'tops_payment_behaviour_timing': return ok(timingFixture);
      case 'tops_payment_behaviour_by': return ok({ dimension: args.p_dimension, rows: byDimensionFixture[args.p_dimension as keyof typeof byDimensionFixture] });
      case 'tops_payment_behaviour_watchlist': return ok(watchlistFixture);
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
  beforeEach(() => { vi.clearAllMocks(); install(); });

  it('leads with the share of paying tenants who paid themselves, straight from the server', async () => {
    render(<PaymentBehaviorTab />, { wrapper });
    expect(await screen.findByText('5.1%')).toBeInTheDocument();
    expect(screen.getByTestId('headline-self-pct')).toHaveTextContent('5.1%');
    expect(screen.getAllByText(/38/).length).toBeGreaterThan(0);
    expect(screen.getByText('+4.7 pts vs the previous 30 days (0.4%)')).toBeInTheDocument();
    expect(screen.getAllByText('Observed').length).toBeGreaterThan(0);
  });

  it('opens on this month by default and sends one date range and no filters to every read', async () => {
    render(<PaymentBehaviorTab />, { wrapper });
    await screen.findByText('5.1%');
    for (const fn of ['tops_payment_behaviour_overview', 'tops_payment_behaviour_trend', 'tops_payment_behaviour_timing']) {
      const a = callsTo(fn)[0];
      expect(a).toMatchObject({ p_agent_id: null, p_region: null, p_district: null, p_cadence: null });
      expect(typeof a.p_start).toBe('string');
    }
    expect(callsTo('tops_payment_behaviour_overview')[0].p_start).toBe(callsTo('tops_payment_behaviour_trend')[0].p_start);
  });

  it('opens on the range named in the URL (pb_range / pb_from / pb_to)', async () => {
    render(<PaymentBehaviorTab />, { wrapper: wrapperAt('/executive-hub?pb_range=custom&pb_from=2026-09-29&pb_to=2026-10-05') });
    await screen.findByText('5.1%');
    const a = callsTo('tops_payment_behaviour_overview')[0];
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
    expect(callsTo('tops_payment_behaviour_watchlist')[0]).toMatchObject({ p_min_score: 2, p_limit: 20, p_offset: 0 });
  });

  it('narrows every section when a breakdown row is focused', async () => {
    const user = userEvent.setup();
    render(<PaymentBehaviorTab />, { wrapper });
    await screen.findByText('5.1%');
    await user.click(screen.getByRole('tab', { name: 'Breakdowns' }));
    expect(callsTo('tops_payment_behaviour_by').some((a) => a.p_dimension === 'agent')).toBe(true);

    const focus = (await screen.findAllByRole('button', { name: /Focus on SHAFEEQ SSENABULYA/ }))[0];
    await user.click(focus);
    await waitFor(() => expect(callsTo('tops_payment_behaviour_overview').some((a) => a.p_agent_id === 'agent-1')).toBe(true));
    expect(callsTo('tops_payment_behaviour_trend').some((a) => a.p_agent_id === 'agent-1')).toBe(true);
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
    expect(meta.periodLabel).toMatch(/ to /);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Report ready', expect.anything()));
  });

  it('shows a readable message when the data cannot load', async () => {
    rpcMock.mockImplementation((fn: string) => Promise.resolve(fn === 'tops_payment_behaviour_overview'
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
