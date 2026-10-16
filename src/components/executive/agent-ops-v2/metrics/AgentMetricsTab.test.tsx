import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const totalsState: { value: Record<string, unknown> } = { value: {} };
const refetch = vi.fn();
const agentRows = [
  { agent_id: 'a1', name: 'Test Agent One', phone: '+256700000001', main_agent_id: 'm1', main_agent_name: 'Main One', houses_listed: 12, houses_approved: 9, houses_pending: 3, houses_rejected: 1, top_district: 'Wakiso', gps_share: 100, listing_earned: 600000, clawed_back: 100000, net: 123456, advance_principal: 300000, advance_outstanding: 250000, advance_status: 'active', last_listing: '2026-10-15', total_matched: 1 },
];
const TOTALS = {
  as_at: '2026-10-16', range_start: '2026-09-17', range_end: '2026-10-16', basis: 'Server basis text for the totals cards.',
  agents_role: 59160, linked_subagents: 3125, qualifying_agents: 770, listers_ever: 456, listers_in_range: 29,
  houses_listed: 292, houses_verified: 220, houses_pending: 69, houses_rejected: 36, houses_with_gps: 292,
  listing_earned: 1752000, listing_clawed_back: 64000,
  advances_given_count: 5, advances_given_amount: 9300000, advances_repaid: 104024.34, advances_outstanding: 59086790.98, advances_overdue_count: 282, advances_overdue_amount: 36177592.28,
};
const ok = (extra = {}) => ({ error: null, isLoading: false, isFetching: false, isStale: false, updatedAt: Date.UTC(2026, 9, 16, 11, 30), refetch, ...extra });

const csvMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rest: {}, rpc: vi.fn() } }));
vi.mock('@/lib/csvExport', () => ({ downloadCsvWithPreamble: (...a: unknown[]) => csvMock(...a) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));
vi.mock('@/hooks/useGoogleMapsLoader', () => ({ useGoogleMapsLoader: () => ({ isReady: false, isLoading: false, isError: false, errorReason: null, hasKey: true }) }));
vi.mock('@/hooks/useAgentOpsMetrics', () => ({
  useMetricsTotals: () => totalsState.value,
  useMetricsAgents: () => ({ rows: agentRows, total: 1, debouncing: false, ...ok() }),
  useMetricsLocations: () => ({ rows: [{ region: 'Central', district: 'Wakiso', sub_county: null, houses_listed: 100, houses_verified: 80, houses_pending: 20, houses_with_gps: 100, agents: 7 }], ...ok() }),
  useMetricsPins: () => ({ rows: [], ...ok() }),
  useMetricsMainAgents: () => ({ rows: [{ main_agent_id: 'm1', name: 'Main One', phone: '+256700000009', team_size: 4, team_houses: 40, team_earnings: 900000, team_advances_outstanding: 1200000, total_matched: 1 }], total: 1, ...ok() }),
}));

import { AgentMetricsStandalone } from './AgentMetricsTab';

const show = () => render(<MemoryRouter><AgentMetricsStandalone /></MemoryRouter>);
const text = () => (document.body.textContent ?? '').replace(/\u00a0/g, ' ');
const titles = () => screen.getAllByTestId(/^metrics-card-/).map((c) => c.getAttribute('data-testid')!.replace('metrics-card-', ''));

beforeEach(() => {
  localStorage.clear();
  refetch.mockClear();
  csvMock.mockClear();
  totalsState.value = { data: TOTALS, ...ok() };
});

describe('Metrics tab', () => {
  it('stacks the eight cards in the default order and shows the server figures exactly as returned, in UGX', () => {
    show();
    expect(titles()).toEqual(['headline', 'listings', 'earnings', 'agents', 'locations', 'main-agents', 'advances', 'activity']);
    expect(screen.getByTestId('metrics-houses-listed')).toHaveTextContent('292');
    expect(screen.getByTestId('metrics-houses-verified')).toHaveTextContent('220');
    expect(screen.getByTestId('metrics-houses-pending')).toHaveTextContent('69');
    expect(screen.getByTestId('metrics-listing-earned').textContent?.replace(/\u00a0/g, ' ')).toContain('UGX 1,752,000');
    expect(screen.getByTestId('metrics-listing-clawed').textContent?.replace(/\u00a0/g, ' ')).toContain('UGX 64,000');
    expect(screen.getByTestId('metrics-adv-outstanding').textContent?.replace(/\u00a0/g, ' ')).toContain('UGX 59,086,791');
    expect(screen.getByTestId('metrics-adv-overdue-count')).toHaveTextContent('282');
    // nothing was worked out in the browser: no net of earned and clawed back on the totals card
    expect(text()).not.toContain('1,688,000');
  });

  it('shows the basis and an as-at time on every card', () => {
    show();
    for (const id of ['headline', 'listings', 'earnings', 'agents', 'locations', 'main-agents', 'advances', 'activity']) {
      const basis = screen.getByTestId(`metrics-basis-${id}`);
      expect(basis.textContent).toMatch(/As at \d{1,2} \w{3} 2026, \d{2}:\d{2} EAT/);
    }
    expect(screen.getByTestId('metrics-basis-listings')).toHaveTextContent('Server basis text for the totals cards.');
  });

  it('moves a card with the buttons, keeps the order per user in this browser, and resets it', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Move Advances up' }));
    expect(titles().indexOf('advances')).toBe(5);
    expect(JSON.parse(localStorage.getItem('agentOpsMetricsOrder:user-1')!).indexOf('advances')).toBe(5);
    expect(screen.getByRole('button', { name: 'Move Headline up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Activity down' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset order' }));
    expect(titles()[6]).toBe('advances');
    expect(localStorage.getItem('agentOpsMetricsOrder:user-1')).toBeNull();
  });

  it('opens a saved order on the next visit', () => {
    localStorage.setItem('agentOpsMetricsOrder:user-1', JSON.stringify(['advances', 'headline']));
    show();
    expect(titles().slice(0, 3)).toEqual(['advances', 'headline', 'listings']);
  });

  it('every move button and the collapse toggle is at least 44px (h-11 / min-h-11)', () => {
    show();
    for (const b of screen.getAllByRole('button', { name: /^Move / })) expect(b.className).toMatch(/h-11 w-11/);
    for (const b of screen.getAllByRole('button', { name: /^Collapse / })) expect(b.className).toMatch(/min-h-11/);
  });

  it('collapses a card', () => {
    show();
    const card = screen.getByTestId('metrics-card-listings');
    expect(within(card).getByTestId('metrics-houses-listed')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Collapse Listings' }));
    expect(within(card).queryByTestId('metrics-houses-listed')).toBeNull();
  });

  it('shows skeletons while loading, an error with Retry on each card that failed, and empty states', () => {
    totalsState.value = { data: null, ...ok({ isLoading: true, updatedAt: 0 }) };
    const a = show();
    expect(within(screen.getByTestId('metrics-card-listings')).getByTestId('metrics-skeleton')).toBeInTheDocument();
    a.unmount();

    totalsState.value = { data: null, ...ok({ error: { message: 'boom' }, updatedAt: 0 }) };
    const b = show();
    const card = screen.getByTestId('metrics-card-advances');
    expect(within(card).getByRole('alert')).toHaveTextContent('boom');
    fireEvent.click(within(card).getByRole('button', { name: /Retry/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('metrics-error').length).toBeGreaterThanOrEqual(5);
    b.unmount();

    totalsState.value = { data: { ...TOTALS, houses_listed: 0, houses_rejected: 0, listing_earned: 0, listing_clawed_back: 0, listers_in_range: 0 }, ...ok() };
    show();
    expect(screen.getByTestId('metrics-empty-listings')).toBeInTheDocument();
    expect(screen.getByTestId('metrics-empty-earnings')).toBeInTheDocument();
  });

  it('opens an agent in a sheet with every figure and a tap-to-call link', () => {
    show();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open Test Agent One' })[0]);
    const sheet = screen.getByTestId('metrics-agent-sheet');
    const t = (sheet.textContent ?? '').replace(/\u00a0/g, ' ');
    expect(t).toContain('Net listing earnings');
    expect(t).toContain('UGX 123,456');
    expect(t).toContain('UGX 250,000');
    expect(within(sheet).getByRole('link', { name: 'Call Test Agent One' })).toHaveAttribute('href', 'tel:+256700000001');
  });

  it('lists agents as cards on phones and as a table from md up (both are in the page, CSS picks one)', () => {
    show();
    expect(screen.getByTestId('metrics-agent-cards').className).toContain('md:hidden');
    expect(screen.getByTestId('metrics-agent-table').className).toMatch(/hidden md:block/);
  });

  it('has a download button per card and the date presets', () => {
    show();
    expect(screen.getByRole('button', { name: 'Download CSV: Headline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download CSV: Agents (this page)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV: Listing earnings' }));
    const [name, preamble, headers, rows] = csvMock.mock.calls[0];
    expect(name).toMatch(/^agent-ops-metrics-listing-earnings-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(JSON.stringify(preamble)).toContain('Server basis text');
    expect(headers).toEqual(['Figure', 'Amount (UGX)']);
    expect(rows).toEqual([['Listing earnings', 1752000], ['Clawed back', 64000]]);
    for (const l of ['Today', 'Last 7 days', 'Last 30 days', 'This month', 'Custom']) expect(screen.getByRole('button', { name: l })).toBeInTheDocument();
  });

  it('uses the approved wording and no emoji', () => {
    show();
    expect(text()).not.toMatch(/\bloan\b|\blender\b|\bROI\b|\binterest\b/i);
    expect(text()).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
