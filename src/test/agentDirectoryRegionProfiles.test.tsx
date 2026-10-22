/**
 * Agent profiles are reachable from the "By Region" view.
 *
 * WHY: The regional summary RPC returns counts only, so before this the
 * By Region view was a dead end — you could see that Wakiso holds 120
 * agents but could not reach any of them. Josh wants to review an
 * individual agent's activity and contact details from here.
 *
 * These tests pin the two things that matter:
 *  - clicking a district asks the server for that district's register and
 *    shows only the agents who actually belong to it (a name, phone or
 *    territory that merely happens to contain the district word, or an
 *    identically-named district in another region, must not leak in);
 *  - clicking an agent opens the same profile panel the List view opens.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();

// Any `supabase.from(...)` chain (profile cards, ledgers, audit inserts)
// resolves to an empty result instead of throwing in jsdom.
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
  { region: 'Central', district: 'Wakiso', agent_count: 3, verified_count: 2, active_30d: 2 },
  { region: 'Central', district: 'Kyoga', agent_count: 1, verified_count: 1, active_30d: 1 },
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

// The register filters by free text, so its answer for "Wakiso" also carries
// people who are not in Wakiso: one matched by name in another district, and
// one whose district word is shared with a different region.
const DIRECTORY_ANSWER = {
  kpis: { total_agents: 4, total_sub_agents: 0, total_active: 3, total_all: 4 },
  total_matched: 4,
  rows: [
    row({ id: 'aaa-1', full_name: 'Nabukeera Sarah', phone: '0772 111 222', total_tenants: 6, daily_target: 20000, collected_today: 8000 }),
    row({ id: 'bbb-2', full_name: 'Okello Peter', phone: '0700 333 444', total_tenants: 2, daily_target: 10000, collected_today: 0, status: 'inactive' }),
    row({ id: 'ccc-3', full_name: 'Wakisa Joan', district: 'Kampala', region: 'Central' }),
    row({ id: 'ddd-4', full_name: 'Mukasa Tom', district: 'Wakiso', region: 'Eastern' }),
  ],
};

const PROFILE = {
  bio: { full_name: 'Nabukeera Sarah', phone: '0772 111 222', district: 'Wakiso', created_at: null },
  rent_requests: { total: 6 },
  repayments: { expected_total: 0, repaid_total: 0, outstanding_total: 0, daily_target: 20000 },
  collections: { total: 8000 },
  recruitment: { sub_agents_total: 0 },
  listings: { total: 0 },
  performance: { earnings_total: 0 },
  wallet: {},
  tenants: [],
};

const renderDirectory = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AgentDirectory />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const openDistrict = async (district: string) => {
  await screen.findByPlaceholderText('Filter by region or district…');
  await userEvent.click(screen.getByRole('button', { name: /^Central region/ }));
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${district} district`) }));
};

describe('Agent profiles from the By Region view', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (name: string, args: any) => {
      if (name === 'get_agent_directory_region_breakdown') return { data: REGION_ROWS, error: null };
      if (name === 'get_agent_directory_v2') {
        return args?.p_search === 'Wakiso' ? { data: DIRECTORY_ANSWER, error: null } : { data: { ...DIRECTORY_ANSWER, rows: [] }, error: null };
      }
      if (name === 'get_agent_profile_360') return { data: PROFILE, error: null };
      return { data: null, error: null };
    });
  });

  it('lists the district’s own agents when the district is clicked', async () => {
    renderDirectory();
    await openDistrict('Wakiso');

    // The register is asked for this district, not for nothing.
    expect(rpcMock).toHaveBeenCalledWith(
      'get_agent_directory_v2',
      expect.objectContaining({ p_search: 'Wakiso' }),
    );

    // Both real Wakiso agents are on screen with a contact number.
    expect(await screen.findByText('Nabukeera Sarah')).toBeInTheDocument();
    expect(screen.getByText('Okello Peter')).toBeInTheDocument();
    expect(screen.getByText('0772 111 222')).toBeInTheDocument();

    // Nobody outside the clicked district slipped in through the free-text match.
    expect(screen.queryByText('Wakisa Joan')).toBeNull();
    expect(screen.queryByText('Mukasa Tom')).toBeNull();

    // The panel says how many it actually loaded.
    expect(screen.getByText('2 agents in Wakiso')).toBeInTheDocument();
  });

  it('opens the agent profile when an agent is clicked', async () => {
    renderDirectory();
    await openDistrict('Wakiso');

    await userEvent.click(await screen.findByText('Nabukeera Sarah'));

    expect(rpcMock).toHaveBeenCalledWith('get_agent_profile_360', { p_agent_id: 'aaa-1' });
    expect(await screen.findByRole('button', { name: /Back to directory/ })).toBeInTheDocument();
  });

  it('keeps the district list closed until it is asked for', async () => {
    renderDirectory();
    await screen.findByPlaceholderText('Filter by region or district…');
    await userEvent.click(screen.getByRole('button', { name: /^Central region/ }));

    // Expanding the region shows district counts only — no register request yet.
    await waitFor(() => expect(screen.getByText('Kyoga')).toBeInTheDocument());
    expect(rpcMock).not.toHaveBeenCalledWith(
      'get_agent_directory_v2',
      expect.objectContaining({ p_search: 'Wakiso' }),
    );
  });

  it.each(['active', 'inactive', 'frozen'])('opens a %s agent from their name in List view', async (status) => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'get_agent_directory_region_breakdown') return { data: REGION_ROWS, error: null };
      if (name === 'get_agent_directory_v2') return {
        data: { ...DIRECTORY_ANSWER, rows: [row({ id: 'aaa-1', full_name: 'Nabukeera Sarah', status })] }, error: null,
      };
      if (name === 'get_agent_profile_360') return { data: PROFILE, error: null };
      return { data: null, error: null };
    });
    renderDirectory();
    await userEvent.click(screen.getByRole('button', { name: /^List$/ }));
    const name = await screen.findByRole('button', { name: 'Open profile for Nabukeera Sarah' });
    name.focus();
    await userEvent.keyboard('{Enter}');
    expect(rpcMock).toHaveBeenCalledWith('get_agent_profile_360', { p_agent_id: 'aaa-1' });
    await userEvent.click(await screen.findByRole('button', { name: /Back to directory/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open profile for Nabukeera Sarah' }));
    expect(await screen.findByRole('button', { name: /Back to directory/ })).toBeInTheDocument();
  });
});
