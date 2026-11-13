import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
    expect(container.querySelector('[data-flow-line="released"]')?.className).toContain('text-xl');
    expect(container.querySelector('[data-flow-line="live"]')?.className).toContain('text-xl');
    expect(screen.getByText('Incomplete requests: 4').className).toContain('text-xl');
  });

  it('"With agents, landlord not paid" lists those releases; one opens the plan drawer, where Recall shows', async () => {
    const id = '5b3c1f0e-1111-4222-8333-444455556666';
    const flow = {
      ...FLOW,
      items: [
        { rent_request_id: id, tenant: 'Amina Nakato', agent: 'Paul Okello', landlord: 'Grace L', amount: 650000, paid_out: 0, stage: 'with_agent', hours_since_release: 30 },
        { rent_request_id: '9d9d9d9d-1111-4222-8333-444455556666', tenant: 'Ben Live', agent: 'Ann', landlord: 'Leo', amount: 600000, paid_out: 600000, stage: 'live', hours_since_release: 50 },
      ],
    };
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'funded_money_flow'
          ? { data: flow, error: null }
          : fn === 'pipeline_incomplete_queue'
            ? { data: QUEUE, error: null }
            : fn === 'funders_board_can_demote'
              ? { data: true, error: null }
              : { data: null, error: null },
      ),
    );
    wrap(<FundersMoneyLines board />);
    fireEvent.click(await screen.findByRole('button', { name: 'With agents, landlord not paid: 3 · UGX 2,100,000 · oldest 80 h' }));
    const list = await screen.findByRole('dialog', { name: 'With agents, landlord not paid' });
    expect(within(list).getByText('Amina Nakato')).toBeTruthy();
    expect(within(list).queryByText('Ben Live')).toBeNull();
    // 1 of the 3 the server counted came back in its latest-50 items.
    expect(list.querySelector('[data-releases-note]')!.textContent).toBe('Last 30 days · latest 1 of 3 shown');
    fireEvent.click(within(list).getByRole('button', { name: 'Open the plan for Amina Nakato' }));
    const drawer = await screen.findByRole('dialog', { name: 'Rent Plan Ref 5B3C1F0E' });
    expect(await within(drawer).findByRole('button', { name: 'Recall' })).toBeTruthy();
    // Closing the drawer brings the list back.
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Close' })[0]);
    expect(await screen.findByRole('dialog', { name: 'With agents, landlord not paid' })).toBeTruthy();
  });

  it('the E93 lines are tappable too: Sold lists the sold ones, Selected, waiting lists every one not sold yet', async () => {
    const it2 = (id: string, tenant: string, stage: string) => ({ rent_request_id: id, tenant, agent: 'A', landlord: 'L', funder: 'F', amount: 500000, paid_out: 0, stage, selected_at: '2026-11-11T07:00:00Z', hours_since_release: 5 });
    const flow = {
      ...FLOW,
      sold: { count: 1, ugx: 500000 },
      selected_waiting: { count: 2, ugx: 1000000, oldest_hours: 30 },
      items: [
        it2('11111111-1111-4111-8111-111111111111', 'Sold Sam', 'sold'),
        it2('22222222-2222-4222-8222-222222222222', 'Waiting Wanda', 'with_agent'),
        it2('33333333-3333-4333-8333-333333333333', 'Part Pat', 'part_paid'),
      ],
    };
    answers(Promise.resolve({ data: flow, error: null }), Promise.resolve({ data: QUEUE, error: null }));
    const { container } = wrap(<FundersMoneyLines board={false} />);
    await screen.findByText('Released to agents: 12 · UGX 8,400,000');
    const names = (dlg: HTMLElement) => [...dlg.querySelectorAll('[data-release-tenant]')].map((e) => e.textContent);

    fireEvent.click(container.querySelector('[data-flow-line="sold"]') as HTMLElement);
    const sold = await screen.findByRole('dialog', { name: 'Sold (landlord paid, OTP)' });
    expect(names(sold)).toEqual(['Sold Sam']);
    expect(sold.querySelector('[data-releases-note]')!.textContent).toBe('Last 30 days');
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(container.querySelector('[data-flow-line="selected_waiting"]') as HTMLElement);
    const sel = await screen.findByRole('dialog', { name: 'Selected, waiting' });
    expect(names(sel).sort()).toEqual(['Part Pat', 'Waiting Wanda']);
    expect(sel.querySelector('[data-releases-note]')!.textContent).toBe('Right now');
  });

  it('sits under the top tiles of the cfo desk and reuses Op 5’s hook and words unchanged', () => {
    const page = readFileSync(resolve(__dirname, '../../DeskPage.tsx'), 'utf8');
    const tiles = page.indexOf("desk.id === 'cfo' && <FundersHeadline");
    const lines = page.indexOf("desk.id === 'cfo' && <FundersMoneyLines");
    expect(tiles).toBeGreaterThan(-1);
    expect(lines).toBeGreaterThan(tiles);
    const src = readFileSync(resolve(__dirname, '../FundersMoneyLines.tsx'), 'utf8');
    expect(src).toContain("import { MONEY_FLOW_DAYS, moneyFlowLines, useMoneyFlow } from '../moneyFlow'");
    expect(src).toContain("import { useIncompleteQueue } from '../incomplete'");
  });
});
