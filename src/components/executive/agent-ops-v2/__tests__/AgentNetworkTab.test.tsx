import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fs from 'node:fs';
import path from 'node:path';

const rpcMock = vi.fn();
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
vi.mock('@/lib/csvExport', () => ({ downloadCsvWithPreamble: (...a: unknown[]) => csvMock(...a) }));

import { MemoryRouter, useLocation } from 'react-router-dom';
import { AgentNetworkStandalone, AgentNetworkTab } from '../AgentNetworkTab';
import { kampalaOffsetYmd, kampalaTodayYmd } from '@/lib/kampalaDays';

// Radix Select needs these in jsdom
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false, setPointerCapture: () => {}, releasePointerCapture: () => {}, scrollIntoView: () => {},
});

const day = (s: string) => new Date(`${s}T00:00:00`);

const populated = {
  range: { start: '2026-09-16', end: '2026-10-15', min_expected: 50000 },
  counts: { agents: 770, with_service_centres: 53, with_bikes: 2, with_smartphone_plan: 34, with_smartphone_tenants: 240, with_subagents: 166, posted_requests: 254, approved_agents: 124 },
  approved: { agents: 73, requests: 348, amount: 197940001, receivables_outstanding: 232937315 },
  bikes: { agents: 2, leases: 3, amount_outstanding: 2820000 },
  smartphone_usage: { as_of: '2026-10-15', from_day: '2026-09-16', to_day: '2026-10-15', tenants: 59117, recorded_smartphone: 58908, recorded_without: 209, confirmed_smartphone: 12, confirmed_feature_phone: 496, device_unknown: 58609, joined: 701, joined_recorded_smartphone: 642, checks: 105, checks_smartphone: 11, checks_feature_phone: 94, seen_on_phone: 6 },
  top_portfolios: [
    { agent_id: 'a-1', name: 'IAN MUHWEZI', phone: '+256787725122', portfolio: 49482312, plans: 19 },
    { agent_id: 'a-2', name: 'JAMES KATONGOLE', phone: '+256779007902', portfolio: 17221812, plans: 7 },
  ],
  // deliberately not collected / expected, to prove the tab shows the server's rate and never computes its own
  top_collection_rate: [{ agent_id: 'a-3', name: 'Thomas hawahka', phone: '+256744846540', collected: 11189195, expected: 3545467, rate_pct: 315.6 }],
  default_rate_ascending: [{ agent_id: 'a-4', name: 'Akampurira Onesmus', phone: '+256743657091', outstanding: 9919721, defaulted: 0, default_rate_pct: 0, plans: 29 }],
};
const zero = {
  range: { start: '2026-10-15', end: '2026-10-15', min_expected: 50000 },
  counts: { agents: 0, with_service_centres: 0, with_bikes: 0, with_smartphone_plan: 0, with_smartphone_tenants: 0, with_subagents: 0, posted_requests: 0, approved_agents: 0 },
  approved: { agents: 0, requests: 0, amount: 0, receivables_outstanding: 0 },
  bikes: { agents: 0, leases: 0, amount_outstanding: 0 },
  smartphone_usage: { as_of: '2026-10-15', from_day: '2026-10-15', to_day: '2026-10-15', tenants: 0, recorded_smartphone: 0, recorded_without: 0, confirmed_smartphone: 0, confirmed_feature_phone: 0, device_unknown: 0, joined: 0, joined_recorded_smartphone: 0, checks: 0, checks_smartphone: 0, checks_feature_phone: 0, seen_on_phone: 0 },
  top_portfolios: [], top_collection_rate: [], default_rate_ascending: [],
};

const renderTab = (start = '2026-09-16', end = '2026-10-15') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AgentNetworkTab start={day(start)} end={day(end)} />
  </QueryClientProvider>,
);
const kpi = (title: string) => screen.getAllByTestId('network-kpi').find((c) => within(c).queryByText(title)) as HTMLElement;

beforeEach(() => { rpcMock.mockReset(); csvMock.mockReset(); });

describe('AgentNetworkTab', () => {
  it('asks the server for the Kampala days of the range and shows the eight KPI cards exactly as returned', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    await screen.findAllByTestId('network-kpi');
    expect(rpcMock).toHaveBeenCalledWith('get_agent_ops_network_overview', { p_start: '2026-09-16', p_end: '2026-10-15', p_min_expected: 50000 });
    const expected: [string, string][] = [
      ['Agents', '770'], ['With service centres', '53'], ['With bikes', '2'], ['With smartphone plan', '34'], ['Tenants on smartphones', '240'],
      ['With sub-agents', '166'], ['Posted rent requests', '254'], ['Approved agents', '124'],
    ];
    expect(screen.getAllByTestId('network-kpi')).toHaveLength(8);
    for (const [title, value] of expected) expect(within(kpi(title)).getByText(value)).toBeInTheDocument();
    expect(screen.getByText(/Kampala days/)).toHaveTextContent(/16 Sept.*15 Oct/);
  });

  it('shows the Approved card: agents, requests, amount approved and receivables outstanding in UGX', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    const card = within(await screen.findByTestId('network-approved'));
    expect(card.getByText('Agents').nextElementSibling).toHaveTextContent('73');
    expect(card.getByText('Requests').nextElementSibling).toHaveTextContent('348');
    expect(card.getByText('Amount approved').nextElementSibling).toHaveTextContent('UGX 197,940,001');
    expect(card.getByText('Receivables outstanding').nextElementSibling).toHaveTextContent('UGX 232,937,315');
  });

  it('lists the three ranked tables in the order returned, with a tap-to-call phone and UGX figures', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    const port = within(await screen.findByTestId('network-portfolios'));
    const rows = port.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('IAN MUHWEZI')).toBeInTheDocument();
    expect(within(rows[0]).getByText('UGX 49,482,312')).toBeInTheDocument();
    expect(within(rows[0]).getByText('19')).toBeInTheDocument();
    expect(within(rows[1]).getByText('JAMES KATONGOLE')).toBeInTheDocument();
    expect(port.getByRole('link', { name: /Call IAN MUHWEZI on \+256787725122/ })).toHaveAttribute('href', 'tel:+256787725122');

    const rate = within(screen.getByTestId('network-collection-rate'));
    expect(rate.getByText('Thomas hawahka')).toBeInTheDocument();
    expect(rate.getByText('UGX 11,189,195')).toBeInTheDocument();
    expect(rate.getByText('UGX 3,545,467')).toBeInTheDocument();
    expect(rate.getByText('315.6%')).toBeInTheDocument(); // the server's rate, not collected / expected
    expect(rate.getByRole('link', { name: /Call Thomas hawahka/ })).toHaveAttribute('href', 'tel:+256744846540');

    const def = within(screen.getByTestId('network-default-rate'));
    expect(def.getByText('Akampurira Onesmus')).toBeInTheDocument();
    expect(def.getByText('UGX 9,919,721')).toBeInTheDocument();
    expect(def.getByText('0%')).toBeInTheDocument();
    expect(screen.getByTestId('network-default-rate')).toHaveTextContent('Defaulted');
  });

  it('explains the minimum in the table captions, from the server value', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    expect(await screen.findByTestId('network-collection-rate')).toHaveTextContent('at least UGX 50,000');
    expect(screen.getByTestId('network-default-rate')).toHaveTextContent('at least UGX 50,000');
  });

  it('renders a zero payload: zeros, UGX 0, and a clear empty state in every table', async () => {
    rpcMock.mockResolvedValue({ data: zero, error: null });
    renderTab('2026-10-15', '2026-10-15');
    await screen.findAllByTestId('network-kpi');
    for (const c of screen.getAllByTestId('network-kpi')) expect(within(c).getByText('0')).toBeInTheDocument();
    const card = within(screen.getByTestId('network-approved'));
    expect(card.getByText('Amount approved').nextElementSibling).toHaveTextContent('UGX 0');
    expect(card.getByText('Receivables outstanding').nextElementSibling).toHaveTextContent('UGX 0');
    expect(screen.getByTestId('network-portfolios')).toHaveTextContent('No agent has a live Rent Plan portfolio.');
    expect(screen.getByTestId('network-collection-rate')).toHaveTextContent('No agent has expected collections of at least UGX 50,000 in this range.');
    expect(screen.getByTestId('network-default-rate')).toHaveTextContent('No agent has a live book of at least UGX 50,000.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('empties one section on its own without touching the others', async () => {
    rpcMock.mockResolvedValue({ data: { ...populated, top_collection_rate: [] }, error: null });
    renderTab();
    expect(await screen.findByTestId('network-collection-rate')).toHaveTextContent('No agent has expected collections');
    expect(screen.getByTestId('network-portfolios')).toHaveTextContent('IAN MUHWEZI');
    expect(screen.getByTestId('network-default-rate')).toHaveTextContent('Akampurira Onesmus');
  });

  it('shows a loading skeleton while the answer is on its way', async () => {
    rpcMock.mockReturnValue(new Promise(() => {}));
    renderTab();
    expect(await screen.findByLabelText('Loading Agent Network')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows the error in plain words with Try again', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_authorized' } });
    renderTab();
    expect(await screen.findByText('Could not load the Agent Network')).toBeInTheDocument();
    expect(screen.getByText('You do not have access to the Agent Network figures.')).toBeInTheDocument();
    rpcMock.mockResolvedValue({ data: populated, error: null });
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(screen.getAllByTestId('network-kpi')).toHaveLength(8));
  });

  it('lets the tables scroll sideways on a phone', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    for (const id of ['network-portfolios', 'network-collection-rate', 'network-default-rate']) {
      expect((await screen.findByTestId(id)).querySelector('.overflow-x-auto')).not.toBeNull();
    }
  });

  it('never asks for a future day, even when the picker ends after today', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab('2026-10-10', '2099-01-01');
    await screen.findAllByTestId('network-kpi');
    const args = rpcMock.mock.calls[0][1] as { p_start: string; p_end: string };
    expect(args.p_end <= new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date())).toBe(true);
    expect(args.p_start <= args.p_end).toBe(true);
  });

  it('splits the all-time cards under their own heading and badges what follows the chosen dates', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    expect(await screen.findByRole('region', { name: "Today's network (all time)" })).toHaveTextContent("Today's network (all time)");
    expect(within(screen.getByRole('region', { name: "Today's network (all time)" })).getAllByTestId('network-kpi')).toHaveLength(8);
    expect(within(screen.getByTestId('network-approved')).getByTestId('in-range-badge')).toHaveTextContent('In the chosen dates');
    expect(within(screen.getByTestId('network-collection-rate')).getByTestId('in-range-badge')).toBeInTheDocument();
    expect(within(screen.getByTestId('network-portfolios')).queryByTestId('in-range-badge')).toBeNull();
    expect(within(screen.getByTestId('network-default-rate')).queryByTestId('in-range-badge')).toBeNull();
  });

  it('shows the bikes leases and what is still owed, and the service-centre hint', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    await screen.findAllByTestId('network-kpi');
    expect(kpi('With bikes')).toHaveTextContent('3 leases · UGX 2,820,000 still owed');
    expect(kpi('With bikes')).toHaveTextContent('2');
    expect(kpi('With service centres')).toHaveTextContent('linked agents · few centres are set up yet');
  });

  it('shows the Tenant Ops smartphone figures as returned, labelled platform-wide, under the Approved card', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    const card = within(await screen.findByTestId('network-smartphones'));
    expect(card.getByText('Tenant smartphones (Tenant Ops figures)')).toBeInTheDocument();
    expect(card.getByText('Platform-wide')).toBeInTheDocument();
    expect(card.getByText('Tenants').nextElementSibling).toHaveTextContent('59,117');
    expect(card.getByText('Recorded with a smartphone').nextElementSibling).toHaveTextContent('58,908');
    expect(card.getByText('Confirmed smartphone').nextElementSibling).toHaveTextContent('12');
    expect(card.getByText('Confirmed feature phone').nextElementSibling).toHaveTextContent('496');
    expect(card.getByText('Seen on a phone in the dates').nextElementSibling).toHaveTextContent('6');
    const order = screen.getAllByTestId(/network-(approved|smartphones|portfolios)/).map((e) => e.getAttribute('data-testid'));
    expect(order).toEqual(['network-approved', 'network-smartphones', 'network-portfolios']);
  });

  it('a minimum of 0 / 50,000 / 100,000 / 500,000 is offered, 50,000 is chosen first, and changing it asks again with p_min_expected', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    await screen.findAllByTestId('network-kpi');
    const select = screen.getByRole('combobox', { name: 'Minimum size for the rankings' });
    expect(select).toHaveTextContent('UGX 50,000');
    await userEvent.click(select);
    const options = (await screen.findAllByRole('option')).map((o) => (o.textContent ?? '').replace(/\u00a0/g, ' '));
    expect(options).toEqual(['UGX 0', 'UGX 50,000', 'UGX 100,000', 'UGX 500,000']);
    await userEvent.click(screen.getAllByRole('option')[3]);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_agent_ops_network_overview', { p_start: '2026-09-16', p_end: '2026-10-15', p_min_expected: 500000 }));
  });

  it('Download CSV on each ranked table hands the rows as returned, with the preamble, to downloadCsvWithPreamble', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    await screen.findByTestId('network-portfolios');
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV: Biggest portfolios' }));
    expect(csvMock).toHaveBeenCalledTimes(1);
    const [file, pre, head, rows] = csvMock.mock.calls[0];
    expect(file).toBe('agent-network-portfolios-2026-09-16_2026-10-15.csv');
    expect(pre[0]).toEqual(['Agent Network: Biggest portfolios']);
    expect(pre[1]).toEqual(['Kampala days', '2026-09-16 to 2026-10-15']);
    expect(pre[2]).toEqual(['Minimum (UGX)', '50000']);
    expect(pre[3][0]).toBe('Generated (Kampala time)');
    expect(head).toEqual(['Rank', 'Agent', 'Phone', 'Rent Plans', 'Portfolio (UGX)']);
    expect(rows).toEqual([[1, 'IAN MUHWEZI', '+256787725122', 19, 49482312], [2, 'JAMES KATONGOLE', '+256779007902', 7, 17221812]]);
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV: Best collection rate' }));
    expect(csvMock.mock.calls[1][3]).toEqual([[1, 'Thomas hawahka', '+256744846540', 11189195, 3545467, 315.6]]);
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV: Default rate (lowest first)' }));
    expect(csvMock.mock.calls[2][3]).toEqual([[1, 'Akampurira Onesmus', '+256743657091', 29, 9919721, 0, 0]]);
  });

  it('the CSV buttons are off for an empty table', async () => {
    rpcMock.mockResolvedValue({ data: zero, error: null });
    renderTab('2026-10-15', '2026-10-15');
    await screen.findByTestId('network-portfolios');
    for (const t of ['Biggest portfolios', 'Best collection rate', 'Default rate (lowest first)']) expect(screen.getByRole('button', { name: `Download CSV: ${t}` })).toBeDisabled();
  });

  it('"How these are counted" lists one plain line per card, from the migration definitions', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    await screen.findAllByTestId('network-kpi');
    await userEvent.click(screen.getByRole('button', { name: /How these are counted/ }));
    const pop = within(await screen.findByTestId('how-counted'));
    for (const t of ['Agents', 'With service centres', 'With bikes', 'With smartphone plan', 'Tenants on smartphones', 'With sub-agents', 'Posted rent requests', 'Approved agents', 'Approved (chosen dates)', 'Portfolio', 'Collection rate', 'Default rate']) {
      expect(pop.getByText(`${t}.`)).toBeInTheDocument();
    }
    expect(pop.getByText(/working sub-agent/)).toBeInTheDocument();
    expect(pop.getByText(/payout clock/)).toBeInTheDocument();
    expect(pop.getByText(/CFO approval time/)).toBeInTheDocument();
  });

  it('uses only design tokens, the Rent Plan wording, formatUGX, no sums in the client and no writes', () => {
    for (const f of ['components/executive/agent-ops-v2/AgentNetworkTab.tsx', 'hooks/useAgentOpsNetworkOverview.ts', 'lib/agentNetwork.ts']) {
      const src = fs.readFileSync(path.resolve(process.cwd(), 'src', f), 'utf8');
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/\b(?:bg|text|border|ring|fill|stroke)-(?:red|green|amber|yellow|emerald|rose|blue|sky|slate|gray|zinc|orange|purple)-\d{2,3}\b/);
      expect(src).not.toMatch(/\.(insert|update|upsert)\(|supabase\.from\(/);
      expect(src).not.toMatch(/\.reduce\(|\.sort\(|Math\.(round|floor|ceil)\(/);
      expect(src).not.toMatch(/\b(loan|lender|ROI)\b/i);
      expect(src).not.toMatch(/text-\[\d+px\]/);
    }
    expect(fs.readFileSync(path.resolve(process.cwd(), 'src/components/executive/agent-ops-v2/AgentNetworkTab.tsx'), 'utf8')).toContain("formatUGX");
  });
});

function Where() { const l = useLocation(); return <p data-testid="where">{l.search}</p>; }
const renderStandalone = (url = '/executive-hub?tab=agent-ops') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]}><AgentNetworkStandalone /><Where /></MemoryRouter>
  </QueryClientProvider>,
);

describe('AgentNetworkStandalone (the Agent Network chip)', () => {
  const today = kampalaTodayYmd();
  it('defaults to Last 30 days in Kampala days, ending today, with the link in the URL', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderStandalone();
    await screen.findAllByTestId('network-kpi');
    expect(rpcMock).toHaveBeenCalledWith('get_agent_ops_network_overview', { p_start: kampalaOffsetYmd(-29), p_end: today, p_min_expected: 50000 });
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('net=1'));
    const w = screen.getByTestId('where').textContent as string;
    expect(w).toContain(`netfrom=${kampalaOffsetYmd(-29)}`);
    expect(w).toContain(`netto=${today}`);
    expect(w).toContain('tab=agent-ops');
    expect(w).not.toContain('netmin');
  });
  it('has Today, Last 7 days, Last 30 days, This month and Custom; a preset asks again and updates the link', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderStandalone();
    await screen.findAllByTestId('network-kpi');
    for (const l of ['Today', 'Last 7 days', 'Last 30 days', 'This month', 'Custom']) expect(screen.getByRole('button', { name: l })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_agent_ops_network_overview', { p_start: kampalaOffsetYmd(-6), p_end: today, p_min_expected: 50000 }));
    expect(screen.getByTestId('where').textContent).toContain(`netfrom=${kampalaOffsetYmd(-6)}`);
  });
  it('opens on the dates and minimum of a shared link', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderStandalone('/executive-hub?tab=agent-ops&net=1&netfrom=2026-10-01&netto=2026-10-10&netmin=100000');
    await screen.findAllByTestId('network-kpi');
    expect(rpcMock).toHaveBeenCalledWith('get_agent_ops_network_overview', { p_start: '2026-10-01', p_end: '2026-10-10', p_min_expected: 100000 });
    expect(screen.getByRole('combobox', { name: 'Minimum size for the rankings' })).toHaveTextContent('UGX 100,000');
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('never asks for a day after today, even from a link, and leaves the f7* parameters alone', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderStandalone('/executive-hub?tab=agent-ops&f7from=2026-10-01&f7freq=weekly&net=1&netfrom=2026-10-01&netto=2099-01-01');
    await screen.findAllByTestId('network-kpi');
    expect((rpcMock.mock.calls[0][1] as { p_end: string }).p_end).toBe(today);
    expect(screen.getByTestId('where').textContent).toContain('f7from=2026-10-01');
    expect(screen.getByTestId('where').textContent).toContain('f7freq=weekly');
  });
  it('takes its parameters out of the link again when another chip is chosen (it closes)', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    function Host() {
      const [open, setOpen] = useState(true);
      return <><button type="button" onClick={() => setOpen(false)}>Close</button>{open && <AgentNetworkStandalone />}<Where /></>;
    }
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/executive-hub?tab=agent-ops&f7from=2026-10-01']}><Host /></MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findAllByTestId('network-kpi');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('net=1'));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).not.toContain('net'));
    expect(screen.getByTestId('where').textContent).toContain('tab=agent-ops');
    expect(screen.getByTestId('where').textContent).toContain('f7from=2026-10-01');
  });
});
