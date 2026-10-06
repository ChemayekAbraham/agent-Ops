import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import { ShortfallTrendCard } from './ShortfallTrendCard';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

const day = (d: string, exp: number, col: number, plans: number, pct: number | null) => ({
  day: d, expected_ugx: String(exp), collected_ugx: String(col), short_ugx: String(exp - col), short_plans: plans, covered_pct: pct === null ? null : String(pct),
});

describe('ShortfallTrendCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for 30 days first and lists each billed day with exact UGX, skipping days before billing began', async () => {
    rpcMock.mockResolvedValue({
      data: [day('2026-09-08', 0, 0, 0, null), day('2026-10-04', 7000000, 4000000, 300, 57.1), day('2026-10-05', 8129123, 913106, 396, 11.2)],
      error: null,
    });
    render(<ShortfallTrendCard />, { wrapper });

    const table = await screen.findByTestId('shortfall-trend-data');
    expect(rpcMock).toHaveBeenCalledWith('tops_shortfall_daily_trend', { p_days: 30 });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);                       // the 2026-09-08 zero day is not drawn
    expect(rows[0]).toHaveTextContent('2026-10-04');
    expect(rows[0]).toHaveTextContent('3,000,000');     // short = expected - collected, from the server
    expect(rows[0]).toHaveTextContent('57.1%');
    expect(rows[1]).toHaveTextContent('7,216,017');
    expect(rows[1]).toHaveTextContent('396');
  });

  it('switches between 7, 30 and 90 days', async () => {
    const user = userEvent.setup();
    rpcMock.mockResolvedValue({ data: [day('2026-10-05', 1000, 400, 3, 40)], error: null });
    render(<ShortfallTrendCard />, { wrapper });
    await screen.findByTestId('shortfall-trend-data');

    const group = screen.getByRole('group', { name: 'Trend window' });
    expect(within(group).getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(group).getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('tops_shortfall_daily_trend', { p_days: 7 }));
    await user.click(within(group).getByRole('button', { name: '90 days' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('tops_shortfall_daily_trend', { p_days: 90 }));
    expect(within(group).getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says so when nothing was billed, and when the trend cannot load', async () => {
    rpcMock.mockResolvedValueOnce({ data: [day('2026-09-08', 0, 0, 0, null)], error: null });
    const { unmount } = render(<ShortfallTrendCard />, { wrapper });
    expect(await screen.findByText(/No Rent Plans were billed/)).toBeInTheDocument();
    unmount();

    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'not authorized' } });
    render(<ShortfallTrendCard />, { wrapper });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load the trend/);
  });
});
