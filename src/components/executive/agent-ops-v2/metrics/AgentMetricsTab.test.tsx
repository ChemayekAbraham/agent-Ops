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
const QUALITY = {
  network: { as_at: '2026-10-16', range_start: '2026-09-17', range_end: '2026-10-16', basis: 'Quality basis from the server.', agents: 29, houses_listed: 307, houses_verified: 230, houses_pending: 74, houses_currently_rejected: 3, rejection_events: 36, occupied: 0, empty: 307, approval_rate: 74.9, avg_days_to_verify: 1.2, listing_earned: 1850000, listing_earned_listers: 1776000, earn_per_approved: 8043, waiting_total: 2031, oldest_waiting_days: 108 },
  agents: [],
  waiting: [{ listing_id: 'l1', agent_id: 'a9', agent_name: 'Grace Paul', phone: '+256700212384', district: 'Wakiso', listed_at: '2026-06-30T05:18:54.406225+00:00', days_waiting: 108 }],
};
const RISK = {
  summary: { as_at: '2026-10-16', range_start: '2026-09-17', range_end: '2026-10-16', inactive_window_start: '2026-09-17', basis: 'Risk basis from the server.', advance_no_listing_count: 320, advance_no_listing_amount: 57002116.28, owing_agents: 322, owing_amount: 57941492.28, flag_no_earnings: 321, flag_high: 1, flag_watch: 0, flag_ok: 0, inactive_listers_count: 427, never_listed_subagents_count: 2695, main_agents_owing_count: 82, main_agents_owing_amount: 30969197.78 },
  advance_no_listing: [{ agent_id: 'r1', name: 'Risk Agent One', phone: '+256700000011', advance_outstanding: 7415000, last_listing: '2026-08-01' }],
  advance_vs_earnings: [{ agent_id: 'r1', name: 'Risk Agent One', phone: '+256700000011', advance_outstanding: 7415000, listing_earned: 0, ratio: null, flag: 'no_earnings' }, { agent_id: 'r2', name: 'Risk Agent Two', phone: null, advance_outstanding: 900000, listing_earned: 100000, ratio: 9, flag: 'high' }],
  inactive_listers: [{ agent_id: 'i1', name: 'Quiet Lister', phone: '+256700000021', last_listing: '2026-09-16', days_inactive: 30, houses_listed_ever: 8 }],
  never_listed_subagents: [{ agent_id: 'n1', name: 'New Sub', phone: '+256700000031', main_agent_id: 'm1', main_agent_name: 'Main One', linked_on: '2026-01-19' }],
  main_agents_by_advance: [{ main_agent_id: 'm7', name: 'Team Owes Lead', phone: '+256700000041', team_size: 443, team_houses: 4, team_earnings: 62000, team_advances_outstanding: 12891354.74 }],
};
const qualityState: { value: Record<string, unknown> } = { value: {} };
const riskState: { value: Record<string, unknown> } = { value: {} };
const topState: { value: Record<string, unknown> } = { value: {} };
const riskArgs: unknown[][] = [];
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
  useMetricsQuality: () => qualityState.value,
  useMetricsRisk: (...a: unknown[]) => { riskArgs.push(a); return riskState.value; },
  useMetricsTopEarners: () => topState.value,
  useMetricsPins: () => ({ rows: [], ...ok() }),
  useMetricsMainAgents: () => ({ rows: [{ main_agent_id: 'm1', name: 'Main One', phone: '+256700000009', team_size: 4, team_houses: 40, team_earnings: 900000, team_advances_outstanding: 1200000, total_matched: 1 }], total: 1, ...ok() }),
}));

import { AgentMetricsStandalone } from './AgentMetricsTab';

const show = () => render(<MemoryRouter><AgentMetricsStandalone /></MemoryRouter>);
const text = () => (document.body.textContent ?? '').replace(/\u00a0/g, ' ');
const titles = () => screen.getAllByTestId(/^metrics-card-/).map((c) => c.getAttribute('data-testid')!.replace('metrics-card-', ''));

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  localStorage.clear();
  refetch.mockClear();
  csvMock.mockClear();
  riskArgs.length = 0;
  qualityState.value = { data: QUALITY, ...ok() };
  riskState.value = { data: RISK, ...ok() };
  topState.value = { rows: [{ ...agentRows[0], name: 'Top Earner One', listing_earned: 900000, net: 800000 }], ...ok() };
  totalsState.value = { data: TOTALS, ...ok() };
});

describe('Metrics tab', () => {
  it('stacks the nine cards in the default order and shows the server figures exactly as returned, in UGX', () => {
    show();
    expect(titles()).toEqual(['headline', 'listings', 'earnings', 'agents', 'locations', 'main-agents', 'advances', 'risk', 'activity']);
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
    for (const id of ['headline', 'listings', 'earnings', 'agents', 'locations', 'main-agents', 'advances', 'risk', 'activity']) {
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
    // a saved order from before the Risk card existed gets it appended after the cards it already had
    expect(titles().indexOf('risk')).toBeGreaterThan(titles().indexOf('main-agents'));
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
    expect(screen.getAllByTestId('metrics-error')).toHaveLength(4); // headline, listings, earnings, advances: the cards that read the totals
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

  it('has a plain-language "How these are counted" popover that explains the rejected and advance figures', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /How these are counted/ }));
    const body = screen.getByTestId('metrics-how-counted-body');
    expect(body.textContent).toMatch(/add up to the houses listed/);
    expect(body.textContent).toMatch(/Advance Repayment Monitor/);
    expect(body.textContent).toMatch(/only from the company ledger/);
    expect(body.textContent).not.toMatch(/\bloan\b|\blender\b|\bROI\b|\binterest\b/i);
  });

  it('Listings card: Currently rejected sits next to the rejection events, with the quality figures and the Waiting longest list as returned', () => {
    show();
    const listings = screen.getByTestId('metrics-card-listings');
    expect(within(listings).getByTestId('metrics-houses-rejected')).toHaveTextContent('36');
    expect(within(listings).getByTestId('metrics-houses-current-rejected')).toHaveTextContent('3');
    expect(within(listings).getByTestId('metrics-approval-rate')).toHaveTextContent('74.9%');
    expect(within(listings).getByTestId('metrics-days-to-verify')).toHaveTextContent('1.2');
    expect(within(listings).getByTestId('metrics-occupied')).toHaveTextContent('0');
    expect(within(listings).getByTestId('metrics-empty')).toHaveTextContent('307');
    expect(within(listings).getByTestId('metrics-earn-per-approved').textContent?.replace(/\u00a0/g, ' ')).toContain('UGX 8,043');
    const waiting = within(listings).getByTestId('metrics-waiting-list');
    expect(waiting).toHaveTextContent('Grace Paul');
    expect(waiting).toHaveTextContent('108 days');
    expect(within(waiting).getByRole('link', { name: 'Call Grace Paul' })).toHaveAttribute('href', 'tel:+256700212384');
    expect(within(listings).getByTestId('metrics-waiting').textContent).toContain('2,031 houses waiting');
    // nothing was worked out here: no verified + pending sum, no rate from counts
    expect(within(listings).queryByText('75.9%')).toBeNull();
  });

  it('Listings card: the quality part has its own loading, empty and error-with-retry, and the top figures stay', () => {
    qualityState.value = { data: null, ...ok({ isLoading: true, updatedAt: 0 }) };
    const a = show();
    expect(within(screen.getByTestId('metrics-quality')).getByTestId('metrics-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('metrics-houses-listed')).toHaveTextContent('292');
    a.unmount();
    qualityState.value = { data: null, ...ok({ error: { message: 'quality boom' }, updatedAt: 0 }) };
    const b = show();
    const block = screen.getByTestId('metrics-quality');
    expect(within(block).getByRole('alert')).toHaveTextContent('quality boom');
    fireEvent.click(within(block).getByRole('button', { name: /Retry/ }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByTestId('metrics-houses-current-rejected')).toBeNull();
    b.unmount();
    qualityState.value = { data: { ...QUALITY, network: { ...QUALITY.network, houses_listed: 0, waiting_total: 0 }, waiting: [] }, ...ok() };
    show();
    expect(screen.getByTestId('metrics-quality-empty')).toBeInTheDocument();
    expect(screen.getByTestId('metrics-waiting-empty')).toBeInTheDocument();
  });

  it('Risk card: figures, flags and ratios exactly as the server returned them, with tap-to-call, CSV, and its own states', () => {
    show();
    const risk = screen.getByTestId('metrics-card-risk');
    expect(within(risk).getByTestId('metrics-risk-nolisting')).toHaveTextContent('320');
    expect(within(risk).getByTestId('metrics-risk-owing')).toHaveTextContent('322');
    expect(within(risk).getByTestId('metrics-risk-flag-none')).toHaveTextContent('321');
    expect(within(risk).getByTestId('metrics-risk-flag-high')).toHaveTextContent('1');
    expect(within(risk).getByTestId('metrics-risk-nolisting').textContent?.replace(/\u00a0/g, ' ')).toContain('UGX 57,002,116');
    const ratio = within(risk).getByTestId('metrics-risk-ratio-list');
    expect(ratio).toHaveTextContent('High (3x or more)');
    expect(ratio).toHaveTextContent('advance is 9x');
    expect(ratio).toHaveTextContent('No listing earnings');
    expect(within(ratio).getAllByRole('link')).toHaveLength(1);
    expect(screen.getByTestId('metrics-basis-risk')).toHaveTextContent('Risk basis from the server.');
    fireEvent.click(within(risk).getByRole('button', { name: 'Download CSV: Risk (loaded rows)' }));
    const [name, , headers, rows] = csvMock.mock.calls[0];
    expect(name).toMatch(/^agent-ops-metrics-risk-/);
    expect(headers[0]).toBe('List');
    expect(rows).toHaveLength(3);
    expect(rows[2][6]).toBe('High (3x or more)');
  });

  it('Risk card: skeleton while loading, error with Retry, empty when nobody owes', () => {
    riskState.value = { data: null, ...ok({ isLoading: true, updatedAt: 0 }) };
    const a = show();
    expect(within(screen.getByTestId('metrics-card-risk')).getByTestId('metrics-skeleton')).toBeInTheDocument();
    a.unmount();
    riskState.value = { data: null, ...ok({ error: { code: '42501', message: 'not authorized' }, updatedAt: 0 }) };
    const b = show();
    const card = screen.getByTestId('metrics-card-risk');
    expect(within(card).getByRole('alert')).toHaveTextContent('do not have access');
    fireEvent.click(within(card).getByRole('button', { name: /Retry/ }));
    expect(refetch).toHaveBeenCalled();
    b.unmount();
    riskState.value = { data: { ...RISK, summary: { ...RISK.summary, owing_agents: 0 } }, ...ok() };
    show();
    expect(screen.getByTestId('metrics-empty-risk')).toBeInTheDocument();
  });

  it('Activity card now shows the inactive listers and the sub-agents who never listed, as returned, with Show more and CSV', () => {
    show();
    const card = screen.getByTestId('metrics-card-activity');
    expect(within(card).getByTestId('metrics-inactive-count')).toHaveTextContent('427');
    expect(within(card).getByTestId('metrics-never-count')).toHaveTextContent('2,695');
    expect(within(card).getByTestId('metrics-inactive-list')).toHaveTextContent('Quiet Lister');
    expect(within(card).getByTestId('metrics-inactive-list')).toHaveTextContent('30 days');
    expect(within(card).getByTestId('metrics-never-list')).toHaveTextContent('Main agent Main One');
    expect(within(card).queryByTestId('metrics-listers-range')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Show more inactive listers' }));
    expect(riskArgs.some((a) => a[2] === 30)).toBe(true);
    fireEvent.click(within(card).getByRole('button', { name: 'Download CSV: Activity (loaded rows)' }));
    expect(csvMock.mock.calls.at(-1)![3]).toHaveLength(2);
  });

  it('Activity card: loading, error with Retry and empty', () => {
    riskState.value = { data: null, ...ok({ isLoading: true, updatedAt: 0 }) };
    const a = show();
    expect(within(screen.getByTestId('metrics-card-activity')).getByTestId('metrics-skeleton')).toBeInTheDocument();
    a.unmount();
    riskState.value = { data: null, ...ok({ error: { message: 'act boom' }, updatedAt: 0 }) };
    const b = show();
    expect(within(screen.getByTestId('metrics-card-activity')).getByRole('alert')).toHaveTextContent('act boom');
    b.unmount();
    riskState.value = { data: { ...RISK, summary: { ...RISK.summary, inactive_listers_count: 0, never_listed_subagents_count: 0 } }, ...ok() };
    show();
    expect(screen.getByTestId('metrics-empty-activity')).toBeInTheDocument();
  });

  it('Listing earnings card: top earners as the server ranks them, with its own empty and error states and CSV', () => {
    show();
    const card = screen.getByTestId('metrics-card-earnings');
    const list = within(card).getByTestId('metrics-top-earners-list');
    expect(list).toHaveTextContent('Top Earner One');
    expect(list.textContent?.replace(/\u00a0/g, ' ')).toContain('UGX 900,000');
    expect(list.textContent?.replace(/\u00a0/g, ' ')).toContain('net UGX 800,000');
    fireEvent.click(within(card).getByRole('button', { name: 'Download CSV: Top earners' }));
    expect(csvMock.mock.calls.at(-1)![0]).toMatch(/top-earners/);
  });

  it('Listing earnings card: top earners error and empty do not hide the earnings figures', () => {
    topState.value = { rows: [], ...ok({ error: { message: 'top boom' } }) };
    const a = show();
    expect(within(screen.getByTestId('metrics-top-earners')).getByRole('alert')).toHaveTextContent('top boom');
    expect(screen.getByTestId('metrics-listing-earned').textContent?.replace(/\u00a0/g, ' ')).toContain('UGX 1,752,000');
    a.unmount();
    topState.value = { rows: [], ...ok() };
    show();
    expect(screen.getByTestId('metrics-top-earners-empty')).toBeInTheDocument();
  });

  it('Main agents card: "Team owes most" switches to the risk list and asks the server for it', () => {
    show();
    const card = screen.getByTestId('metrics-card-main-agents');
    expect(within(card).getByRole('button', { name: 'Biggest team' })).toHaveAttribute('aria-pressed', 'true');
    expect(card).toHaveTextContent('Main One');
    fireEvent.click(within(card).getByRole('button', { name: 'Team owes most' }));
    expect(within(card).getByRole('button', { name: 'Team owes most' })).toHaveAttribute('aria-pressed', 'true');
    expect(card).toHaveTextContent('Team Owes Lead');
    expect(card.textContent?.replace(/\u00a0/g, ' ')).toContain('UGX 12,891,355');
    expect(card).toHaveTextContent('1 to 1 of 82');
    expect(screen.getByTestId('metrics-basis-main-agents')).toHaveTextContent('Team owes most');
    fireEvent.click(within(card).getByRole('button', { name: 'Download CSV: Main agents (this page)' }));
    expect(csvMock.mock.calls.at(-1)![0]).toMatch(/main-agents-team-owes/);
  });

  it('the popover explains the new figures in plain words', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /How these are counted/ }));
    const body = screen.getByTestId('metrics-how-counted-body').textContent ?? '';
    for (const k of ['Listing quality', 'Currently rejected', 'Waiting longest', 'Risk', 'Inactive and never listed', 'Team owes most']) expect(body).toContain(k);
    expect(body).toMatch(/3 times or more/);
    expect(body).not.toMatch(/\bloan\b|\blender\b|\bROI\b|\binterest\b/i);
  });

  it('uses the approved wording and no emoji', () => {
    show();
    expect(text()).not.toMatch(/\bloan\b|\blender\b|\bROI\b|\binterest\b/i);
    expect(text()).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
