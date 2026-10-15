import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fs from 'node:fs';
import path from 'node:path';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

import { LandlordPaidListPanel } from '../LandlordPaidListPanel';
import { useLandlordPaidListCounts } from '@/hooks/useLandlordPaidLists';
import type { PaidListRow } from '@/lib/landlordPaidLists';

const row = (over: Partial<PaidListRow> = {}): PaidListRow => ({
  landlord_id: 'll-1', landlord_name: 'Mr Okello', landlord_phone: '0772000111', mobile_money_number: null, district: 'Kampala', village: 'Kisaasi', property_address: 'Plot 4',
  verified: true, verification_status: 'verified', plans_total: 4, repaying_plans: 2, completed_plans: 1, active_plans: 2, tenant_count: 3, total_rent: 1500000, total_repaid: 600000,
  balance_left: 950000, received_amount: 1200000, last_paid_at: '2026-09-01T00:00:00Z', agent_name: 'Joy Namukasa', agent_phone: '0701000000', ...over,
});
const response = (rows: PaidListRow[], total = rows.length, tab = 'paid_repaying') => ({ tab, search: null, limit: 20, offset: 0, total, counts: { paid_repaying: 590, completed: 267 }, rows });

const renderPanel = (props: Partial<React.ComponentProps<typeof LandlordPaidListPanel>> = {}) => {
  const onEdit = vi.fn(); const onPageChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LandlordPaidListPanel tab="paid_repaying" search="" page={1} onPageChange={onPageChange} onEdit={onEdit} renderReview={(r) => <div>review body for {r.landlord_name}</div>} {...props} />
    </QueryClientProvider>,
  );
  return { onEdit, onPageChange };
};

beforeEach(() => { rpcMock.mockReset(); });

describe('LandlordPaidListPanel', () => {
  it('loads the tab from landlord_ops_paid_lists with the search and the page', async () => {
    rpcMock.mockResolvedValue({ data: response([row()]), error: null });
    renderPanel({ tab: 'completed', search: ' okello ', page: 3 });
    await screen.findByText('Mr Okello');
    expect(rpcMock).toHaveBeenCalledWith('landlord_ops_paid_lists', { p_tab: 'completed', p_search: 'okello', p_limit: 20, p_offset: 40 });
  });

  it('shows the landlord, tenant count, total rent, total repaid, balance left and the agent, with call buttons', async () => {
    rpcMock.mockResolvedValue({ data: response([row()]), error: null });
    renderPanel();
    const card = within(await screen.findByTestId('paid-list-row'));
    expect(card.getByText('Mr Okello')).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Call Mr Okello on 0772000111/ })).toHaveAttribute('href', 'tel:+256772000111');
    expect(card.getByText('Tenants')).toBeInTheDocument();
    expect(card.getByText('3')).toBeInTheDocument();
    for (const t of ['UGX 1,500,000', 'UGX 600,000', 'UGX 950,000']) expect(card.getByText(t)).toBeInTheDocument();
    for (const l of ['Total rent', 'Total repaid', 'Balance left']) expect(card.getByText(l)).toBeInTheDocument();
    expect(card.getByText('Joy Namukasa')).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Call Joy Namukasa on 0701000000/ })).toHaveAttribute('href', 'tel:+256701000000');
    expect(card.getByText('Verified')).toBeInTheDocument();
  });

  it('has Review and Edit; Review opens the review body (and closes it again); Edit hands the row to the page', async () => {
    rpcMock.mockResolvedValue({ data: response([row()]), error: null });
    const { onEdit } = renderPanel();
    await screen.findByText('Mr Okello');
    expect(screen.queryByText(/review body for/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('review body for Mr Okello')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(/review body for/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ landlord_id: 'll-1' }));
  });

  it('flags a landlord who is not verified yet', async () => {
    rpcMock.mockResolvedValue({ data: response([row({ verified: false })]), error: null });
    renderPanel();
    expect(await screen.findByText('Not Verified')).toBeInTheDocument();
  });

  it('copes with a landlord with no phone and no agent', async () => {
    rpcMock.mockResolvedValue({ data: response([row({ landlord_phone: null, agent_name: null, agent_phone: null })]), error: null });
    renderPanel();
    expect(await screen.findByText('No agent on record')).toBeInTheDocument();
  });

  it('pages: shows the range and moves between pages through the page callback', async () => {
    rpcMock.mockResolvedValue({ data: response(Array.from({ length: 20 }, (_, i) => row({ landlord_id: `l${i}`, landlord_name: `Landlord ${i}` })), 590), error: null });
    const { onPageChange } = renderPanel({ page: 2 });
    await screen.findByText('Landlord 0');
    expect(screen.getByText('Showing 21–40 of 590')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 30')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('shows no paging when everything fits on one page', async () => {
    rpcMock.mockResolvedValue({ data: response([row()]), error: null });
    renderPanel();
    await screen.findByText('Mr Okello');
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('says so when a tab is empty, and when a search finds nothing', async () => {
    rpcMock.mockResolvedValue({ data: response([], 0), error: null });
    renderPanel();
    expect(await screen.findByText('No landlords have tenants repaying right now.')).toBeInTheDocument();
  });
  it('says so when a search finds nothing', async () => {
    rpcMock.mockResolvedValue({ data: response([], 0, 'completed'), error: null });
    renderPanel({ tab: 'completed', search: 'zzz' });
    expect(await screen.findByText('No landlords match this search.')).toBeInTheDocument();
  });

  it('shows a clear error with Try again when loading fails', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load this list.");
    rpcMock.mockResolvedValueOnce({ data: response([row()]), error: null });
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Mr Okello')).toBeInTheDocument();
  });

  it('shows a loading state first, and says what each tab is', async () => {
    rpcMock.mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getByRole('status')).toHaveTextContent('Loading landlords');
  });
  it('explains the tab above the list', async () => {
    rpcMock.mockResolvedValue({ data: response([row()]), error: null });
    renderPanel({ tab: 'completed' });
    expect(await screen.findByText('Landlords whose tenants paid off fully, with no active Rent Plan.')).toBeInTheDocument();
  });
});

describe('tab counts', () => {
  it('reads each tab\'s total for the search on screen, one landlord per call', async () => {
    rpcMock.mockImplementation(async (_n: string, a: any) => ({ data: { ...response([], a.p_tab === 'completed' ? 12 : 34, a.p_tab), counts: { paid_repaying: 590, completed: 267 } }, error: null }));
    let result: any;
    function Probe() { result = useLandlordPaidListCounts({ search: 'okello' }); return null; }
    render(<QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>);
    await waitFor(() => expect(result.data).toEqual({ paid_repaying: 34, completed: 12 }));
    expect(rpcMock).toHaveBeenCalledWith('landlord_ops_paid_lists', { p_tab: 'paid_repaying', p_search: 'okello', p_limit: 1, p_offset: 0 });
    expect(rpcMock).toHaveBeenCalledWith('landlord_ops_paid_lists', { p_tab: 'completed', p_search: 'okello', p_limit: 1, p_offset: 0 });
  });
});

describe('how the tabs are wired into the Landlords page', () => {
  const dashboard = fs.readFileSync(path.resolve(__dirname, '../../LandlordOpsDashboard.tsx'), 'utf8');
  it('adds the two tabs right after Funded, and leaves the existing ones as they were', () => {
    const block = dashboard.slice(dashboard.indexOf('const LANDLORD_CATEGORIES'), dashboard.indexOf('];', dashboard.indexOf('const LANDLORD_CATEGORIES')));
    const order = [...block.matchAll(/\{ value: '([a-z_]+)', label: '([^']+)'/g)].map((m) => m[1]);
    expect(order).toEqual(['all', 'verified', 'pending', 'rejected', 'resubmitted', 'funded', 'paid_repaying', 'completed', 'has_tenants', 'no_tenants']);
    expect(dashboard).toContain("{ value: 'paid_repaying', label: 'Paid & Repaying'");
    expect(dashboard).toContain("{ value: 'completed', label: 'Completed'");
  });
  it('shows the Funded note, wording exact, under the tabs', () => {
    expect(dashboard).toContain("categoryFilter === 'funded' && (");
    expect(dashboard).toContain('data-testid="funded-tab-note"');
    expect(dashboard).toContain('{FUNDED_TAB_NOTE}');
  });
  it('keeps the old list, its pagination and the PDF export away from the two new tabs, and puts the new panel in their place', () => {
    expect(dashboard).toContain("enabled: view === 'landlords' && !landlordIsPaidTab,");
    expect(dashboard).toContain("{categoryFilter !== 'funded' && !landlordIsPaidTab && totalMatched > perPage && (");
    expect(dashboard).toContain('disabled={exportingLandlordReport || landlordIsPaidTab}');
    expect(dashboard).toContain('<LandlordPaidListPanel');
    expect(dashboard).toContain('onEdit={(row) => setEditLandlord(');
  });
  it('keeps the existing chip counts, Funded register, Funded report and approve / reject / edit wiring', () => {
    for (const kept of ['verified: scoped?.verified ?? landlordOpsTotals?.verified', 'funded: landlordFundedStats?.summary.landlords_funded', 'onClick={() => void exportFundedReportPdf()}',
      'onApprove={(note) => handleApproveLandlord(landlord, note)}', 'onReject={(note) => handleRejectLandlord(landlord, note)}', 'onClick={() => setEditLandlord({ ...landlord })}', '<LandlordTenantsSection landlordId={landlord.id} />']) {
      expect(dashboard).toContain(kept);
    }
  });
  it('the Review panel on the new tabs includes the Tenants section', () => {
    expect(dashboard).toContain('<LandlordTenantsSection landlordId={row.landlord_id} />');
  });
});
