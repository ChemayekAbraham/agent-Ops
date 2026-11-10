import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FILTERS, adjustmentChange, computeKpis, csvTable, exceptionLabel, filterRows, sortRows, type RepaymentPlanRow,
} from '@/lib/tenantRepaymentTracker';
import { normaliseRow, loadTenantRepaymentRegister } from '@/hooks/useTenantRepaymentTracker';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), downloadCsv: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('@/lib/csvExport', () => ({ downloadCsv: mocks.downloadCsv }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'cfo-test' } }) }));

import TenantRepaymentTracker from '@/components/cfo/tenant-repayments/TenantRepaymentTracker';

const base: RepaymentPlanRow = {
  rent_request_id: '00000000-0000-0000-0000-000000000001', status: 'repaying', tenant_id: 't1', tenant_name: 'Malinga Joel',
  tenant_phone: '+256752560978', agent_id: 'a1', agent_name: 'IAN MUHWEZI', landlord_name: 'musubika bridget', funded_at: '2026-10-08T09:05:40Z',
  clock_bucket: 'counting', clock_start: '2026-10-08', clock_end: '2026-11-06', duration_days: 30, principal: 1_000_000, access_fee: 330_000,
  request_fee: 20_000, fees: 350_000, obligation: 1_350_000, disbursed: 1_000_000, verified_collected: 568_000, money_in_collected: 568_000,
  pre_cutoff_collected: 0, receipts_count: 10,
  last_receipt_at: '2026-10-30T10:00:00Z', reversed_amount: 0, reversed_count: 0, ledger_backed_amount: 0, unverified_amount: 0,
  unverified_count: 0, stored_repaid: 568_000, stored_outstanding: 782_000, calc_outstanding: 782_000, progress_pct: 42.1,
  repaid_without_receipts: 0, manual_reduction_total: 0, manual_reduction_count: 0, unreceipted_repaid_increase: 0, obligation_reduced: 0,
  last_adjustment_at: null, books_receivable: 1_350_000, receipts_not_posted: 0, expected_to_date: 1_305_000, arrears: 737_000,
  days_behind: 16, is_legacy: false, exceptions: [],
};
const wasajja: RepaymentPlanRow = {
  ...base, rent_request_id: '00000000-0000-0000-0000-000000000002', status: 'completed', tenant_name: 'Wasajja Simon', tenant_phone: '+256781604060',
  landlord_name: 'Mafabi Nasser', principal: 4_000_000, access_fee: 1_320_000, obligation: 5_340_000, verified_collected: 820_000,
  money_in_collected: 820_000, receipts_count: 1,
  stored_repaid: 5_340_000, stored_outstanding: 0, calc_outstanding: 4_520_000, progress_pct: 15.4, repaid_without_receipts: 4_520_000,
  manual_reduction_total: 4_520_000, manual_reduction_count: 1, arrears: 4_520_000, days_behind: 25,
  exceptions: ['completed_with_balance', 'repaid_without_receipts', 'manual_balance_reduction'],
};
const clean: RepaymentPlanRow = {
  ...base, rent_request_id: '00000000-0000-0000-0000-000000000003', status: 'completed', tenant_name: 'Clean Tenant', tenant_phone: '+256700111222',
  verified_collected: 1_350_000, money_in_collected: 0, pre_cutoff_collected: 1_350_000, stored_repaid: 1_350_000, stored_outstanding: 0, calc_outstanding: 0, progress_pct: 100, arrears: 0, days_behind: 0,
};
const cancelled: RepaymentPlanRow = { ...base, rent_request_id: '00000000-0000-0000-0000-000000000004', status: 'cancelled', tenant_name: 'Old Plan', arrears: 0 };
const ROWS = [base, wasajja, clean, cancelled];

describe('tracker calculations (display layer only)', () => {
  it('KPIs: active, verified outstanding vs recorded, overdue, completed and completed-with-balance', () => {
    const k = computeKpis(ROWS);
    expect(k).toEqual({
      activePlans: 1, activeOutstanding: 782_000, totalOutstanding: 782_000 + 4_520_000, storedOutstanding: 782_000,
      overduePlans: 2, overdueArrears: 737_000 + 4_520_000, completedPlans: 2, completedWithBalance: 1, plansWithExceptions: 1, highExceptions: 1,
    });
  });
  it('a cancelled plan is not counted in outstanding or overdue', () => {
    const k = computeKpis([cancelled]);
    expect([k.totalOutstanding, k.overduePlans, k.activePlans]).toEqual([0, 0, 0]);
  });
  it('search finds tenant, agent, landlord, plan ID and phone in any format', () => {
    const s = (q: string) => filterRows(ROWS, { ...DEFAULT_FILTERS, search: q }).map((r) => r.tenant_name);
    expect(s('wasajja')).toEqual(['Wasajja Simon']);
    expect(s('mafabi')).toEqual(['Wasajja Simon']);
    expect(s('ian muh')).toHaveLength(4);
    expect(s('0781 604 060')).toEqual(['Wasajja Simon']);
    expect(s('+256781604060')).toEqual(['Wasajja Simon']);
    expect(s('000000000003')).toEqual(['Clean Tenant']);
    expect(s('zzzz')).toEqual([]);
  });
  it('filters by status, schedule and exception', () => {
    const f = (patch: object) => filterRows(ROWS, { ...DEFAULT_FILTERS, ...patch }).map((r) => r.tenant_name);
    expect(f({ status: 'active' })).toEqual(['Malinga Joel']);
    expect(f({ status: 'completed' })).toEqual(['Wasajja Simon', 'Clean Tenant']);
    expect(f({ status: 'other' })).toEqual(['Old Plan']);
    expect(f({ schedule: 'behind' })).toEqual(['Malinga Joel', 'Wasajja Simon']);
    expect(f({ exception: 'any' })).toEqual(['Wasajja Simon']);
    expect(f({ exception: 'none' })).toHaveLength(3);
    expect(f({ exception: 'manual_balance_reduction' })).toEqual(['Wasajja Simon']);
  });
  it('sorts by outstanding, arrears or funding date', () => {
    expect(sortRows(ROWS, 'calc_outstanding').map((r) => r.tenant_name).slice(0, 2)).toEqual(['Wasajja Simon', 'Malinga Joel']);
    expect(sortRows(ROWS, 'calc_outstanding', 'asc')[0].calc_outstanding).toBe(0);
  });
  it('CSV columns: numbers stay numbers, Yes/No for flags, exceptions as labels', () => {
    const t = csvTable([wasajja]);
    const at = (h: string) => t.rows[0][t.headers.indexOf(h)];
    expect(at('Outstanding (UGX)')).toBe(4_520_000);
    expect(at('Collected on Money In from 1 Oct 2026 (UGX)')).toBe(820_000);
    expect(at('Collected before 1 Oct 2026, receipts (UGX)')).toBe(0);
    expect(at('Recorded outstanding (UGX)')).toBe(0);
    expect(at('Funded before 1 Oct 2026')).toBe('No');
    expect(at('Exceptions')).toBe('Completed with balance; Repaid without collections; Balance reduced by an edit');
    expect(t.headers.length).toBe(t.rows[0].length);
  });
  it('labels and adjustment lines are readable', () => {
    expect(exceptionLabel('receipt_not_in_ledger')).toBe('Receipt not on Money In');
    expect(exceptionLabel('something_new')).toBe('something new');
    const f = (n: number) => `UGX ${n.toLocaleString('en-US')}`;
    expect(adjustmentChange({ at: '', kind: '', status: null, by: null, old_outstanding: 5_340_000, new_outstanding: 820_000 }, f)).toBe('Outstanding UGX 5,340,000 to UGX 820,000');
    expect(adjustmentChange({ at: '', kind: '', status: null, by: null, old_total_repayment: 1_500_000, new_total_repayment: 1_320_000, old_amount_repaid: 0, new_amount_repaid: 0 }, f))
      .toBe('Obligation UGX 1,500,000 to UGX 1,320,000');
  });
  it('numerics from Postgres (strings) are normalised once', () => {
    const r = normaliseRow({ ...wasajja, obligation: '5340000.00', calc_outstanding: '4520000', arrears: null, exceptions: null } as unknown as Record<string, unknown>);
    expect([r.obligation, r.calc_outstanding, r.arrears, r.exceptions]).toEqual([5_340_000, 4_520_000, null, []]);
  });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><TenantRepaymentTracker /></QueryClientProvider>);
}

describe('Tenant Repayment Tracker page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/cfo/dashboard?section=tenant-repayment-tracker');
    const response = (data: unknown) => {
      const value = Promise.resolve({ data, error: null });
      return Object.assign(value, { range: () => Object.assign(value, { abortSignal: () => value }), abortSignal: () => value });
    };
    mocks.rpc.mockImplementation((fn: string) => {
      if (fn === 'get_cfo_tenant_repayment_register') return response(ROWS);
      if (fn === 'get_cfo_tenant_repayment_detail') return response({
        as_at: '2026-11-07T10:00:00Z', plan: wasajja, repayment_records: [],
        money_in: [{ at: '2026-10-26T06:27:20Z', category: 'tenant_repayment_collected', direction: 'cash_in', amount: 820000, reference: 'MI-820',
          group: 'g1', description: 'Tenant rent allocation settled for landlord Mafabi Nasser', counted: true }],
        receipts: [{ id: 'c1', at: '2026-10-26T06:27:00Z', amount: 820000, method: 'cash', reference: 'AGT-c279b10e', tracking_id: 'AGT-c279b10e',
          agent: 'IAN MUHWEZI', path: 'agent collection', reversed: false, reversed_at: null, ledger_posted: true, ledger_checked: true, counted: false, notes: null }],
        adjustments: [{ at: '2026-10-25T06:13:24Z', kind: 'Tenant balance edit', status: 'approved', by: 'Nankambo sharimah', approved_by: 'SARAH ANGWEN',
          reason: 'system bal correction', old_outstanding: 5340000, new_outstanding: 820000, reduction: 4520000 }],
        ledger: [] });
      return Promise.resolve({ data: null, error: { message: 'unexpected' } });
    });
  });

  it('shows the KPI cards from verified collections, with recorded balances beside them', async () => {
    renderPage();
    expect(await screen.findByText('Active plans')).toBeTruthy();
    expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_tenant_repayment_register');
    expect(screen.getByText('1 still owe on collections')).toBeTruthy();
    expect(screen.getByText(/Recorded balances say/)).toBeTruthy();
    expect(screen.getAllByTestId('tracker-row')).toHaveLength(4);
  });

  it('an exception chip filters the register', async () => {
    renderPage();
    await screen.findByText('Active plans');
    fireEvent.click(screen.getByRole('button', { name: /Balance reduced by an edit/ }));
    const rows = screen.getAllByTestId('tracker-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('Wasajja Simon')).toBeTruthy();
  });

  it('search narrows the register; export sends exactly the filtered rows to the shared CSV exporter', async () => {
    renderPage();
    await screen.findByText('Active plans');
    fireEvent.change(screen.getByLabelText('Search the register'), { target: { value: 'malinga' } });
    expect(screen.getAllByTestId('tracker-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Export CSV \(1\)/ }));
    expect(mocks.downloadCsv).toHaveBeenCalledTimes(1);
    const [name, headers, rows] = mocks.downloadCsv.mock.calls[0];
    expect(name).toMatch(/^tenant-repayment-tracker-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(rows).toHaveLength(1);
    expect(rows[0][headers.indexOf('Tenant')]).toBe('Malinga Joel');
  });

  it('opening a plan shows obligation, receipts with references and who changed the balance', async () => {
    renderPage();
    await screen.findByText('Active plans');
    const target = screen.getAllByTestId('tracker-row').find((r) => r.textContent?.includes('Wasajja'));
    if (!target) throw new Error('Expected plan row');
    fireEvent.click(within(target).getByText('Wasajja Simon'));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_tenant_repayment_detail', { p_rent_request_id: wasajja.rent_request_id }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Total repayment obligation')).toBeTruthy();
    expect(within(sheet).getByText('Completed with balance')).toBeTruthy();
    expect(within(sheet).getByText(/is recorded as repaid with no collection behind it/)).toBeTruthy();
    expect(within(sheet).getByText(/on Money In \(Tenant Products and Services\) from 1 Oct 2026/)).toBeTruthy();
    expect(await within(sheet).findByText('MI-820')).toBeTruthy();
    const receiptsTab = within(sheet).getByRole('tab', { name: /Receipts/ });
    fireEvent.mouseDown(receiptsTab); fireEvent.click(receiptsTab);
    expect(await within(sheet).findByText('AGT-c279b10e')).toBeTruthy();
    expect(within(sheet).getByText('On Money In')).toBeTruthy();
    const tab = within(sheet).getByRole('tab', { name: /Balance adjustments/ });
    fireEvent.mouseDown(tab); fireEvent.click(tab);
    expect(await within(sheet).findByText(/system bal correction/)).toBeTruthy();
    expect(within(sheet).getByText(/Nankambo sharimah · approved by SARAH ANGWEN/)).toBeTruthy();
  });

  it('a non-CFO sees the database refusal, not data', async () => {
    mocks.rpc.mockImplementation(() => ({ range: () => ({ abortSignal: () => Promise.resolve({ data: null, error: { message: 'Not authorized: the Tenant Repayment Tracker is for the CFO', code: '42501' } }) }) }));
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not authorized/);
    expect(screen.queryByTestId('tracker-row')).toBeNull();
  });

  it('an investigation link loads the exact plan instead of the tenant’s other plan', async () => {
    window.history.replaceState({}, '', `/cfo/dashboard?section=tenant-repayment-tracker&repayment_plan=${wasajja.rent_request_id}`);
    renderPage();
    await screen.findByRole('dialog');
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_tenant_repayment_detail', { p_rent_request_id: wasajja.rent_request_id }));
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_cfo_tenant_repayment_detail', { p_rent_request_id: base.rent_request_id });
  });
});

describe('complete register loading', () => {
  it('loads beyond the 1,000 row API limit with exact non-overlapping ranges', async () => {
    const pages = Array.from({ length: 1003 }, (_, n) => ({ ...base, rent_request_id: `plan-${n}`, verified_collected: n, exceptions: n === 1002 ? ['receipt_not_in_ledger'] : [] }));
    const ranges: number[][] = [];
    mocks.rpc.mockImplementation(() => ({ range: (from: number, to: number) => {
      ranges.push([from, to]);
      return Promise.resolve({ data: pages.slice(from, to + 1), error: null });
    } }));
    const result = await loadTenantRepaymentRegister();
    expect(ranges).toEqual([[0, 499], [500, 999], [1000, 1499]]);
    expect(result.rows).toHaveLength(1003);
    expect(result.rows[1002].verified_collected).toBe(1002);
    expect(computeKpis(result.rows).plansWithExceptions).toBe(1);
  });

  it('does not return partial totals after a later page fails', async () => {
    mocks.rpc.mockImplementation(() => ({ range: (from: number) => Promise.resolve(from === 0
      ? { data: Array.from({ length: 500 }, (_, n) => ({ ...base, rent_request_id: `plan-${n}` })), error: null }
      : { data: null, error: new Error('Page unavailable') }) }));
    await expect(loadTenantRepaymentRegister()).rejects.toThrow('Page unavailable');
  });

  it('rejects overlapping pages instead of silently mixing snapshots', async () => {
    mocks.rpc.mockImplementation(() => ({ range: () => Promise.resolve({ data: [base, base], error: null }) }));
    await expect(loadTenantRepaymentRegister()).rejects.toThrow('register changed');
  });
});
