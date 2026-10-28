import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { addDays, format, subDays } from 'date-fns';
import { formatUGX } from '@/lib/creditFeeCalculations';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
import { PaidByCategory } from '@/components/cfo/PaidByCategory';

const kampalaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });
const today = () => kampalaToday();
const windowEnd = () => format(addDays(new Date(`${today()}T00:00:00Z`), 7), 'yyyy-MM-dd');
const yesterday = () => format(subDays(new Date(`${today()}T00:00:00Z`), 1), 'yyyy-MM-dd');

const cat = (key: string, label: string, amount: number, tx_count: number, sort_order: number) =>
  ({ category_key: key, category_label: label, amount, tx_count, pct: 0, sort_order });

/**
 * The 28-day estimate window. Every amount divides by 28 exactly, so the projected
 * seven-day figure and the daily figure are known down to the shilling.
 */
const estimateTotals = [
  cat('partner', 'Partner Products and Services', 2_800_000, 28, 1),
  cat('landlord_float', 'Landlord Float', 1_400_000, 14, 2),
  cat('agent', 'Agent Commissions', 560_000, 8, 3),
];

/** A clearly different figure (9x) for the period actually selected on screen. */
const selectedTotals = estimateTotals.map(c => ({ ...c, amount: c.amount * 9, pct: 100 / 3 }));

/** Server payables schedule for the next seven days (server-computed figures). */
const dueRange = {
  currency: 'UGX',
  from: today(),
  to: windowEnd(),
  business_date: today(),
  due_in_range: 7_500_000,
  item_count: 12,
  overdue: 1_250_000,
  outstanding: 40_000_000,
  paid_in_range: 3_000_000,
  rows: [],
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const money = (n: number) => new RegExp('^' + esc(formatUGX(n).replace(/\s+/g, ' ').trim()) + '$');
const perDay = (n: number) =>
  new RegExp('^about ' + esc(formatUGX(n).replace(/\s+/g, ' ').trim()) + ' a day$');
const flat = (s: string) => s.replace(/[\s\u00a0\u202f]/g, '');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (name: string, args: any = {}) => {
    if (name === 'get_cfo_paid_by_category_totals') {
      return { data: args.p_to === yesterday() ? estimateTotals : selectedTotals, error: null };
    }
    if (name === 'get_payables_due_range') return { data: dueRange, error: null };
    if (name === 'get_cfo_paid_by_category_page') return { data: [], error: null };
    return { data: [], error: null };
  });
});

function renderReport() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<PaidByCategory />, { wrapper });
}

/** The footnote <p> is a direct child of the panel, so its closest div is the panel. */
const panel = () => screen.getByText(/^The figure at the top/).closest('div') as HTMLElement;

describe('CFO Money Out — next 7 days', () => {
  it('shows the payables the server says fall due in the next seven days', async () => {
    renderReport();
    await screen.findByText(money(7_500_000));

    const text = flat(panel().textContent ?? '');
    expect(text).toContain('12commitmentsdue');
    expect(text).toContain(flat(formatUGX(1_250_000)));   // already overdue
    expect(text).toContain(flat(formatUGX(40_000_000)));  // outstanding overall
  });

  it('asks the server for today through day seven', async () => {
    renderReport();
    await screen.findByText(money(7_500_000));
    expect(mocks.rpc).toHaveBeenCalledWith('get_payables_due_range',
      expect.objectContaining({ p_from: today(), p_to: windowEnd() }));
  });

  it('estimates the run rate from the 28-day window, not the selected period', async () => {
    renderReport();
    // Partner: 2,800,000 over 28 days = 100,000 a day -> 700,000 across seven days.
    await within(panel()).findByText(money(700_000));

    const cards = panel();
    expect(within(cards).getByText(perDay(100_000))).toBeInTheDocument();
    expect(within(cards).getByText(money(350_000))).toBeInTheDocument(); // landlord float
    expect(within(cards).getByText(money(140_000))).toBeInTheDocument();  // agent commissions
    // Grand pace figure: (2,800,000 + 1,400,000 + 560,000) / 28 * 7.
    expect(within(cards).getByText(money(1_190_000))).toBeInTheDocument();
    // The selected period is 9x (10,710,000 across seven days) and must not leak in.
    expect(flat(cards.textContent ?? '')).not.toContain(flat(formatUGX(10_710_000)));
  });

  it('shows Unavailable, not UGX 0, when the payables schedule refuses the read', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_payables_due_range') {
        return { data: null, error: { code: '42501', message: 'Not authorised to view payables' } };
      }
      if (name === 'get_cfo_paid_by_category_totals') return { data: estimateTotals, error: null };
      return { data: [], error: null };
    });
    renderReport();
    await within(panel()).findByText(money(700_000));
    const cards = panel();
    expect(within(cards).getByText('Unavailable')).toBeInTheDocument();
    expect(flat(cards.textContent ?? '')).not.toContain('UGX0');
  });

  it('shows Unavailable for an answer that carries no payables figure', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_payables_due_range') return { data: [], error: null };
      if (name === 'get_cfo_paid_by_category_totals') return { data: estimateTotals, error: null };
      return { data: [], error: null };
    });
    renderReport();
    await within(panel()).findByText(money(700_000));
    const cards = panel();
    expect(within(cards).getByText('Unavailable')).toBeInTheDocument();
    expect(flat(cards.textContent ?? '')).not.toContain('UGX0');
  });
});
