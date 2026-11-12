import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E85 on the Funders Dashboard (/desk/cfo): the money after release and the incomplete count, under the top tiles. */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['cfo'] }) }));

import { FundersMoneyLines, INCOMPLETE_REFRESH_MS } from '../FundersMoneyLines';

const FLOW = {
  released: { count: 12, ugx: 8400000 },
  with_agent: { count: 3, ugx: 2100000, oldest_hours: 80 },
  part_paid: { count: 1, ugx_paid: 300000, ugx_left: 400000 },
  live: { count: 9, ugx: 6300000 },
  items: [],
};
const QUEUE = { count: 4, by_desk: { coo: 4 }, items: [] };

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

const answers = (flow: unknown, queue: unknown) =>
  h.rpc.mockImplementation((fn: string) =>
    fn === 'funded_money_flow' ? flow : fn === 'pipeline_incomplete_queue' ? queue : Promise.resolve({ data: null, error: null }),
  );

beforeEach(() => h.rpc.mockReset());
afterEach(() => vi.useRealTimers());

describe('Funders Dashboard money lines', () => {
  it('skeletons first, never a zero; then the four lines and the incomplete count', async () => {
    let flow!: (v: unknown) => void;
    let queue!: (v: unknown) => void;
    answers(new Promise((r) => (flow = r)), new Promise((r) => (queue = r)));
    wrap(<FundersMoneyLines board={false} />);
    expect(screen.getByRole('status', { name: 'Loading the money after release' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading the incomplete requests' })).toBeTruthy();
    expect(screen.queryByText(/: 0/)).toBeNull();

    await act(async () => {
      flow({ data: FLOW, error: null });
      queue({ data: QUEUE, error: null });
    });
    expect(await screen.findByText('Released to agents: 12 · UGX 8,400,000')).toBeTruthy();
    const withAgent = screen.getByText('With agents, landlord not paid: 3 · UGX 2,100,000 · oldest 80 h');
    expect(withAgent.getAttribute('data-tone')).toBe('bad');
    expect(screen.getByText('Part paid to landlords: 1 · UGX 300,000 paid · UGX 400,000 left')).toBeTruthy();
    expect(screen.getByText('LIVE (landlord paid): 9 · UGX 6,300,000')).toBeTruthy();
    const inc = screen.getByText('Incomplete requests: 4');
    expect(inc.getAttribute('data-tone')).toBe('bad');
  });

  it('the server’s words on a failure, not a zero', async () => {
    answers(Promise.resolve({ data: null, error: { code: 'P0001', message: 'queue offline' } }), Promise.resolve({ data: null, error: { code: 'P0001', message: 'incomplete offline' } }));
    wrap(<FundersMoneyLines board={false} />);
    // Both hooks retry once before they show the failure.
    expect(await screen.findByText('queue offline', undefined, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByText('incomplete offline', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(/Incomplete requests: 0/)).toBeNull();
  });

  it('refetches the incomplete count every 30 s (the money lines poll on their own 30 s)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answers(Promise.resolve({ data: FLOW, error: null }), Promise.resolve({ data: QUEUE, error: null }));
    wrap(<FundersMoneyLines board={false} />);
    await screen.findByText('Incomplete requests: 4');
    const calls = () => h.rpc.mock.calls.filter((c) => c[0] === 'pipeline_incomplete_queue').length;
    const before = calls();
    await act(async () => {
      vi.advanceTimersByTime(INCOMPLETE_REFRESH_MS + 10);
    });
    expect(calls()).toBeGreaterThan(before);
  });

  it('the wall view sizes every line for TV distance', async () => {
    answers(Promise.resolve({ data: FLOW, error: null }), Promise.resolve({ data: QUEUE, error: null }));
    const { container } = wrap(<FundersMoneyLines board />);
    await screen.findByText('Released to agents: 12 · UGX 8,400,000');
    expect(container.querySelector('[data-funders-money-lines]')?.className).toContain('[&_span[data-flow-line]]:!text-xl');
    expect(screen.getByText('Incomplete requests: 4').className).toContain('text-xl');
  });

  it('sits under the top tiles of the cfo desk and reuses Op 5’s component unchanged', () => {
    const page = readFileSync(resolve(__dirname, '../../DeskPage.tsx'), 'utf8');
    const tiles = page.indexOf("desk.id === 'cfo' && <FundersHeadline");
    const lines = page.indexOf("desk.id === 'cfo' && <FundersMoneyLines");
    expect(tiles).toBeGreaterThan(-1);
    expect(lines).toBeGreaterThan(tiles);
    const src = readFileSync(resolve(__dirname, '../FundersMoneyLines.tsx'), 'utf8');
    expect(src).toContain("import { MoneyFlowLines } from '../moneyFlow'");
    expect(src).toContain("import { useIncompleteQueue } from '../incomplete'");
  });
});
