/**
 * Region filters and agent counts in the "By Region" directory view.
 *
 * WHY: The view used to be a text box and a list. Finding the agents in one
 * area meant typing the area name and hoping, and the only counts on screen
 * were per-card — there was no way to see at a glance how big each region is,
 * or to jump straight to a district. Josh wants to filter to a specific area
 * quickly and see how many agents are in it.
 *
 * These tests pin what the filters must actually do:
 *  - every region chip carries that region's own agent count;
 *  - clicking a chip leaves only that region and recounts the line;
 *  - the district dropdown is scoped to the chosen region and picking a
 *    district loads that district's agents (asked from the server, never
 *    invented);
 *  - clearing the filter restores the full picture and the original total.
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

const REGION_ROWS = [
  { region: 'Central', district: 'Wakiso', agent_count: 120, verified_count: 90, active_30d: 70 },
  { region: 'Central', district: 'Kyoga', agent_count: 40, verified_count: 30, active_30d: 20 },
  { region: 'Eastern', district: 'Mbale', agent_count: 25, verified_count: 15, active_30d: 10 },
];

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

// Only two of these really belong to Wakiso: one is a Kampala agent whose name
// contains the word, one sits in an identically-named district elsewhere.
const WAKISO_ANSWER = {
  kpis: { total_agents: 4, total_sub_agents: 0, total_active: 3, total_all: 4 },
  total_matched: 4,
  rows: [
    row({ id: 'aaa-1', full_name: 'Nabukeera Sarah', phone: '0772 111 222', total_tenants: 6 }),
    row({ id: 'bbb-2', full_name: 'Okello Peter', phone: '0700 333 444', total_tenants: 2, status: 'inactive' }),
    row({ id: 'ccc-3', full_name: 'Wakisa Joan', district: 'Kampala', region: 'Central' }),
    row({ id: 'ddd-4', full_name: 'Mukasa Tom', district: 'Wakiso', region: 'Eastern' }),
  ],
};

const EMPTY_ANSWER = {
  kpis: { total_agents: 4, total_sub_agents: 0, total_active: 3, total_all: 4 },
  total_matched: 0,
  rows: [],
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

describe('Region filters in the By Region directory', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (name: string, args: any) => {
      if (name === 'get_agent_directory_region_breakdown') return { data: REGION_ROWS, error: null };
      if (name === 'get_agent_directory_v2') {
        return args?.p_search === 'Wakiso' ? { data: WAKISO_ANSWER, error: null } : { data: EMPTY_ANSWER, error: null };
      }
      if (name === 'get_agent_profile_360') return { data: {}, error: null };
      return { data: null, error: null };
    });
  });

  it('shows each region with its own agent count', async () => {
    renderDirectory();
    await screen.findByPlaceholderText('Filter by region or district…');

    // Counts come from the server's own rows: Central 120 + 40, Eastern 25.
    expect(await screen.findByRole('button', { name: 'Show Central, 160 agents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Eastern, 25 agents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show All regions, 185 agents' })).toBeInTheDocument();
  });

  it('narrows the view to one region and recounts when its chip is clicked', async () => {
    renderDirectory();
    await screen.findByPlaceholderText('Filter by region or district…');

    await userEvent.click(screen.getByRole('button', { name: 'Show Central, 160 agents' }));

    // Only Central is left standing; Eastern's card is gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Mbale district/ })).toBeNull());
    expect(screen.getByRole('button', { name: /^Wakiso district/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Kyoga district/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Eastern region/ })).toBeNull();

    // The count line describes the filtered area, not the whole register.
    expect(bodyText()).toMatch(/160 agents in Central/);
    expect(bodyText()).not.toMatch(/185 agents across 2 regions/);
  });

  it('offers only the chosen region’s districts and loads them when picked', async () => {
    renderDirectory();
    await screen.findByPlaceholderText('Filter by region or district…');

    await userEvent.click(screen.getByRole('button', { name: 'Show Central, 160 agents' }));

    // The dropdown is scoped to Central — Mbale is not on offer.
    await userEvent.click(screen.getByRole('combobox'));
    const options = await screen.findAllByRole('option');
    const labels = options.map((o) => o.textContent ?? '');
    expect(labels.join(' ')).toMatch(/Wakiso/);
    expect(labels.join(' ')).not.toMatch(/Mbale/);

    await userEvent.click(screen.getByRole('option', { name: /Wakiso/ }));

    // Picking the district asks the server for its register and shows only the
    // agents who actually belong to it.
    expect(rpcMock).toHaveBeenCalledWith('get_agent_directory_v2', expect.objectContaining({ p_search: 'Wakiso' }));
    expect(await screen.findByText('Nabukeera Sarah')).toBeInTheDocument();
    expect(screen.getByText('Okello Peter')).toBeInTheDocument();
    expect(screen.queryByText('Wakisa Joan')).toBeNull();
    expect(screen.queryByText('Mukasa Tom')).toBeNull();

    // And the count line names the exact area it describes.
    expect(bodyText()).toMatch(/120 agents in Wakiso, Central/);
  });

  it('brings every region back when the area filter is cleared', async () => {
    renderDirectory();
    await screen.findByPlaceholderText('Filter by region or district…');

    await userEvent.click(screen.getByRole('button', { name: 'Show Central, 160 agents' }));
    await waitFor(() => expect(bodyText()).toMatch(/160 agents in Central/));

    await userEvent.click(screen.getByRole('button', { name: 'Clear area' }));

    await waitFor(() => expect(bodyText()).toMatch(/185 agents across 2 regions/));
    expect(screen.getByRole('button', { name: /^Eastern region/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear area' })).toBeNull();
  });
});
