import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    // The recent-transactions read is a plain table select; stub the whole chain.
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
        }),
      }),
    }),
  },
}));

import { CashPositionInsights } from '@/components/cfo/CashPositionInsights';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (name: string, args: any = {}) => {
    if (name === 'get_cfo_daily_cash_flow') {
      const days = Number(args.p_days);
      return {
        data: Array.from({ length: days }, (_, i) => ({
          day: `2026-10-${String(25 - i).padStart(2, '0')}`,
          inflow: 1_000_000,
          outflow: 400_000,
        })),
        error: null,
      };
    }
    if (name === 'get_payables_due_range') {
      return { data: { outstanding: 0, due_in_range: 0 }, error: null };
    }
    return { data: [], error: null };
  });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <CashPositionInsights
      totalReceivables={0}
      receivablesCategories={[]}
      moneyWeHave={0}
      moneyWeCanUse={0}
      moneyWeOwe={0}
    />,
    { wrapper },
  );
}

describe('Cash Position overview date range', () => {
  it('lists Today alongside the rolling windows and fetches one day when chosen', async () => {
    renderPage();
    const select = await screen.findByDisplayValue('Last 30 days');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Today', 'Last 7 days', 'Last 30 days', 'Last 90 days']);

    fireEvent.change(select, { target: { value: '1' } });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('get_cfo_daily_cash_flow', { p_days: 1 }),
    );
  });

  it('labels the net movement insight as today when the range is Today', async () => {
    renderPage();
    const select = await screen.findByDisplayValue('Last 30 days');
    fireEvent.change(select, { target: { value: '1' } });
    const insight = await screen.findByText('Net cash movement positive');
    await waitFor(() =>
      expect(insight.parentElement?.textContent).toContain('UGX 600,000 today'),
    );
  });
});
