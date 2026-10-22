/**
 * The Agent Directory opens on the "By Region" view.
 *
 * WHY: Agent Ops overview hands off to this screen through the
 * "Open agent directory" buttons (General Agents Activities and the
 * brief drill-downs). Josh wants that hand-off to land on the regional
 * picture first, not a flat 50-row page of names — the region list is
 * how the field force is actually managed.
 *
 * The toggle still works both ways, so this pins the DEFAULT only:
 * opening the directory shows the regional grouping, and choosing
 * "List" still reaches the searchable register.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rest: {},
    rpc: (...a: unknown[]) => rpcMock(...a),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    from: () => ({ insert: async () => ({ data: null, error: null }) }),
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

const DIRECTORY_EMPTY = {
  kpis: { total_agents: 185, total_sub_agents: 20, total_active: 100, total_all: 205 },
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

describe('Agent Directory default view', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'get_agent_directory_region_breakdown') return { data: REGION_ROWS, error: null };
      if (name === 'get_agent_directory_v2') return { data: DIRECTORY_EMPTY, error: null };
      return { data: null, error: null };
    });
  });

  it('opens on the regional grouping, not the flat list', async () => {
    renderDirectory();

    // Regional grouping is on screen with the server's own totals.
    const regionFilter = await screen.findByPlaceholderText('Search agents, regions or districts…');
    expect(regionFilter).toBeInTheDocument();
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/185 agents across 2 regions/),
    );
    expect(screen.getByRole('button', { name: /^Central region/ })).toBeInTheDocument();

    // The flat register (its search box and row filters) is NOT the landing view.
    expect(screen.queryByPlaceholderText(/Search by name, phone, district/)).toBeNull();
    expect(screen.queryByText('Any status')).toBeNull();
  });

  it('still lets the user switch to the flat list', async () => {
    renderDirectory();
    await screen.findByPlaceholderText('Search agents, regions or districts…');

    await userEvent.click(screen.getByRole('button', { name: /List/ }));

    expect(await screen.findByPlaceholderText(/Search by name, phone, district/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search agents, regions or districts…')).toBeNull();
  });

  it('asks the server for the regional breakdown on open', async () => {
    renderDirectory();
    await screen.findByPlaceholderText('Search agents, regions or districts…');

    expect(rpcMock).toHaveBeenCalledWith(
      'get_agent_directory_region_breakdown',
      expect.objectContaining({ _verified_only: false }),
    );
  });
});
