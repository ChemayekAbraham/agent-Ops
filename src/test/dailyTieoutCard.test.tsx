/* eslint-disable @typescript-eslint/no-explicit-any -- loose mock payloads */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rows: [] as any[], error: null as any, table: '' }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => {
      mocks.table = t;
      const chain: any = { select: () => chain, order: () => chain, limit: async () => ({ data: mocks.rows, error: mocks.error }) };
      return chain;
    },
  },
}));

import DailyTieoutCard from '@/components/cfo/DailyTieoutCard';

const wrap = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

const RUN = {
  run_date: '2026-11-11', as_at: '2026-11-11T20:30:12Z', status: 'attention', bs_difference: 0, tb_difference: 0,
  total_assets: 4912449546.08, error: null,
  cash_flow: { closing: 1958738713, balance_sheet_cash: 1958738713, ties: true, unexplained: 0 },
  ties: [
    { key: 'rent_plans', label: 'Rent Plan receivables (A3) vs Rent Plan book', ledger: 447180894, operational: 436892386, difference: 10288508 },
    { key: 'promissory_notes', label: 'Promissory notes (A7) vs activated notes not yet settled', ledger: 3891082106, operational: 3891082106, difference: 0 },
  ],
  changes: [{ key: 'rent_plans', label: 'Rent Plan receivables (A3) vs Rent Plan book', previous: 10000000, current: 10288508, moved_by: 288508 }],
};

beforeEach(() => { mocks.rows = []; mocks.error = null; });

describe('Nightly tie-out card', () => {
  it('shows the latest run: status, statement checks, each tie and what moved since the previous night', async () => {
    mocks.rows = [RUN];
    render(<DailyTieoutCard />, { wrapper: wrap });
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(mocks.table).toBe('fin_daily_tieout');
    expect(screen.getByText(/Balance Sheet: assets = liabilities \+ equity/)).toBeTruthy();
    expect(screen.getByText(/Cash Flow: closing cash/)).toBeTruthy();
    expect(screen.getByText('Rent Plan receivables (A3) vs Rent Plan book')).toBeTruthy();
    expect(screen.getByText(/^\+/)).toBeTruthy(); // moved since previous night
    expect(screen.getByText('unchanged')).toBeTruthy(); // promissory notes did not move
  });

  it('says when no run has happened yet', async () => {
    render(<DailyTieoutCard />, { wrapper: wrap });
    expect(await screen.findByText(/No tie-out has run yet/)).toBeTruthy();
  });

  it('shows a failed run and its reason', async () => {
    mocks.rows = [{ ...RUN, status: 'failed', error: 'Balance Sheet: canceling statement due to statement timeout', changes: [] }];
    render(<DailyTieoutCard />, { wrapper: wrap });
    expect(await screen.findByText('Run failed')).toBeTruthy();
    expect(screen.getByText(/canceling statement due to statement timeout/)).toBeTruthy();
  });
});
