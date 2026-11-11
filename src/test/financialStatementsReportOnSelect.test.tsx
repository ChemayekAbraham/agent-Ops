import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Financial Statements: each tab loads only its own report, when selected.
 * The general statements run (ledger sums + platform cash + comparison) must not start on opening, and the
 * Balance Sheet must render without waiting for it.
 */

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  cashFlowEnabled: [] as boolean[],
  incomeEnabled: [] as boolean[],
  data: null as unknown,
}));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('@/hooks/useFinancialStatements', () => ({
  useFinancialStatements: () => {
    const [filters, setFilters] = useState({ period: 'month', startDate: null, endDate: null });
    return {
      data: mocks.data, previousData: null, loading: false, filters, setFilters,
      generate: mocks.generate, updatePeriod: vi.fn(), comparisonMode: 'none', updateComparisonMode: vi.fn(),
      comparisonMetrics: null, loadingComparison: false,
    };
  },
  getPreviousPeriodDates: () => ({ start: null, end: null }),
  generateStatementsRaw: vi.fn(),
}));
vi.mock('@/hooks/useStatementOfCashFlows', () => ({
  useStatementOfCashFlows: (_s: unknown, _e: unknown, o?: { enabled?: boolean }) => {
    mocks.cashFlowEnabled.push(o?.enabled !== false);
    return { data: null, error: null, loading: false, reload: vi.fn() };
  },
  flattenCashFlowStatement: () => [],
}));
vi.mock('@/hooks/useFinIncomeStatement', () => ({
  useFinIncomeStatement: (s: unknown, _e: unknown, o?: { enabled?: boolean } | boolean) => {
    if (s === null) return { data: null, error: null, loading: false, reload: vi.fn() }; // comparison period: off
    mocks.incomeEnabled.push(typeof o === 'boolean' ? o : o?.enabled !== false);
    return { data: null, error: null, loading: false, reload: vi.fn() };
  },
  buildFinIncomeRows: () => [],
  convertToFinIncomeStatement: () => null,
}));
vi.mock('@/components/cfo/BalanceSheetPanel', () => ({ default: () => <div>BALANCE SHEET PANEL</div> }));
vi.mock('@/components/cfo/ComprehensiveCashMovement', () => ({ ComprehensiveCashMovement: () => <div>CASH MOVEMENT PANEL</div> }));
vi.mock('@/components/cfo/BudgetApprovalPanel', () => ({ default: () => <div>BUDGET PANEL</div> }));
vi.mock('@/components/cfo/FinIncomeStatementSection', () => ({ default: () => <div>INCOME PANEL</div> }));
vi.mock('@/components/cfo/LedgerDrillDownDialog', () => ({ LedgerDrillDownDialog: () => null }));

import { FinancialStatementsPanel } from '@/components/manager/FinancialStatementsPanel';

const last = (a: boolean[]) => a[a.length - 1];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generate.mockResolvedValue(undefined);
  mocks.cashFlowEnabled.length = 0;
  mocks.incomeEnabled.length = 0;
  mocks.data = null;
});

describe('Financial Statements loads one report per selected tab', () => {
  it('opens on the Balance Sheet without starting the general run, Cash Flow or Income', () => {
    render(<FinancialStatementsPanel />);
    expect(screen.getByText('BALANCE SHEET PANEL')).toBeTruthy();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(last(mocks.cashFlowEnabled)).toBe(false);
    expect(last(mocks.incomeEnabled)).toBe(false);
  });

  it('starts only the Cash Flow report on the Cash Flow tab, and only the Income report on the Income tab', () => {
    render(<FinancialStatementsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^Cash Flow$/ }));
    expect(last(mocks.cashFlowEnabled)).toBe(true);
    expect(last(mocks.incomeEnabled)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^Income Statement$/ }));
    expect(last(mocks.cashFlowEnabled)).toBe(false);
    expect(last(mocks.incomeEnabled)).toBe(true);
    expect(screen.getByText('INCOME PANEL')).toBeTruthy();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('runs the general statements once when Facilitated Volume is selected', async () => {
    render(<FinancialStatementsPanel />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Facilitated Volume$/ })); });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /^Balance Sheet$/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Facilitated Volume$/ })); });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('changing the period on the Cash Flow tab does not start the general run', async () => {
    render(<FinancialStatementsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^Cash Flow$/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'This Year' })); });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('the Generate button still runs the general statements on request', async () => {
    render(<FinancialStatementsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^Cash Flow$/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Generate Statements/ })); });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });
});
