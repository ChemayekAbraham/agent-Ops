import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PlanScheduleLedgerRow } from '@/hooks/tenantOpsWorkspace/usePlanScheduleLedger';

const mockUsePlanScheduleLedger = vi.fn();

vi.mock('@/hooks/tenantOpsWorkspace/usePlanScheduleLedger', () => ({
  usePlanScheduleLedger: (...args: unknown[]) => mockUsePlanScheduleLedger(...args),
}));

import ScheduleLedger from './ScheduleLedger';

function row(seq: number, overrides: Partial<PlanScheduleLedgerRow> = {}): PlanScheduleLedgerRow {
  return {
    seq,
    due_date: `2026-01-${String(seq).padStart(2, '0')}`,
    amount_ugx: 5_000,
    settled_ugx: 0,
    outstanding_ugx: 5_000,
    running_arrears_ugx: seq * 5_000,
    settled_by: [],
    never_billed: false,
    ...overrides,
  };
}

describe('ScheduleLedger — server-paginated rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the running arrears balance for each row on the current page only', () => {
    mockUsePlanScheduleLedger.mockReturnValue({
      data: { rows: [row(1), row(2)], totalRowCount: 2 },
      isLoading: false,
      error: null,
    });

    render(<ScheduleLedger rentRequestId="rr-1" />);

    expect(screen.getAllByText('UGX 5,000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('UGX 10,000').length).toBeGreaterThan(0);
    // The hook itself is trusted to have computed this over the whole plan —
    // this test only checks the page renders what the hook returned.
    expect(mockUsePlanScheduleLedger).toHaveBeenCalledWith('rr-1', 20, 0);
  });

  it('does not show a pager when everything fits on one page', () => {
    mockUsePlanScheduleLedger.mockReturnValue({
      data: { rows: [row(1)], totalRowCount: 1 },
      isLoading: false,
      error: null,
    });

    render(<ScheduleLedger rentRequestId="rr-1" />);

    expect(screen.queryByText(/Page \d+ of \d+/)).not.toBeInTheDocument();
  });

  it('advancing to the next page re-queries the hook with the next offset, not a client-side slice', () => {
    mockUsePlanScheduleLedger.mockReturnValue({
      data: { rows: Array.from({ length: 20 }, (_, i) => row(i + 1)), totalRowCount: 45 },
      isLoading: false,
      error: null,
    });

    render(<ScheduleLedger rentRequestId="rr-1" />);

    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // The component re-renders with page=1; since the hook is mocked, the
    // *next* render's query args are what prove the component asked the
    // server for a new page rather than slicing the 45 rows it never had.
    expect(mockUsePlanScheduleLedger).toHaveBeenLastCalledWith('rr-1', 20, 20);
  });

  it('shows the loading state before any data arrives', () => {
    mockUsePlanScheduleLedger.mockReturnValue({ data: undefined, isLoading: true, error: null });

    render(<ScheduleLedger rentRequestId="rr-1" />);

    expect(screen.getByText('Loading schedule…')).toBeInTheDocument();
  });

  it('shows the empty state when the plan has no instalments yet', () => {
    mockUsePlanScheduleLedger.mockReturnValue({
      data: { rows: [], totalRowCount: 0 },
      isLoading: false,
      error: null,
    });

    render(<ScheduleLedger rentRequestId="rr-1" />);

    expect(screen.getByText('No instalments for this plan yet.')).toBeInTheDocument();
  });
});
