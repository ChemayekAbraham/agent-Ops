import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { format, subDays } from 'date-fns';
import { formatUGX } from '@/lib/creditFeeCalculations';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { ReceivedByCategory } from '@/components/cfo/ReceivedByCategory';

const kampalaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });
const yesterday = () => format(subDays(new Date(`${kampalaToday()}T00:00:00Z`), 1), 'yyyy-MM-dd');

const cat = (
  key: string, label: string, nature: 'income' | 'capital' | 'recovery',
  amount: number, tx_count: number, sort_order: number,
) => ({ category_key: key, category_label: label, nature, amount, tx_count, pct: 0, sort_order });

// The 28-day estimate window: each amount divides by 28 exactly.
const estimateTotals = [
  cat('partner', 'Partner Products and Services', 'capital', 2_800_000, 28, 1),
  cat('land', 'Land Products and Services', 'recovery', 1_400_000, 14, 2),
  cat('agent', 'Agent Products and Services', 'recovery', 280_000, 4, 3),
  cat('fees', 'Fees and Service Income', 'income', 560_000, 8, 4),
  cat('other_income', 'Other Income', 'income', 0, 0, 5),
  cat('capital', 'Share Capital', 'capital', 0, 0, 6),
];

// A clearly different figure for the period actually selected on screen, so a
// panel that reused the on-screen totals instead of its own window would fail.
const selectedTotals = estimateTotals.map(c => ({ ...c, amount: c.amount * 9, pct: 100 / 6 }));

const flat = (s: string) => s.replace(/[\s\u00a0\u202f]/g, '');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (name: string, args: any = {}) => {
    if (name === 'get_cfo_received_by_category_totals') {
      return { data: args.p_to === yesterday() ? estimateTotals : selectedTotals, error: null };
    }
    if (name === 'get_cfo_received_by_category_page') return { data: [], error: null };
    return { data: [], error: null };
  });
});

function renderReport() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<ReceivedByCategory />, { wrapper });
}

const panel = () => screen.getByText(/^Estimate only:/).closest('div') as HTMLElement;

describe('CFO Money In — next 7 days projection', () => {
  it('projects each category as its 28-day daily average multiplied by seven', async () => {
    renderReport();
    await screen.findByText('Projected Money In — next 7 days');

    // 2,800,000 / 28 = 100,000 a day -> 700,000 over seven days.
    await waitFor(() => expect(within(panel()).getByText(formatUGX(700_000))).toBeInTheDocument());
    expect(within(panel()).getByText('about ' + formatUGX(100_000) + ' a day')).toBeInTheDocument();
    expect(within(panel()).getByText(formatUGX(350_000))).toBeInTheDocument(); // land 1,400,000/28*7
    expect(within(panel()).getByText(formatUGX(140_000))).toBeInTheDocument(); // fees 560,000/28*7
    expect(within(panel()).getByText(formatUGX(70_000))).toBeInTheDocument();  // agent 280,000/28*7
  });

  it('shows the projected grand total from the estimate window, not the selected period', async () => {
    renderReport();
    await screen.findByText('Projected Money In — next 7 days');
    await waitFor(() => expect(panel().textContent).toContain(formatUGX(1_260_000)));

    const selectedGrand = flat(
      selectedTotals.reduce((s, c) => s + c.amount, 0).toLocaleString('en-US'),
    );
    expect(flat(panel().textContent)).not.toContain(selectedGrand);
    // Genuine income (fees only) is called out on its own line.
    expect(flat(panel().textContent)).toContain(flat(formatUGX(140_000)));
  });

  it('states that the figure is an estimate that ignores the selected date period', async () => {
    renderReport();
    await screen.findByText('Projected Money In — next 7 days');
    await waitFor(() => expect(panel()).toBeInTheDocument());
    const note = screen.getByText(/^Estimate only:/).textContent ?? '';
    expect(note).toContain('average received per day over the last 28 days');
    expect(note).toContain('does not look at');
    expect(note).toContain('stays the same');
  });
});
