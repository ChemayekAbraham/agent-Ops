import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

const state: { value: Record<string, unknown> } = { value: {} };
const listState: { value: Record<string, unknown> } = { value: {} };
const listArgs: unknown[][] = [];
const refetch = vi.fn();
vi.mock('@/hooks/useTenantOpsRentLifetime', () => ({
  useTenantOpsRentLifetime: () => state.value,
  useTenantOpsRentLifetimeList: (...a: unknown[]) => { listArgs.push(a); return listState.value; },
}));

import { TenantOpsRentLifetimeCards } from './TenantOpsRentLifetimeCards';
import { FUNNEL_STAGES, normalizeLifetime } from '@/lib/rentLifetime';

const counts = [2540, 2152, 1976, 1906, 1902, 1855, 1744, 1329];
const DATA = normalizeLifetime({
  as_at: '2026-10-16', generated_at: '2026-10-16T11:32:00Z', submitted: 6577, funded: 1742, financed: 1329,
  stage_funnel: FUNNEL_STAGES.map((stage, i) => ({ stage, count: counts[i] })),
  outcomes: { waiting_service_centre: 3786, pending: 22, in_approval: 128, rejected: 668, deleted_by_agent: 172, cancelled: 44 },
  repayment: { full: 489, partial: 773, never_paid: 22, too_early: 45 }, financed_now_closed: 6, funded_not_financed: 415,
  money: { total_repayment: 1007310368, amount_repaid: 614908410 },
});
const text = (el: HTMLElement) => (el.textContent ?? '').replace(/\u00a0/g, ' ');
const ROWS = [
  { id: 'r1', tenant_name: 'Tess Tenant', agent_name: 'Ann Agent', rent_amount: 400000, total_repayment: 520000, amount_repaid: 0, landlord_paid_at: '2026-08-01T07:00:00Z', funded_at: '2026-07-30T07:00:00Z', status: 'repaying', total_matched: 22 },
  { id: 'r2', tenant_name: 'Tom Tenant', agent_name: 'Ben Agent', rent_amount: 300000, total_repayment: 390000, amount_repaid: 0, landlord_paid_at: null, funded_at: '2026-06-01T07:00:00Z', status: 'funded', total_matched: 22 },
];
beforeEach(() => {
  refetch.mockClear();
  listArgs.length = 0;
  state.value = { data: DATA, isLoading: false, isFetching: false, error: null, updatedAt: 1, refetch };
  listState.value = { rows: ROWS, total: 22, isLoading: false, isFetching: false, error: null, refetch };
});

describe('Tenant Ops all-time rent request cards', () => {
  it('Card A: All time badge, the funnel counts as returned with % of submitted and % of previous, and the outcomes footer', () => {
    render(<TenantOpsRentLifetimeCards />);
    const card = screen.getByTestId('lifetime-journey');
    expect(within(card).getByTestId('lifetime-all-time-badge')).toHaveTextContent('All time');
    expect(card).toHaveTextContent('Rent request journey');
    expect(within(screen.getByTestId('lifetime-row-submitted')).getByText('6,577')).toBeInTheDocument();
    expect(screen.getByTestId('lifetime-row-financed')).toHaveTextContent('1,329');
    expect(screen.getByTestId('lifetime-of-submitted-financed')).toHaveTextContent('20.2%');
    expect(screen.getByTestId('lifetime-of-previous-financed')).toHaveTextContent('76.2%');
    expect(screen.getByTestId('lifetime-of-previous-service_center')).toHaveTextContent('38.6%');
    expect(screen.getAllByTestId(/^lifetime-row-/)).toHaveLength(9);
    expect(within(screen.getByTestId('lifetime-row-submitted')).getByText('—')).toBeInTheDocument();
    expect(screen.getByTestId('lifetime-row-submitted')).not.toHaveTextContent('None');
    const o = screen.getByTestId('lifetime-outcomes');
    for (const k of ['Waiting at Service Centre', '3,786', 'In approval', '128', 'Rejected', '668', 'Withdrawn by agent', '172', 'Cancelled', '44']) expect(o).toHaveTextContent(k);
    expect(o.className).toContain('grid-cols-2');
    expect(o).not.toHaveTextContent('Pending');
  });

  it('Card B: All time badge, a bar and the four buckets with counts and % of financed, funded-not-financed, and money recovered in UGX', () => {
    render(<TenantOpsRentLifetimeCards />);
    const card = screen.getByTestId('lifetime-repayment');
    expect(within(card).getByTestId('lifetime-all-time-badge')).toHaveTextContent('All time');
    expect(card).toHaveTextContent('Financed: repayment outcome');
    expect(screen.getByTestId('lifetime-bucket-full')).toHaveTextContent('Paid in full');
    expect(screen.getByTestId('lifetime-bucket-full')).toHaveTextContent('489');
    expect(screen.getByTestId('lifetime-bucket-full')).toHaveTextContent('36.8%');
    expect(screen.getByTestId('lifetime-bucket-partial')).toHaveTextContent('773');
    expect(screen.getByTestId('lifetime-bucket-never_paid')).toHaveTextContent('Never paid (30+ days)');
    expect(screen.getByTestId('lifetime-bucket-too_early')).toHaveTextContent('Too early');
    expect(screen.getByTestId('lifetime-funded-not-financed')).toHaveTextContent('415');
    const rec = text(screen.getByTestId('lifetime-recovered'));
    expect(rec).toContain('61%');
    expect(rec).toContain('UGX 614,908,410 of UGX 1,007,310,368');
    expect(screen.getByTestId('lifetime-closed-row')).toHaveTextContent('6');
    expect(screen.getByTestId('lifetime-bar-full').getAttribute('style')).toContain('36.8%');
  });

  it('loading skeleton, and an error with Retry', () => {
    state.value = { data: null, isLoading: true, isFetching: true, error: null, updatedAt: 0, refetch };
    const a = render(<TenantOpsRentLifetimeCards />);
    expect(screen.getByTestId('lifetime-loading')).toBeInTheDocument();
    a.unmount();
    state.value = { data: null, isLoading: false, isFetching: false, error: { message: 'boom' }, updatedAt: 0, refetch };
    render(<TenantOpsRentLifetimeCards />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the all-time rent request figures.');
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('uses the approved wording and no emoji; an empty book shows zeros, not NaN', () => {
    state.value = { data: normalizeLifetime(null), isLoading: false, isFetching: false, error: null, updatedAt: 1, refetch };
    render(<TenantOpsRentLifetimeCards />);
    const t = text(screen.getByTestId('lifetime-cards'));
    expect(t).not.toMatch(/NaN|Infinity/);
    expect(t).not.toMatch(/\bloan\b|\blender\b|\bROI\b|\binterest\b/i);
    expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(screen.getByTestId('lifetime-recovered')).toHaveTextContent('0%');
  });

  it('has the section heading and the note that the date filter does not apply', () => {
    render(<TenantOpsRentLifetimeCards />);
    expect(screen.getByTestId('lifetime-section')).toHaveTextContent('Rent requests — all time');
    expect(screen.getByTestId('lifetime-note')).toHaveTextContent('These figures cover all time; the date filter does not apply.');
  });

  it('phones get a block per stage with a thin bar and the table is for 640px and wider', () => {
    render(<TenantOpsRentLifetimeCards />);
    const cards = screen.getByTestId('lifetime-funnel-cards');
    expect(cards.className).toContain('sm:hidden');
    expect(screen.getByTestId('lifetime-funnel').closest('div')!.className).toMatch(/hidden .*sm:block/);
    const fin = within(cards).getByTestId('lifetime-card-row-financed');
    expect(fin).toHaveTextContent('1,329');
    expect(fin).toHaveTextContent('20.2% of submitted');
    expect(fin).toHaveTextContent('76.2% of previous');
    expect(within(within(cards).getByTestId('lifetime-card-row-submitted')).getByText(/of previous: —/)).toBeInTheDocument();
  });

  it('shows Updated HH:mm from the server time (Kampala) and a refresh button that refetches, in each card header', () => {
    render(<TenantOpsRentLifetimeCards />);
    const updated = screen.getAllByTestId('lifetime-updated');
    expect(updated).toHaveLength(2);
    expect(updated[0]).toHaveTextContent('Updated 14:32');
    const buttons = screen.getAllByRole('button', { name: 'Refresh the all-time figures' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('the three drill-down rows open a sheet with the paged list and ask for the right bucket', () => {
    listState.value = { ...listState.value, total: 120 };
    render(<TenantOpsRentLifetimeCards />);
    fireEvent.click(screen.getByRole('button', { name: /Open the list: Never paid/ }));
    expect(listArgs.at(-1)).toEqual(['never_paid', 0]);
    const sheet = screen.getByTestId('lifetime-sheet');
    expect(sheet).toHaveTextContent('Never paid (30+ days)');
    expect(within(sheet).getAllByTestId('lifetime-sheet-row')).toHaveLength(2);
    const t = text(sheet);
    expect(t).toContain('Tess Tenant');
    expect(t).toContain('Agent Ann Agent');
    expect(t).toContain('Rent UGX 400,000, owed UGX 520,000, repaid UGX 0');
    expect(t).toContain('Landlord paid about 1 Aug 2026');
    expect(within(sheet).getByTestId('lifetime-sheet-count')).toHaveTextContent('1 to 2 of 120');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Next page' }));
    expect(listArgs.at(-1)).toEqual(['never_paid', 1]);
  });

  it('the other two rows open their lists; funded-not-financed shows the funded date', () => {
    const a = render(<TenantOpsRentLifetimeCards />);
    fireEvent.click(screen.getByRole('button', { name: /Open the list: Funded but not yet financed/ }));
    expect(listArgs.at(-1)).toEqual(['funded_not_financed', 0]);
    expect(text(screen.getByTestId('lifetime-sheet'))).toContain('Funded 1 Jun 2026');
    a.unmount();
    render(<TenantOpsRentLifetimeCards />);
    fireEvent.click(screen.getByRole('button', { name: /Open the list: Financed, now rejected/ }));
    expect(listArgs.at(-1)).toEqual(['financed_now_closed', 0]);
  });

  it('the sheet has its own loading, empty and error-with-retry', () => {
    listState.value = { rows: [], total: 0, isLoading: true, isFetching: true, error: null, refetch };
    const a = render(<TenantOpsRentLifetimeCards />);
    fireEvent.click(screen.getByRole('button', { name: /Open the list: Never paid/ }));
    expect(screen.getByTestId('lifetime-sheet-loading')).toBeInTheDocument();
    a.unmount();
    listState.value = { rows: [], total: 0, isLoading: false, isFetching: false, error: { message: 'boom' }, refetch };
    const b = render(<TenantOpsRentLifetimeCards />);
    fireEvent.click(screen.getByRole('button', { name: /Open the list: Never paid/ }));
    fireEvent.click(within(screen.getByTestId('lifetime-sheet-error')).getByRole('button', { name: /Retry/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
    b.unmount();
    listState.value = { rows: [], total: 0, isLoading: false, isFetching: false, error: null, refetch };
    render(<TenantOpsRentLifetimeCards />);
    fireEvent.click(screen.getByRole('button', { name: /Open the list: Never paid/ }));
    expect(screen.getByTestId('lifetime-sheet-empty')).toBeInTheDocument();
  });

  it('the "How these are counted" popover states the 30-day rule and that the landlord-paid date is approximate', () => {
    render(<TenantOpsRentLifetimeCards />);
    fireEvent.click(screen.getByRole('button', { name: /How these are counted/ }));
    const body = screen.getByTestId('lifetime-how-counted-body').textContent ?? '';
    expect(body).toMatch(/more than 30 days ago/);
    expect(body).toMatch(/approximate/);
    expect(body).not.toMatch(/\bloan\b|\blender\b|\bROI\b|\binterest\b/i);
  });

  it('the loading placeholders are plain blocks (no shared Skeleton that could be handed a ref)', () => {
    state.value = { data: null, isLoading: true, isFetching: true, error: null, updatedAt: 0, refetch };
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(String(a[0])); });
    render(<TenantOpsRentLifetimeCards />);
    spy.mockRestore();
    expect(errors.filter((e) => /cannot be given refs/i.test(e))).toEqual([]);
    expect(screen.getByTestId('lifetime-loading')).toBeInTheDocument();
  });
});
