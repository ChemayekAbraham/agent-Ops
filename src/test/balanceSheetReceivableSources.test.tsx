/* eslint-disable @typescript-eslint/no-explicit-any -- loose mock payloads */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assetSourceLabel } from '@/components/cfo/balanceSheetClassification';

/**
 * Balance Sheet: the receivables pop-up names the ledger sources that make up the line (CFO, 11 Nov 2026).
 * Figures are today's production values for the partner line: A7 promissory notes 3,891,082,106 and
 * A26 shares paid from company float 3,352,500; the operational records still show 4,413,987,106 of notes.
 */
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: vi.fn() } }));
vi.mock('@/hooks/useReceivables', () => ({
  useReceivablesBreakdown: () => ({
    isLoading: false, error: null,
    data: { categories: [{ key: 'partner', label: 'Partner Products & Services', products: [
      { key: 'promissory_note', label: 'Promissory Notes', outstanding: 4413987106 },
    ] }] },
  }),
}));

import BalanceSheetPanel from '@/components/cfo/BalanceSheetPanel';

const line = (code: string, label: string, value: number) =>
  ({ label, value, source: `general_ledger trial balance — account ${code}` });

const STATEMENT = {
  as_at: '2026-11-11T20:59:59Z', generated_at: '2026-11-11T12:00:00Z', currency: 'UGX',
  assets: {
    current: [
      line('A7', 'Partner Product Receivables', 3891082106),
      line('A26', 'Receivable from shareholders — shares paid from company float', 3352500),
      line('A23', 'Receivable from Pius — Angel Pool share', 0),
    ],
    non_current: [], total_current: 3894434606, total_non_current: 0, total: 3894434606,
  },
  liabilities: { current: [], non_current: [], total_current: 0, total_non_current: 0, total: 0 },
  equity: { lines: [line('E1', "Shareholders' Capital Contributions", 3894434606)], revenue_to_date: 0, expenses_to_date: 0, total: 3894434606 },
  trial_balance: { total_debits: 0, total_credits: 0, difference: 0, balanced: true },
  reconciliation: { memo_sub_ledgers: [], schedule: [], excluded_classifications: [], plug_applied: false, suspense_amount: 0, unreconciled_difference: 0,
    one_sided_groups: 0, one_sided_absolute_amount: 0, one_sided_equity_counterpart: 0, unresolved_groups: 0, unresolved_absolute_amount: 0 },
  balance_check: { total_assets: 3894434606, total_liabilities_and_equity: 3894434606, difference: 0, balanced: true, state: 'balanced', message: '' },
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(<BalanceSheetPanel />, { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'fin_balance_sheet' || name === 'get_statement_of_financial_position') return { data: STATEMENT, error: null };
    return { data: null, error: null };
  });
});

describe('ledger source names', () => {
  it('names each partner source with its account code', () => {
    expect(assetSourceLabel(line('A7', 'Partner Product Receivables', 1))).toBe('Promissory notes signed by partners — not yet paid (A7)');
    expect(assetSourceLabel(line('A26', 'x', 1))).toBe('Shares paid from company float — owed by shareholders (A26)');
    expect(assetSourceLabel(line('A99', 'Something new', 1))).toBe('Something new (A99)');
    expect(assetSourceLabel({ label: 'No code', value: 1 })).toBe('No code');
  });
});

describe('Balance Sheet partner receivables pop-up', () => {
  it('lists the ledger sources that add up to the line, then the operational records as a comparison', async () => {
    renderPanel();
    const row = await screen.findByText('Receivables from Partner Products and Services', {}, { timeout: 5000 });
    fireEvent.click(row);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('Recorded in the ledger')).toBeTruthy());
    expect(within(dialog).getByText('Promissory notes signed by partners — not yet paid (A7)')).toBeTruthy();
    expect(within(dialog).getByText('Shares paid from company float — owed by shareholders (A26)')).toBeTruthy();
    expect(within(dialog).queryByText(/Angel Pool share paid from company float/)).toBeNull(); // zero balance left out
    expect(within(dialog).getByText('Total on the Balance Sheet')).toBeTruthy();
    expect(within(dialog).getByText('Operational records (comparison)')).toBeTruthy();
    expect(within(dialog).getByText(/Differs from the ledger by/)).toBeTruthy();
  });
});
