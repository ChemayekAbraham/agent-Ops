import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a) } }));

import { First7DaysTab } from '../First7DaysTab';
import { kampalaToday, addDays } from '@/lib/newTenantFirst7';

const TODAY = kampalaToday();
const YESTERDAY = addDays(TODAY, -1);

const raw = (over: Record<string, unknown> = {}) => ({
  rent_request_id: 'rr-1', tenant_id: 't-1', tenant_name: 'Amina Nakato', tenant_phone: '0772000111', agent_id: 'a-1', agent_name: 'Joy Namukasa',
  landlord_paid_on: addDays(TODAY, -4), day1: addDays(TODAY, -3), frequency: 'daily', daily_due: 10000, total_repayment: 300000,
  day_paid: [10000, 0, 5000, 0, 0, 0, 0], day_due: [10000, 10000, 10000, 10000, 10000, 10000, 10000],
  day_state: ['paid', 'missed', 'part', 'future', 'future', 'future', 'future'], paid_7d: 15000, expected_to_date: 30000, first_paid_day: 1, row_status: 'behind', ...over,
});
const weekly = raw({
  rent_request_id: 'rr-2', tenant_name: 'Bosco Ouma', agent_name: 'Peter Kato', frequency: 'weekly', daily_due: 10000,
  day_paid: [70000, 0, 0, 0, 0, 0, 0], day_due: [70000, 0, 0, 0, 0, 0, 0], day_state: ['paid', 'not_due', 'not_due', 'future', 'future', 'future', 'future'],
  paid_7d: 70000, expected_to_date: 70000, row_status: 'on_track',
});
const idle = raw({
  rent_request_id: 'rr-3', tenant_name: 'Carol Auma', agent_name: 'Joy Namukasa', day_paid: [0, 0, 0, 0, 0, 0, 0], day_state: ['missed', 'missed', 'missed', 'future', 'future', 'future', 'future'],
  paid_7d: 0, expected_to_date: 30000, first_paid_day: null, row_status: 'not_started',
});
const summary = {
  from: YESTERDAY, to: YESTERDAY, as_at: TODAY, plans: 3, daily_plans: 2, weekly_plans: 1, status: { on_track: 1, behind: 1, not_started: 1, too_early: 0 },
  day1: { started: 3, payers: 2, pct: 66.7 },
  per_day: Array.from({ length: 7 }, (_, i) => ({ day: i + 1, started: i < 3 ? 3 : 0, payers: i === 0 ? 2 : i === 2 ? 1 : 0, paid_amount: 0, due_amount: 0, states: { paid: 0, part: 0, missed: 0, not_due: 0, future: 0 } })),
  collected: 85000, expected: 130000, collected_pct: 65.4, generated_at: new Date().toISOString(),
};

const answer = (rows: unknown[] = [raw(), weekly, idle], sum: unknown = summary) => {
  rpcMock.mockImplementation((fn: string) => Promise.resolve(
    fn === 'am_new_tenant_first7_v2' ? { data: rows, error: null } : fn === 'am_new_tenant_first7_summary_v2' ? { data: sum, error: null } : { data: null, error: { message: `unexpected ${fn}` } }));
};

function Where() { const l = useLocation(); return <p data-testid="where">{l.search}</p>; }
const renderTab = (url = '/agent-ops') => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}><First7DaysTab /><Where /></MemoryRouter>
    </QueryClientProvider>,
  );
};
const where = () => screen.getByTestId('where').textContent;

beforeEach(() => { rpcMock.mockReset(); window.innerWidth = 1280; });

describe('First7DaysTab', () => {
  it('opens on Yesterday and asks the v2 functions for that day (no frequency when All)', async () => {
    answer();
    renderTab();
    await screen.findByText('Amina Nakato');
    expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_v2', { p_from: YESTERDAY, p_to: YESTERDAY });
    expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_summary_v2', { p_from: YESTERDAY, p_to: YESTERDAY });
    expect(screen.getByRole('button', { name: 'Yesterday' })).toHaveAttribute('aria-pressed', 'true');
    expect(where()).toBe('');
  });

  it('presets, the Daily / Weekly toggle and the search are kept in the URL and sent to the server', async () => {
    answer();
    renderTab();
    await screen.findByText('Amina Nakato');
    await userEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(where()).toContain(`f7from=${addDays(TODAY, -6)}`));
    expect(where()).toContain(`f7to=${TODAY}`);
    await userEvent.click(screen.getByRole('button', { name: 'Weekly' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_v2', { p_from: addDays(TODAY, -6), p_to: TODAY, p_frequency: 'weekly' }));
    expect(where()).toContain('f7freq=weekly');
    await userEvent.type(screen.getByLabelText('Search agent or tenant'), 'peter');
    expect(where()).toContain('f7q=peter');
    await waitFor(() => expect(screen.queryByText('Amina Nakato')).not.toBeInTheDocument());
    expect(screen.getByText('Bosco Ouma')).toBeInTheDocument();
  }, 20000);

  it('reads the controls back from a shared link', async () => {
    answer();
    renderTab(`/agent-ops?f7from=${addDays(TODAY, -6)}&f7to=${TODAY}&f7freq=daily&f7card=behind`);
    await screen.findByText('Amina Nakato');
    expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_v2', { p_from: addDays(TODAY, -6), p_to: TODAY, p_frequency: 'daily' });
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Daily' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Bosco Ouma')).not.toBeInTheDocument();
    expect(screen.queryByText('Carol Auma')).not.toBeInTheDocument();
  });

  it('Custom shows two date boxes that never allow more than 31 days', async () => {
    answer();
    renderTab();
    await screen.findByText('Amina Nakato');
    await userEvent.click(screen.getByRole('button', { name: 'Custom' }));
    const from = screen.getByLabelText('From') as HTMLInputElement;
    expect(screen.getByLabelText('To')).toBeInTheDocument();
    expect(from.max).toBe(TODAY);
    fireEvent.change(from, { target: { value: addDays(TODAY, -60) } });
    await waitFor(() => expect(where()).toContain(`f7to=${addDays(addDays(TODAY, -60), 30)}`));
  });

  it('shows the six summary cards from the server figures, and clicking one filters the grid and the URL', async () => {
    answer();
    renderTab();
    await screen.findByText('Amina Nakato');
    for (const label of ['New Rent Plans', 'Paid on day 1', 'On track', 'Behind', 'Not started', 'Too early']) expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Paid on day 1/ })).toHaveTextContent('66.7% of 3 started');
    await userEvent.click(screen.getByRole('button', { name: /^Behind/ }));
    expect(where()).toContain('f7card=behind');
    expect(screen.getByText('Amina Nakato')).toBeInTheDocument();
    expect(screen.queryByText('Bosco Ouma')).not.toBeInTheDocument();
    expect(screen.queryByText('Carol Auma')).not.toBeInTheDocument();
    expect(screen.getByText(/Showing/)).toHaveTextContent('Showing 1 of 3 plans');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('Bosco Ouma')).toBeInTheDocument();
    expect(where()).toBe('');
  });

  it('the day chips (the chart bars) filter to the plans that paid that day', async () => {
    answer();
    renderTab();
    await screen.findByText('Amina Nakato');
    await userEvent.click(screen.getByRole('button', { name: /^Day 3 · 1\/3/ }));
    expect(where()).toContain('f7day=3');
    expect(screen.getByText('Amina Nakato')).toBeInTheDocument();
    expect(screen.queryByText('Carol Auma')).not.toBeInTheDocument();
    expect(screen.queryByText('Bosco Ouma')).not.toBeInTheDocument();
  });

  it('lists behind and not-started plans first', async () => {
    answer([weekly, idle, raw()]);
    renderTab();
    await screen.findByText('Amina Nakato');
    const names = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);
    expect(names[0]).toContain('Amina Nakato');
    expect(names[1]).toContain('Carol Auma');
    expect(names[2]).toContain('Bosco Ouma');
  });

  it('a daily row has seven coloured day cells; a weekly row highlights the due day and shows the rest as not due', async () => {
    answer();
    renderTab();
    const daily = (await screen.findByText('Amina Nakato')).closest('tr')!;
    const dayCells = within(daily).getAllByTitle(/^Day \d/);
    expect(dayCells).toHaveLength(7);
    expect(dayCells[0]).toHaveTextContent('UGX 10,000');
    expect(dayCells[0].className).toContain('bg-success/15');
    expect(dayCells[1]).toHaveTextContent('Missed');
    expect(dayCells[1].className).toContain('bg-destructive/15');
    expect(dayCells[2]).toHaveTextContent('UGX 5,000');
    expect(dayCells[2].className).toContain('bg-warning/15');
    expect(dayCells[3].className).toContain('bg-muted/40');
    expect(daily.querySelector('.ring-primary')).toBeNull();

    const wk = screen.getByText('Bosco Ouma').closest('tr')!;
    const wCells = within(wk).getAllByTitle(/^Day \d/);
    expect(wCells[0].className).toContain('ring-primary');
    expect(wCells[0]).toHaveTextContent('UGX 70,000');
    for (const c of wCells.slice(1)) { expect(c).toHaveTextContent('not due'); expect(c.className).not.toContain('ring-primary'); }
    expect(within(wk).getByText(/Weekly · UGX 70,000 \/ week/)).toBeInTheDocument();
  });

  it('shows every amount as UGX with the server\'s paid and due so far, and the collected strip', async () => {
    answer();
    renderTab();
    const daily = (await screen.findByText('Amina Nakato')).closest('tr')!;
    expect(within(daily).getByText('UGX 15,000')).toBeInTheDocument();
    expect(within(daily).getByText('of UGX 30,000 due')).toBeInTheDocument();
    expect(within(daily).getByText('Behind')).toBeInTheDocument();
    expect(screen.getByText(/Collected UGX 85,000/)).toHaveTextContent('of UGX 130,000 due so far');
    expect(screen.getByText('65.4%')).toBeInTheDocument();
  });

  it('on a phone it shows cards with a 7-dot strip instead of the table', async () => {
    window.innerWidth = 400;
    answer();
    renderTab();
    await screen.findByText('Amina Nakato');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const strip = screen.getAllByRole('img', { name: /Day 1 paid, Day 2 missed, Day 3 part paid/ })[0];
    expect(strip.querySelectorAll('span')).toHaveLength(7);
    expect(within(screen.getByRole('list')).getAllByText('Behind')).toHaveLength(1);
  });

  it('shows skeletons while loading', async () => {
    rpcMock.mockReturnValue(new Promise(() => {}));
    renderTab();
    expect(await screen.findByLabelText('Loading First 7 Days')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows an empty state when no plan was first paid in the range', async () => {
    answer([], { ...summary, plans: 0, daily_plans: 0, weekly_plans: 0, status: { on_track: 0, behind: 0, not_started: 0, too_early: 0 }, day1: { started: 0, payers: 0, pct: null }, per_day: [], collected: 0, expected: 0, collected_pct: null });
    renderTab();
    expect(await screen.findByText('No new Rent Plans in this range')).toBeInTheDocument();
  });

  it('shows an error state with Try again, in plain words', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'Not authorized' } });
    renderTab();
    expect(await screen.findByText('Could not load First 7 Days')).toBeInTheDocument();
    expect(screen.getByText('You do not have access to Agent Monitoring.')).toBeInTheDocument();
    answer();
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Amina Nakato')).toBeInTheDocument();
  });

  it('uses only design tokens (no hard-coded colours) and never writes anything', () => {
    for (const f of ['components/executive/agent-ops/First7DaysTab.tsx', 'hooks/useNewTenantFirst7.ts', 'lib/newTenantFirst7.ts']) {
      const src = fs.readFileSync(path.resolve(process.cwd(), 'src', f), 'utf8');
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/\b(?:bg|text|border|ring|fill|stroke)-(?:red|green|amber|yellow|emerald|rose|blue|slate|gray|zinc|orange|purple)-\d{2,3}\b/);
      expect(src).not.toMatch(/\.(insert|update|upsert)\(|supabase\.from\(/);
    }
  });
});
