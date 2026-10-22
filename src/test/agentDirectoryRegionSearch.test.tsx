/**
 * Searching the Agent Directory for an agent by name, phone or district.
 *
 * WHY: the By Region view used to narrow region and district rows only —
 * typing an agent's name found nothing, because the register was never asked.
 * Josh wants one search box that finds the agent directly.
 *
 * These tests pin what the search must actually do:
 *  - a name asks the same guarded register RPC the List view uses and shows
 *    the matching agents;
 *  - a phone number finds the agent too;
 *  - clicking a match opens the agent's profile.
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

// The register's answer for a name, a phone number, and a district the agent
// belongs to — the server matches all three against the same term.
const NAME_ANSWER = {
  kpis: { total_agents: 1, total_sub_agents: 0, total_active: 1, total_all: 1 },
  total_matched: 1,
  rows: [
    row({
      id: 'aaa-1',
      full_name: 'Nabukeera Sarah Namutebi',
      phone: '0772 111 222',
      verified: true,
      total_tenants: 6,
    }),
  ],
};

const PHONE_ANSWER = {
  ...NAME_ANSWER,
  rows: [row({ id: 'aaa-1', full_name: 'Nabukeera Sarah Namutebi', phone: '0772111222' })],
};

const DISTRICT_ANSWER = {
  ...NAME_ANSWER,
  rows: [row({ id: 'bbb-2', full_name: 'Okello Peter', district: 'Mbale', region: 'Eastern' })],
};

const EMPTY_ANSWER = {
  kpis: { total_agents: 1, total_sub_agents: 0, total_active: 1, total_all: 1 },
  total_matched: 0,
  rows: [],
};

const PROFILE = {
  bio: { full_name: 'Nabukeera Sarah Namutebi', phone: '0772 111 222', district: 'Wakiso', created_at: null },
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

describe('Agent search in the By Region directory', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (name: string, args: any) => {
      if (name === 'get_agent_directory_region_breakdown') return { data: REGION_ROWS, error: null };
      if (name === 'get_agent_directory_v2') {
        switch (args?.p_search) {
          case 'Nabukeera':
            return { data: NAME_ANSWER, error: null };
          case '0772111':
            return { data: PHONE_ANSWER, error: null };
          case 'Mbale':
            return { data: DISTRICT_ANSWER, error: null };
          default:
            return { data: EMPTY_ANSWER, error: null };
        }
      }
      if (name === 'get_agent_profile_360') return { data: PROFILE, error: null };
      return { data: null, error: null };
    });
  });

  it('finds an agent by name', async () => {
    renderDirectory();
    const box = await screen.findByLabelText('Search agents by name, phone, district or region');
    await userEvent.type(box, 'Nabukeera');

    expect(await screen.findByText('Matching agents')).toBeInTheDocument();
    expect(await screen.findByText('Nabukeera Sarah Namutebi')).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith(
      'get_agent_directory_v2',
      expect.objectContaining({ p_search: 'Nabukeera', p_limit: 10 }),
    );
  });

  it('finds an agent by phone number', async () => {
    renderDirectory();
    const box = await screen.findByLabelText('Search agents by name, phone, district or region');
    await userEvent.type(box, '0772111');

    expect(await screen.findByText('Matching agents')).toBeInTheDocument();
    expect(await screen.findByText('Nabukeera Sarah Namutebi')).toBeInTheDocument();
    expect(screen.getByText('0772111222')).toBeInTheDocument();
  });

  it('finds agents in a district by the district name', async () => {
    renderDirectory();
    const box = await screen.findByLabelText('Search agents by name, phone, district or region');
    await userEvent.type(box, 'Mbale');

    expect(await screen.findByText('Matching agents')).toBeInTheDocument();
    expect(await screen.findByText('Okello Peter')).toBeInTheDocument();
  });

  it('opens the matched agent’s profile when clicked', async () => {
    renderDirectory();
    const box = await screen.findByLabelText('Search agents by name, phone, district or region');
    await userEvent.type(box, 'Nabukeera');

    const match = await screen.findByRole('button', { name: 'Open profile for Nabukeera Sarah Namutebi' });
    await userEvent.click(match);

    expect(rpcMock).toHaveBeenCalledWith('get_agent_profile_360', { p_agent_id: 'aaa-1' });
    expect(await screen.findByRole('button', { name: /Back to directory/ })).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    renderDirectory();
    const box = await screen.findByLabelText('Search agents by name, phone, district or region');
    await userEvent.type(box, 'zzz');

    await waitFor(() => expect(screen.getByText(/No agents match/)).toBeInTheDocument());
    expect(screen.getByText(/“zzz”/)).toBeInTheDocument();
  });
});
