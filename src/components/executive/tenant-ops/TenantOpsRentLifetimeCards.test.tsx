import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

const state: { value: Record<string, unknown> } = { value: {} };
const refetch = vi.fn();
vi.mock('@/hooks/useTenantOpsRentLifetime', () => ({ useTenantOpsRentLifetime: () => state.value }));

import { TenantOpsRentLifetimeCards } from './TenantOpsRentLifetimeCards';
import { FUNNEL_STAGES, normalizeLifetime } from '@/lib/rentLifetime';

const counts = [2540, 2152, 1976, 1906, 1902, 1855, 1744, 1329];
const DATA = normalizeLifetime({
  as_at: '2026-10-16', submitted: 6577, funded: 1742, financed: 1329,
  stage_funnel: FUNNEL_STAGES.map((stage, i) => ({ stage, count: counts[i] })),
  outcomes: { waiting_service_centre: 3786, pending: 22, rejected: 668, deleted_by_agent: 172, cancelled: 44 },
  repayment: { full: 489, partial: 773, never_paid: 22, too_early: 45 }, financed_now_closed: 6, funded_not_financed: 415,
  money: { total_repayment: 1007310368, amount_repaid: 614908410 },
});
const text = (el: HTMLElement) => (el.textContent ?? '').replace(/\u00a0/g, ' ');
beforeEach(() => { refetch.mockClear(); state.value = { data: DATA, isLoading: false, isFetching: false, error: null, updatedAt: 1, refetch }; });

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
    const o = screen.getByTestId('lifetime-outcomes');
    for (const k of ['Waiting at Service Centre', '3,786', 'Rejected', '668', 'Withdrawn by agent', '172', 'Cancelled', '44']) expect(o).toHaveTextContent(k);
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
    expect(screen.getByTestId('lifetime-closed-note')).toHaveTextContent('6 of the financed Rent Plans');
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
});
