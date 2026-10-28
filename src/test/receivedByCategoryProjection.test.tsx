import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
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

// The 28-day estimate window: every amount divides by 28 exactly.
const estimateTotals = [
  cat('partner', 'Partner Products and Services', 'capital', 2_800_000, 28, 1),
  cat('land', 'Land Products and Services', 'recovery', 1_400_000, 14, 2),
  cat('agent', 'Agent Products and Services', 'recovery', 280_000, 4, 3),
  cat('fees', 'Fees and Service Income', 'income', 560_000, 8, 4),
  cat('other_income', 'Other Income', 'income', 0, 0, 5),
  cat('capital', 'Share Capital', 'capital', 0, 0, 6),
];

// A clearly different figure for the period actually selected on screen (9x), so a
// panel that reused the on-screen totals instead of its own 28-day window fails.
const selectedTotals = estimateTotals.map(c => ({ ...c, amount: c.amount * 9, pct: 100 / 6 }));

/**
 * formatUGX separates "UGX" from the figure with a non-breaking space, and the
 * text queries normalize the page but not the expected string, so amounts are
 * matched with a regex built from the same formatter.
 */
const money = (n: number) =>
  new RegExp('^' + formatUGX(n).replace(/\s+/g, ' ').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
const perDay = (n: number) =>
  new RegExp('^about ' + formatUGX(n).replace(/\s+/g, ' ').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' a day$');
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
    // Partner: 2,800,000 over 28 days = 100,000 a day -> 700,000 across seven days.
    await screen.findByText(money(700_000));

    const cards = within(panel());
    expect(cards.getByText(perDay(100_000))).toBeInTheDocument();
    expect(cards.getByText(money(350_000))).toBeInTheDocument(); // land 1,400,000/28*7
    expect(cards.getByText(money(140_000))).toBeInTheDocument(); // fees 560,000/28*7
    expect(cards.getByText(money(70_000))).toBeInTheDocument();  // agent 280,000/28*7
    expect(cards.getByText(perDay(10_000))).toBeInTheDocument();
  });

  it('shows the projected grand total from the estimate window, not the selected period', async () => {
    renderReport();
    // 1,260,000 is the estimate-window grand total; the selected period is 9x (36,360,000).
    await screen.findByText(money(1_260_000));

    const text = flat(panel().textContent ?? '');
    expect(text).toContain(flat(formatUGX(1_260_000)));
    expect(text).not.toContain(flat(formatUGX(36_360_000)));
    // Genuine income (fees only) is called out on its own line.
    expect(text).toContain('genuineincomeabout' + flat(formatUGX(140_000)));
  });

  it('states that the figure is an estimate that ignores the selected date period', async () => {
    renderReport();
    await screen.findByText(money(700_000));
    const note = screen.getByText(/^Estimate only:/).textContent ?? '';
    expect(note).toContain('average received per day over the last 28 days');
    expect(note).toContain('does not look at');
    expect(note).toContain('stays the same');
    // The estimate window is named: yesterday back 28 days, never today.
    const subtitle = panel().textContent ?? '';
    expect(subtitle).toContain(format(new Date(`${yesterday()}T00:00:00Z`), 'd MMM yyyy'));
    expect(subtitle).toContain('Kampala days');
  });
});
