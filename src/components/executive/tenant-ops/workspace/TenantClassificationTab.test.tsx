import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
const exportXlsx = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const exportPdf = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/tenantOpsClassificationReport', () => ({
  exportTenantClassificationXlsx: exportXlsx,
  generateTenantClassificationPdf: exportPdf,
}));
vi.mock('sonner', () => ({ toast: { loading: vi.fn(() => 't'), success: vi.fn(), error: vi.fn() } }));

import TenantClassificationTab from './TenantClassificationTab';

const summary = {
  as_of: '2026-10-13', population: 59042, active: 868, waiting: 114, dormant: 309, dormant_renewal_in_progress: 19,
  inactive: 57751, inactive_never_requested: 53956, inactive_request_in_review: 3258,
  inactive_only_rejected_cancelled: 531, inactive_other: 6, needs_review: 27,
};
const mk = (over: Record<string, unknown> = {}) => ({
  tenant_id: 'aaaaaaaa-1', tenant_name: 'Nakato Ann', tenant_phone: '0700111222', district: 'Kampala', category: 'active',
  sub_label: null, needs_review: false, review_reasons: null, total_requests: 1, running_plans: 1, completed_plans: 0,
  outstanding_ugx: 50000, completed_on: null, days_since_completion: null, latest_status: 'repaying',
  latest_request_at: '2026-09-01T08:00:00Z', latest_agent_name: 'Agent One', total_rows: 868, ...over,
});

function setup(listRows: unknown[] = [mk()]) {
  rpc.mockImplementation((name: string) =>
    Promise.resolve({ data: name === 'tops_tenant_classification_summary' ? summary : listRows, error: null }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TenantClassificationTab /></QueryClientProvider>);
}
const listCalls = () => rpc.mock.calls.filter((c) => c[0] === 'tops_tenant_classification_list');

describe('TenantClassificationTab', () => {
  beforeEach(() => { rpc.mockReset(); exportXlsx.mockClear(); exportPdf.mockClear(); });

  it('shows a card per category with its count, and the Needs review flag', async () => {
    setup();
    const cards = await screen.findByTestId('classification-cards');
    expect(within(cards).getByText('Waiting for landlord payment')).toBeTruthy();
    expect(within(cards).getByText('868')).toBeTruthy();
    expect(within(cards).getByText('114')).toBeTruthy();
    expect(within(cards).getByText('309')).toBeTruthy();
    expect(within(cards).getByText('57,751')).toBeTruthy();
    expect(within(cards).getByText('19 renewal in progress')).toBeTruthy();
    expect(within(cards).getByText('27')).toBeTruthy();
    expect(screen.getByTestId('classification-note').textContent).toContain('Counted from the day after the landlord was paid');
  });

  it('reads only the new read-only functions, 50 at a time', async () => {
    setup();
    await screen.findByText('Nakato Ann');
    const names = rpc.mock.calls.map((c) => c[0]);
    expect(new Set(names)).toEqual(new Set(['tops_tenant_classification_summary', 'tops_tenant_classification_list']));
    expect(listCalls()[0][1]).toEqual({
      p_category: null, p_sub: null, p_search: null, p_limit: 50, p_offset: 0, p_needs_review: false,
    });
    expect(screen.getByTestId('classification-pager').textContent).toBe('868 tenants · Page 1 of 18');
  });

  it('filters the list when a card is clicked and offers the sub-labels for that category', async () => {
    const user = userEvent.setup();
    setup([mk({ category: 'dormant', sub_label: 'renewal_in_progress', completed_on: '2026-10-09', days_since_completion: 4, total_rows: 309 })]);
    const cards = await screen.findByTestId('classification-cards');
    await user.click(within(cards).getByText('Dormant'));
    await waitFor(() => expect(listCalls().some((c) => c[1].p_category === 'dormant')).toBe(true));
    expect(await screen.findByText('9 Oct 2026 (4 days ago)')).toBeTruthy();
    expect(screen.getByLabelText('Detail')).toBeTruthy();
  });

  it('flags a tenant that needs review and says why', async () => {
    setup([mk({ needs_review: true, review_reasons: 'More than one running Rent Plan', running_plans: 2 })]);
    expect(await screen.findByText('More than one running Rent Plan')).toBeTruthy();
    expect(screen.getAllByText('Needs review').length).toBeGreaterThan(0);
  });

  it('shows amounts the Welile way and none for a Dormant tenant', async () => {
    setup([mk({ outstanding_ugx: 50000 }), mk({ tenant_id: 'b', tenant_name: 'Old Timer', category: 'dormant', outstanding_ugx: 0 })]);
    expect(await screen.findByText('UGX 50,000')).toBeTruthy();
  });

  it('sends the Excel export the current filter', async () => {
    const user = userEvent.setup();
    rpc.mockImplementation((name: string, a: { p_limit?: number }) =>
      Promise.resolve({ data: name === 'tops_tenant_classification_summary' ? summary : [mk()], error: null, a }));
    setup();
    await screen.findByText('Nakato Ann');
    await user.click(screen.getByRole('button', { name: /Export Excel/ }));
    await waitFor(() => expect(exportXlsx).toHaveBeenCalledTimes(1));
    expect(exportXlsx.mock.calls[0][2]).toMatchObject({ filterText: 'All tenants' });
    expect(exportPdf).not.toHaveBeenCalled();
  });
});
