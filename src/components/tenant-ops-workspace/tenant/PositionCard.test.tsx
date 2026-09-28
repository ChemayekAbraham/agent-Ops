import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PlanPositionResult } from '@/hooks/tenantOpsWorkspace/usePlanPosition';

const mockUsePlanPosition = vi.fn();
const mockUsePlanScheduleLedger = vi.fn();

vi.mock('@/hooks/tenantOpsWorkspace/usePlanPosition', () => ({
  usePlanPosition: (...args: unknown[]) => mockUsePlanPosition(...args),
}));

vi.mock('@/hooks/tenantOpsWorkspace/usePlanScheduleLedger', () => ({
  usePlanScheduleLedger: (...args: unknown[]) => mockUsePlanScheduleLedger(...args),
}));

// Imported after the mocks above so PositionCard picks up the mocked hooks.
import PositionCard from './PositionCard';

const BASE_TERMS = { total_repayment: 300_000, duration_days: 60, daily_repayment: 5_000 };

function basePosition(overrides: Partial<PlanPositionResult>): PlanPositionResult {
  return {
    rent_request_id: 'rr-1',
    cadence: 'daily',
    cadence_source: 'explicit',
    clock_start: '2026-01-01',
    clock_source: 'funded_at',
    term_end_date: '2026-03-01',
    expected_to_date_ugx: 100_000,
    paid_to_date_ugx: 100_000,
    position_ugx: 0,
    periods_due: 20,
    days_past_due: 0,
    days_behind: null,
    days_ahead: null,
    outstanding_ugx: 200_000,
    catch_up_daily_ugx: null,
    term_expired: false,
    as_at: '2026-01-20',
    basis: 'kampala;reversals_excluded',
    terms: BASE_TERMS,
    ...overrides,
  };
}

function mockLedgerEmpty() {
  mockUsePlanScheduleLedger.mockReturnValue({ data: { rows: [], totalRowCount: 0 } });
}

describe('PositionCard — the three position states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Behind when position_ugx is negative, with a catch-up figure', () => {
    mockUsePlanPosition.mockReturnValue({
      data: basePosition({ position_ugx: -50_000, catch_up_daily_ugx: 6_500 }),
      isLoading: false,
      error: null,
    });
    mockLedgerEmpty();

    render(<PositionCard rentRequestId="rr-1" />);

    expect(screen.getByText(/Behind by/)).toBeInTheDocument();
    // "UGX 50,000" legitimately appears twice (the header and the "pay now"
    // line) — assert presence via count rather than a single-match query.
    expect(screen.getAllByText(/UGX\s*50,000/).length).toBe(2);
    expect(screen.getByText(/UGX\s*6,500/)).toBeInTheDocument();
    expect(screen.getByText(/day to term end/)).toBeInTheDocument();
  });

  it('renders Ahead when position_ugx is positive, with days of cover banked', () => {
    mockUsePlanPosition.mockReturnValue({
      data: basePosition({ position_ugx: 15_000, days_ahead: 3 }),
      isLoading: false,
      error: null,
    });
    mockLedgerEmpty();

    render(<PositionCard rentRequestId="rr-1" />);

    expect(screen.getByText(/Ahead by/)).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*15,000/)).toBeInTheDocument();
    expect(screen.getByText(/3 days of cover banked/)).toBeInTheDocument();
    expect(screen.getByText(/ahead of schedule/)).toBeInTheDocument();
  });

  it('renders On track when position_ugx is exactly zero', () => {
    mockUsePlanPosition.mockReturnValue({
      data: basePosition({ position_ugx: 0 }),
      isLoading: false,
      error: null,
    });
    mockLedgerEmpty();

    render(<PositionCard rentRequestId="rr-1" />);

    expect(screen.getByText('On track')).toBeInTheDocument();
    expect(screen.queryByText(/Behind by/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ahead by/)).not.toBeInTheDocument();
  });
});

describe('PositionCard — guard states outside the three position states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the cannot-compute notice when cadence is unknown, with no figures', () => {
    mockUsePlanPosition.mockReturnValue({
      data: basePosition({ cadence_source: 'unknown', cadence: 'unknown', position_ugx: null }),
      isLoading: false,
      error: null,
    });
    mockLedgerEmpty();

    render(<PositionCard rentRequestId="rr-1" />);

    expect(screen.getByText("This plan's schedule cannot be computed yet")).toBeInTheDocument();
    expect(screen.getByText('View the cadence remediation list')).toBeInTheDocument();
    expect(screen.queryByText(/Behind by|Ahead by|On track/)).not.toBeInTheDocument();
  });

  it('shows Term expired and suppresses the catch-up figure regardless of position_ugx sign', () => {
    mockUsePlanPosition.mockReturnValue({
      data: basePosition({ term_expired: true, position_ugx: -80_000, catch_up_daily_ugx: 9_000 }),
      isLoading: false,
      error: null,
    });
    mockLedgerEmpty();

    render(<PositionCard rentRequestId="rr-1" />);

    expect(screen.getByText('Term expired')).toBeInTheDocument();
    expect(screen.getByText(/overdue regime applies/)).toBeInTheDocument();
    expect(screen.queryByText(/day to term end/)).not.toBeInTheDocument();
  });

  it('shows a loading state while the position query is in flight', () => {
    mockUsePlanPosition.mockReturnValue({ data: undefined, isLoading: true, error: null });
    mockLedgerEmpty();

    render(<PositionCard rentRequestId="rr-1" />);

    expect(screen.getByText('Loading plan position…')).toBeInTheDocument();
  });

  it('shows an error state when the position query fails', () => {
    mockUsePlanPosition.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    mockLedgerEmpty();

    render(<PositionCard rentRequestId="rr-1" />);

    expect(screen.getByText("Could not load this plan's position.")).toBeInTheDocument();
  });
});
