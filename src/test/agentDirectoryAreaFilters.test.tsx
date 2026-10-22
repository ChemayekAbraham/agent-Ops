/**
 * Region and district filters in the Agent Directory's compact filter panel.
 *
 * WHY: On a phone the List view's folded-away panel only offered agent type and
 * status. Narrowing the register to one area meant typing the area into search —
 * and search also matches names, phone numbers and emails, so what came back was
 * never really "the agents of this district". Josh wants location filters in the
 * same panel, sized for a thumb.
 *
 * These tests pin what the panel must actually do:
 *  - it offers a region and a district choice, each carrying that area's count;
 *  - the district choices are scoped to the region that was picked;
 *  - picking an area asks the register for it and then keeps only the agents who
 *    truly belong to it — a name that merely contains the area word is not one;
 *  - the count line describes the area on screen, not the whole register;
 *  - clearing the area brings every agent back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();

const chainable = (): any =>
  new Proxy(function () {} as any, {
    get: (_t, prop) => {
      if (prop === 'then') return (res: (v: unknown) => void) => res({ data: [], error: null, count: 0 });
      return () => chainable();
    },
    apply: () => chainable(),
  });

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rest: {},
    rpc: (...a: unknown[]) => rpcMock(...a),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    from: () => chainable(),
  },
}));

import { MemoryRouter } from 'react-router-dom';
import { AgentDirectory } from '@/components/executive/AgentDirectory';

// Radix primitives need these in jsdom.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  setPointerCapture: () => {},
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

// Area list exactly as the server's region/district count lookup returns it.
const AREA_ROWS = [
  { region: 'Central', district: 'Wakiso', agent_count: 120, verified_count: 90, active_30d: 70 },
  { region: 'Central', district: 'Kyoga', agent_count: 40, verified_count: 30, active_30d: 20 },
  { region: 'Central', district: 'Kampala', agent_count: 1, verified_count: 0, active_30d: 1 },
  { region: 'Eastern', district: 'Mbale', agent_count: 25, verified_count: 15, active_30d: 10 },
];

const KPIS = { total_agents: 5, total_sub_agents: 0, total_active: 5, total_all: 5 };

const row = (over: Record<string, unknown>) => ({
  full_name: null,
  phone: null,
  email: null,
  avatar_url: null,
  verified: false,
  territory: null,
  region: 'Central',
  district: 'Wakiso',
  agent_tier: 'full_agent',
  created_at: null,
  last_active_at: null,
  agent_kind: 'agent',
  total_tenants: 0,
  sub_agents_count: 0,
  houses_listed: 0,
  daily_target: 0,
  collected_today: 0,
  outstanding: 0,
  last_collection_at: null,
  status: 'active',
  ...over,
});

// Three of these belong to Central. "Wakiso Hardware Ltd" is the trap: its name
// contains the district word but it sits in Kampala. "Mukasa Tom" is in a district
// that exists in two regions, so the region has to be checked as well.
const ALL_ROWS = [
  row({ id: 'a1', full_name: 'Nabukeera Sarah', district: 'Wakiso', region: 'Central', total_tenants: 6 }),
  row({ id: 'a2', full_name: 'Okello Peter', district: 'Wakiso', region: 'Central', total_tenants: 2 }),
  row({ id: 'a3', full_name: 'Achieng Ruth', district: 'Mbale', region: 'Eastern', total_tenants: 4 }),
  row({ id: 'a4', full_name: 'Wakiso Hardware Ltd', district: 'Kampala', region: 'Central' }),
  row({ id: 'a5', full_name: 'Mukasa Tom', district: 'Wakiso', region: 'Eastern' }),
];

// Stands in for the register lookup: it filters type and status the way the
// server does, and treats the search term as a substring of name/area fields.
const registerAnswer = (args: any) => {
  const q = String(args?.p_search ?? '').toLowerCase();
  const rows = ALL_ROWS.filter(r =>
    (args?.p_type === 'all' || !args?.p_type || r.agent_kind === args.p_type) &&
    (args?.p_status === 'all' || !args?.p_status || r.status === args.p_status) &&
    (!q || `${r.full_name} ${r.district} ${r.region}`.toLowerCase().includes(q)),
  );
  return { data: { kpis: KPIS, total_matched: rows.length, rows }, error: null };
};

const renderDirectory = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AgentDirectory />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const bodyText = () => document.body.textContent ?? '';

const openListPanel = async () => {
  renderDirectory();
  await userEvent.click(screen.getByRole('button', { name: 'List' }));
  await userEvent.click(screen.getByRole('button', { name: 'Show filters' }));
};

describe('Region and district filters in the Agent Directory panel', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (name: string, args: any) => {
      if (name === 'get_agent_directory_region_breakdown') return { data: AREA_ROWS, error: null };
      if (name === 'get_agent_directory_v2') return registerAnswer(args);
      if (name === 'get_agent_profile_360') return { data: {}, error: null };
      return { data: null, error: null };
    });
  });

  it('offers a region and a district choice carrying the area counts', async () => {
    await openListPanel();

    const regionTrigger = await screen.findByRole('combobox', { name: 'Filter by region' });
    expect(screen.getByRole('combobox', { name: 'Filter by district' })).toBeInTheDocument();

    await userEvent.click(regionTrigger);
    const labels = (await screen.findAllByRole('option')).map(o => o.textContent ?? '');
    // Counts are the server's own: Central 120 + 40 + 1, Eastern 25.
    expect(labels.join(' ')).toMatch(/Central \(161\)/);
    expect(labels.join(' ')).toMatch(/Eastern \(25\)/);
    expect(labels.join(' ')).toMatch(/All regions/);
  });

  it('keeps only the agents who really belong to the chosen region', async () => {
    await openListPanel();

    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by region' }));
    await userEvent.click(screen.getByRole('option', { name: /^Central/ }));

    // The area is asked for from the server, not filtered out of one page.
    expect(rpcMock).toHaveBeenCalledWith(
      'get_agent_directory_v2',
      expect.objectContaining({ p_search: 'Central' }),
    );

    await waitFor(() => expect(bodyText()).toMatch(/Showing 3 agents in Central/));
    expect(screen.getByText('Nabukeera Sarah')).toBeInTheDocument();
    expect(screen.getByText('Wakiso Hardware Ltd')).toBeInTheDocument();
    // Eastern's agents are gone, including the one in a district named Wakiso.
    expect(screen.queryByText('Achieng Ruth')).toBeNull();
    expect(screen.queryByText('Mukasa Tom')).toBeNull();
    // And the register-wide wording is gone with them.
    expect(bodyText()).not.toMatch(/agents & sub-agents/);
  });

  it('offers only the chosen region’s districts', async () => {
    await openListPanel();

    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by region' }));
    await userEvent.click(screen.getByRole('option', { name: /^Central/ }));
    await waitFor(() => expect(bodyText()).toMatch(/Showing 3 agents in Central/));

    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by district' }));
    const labels = (await screen.findAllByRole('option')).map(o => o.textContent ?? '');
    expect(labels.join(' ')).toMatch(/Wakiso/);
    expect(labels.join(' ')).toMatch(/Kyoga/);
    expect(labels.join(' ')).not.toMatch(/Mbale/);
  });

  it('narrows to one district in that region only', async () => {
    await openListPanel();

    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by region' }));
    await userEvent.click(screen.getByRole('option', { name: /^Central/ }));
    await waitFor(() => expect(bodyText()).toMatch(/Showing 3 agents in Central/));

    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by district' }));
    await userEvent.click(screen.getByRole('option', { name: /^Wakiso/ }));

    expect(rpcMock).toHaveBeenCalledWith(
      'get_agent_directory_v2',
      expect.objectContaining({ p_search: 'Wakiso' }),
    );

    await waitFor(() => expect(bodyText()).toMatch(/Showing 2 agents in Wakiso, Central/));
    expect(screen.getByText('Nabukeera Sarah')).toBeInTheDocument();
    expect(screen.getByText('Okello Peter')).toBeInTheDocument();
    // A business whose name contains the district word but sits in Kampala…
    expect(screen.queryByText('Wakiso Hardware Ltd')).toBeNull();
    // …and the same district name in another region.
    expect(screen.queryByText('Mukasa Tom')).toBeNull();
  });

  it('brings the whole register back when the area is cleared', async () => {
    await openListPanel();

    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by region' }));
    await userEvent.click(screen.getByRole('option', { name: /^Central/ }));
    await waitFor(() => expect(bodyText()).toMatch(/Showing 3 agents in Central/));

    // Fold the panel away, the way a phone user does, and clear from the summary.
    await userEvent.click(screen.getByRole('button', { name: 'Show filters' }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear area filter' }));

    await waitFor(() => expect(bodyText()).toMatch(/Showing 5 agents & sub-agents/));
    expect(screen.getByText('Achieng Ruth')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear area filter' })).toBeNull();
  });
});
