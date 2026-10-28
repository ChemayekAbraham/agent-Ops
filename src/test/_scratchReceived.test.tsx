import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { format, subDays } from 'date-fns';
import { formatUGX } from '@/lib/creditFeeCalculations';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { ReceivedByCategory } from '@/components/cfo/ReceivedByCategory';

const kampalaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });
const yesterday = () => format(subDays(new Date(`${kampalaToday()}T00:00:00Z`), 1), 'yyyy-MM-dd');
const cat = (key: string, label: string, nature: string, amount: number, tx_count: number, sort_order: number) =>
  ({ category_key: key, category_label: label, nature, amount, tx_count, pct: 0, sort_order });
const estimateTotals = [
  cat('partner', 'Partner Products and Services', 'capital', 2_800_000, 28, 1),
  cat('land', 'Land Products and Services', 'recovery', 1_400_000, 14, 2),
  cat('agent', 'Agent Products and Services', 'recovery', 280_000, 4, 3),
  cat('fees', 'Fees and Service Income', 'income', 560_000, 8, 4),
  cat('other_income', 'Other Income', 'income', 0, 0, 5),
  cat('capital', 'Share Capital', 'capital', 0, 0, 6),
];
const selectedTotals = estimateTotals.map(c => ({ ...c, amount: c.amount * 9, pct: 100 / 6 }));

function renderReport() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<ReceivedByCategory />, { wrapper });
}

const settled = (n: number) => {
  try {
    screen.getByText(formatUGX(n));
    return 'FOUND';
  } catch {
    return 'missing';
  }
};

describe('scratch settle', () => {
  it('reports when the figure becomes queryable', async () => {
    vi.clearAllMocks();
    mocks.rpc.mockImplementation(async (name: string, args: any = {}) => {
      if (name === 'get_cfo_received_by_category_totals') {
        return { data: args.p_to === yesterday() ? estimateTotals : selectedTotals, error: null };
      }
      if (name === 'get_cfo_received_by_category_page') return { data: [], error: null };
      return { data: [], error: null };
    });
    renderReport();
    for (const ms of [0, 20, 100, 300, 1000]) {
      await new Promise(r => setTimeout(r, ms));
      console.log('SETTLE>>>', ms, settled(700_000));
    }
    expect(true).toBe(true);
  });
});
