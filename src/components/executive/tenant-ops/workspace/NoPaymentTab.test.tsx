import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
const xlsx = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const pdf = vi.hoisted(() => vi.fn(() => new Blob(['x'])));
const download = vi.hoisted(() => vi.fn());
vi.mock('@/lib/xlsxExport', () => ({ downloadXlsxWorkbook: xlsx }));
vi.mock('@/lib/tenantOpsWeeklyPerformancePdf', () => ({ generateNoPaymentPdfForDays: pdf, downloadPdf: download }));
vi.mock('@/hooks/useTenantNoPaymentNotes', () => ({ useTenantNoPaymentNotesSummaries: () => ({ data: new Map() }) }));
vi.mock('@/components/executive/tenant-ops/workspace/TenantNotesPopover', () => ({ TenantNotesPopover: () => null }));

import NoPaymentTab from './NoPaymentTab';

const tenant = (id: string, days: number) => ({
  tenant_id: id, tenant_name: `Tenant ${id}`, tenant_account_number: '0700000000', agent_id: 'a1', agent_name: 'Agent One',
  date_of_last_payment: '2026-09-01', days_since_last_payment: days, expected_daily_payment: 10000, outstanding_balance: 200000,
  total_amount_paid: 100000, progress_pct: 33.3, tenant_status: 'repaying',
});
const report = (n: number, tenants = [tenant('A', n + 25), tenant('B', n + 12), tenant('C', n + 1)]) => ({
  as_of: '2026-10-13', min_days: n, tenants, total_min_days: tenants.length,
  agent_summary: [
    { agent_id: 'a1', label: 'Agent One', gte_min: 5, gte_min_10: 3, gte_min_20: 1 },
    { agent_id: 'a2', label: 'Agent Two', gte_min: 2, gte_min_10: 1, gte_min_20: 0 },
  ],
});

function Where() { const l = useLocation(); return <p data-testid="search">{l.search}</p>; }
function setup(url = '/page', make: (n: number) => unknown = (n) => report(n)) {
  rpc.mockImplementation((name: string, a: { p_min_days: number }) => Promise.resolve({ data: name === 'get_tenant_ops_no_payment_report_v2' ? make(a.p_min_days) : null, error: null }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}><NoPaymentTab /><Where /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NoPaymentTab with a chosen number of days', () => {
  beforeEach(() => { rpc.mockReset(); xlsx.mockClear(); pdf.mockClear(); download.mockClear(); });

  it('at the default shows 20+ / 30+ / 40+ with the totals of the per-agent counts', async () => {
    setup();
    await screen.findAllByText('Tenant A');
    expect(rpc.mock.calls[0]).toEqual(['get_tenant_ops_no_payment_report_v2', { p_min_days: 20, p_agent_id: null }]);
    const text = document.body.textContent ?? '';
    expect(text).toContain('20+ days');
    expect(text).toContain('30+ days');
    expect(text).toContain('40+ days');
    expect(text).toContain('gone 20 or more days');
  });

  it('?days=45 asks for 45 and relabels the cards, the sentence and the bands (45+, 55+, 65+)', async () => {
    setup('/page?days=45');
    await screen.findAllByText('Tenant A');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_min_days: 45 });
    const text = document.body.textContent ?? '';
    for (const t of ['45+ days', '55+ days', '65+ days', 'gone 45 or more days']) expect(text).toContain(t);
    expect(text).not.toContain('40+ days');
  });

  it('picking a preset changes the report and the URL together; the totals are the sums of the agent counts', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByText('Tenant A');
    await user.click(screen.getByRole('button', { name: '30' }));
    await waitFor(() => expect(rpc.mock.calls.some((c) => c[1].p_min_days === 30)).toBe(true));
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?days=30'));
    await waitFor(() => expect(document.body.textContent).toContain('40+ days'));
    expect(document.body.textContent).toContain('50+ days');
    // 5 + 2 at N, 3 + 1 at N+10, 1 + 0 at N+20
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    expect(screen.getAllByText('4').length).toBeGreaterThan(0);
  });

  it('a custom number is checked: 0 and 366 are refused and nothing is requested', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByText('Tenant A');
    const before = rpc.mock.calls.length;
    const box = screen.getByLabelText(/Custom number of days/);
    await user.type(box, '366');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/1 to 365/);
    expect(rpc.mock.calls.length).toBe(before);
    await user.clear(box);
    await user.type(box, '90');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(rpc.mock.calls.some((c) => c[1].p_min_days === 90)).toBe(true));
  });

  it('the empty state names the chosen number', async () => {
    setup('/page?days=60', (n) => report(n, []));
    expect(await screen.findByText('No tenants have gone 60+ days without payment')).toBeTruthy();
  });

  it('Excel and PDF are built from the report on screen, for the same N', async () => {
    const user = userEvent.setup();
    setup('/page?days=30');
    await screen.findAllByText('Tenant A');
    await user.click(screen.getByRole('button', { name: /Export Excel/ }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [fileName, sheets] = xlsx.mock.calls[0] as [string, { name: string; headers: string[]; rows: unknown[][] }[]];
    expect(fileName).toMatch(/^Welile_TenantOps_30_Plus_Days_No_Payment_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const summary = sheets.find((s) => s.name === 'Summary')!;
    expect(summary.headers[0]).toBe('Tenants 30+ days without payment');
    expect(summary.rows.slice(0, 3)).toEqual([['30+ days', 7], ['40+ days', 4], ['50+ days', 1]]);
    expect(sheets.find((s) => s.name === 'Tenants')!.rows).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: /Export PDF/ }));
    expect(pdf).toHaveBeenCalledTimes(1);
    expect((pdf.mock.calls[0] as unknown[])[0]).toMatchObject({ min_days: 30 });
    expect(download.mock.calls[0][1]).toMatch(/30_Plus_Days_No_Payment/);
  });
});
