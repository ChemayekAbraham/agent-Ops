import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E85: the funders' money after release, live, under the funders cards on the Command Centre and its wall view. */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));

import { MONEY_FLOW_REFRESH_MS, MoneyFlowLines, moneyFlowLines, type MoneyFlow } from '../moneyFlow';
import { PushQueueCards } from '../PushQueueCards';

const FLOW = {
  released: { count: 12, ugx: 8400000 },
  with_agent: { count: 3, ugx: 2100000, oldest_hours: 30.4 },
  part_paid: { count: 0, ugx_paid: 0, ugx_left: 0 },
  paid_to_landlord: { count: 7, ugx: 4900000 },
  plan_live: { count: 2, ugx: 1400000 },
  live: { count: 9, ugx: 6300000 },
  items: [
    { rent_request_id: 'a', tenant: 'Tina', agent: 'Andy', landlord: 'Lucy', amount: 700000, paid_out: 0, stage: 'with_agent', hours_since_release: 30.4 },
    { rent_request_id: 'b', tenant: 'Ben', agent: 'Ann', landlord: 'Leo', amount: 600000, paid_out: 600000, stage: 'live', hours_since_release: 50 },
    { rent_request_id: 'c', tenant: 'Cara', agent: 'Ann', landlord: 'Lia', amount: 800000, paid_out: 800000, stage: 'live', hours_since_release: 90 },
  ],
};

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => h.rpc.mockReset());

describe('the lines', () => {
  const f = FLOW as unknown as MoneyFlow;
  it('in the order the money moves, in the brief’s words', () => {
    expect(moneyFlowLines(f).map((l) => l.text)).toEqual([
      'Released to agents: 12 · UGX 8,400,000',
      'With agents, landlord not paid: 3 · UGX 2,100,000 · oldest 30 h',
      'LIVE (landlord paid): 9 · UGX 6,300,000',
    ]);
    expect(moneyFlowLines(f).some((l) => /Paid to landlords|Plans live/.test(l.text))).toBe(false);
  });
  it('LIVE from `live`; without it, the two older parts add up to it', async () => {
    const { live: _drop, ...older } = FLOW;
    h.rpc.mockResolvedValue({ data: older, error: null });
    wrap(<MoneyFlowLines board />);
    expect(await screen.findByText('LIVE (landlord paid): 9 · UGX 6,300,000')).toBeTruthy();
  });
  it('"with agents" is amber past 24 h, red past 72 h, plain when none is waiting', () => {
    const tone = (h2: number | null, count = 3) => moneyFlowLines({ ...f, with_agent: { count, ugx: 1, oldest_hours: h2 } })[1].tone;
    expect(tone(10)).toBe('ok');
    expect(tone(30)).toBe('warn');
    expect(tone(80)).toBe('bad');
    expect(tone(null, 0)).toBe('idle');
    expect(moneyFlowLines({ ...f, with_agent: { count: 0, ugx: 0, oldest_hours: null } })[1].text).toBe('With agents, landlord not paid: 0 · UGX 0');
  });
  it('part-paid shows only when some is part paid, so the lines add up', () => {
    const lines = moneyFlowLines({ ...f, part_paid: { count: 1, ugx_paid: 300000, ugx_left: 400000 } });
    expect(lines.map((l) => l.key)).toEqual(['released', 'with_agent', 'part_paid', 'live']);
    expect(lines[2].text).toBe('Part paid to landlords: 1 · UGX 300,000 paid · UGX 400,000 left');
  });
});

describe('on the Command Centre', () => {
  it('skeleton first (never a zero), then the lines; tap lists the releases with their stage', async () => {
    let answer!: (v: unknown) => void;
    h.rpc.mockReturnValue(new Promise((r) => (answer = r)));
    wrap(<MoneyFlowLines board={false} />);
    expect(screen.getByRole('status', { name: 'Loading the money after release' })).toBeTruthy();
    expect(screen.queryByText(/Released to agents/)).toBeNull();
    answer({ data: FLOW, error: null });
    await screen.findByText('Released to agents: 12 · UGX 8,400,000');
    expect(h.rpc).toHaveBeenCalledWith('funded_money_flow', { p_days: 30 });
    expect(document.querySelector('[data-flow-line="with_agent"]')?.getAttribute('data-tone')).toBe('warn');

    fireEvent.click(screen.getByRole('button', { name: /Released to agents/ }));
    const sheet = screen.getByRole('dialog', { name: 'Funder money after release' });
    const items = within(sheet).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-flow-item'))).toEqual(['with_agent', 'live', 'live']);
    expect(items[0].textContent).toContain('With agent');
    expect(items[0].textContent).toContain('UGX 700,000');
    expect(items[0].textContent).toContain('Agent Andy · Landlord Lucy');
    expect(within(items[1]).getByText('LIVE').getAttribute('data-tone')).toBe('ok');
    expect(items[1].textContent).toContain('paid out UGX 600,000');
  });

  it('the wall view shows the lines but no tap', async () => {
    h.rpc.mockResolvedValue({ data: FLOW, error: null });
    wrap(<MoneyFlowLines board />);
    await screen.findByText('Released to agents: 12 · UGX 8,400,000');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('asks again every 30 seconds, so the lines move as agents pay landlords', async () => {
    expect(MONEY_FLOW_REFRESH_MS).toBe(30_000);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      h.rpc.mockResolvedValue({ data: FLOW, error: null });
      wrap(<MoneyFlowLines board />);
      await vi.waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(MONEY_FLOW_REFRESH_MS + 100);
      await vi.waitFor(() => expect(h.rpc.mock.calls.length).toBeGreaterThanOrEqual(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failure says so; a viewer it is not for sees nothing', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'statement timeout' } });
    const { unmount } = wrap(<MoneyFlowLines board={false} />);
    expect((await screen.findByRole('alert', {}, { timeout: 5000 })).textContent).toBe('statement timeout');
    unmount();
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'This view is for the COO, CEO, Command Centre, Partner Ops and CFO' } });
    const { container } = wrap(<MoneyFlowLines board={false} />);
    await waitFor(() => expect(container.querySelector('[data-money-flow]')).toBeNull(), { timeout: 5000 });
  });

  it('sits under the funders cards on the Command Centre, not on the COO desk', async () => {
    h.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'funded_money_flow' ? { data: FLOW, error: null } : { data: {}, error: null }));
    const cc = wrap(<PushQueueCards board={false} enabled />);
    await waitFor(() => expect(cc.container.querySelector('[data-money-flow]')).toBeTruthy());
    cc.unmount();
    const coo = wrap(<PushQueueCards board={false} enabled onCooDesk />);
    await waitFor(() => expect(coo.container.querySelector('[data-awaiting-release]')).toBeTruthy());
    expect(coo.container.querySelector('[data-money-flow]')).toBeNull();
  });
});
