import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';

const rpcMock = vi.fn();
// like the real client, rpc only works when called on the client itself (a detached call has no `this`)
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rest: {},
    rpc(this: { rest?: unknown } | undefined, ...a: unknown[]) {
      if (!this?.rest) throw new TypeError("Cannot read properties of undefined (reading 'rest')");
      return rpcMock(...a);
    },
  },
}));
const csvMock = vi.fn();
const pdfMock = vi.fn();
vi.mock('@/lib/first7Export', async (orig) => ({ ...(await orig<typeof import('@/lib/first7Export')>()), downloadFirst7Csv: (...a: unknown[]) => csvMock(...a), generateFirst7Pdf: (...a: unknown[]) => pdfMock(...a) }));

import { First7DaysTab } from '../First7DaysTab';
import { kampalaToday, addDays } from '@/lib/newTenantFirst7';

const TODAY = kampalaToday();
const AGENT_JOY = '11111111-1111-4111-8111-111111111111';
const AGENT_PETER = '22222222-2222-4222-8222-222222222222';

const raw = (over: Record<string, unknown> = {}) => ({
  rent_request_id: 'rr-1', tenant_id: 't-1', tenant_name: 'Amina Nakato', tenant_phone: '0772000111', agent_id: AGENT_JOY, agent_name: 'Joy Namukasa',
  landlord_paid_on: addDays(TODAY, -4), day1: addDays(TODAY, -3), frequency: 'daily', daily_due: 10000, total_repayment: 300000,
  day_paid: [10000, 0, 8000, 0, 0, 0, 0], day_due: [10000, 10000, 10000, 10000, 10000, 10000, 10000],
  day_state: ['paid', 'missed', 'part', 'future', 'future', 'future', 'future'], paid_7d: 18000, expected_to_date: 30000, first_paid_day: 1, row_status: 'behind', ...over,
});
const weekly = raw({
  rent_request_id: 'rr-2', tenant_name: 'Bosco Ouma', tenant_phone: '0701000222', agent_id: AGENT_PETER, agent_name: 'Peter Kato', frequency: 'weekly',
  day_paid: [70000, 0, 0, 0, 0, 0, 0], day_due: [70000, 0, 0, 0, 0, 0, 0],
  // a malformed "missed" on a day that owes nothing must still never be red
  day_state: ['paid', 'missed', 'not_due', 'future', 'future', 'future', 'future'], paid_7d: 70000, expected_to_date: 70000, row_status: 'on_track',
});
const future = raw({
  rent_request_id: 'rr-3', tenant_name: 'Carol Auma', day_paid: [0, 0, 0, 0, 0, 0, 0], day_state: ['future', 'future', 'future', 'future', 'future', 'future', 'future'],
  paid_7d: 0, expected_to_date: 0, first_paid_day: null, row_status: 'too_early',
});
const second = raw({ rent_request_id: 'rr-4', tenant_name: 'David Ssemwogerere', row_status: 'on_track', paid_7d: 30000 });

const summary = {
  from: TODAY, to: TODAY, as_at: TODAY, plans: 4, daily_plans: 3, weekly_plans: 1, status: { on_track: 2, behind: 1, not_started: 0, too_early: 1 },
  day1: { started: 3, payers: 3, pct: 100 },
  per_day: Array.from({ length: 7 }, (_, i) => ({ day: i + 1, started: 3, payers: i === 0 ? 3 : 0, paid_amount: 0, due_amount: 0, states: { paid: 0, part: 0, missed: 0, not_due: 0, future: 0 } })),
  collected: 118000, expected: 130000, collected_pct: 90.8,
};
const day = (n: number) => addDays(TODAY, -3 + n - 1);
const payments = [
  { collection_id: 'c1', collected_at: `${day(1)}T07:15:00Z`, collected_day: day(1), day_number: 1, amount: 10000, payment_method: 'cash', collection_channel: 'agent_float', agent_id: AGENT_JOY, agent_name: 'Joy Namukasa' },
  { collection_id: 'c2', collected_at: `${day(3)}T09:00:00Z`, collected_day: day(3), day_number: 3, amount: 5000, payment_method: 'in_app_wallet', collection_channel: 'tenant_deposit_auto', agent_id: null, agent_name: null },
  { collection_id: 'c3', collected_at: `${day(3)}T12:30:00Z`, collected_day: day(3), day_number: 3, amount: 3000, payment_method: 'in_app_wallet', collection_channel: 'agent_float', agent_id: AGENT_JOY, agent_name: 'Joy Namukasa' },
];

let paymentsResult: { data: unknown; error: unknown } = { data: payments, error: null };
const answer = (rows: unknown[] = [raw(), weekly, future, second]) => {
  rpcMock.mockImplementation((fn: string) => Promise.resolve(
    fn === 'am_new_tenant_first7_v2' ? { data: rows, error: null }
      : fn === 'am_new_tenant_first7_summary_v2' ? { data: summary, error: null }
      : fn === 'am_new_tenant_first7_payments' ? paymentsResult
      : { data: null, error: { message: `unexpected ${fn}` } }));
};

function Where() { const l = useLocation(); return <p data-testid="where">{l.search}</p>; }
const renderTab = (url = '/agent-ops') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]}><First7DaysTab /><Where /></MemoryRouter>
  </QueryClientProvider>,
);
const where = () => screen.getByTestId('where').textContent;
const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

beforeEach(() => { rpcMock.mockReset(); csvMock.mockReset(); pdfMock.mockReset(); paymentsResult = { data: payments, error: null }; window.innerWidth = 1280; });

describe('First7DaysTab drill-down', () => {
  it('clicking a Rent Plan row opens a side panel with the plan, the agent, a call link and the payments', async () => {
    answer();
    renderTab();
    await userEvent.click(await rowOf('Amina Nakato'));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Amina Nakato')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: /Call Amina Nakato on 0772000111/ })).toHaveAttribute('href', 'tel:0772000111');
    expect(within(panel).getByText('Joy Namukasa', { selector: 'button' })).toBeInTheDocument();
    expect(within(panel).getByText('Landlord paid').nextElementSibling).toHaveTextContent(/\d{1,2} [A-Z][a-z]{2}/);
    expect(within(panel).getByText('Total to repay').nextElementSibling).toHaveTextContent('UGX 300,000');
    expect(within(panel).getByText('Paid in 7 days').nextElementSibling).toHaveTextContent('UGX 18,000');
    expect(within(panel).getByText('Due so far').nextElementSibling).toHaveTextContent('UGX 30,000');
    expect(within(panel).getByRole('region', { name: 'Seven-day timeline' }).querySelectorAll('li')).toHaveLength(7);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('am_new_tenant_first7_payments', { p_rent_request_id: 'rr-1' }));
    const list = await within(panel).findByRole('region', { name: 'Payments' });
    await within(list).findByText('UGX 10,000');
    expect(within(list).getByText('Cash')).toBeInTheDocument();
    expect(within(list).getByText('Wallet')).toBeInTheDocument();
    expect(within(list).getByText('Self-pay')).toBeInTheDocument();
    expect(within(list).getByText(/10:15 · Day 1 · Joy Namukasa/)).toBeInTheDocument();
    expect(within(list).getByText('3 payments · UGX 18,000')).toBeInTheDocument();
  });

  it('double-clicking a row opens it too, and Esc closes the panel', async () => {
    answer();
    renderTab();
    await userEvent.dblClick(await rowOf('Bosco Ouma'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('is keyboard accessible: a row takes focus and Enter opens it; Esc closes it', async () => {
    answer();
    renderTab();
    const row = await rowOf('Amina Nakato');
    expect(row).toHaveAttribute('tabindex', '0');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toHaveTextContent('Amina Nakato');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('clicking a day cell opens that day\'s payments only, and Show all days brings the rest back', async () => {
    answer();
    renderTab();
    const row = await rowOf('Amina Nakato');
    await userEvent.click(within(row).getAllByTitle(/^Day 3 /)[0]);
    const panel = await screen.findByRole('dialog');
    const list = await within(panel).findByRole('region', { name: 'Payments' });
    expect(within(list).getByRole('heading', { name: /Payments on day 3/ })).toBeInTheDocument();
    await within(list).findByText('UGX 5,000');
    expect(within(list).getByText('UGX 3,000')).toBeInTheDocument();
    expect(within(list).queryByText('UGX 10,000')).not.toBeInTheDocument();
    expect(within(list).getByText('2 payments · UGX 8,000')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Show all days' }));
    expect(await within(list).findByText('UGX 10,000')).toBeInTheDocument();
  });

  it('a day with no payment says so', async () => {
    answer();
    renderTab();
    const row = await rowOf('Amina Nakato');
    await userEvent.click(within(row).getAllByTitle(/^Day 2 /)[0]);
    expect(await screen.findByText('No payment was recorded on this day.')).toBeInTheDocument();
  });

  it('shows the payments error in words with Try again', async () => {
    answer();
    paymentsResult = { data: null, error: { code: '42501', message: 'Not authorized' } };
    renderTab();
    await userEvent.click(await rowOf('Amina Nakato'));
    expect(await screen.findByText('You do not have access to Agent Monitoring.')).toBeInTheDocument();
    paymentsResult = { data: payments, error: null };
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Try again/ }));
    expect(await within(await screen.findByRole('region', { name: 'Payments' })).findByText('UGX 10,000')).toBeInTheDocument();
  });

  it('clicking an agent name filters to that agent (in the URL) and shows their 7-day on-track %', async () => {
    answer();
    renderTab();
    const row = await rowOf('Amina Nakato');
    await userEvent.click(within(row).getByRole('button', { name: 'Joy Namukasa' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); // the click did not also open the row
    expect(where()).toContain(`f7agent=${AGENT_JOY}`);
    const strip = await screen.findByRole('status');
    // Joy has 3 Rent Plans; 1 is too early, 1 is on track, 1 is behind
    expect(strip).toHaveTextContent('Joy Namukasa');
    expect(strip).toHaveTextContent('50% on track');
    expect(strip).toHaveTextContent('1 of 2 Rent Plans started');
    expect(screen.queryByText('Bosco Ouma')).not.toBeInTheDocument();
    expect(screen.getByText('David Ssemwogerere')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Show all agents/ }));
    expect(screen.getByText('Bosco Ouma')).toBeInTheDocument();
    expect(where()).toBe('');
  });

  it('a shared link with an agent opens already filtered', async () => {
    answer();
    renderTab(`/agent-ops?f7agent=${AGENT_PETER}`);
    await screen.findByText('Bosco Ouma');
    expect(screen.queryByText('Amina Nakato')).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('Peter Kato');
  });

  it('weekly not-due cells are never red; future days are grey', async () => {
    answer();
    renderTab();
    const wk = await rowOf('Bosco Ouma');
    const cells = within(wk).getAllByTitle(/^Day \d/);
    for (const c of cells.slice(1)) {
      expect(c).toHaveTextContent('not due');
      expect(c.className).not.toMatch(/destructive|red/);
      expect(c.className).not.toMatch(/bg-warning|bg-success/);
    }
    const fut = await rowOf('Carol Auma');
    for (const c of within(fut).getAllByTitle(/^Day \d/)) {
      expect(c.className).toContain('bg-muted/40');
      expect(c.className).not.toMatch(/destructive/);
    }
    // a day still to come on a Rent Plan that owes it is grey in the panel's timeline too
    await userEvent.click(fut);
    const items = within(await screen.findByRole('region', { name: 'Seven-day timeline' })).getAllByRole('button');
    for (const b of items) expect(b.className).toContain('bg-muted/40');
  });

  it('Export CSV and Export PDF hand over the Rent Plans left after the filters, with the filters', async () => {
    answer();
    renderTab(`/agent-ops?f7freq=daily&f7card=on_track&f7q=david`);
    await screen.findByText('David Ssemwogerere');
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(csvMock).toHaveBeenCalledTimes(1);
    const arg = csvMock.mock.calls[0][0];
    expect(arg.rows.map((r: { tenant_name: string }) => r.tenant_name)).toEqual(['David Ssemwogerere']);
    expect(arg.totalInRange).toBe(4);
    expect(arg.params).toMatchObject({ freq: 'daily', card: 'on_track', q: 'david' });
    await userEvent.click(screen.getByRole('button', { name: /Export PDF/ }));
    await waitFor(() => expect(pdfMock).toHaveBeenCalledTimes(1));
    expect(pdfMock.mock.calls[0][0].rows).toHaveLength(1);
  });

  it('export is off when no Rent Plan is shown', async () => {
    answer();
    renderTab('/agent-ops?f7q=zzzz');
    await screen.findByText('No plans match these filters.');
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Export PDF/ })).toBeDisabled();
  });

  it('on a phone a card opens the same panel and the agent name filters', async () => {
    window.innerWidth = 400;
    answer();
    renderTab();
    const card = (await screen.findByText('Amina Nakato')).closest('li') as HTMLElement;
    await userEvent.click(card);
    expect(await screen.findByRole('dialog')).toHaveTextContent('Amina Nakato');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(within(card).getByRole('button', { name: 'Joy Namukasa' }));
    expect(where()).toContain('f7agent=');
  });
});
