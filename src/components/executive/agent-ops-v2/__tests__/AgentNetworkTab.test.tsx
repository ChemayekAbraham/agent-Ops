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

import { AgentNetworkTab } from '../AgentNetworkTab';

const day = (s: string) => new Date(`${s}T00:00:00`);

const populated = {
  range: { start: '2026-09-16', end: '2026-10-15', min_expected: 50000 },
  counts: { agents: 770, with_service_centres: 53, with_bikes: 2, with_smartphone_plan: 34, with_smartphone_tenants: 240, with_subagents: 166, posted_requests: 254, approved_agents: 124 },
  approved: { agents: 73, requests: 348, amount: 197940001, receivables_outstanding: 232937315 },
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
  top_portfolios: [], top_collection_rate: [], default_rate_ascending: [],
};

const renderTab = (start = '2026-09-16', end = '2026-10-15') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AgentNetworkTab start={day(start)} end={day(end)} />
  </QueryClientProvider>,
);
const kpi = (title: string) => screen.getAllByTestId('network-kpi').find((c) => within(c).queryByText(title)) as HTMLElement;

beforeEach(() => { rpcMock.mockReset(); });

describe('AgentNetworkTab', () => {
  it('asks the server for the Kampala days of the range and shows the eight KPI cards exactly as returned', async () => {
    rpcMock.mockResolvedValue({ data: populated, error: null });
    renderTab();
    await screen.findAllByTestId('network-kpi');
    expect(rpcMock).toHaveBeenCalledWith('get_agent_ops_network_overview', { p_start: '2026-09-16', p_end: '2026-10-15' });
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
