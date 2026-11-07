import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));

import { supabase } from '@/integrations/supabase/client';
import { FlowGrid, FlowPanel } from '../flow/FlowPanel';
import { FLOW_PERIODS, countText, flowColumns, outBreakdown, ugxShort, type DeskFlow } from '../flow/flowApi';

const rpcMock = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

function withClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => rpcMock.mockReset());
afterEach(() => cleanup());

/* The shape `desk_flow` returns (read from the live definition). */
const period = (in_n: number, in_ugx: number, out_n: number, out_ugx: number, f = 0, r = 0, x = 0) => ({
  in_n,
  in_ugx,
  out_n,
  out_ugx,
  forwarded_n: f,
  returned_n: r,
  rejected_n: x,
});

const FLOW: DeskFlow = {
  desk: 'agent-ops',
  generated_at: '2026-11-07T09:00:00Z',
  periods: {
    today: period(12, 4_200_000, 9, 3_100_000, 7, 1, 1),
    '7d': period(70, 25_000_000, 64, 22_500_000, 60, 3, 1),
    '90d': period(910, 320_000_000, 880, 300_000_000, 850, 20, 10),
    all: period(1450, 512_340_000, 1400, 490_000_000, 1350, 30, 20),
  },
  note: 'Rolling windows from now',
};

describe('IN / OUT panel', () => {
  it('shows the four periods in the sketch order, each with count and UGX for IN and OUT', () => {
    const { container } = render(<FlowGrid flow={FLOW} deskId="agent-ops" board={false} mdUp />);
    const cells = [...container.querySelectorAll('[data-period]')].map((c) => c.getAttribute('data-period'));
    expect(cells).toEqual(['Today (24 h)', '7 days', '90 days', 'All time']);
    expect(FLOW_PERIODS.map((p) => p.key)).toEqual(['today', '7d', '90d', 'all']);

    const today = container.querySelector('[data-period="Today (24 h)"]') as HTMLElement;
    expect(today.querySelector('[data-cell="in-count"]')?.textContent).toBe('12');
    expect(today.querySelector('[data-cell="out-count"]')?.textContent).toBe('9');
    expect(today.querySelector('[data-cell="in-ugx"]')?.textContent).toBe('4.2M');
    expect(today.querySelector('[data-cell="in-ugx"]')?.getAttribute('title')).toBe('UGX 4,200,000');
    expect(today.querySelector('[data-cell="out-count"]')?.getAttribute('title')).toBe('7 forwarded · 1 returned · 1 rejected');
    expect(screen.getAllByText('IN')).toHaveLength(4);
    expect(screen.getAllByText('OUT')).toHaveLength(4);
  });

  it('is 2×2 on a phone and four across from md', () => {
    expect(flowColumns(false)).toBe(2);
    expect(flowColumns(true)).toBe(4);
    const phone = render(<FlowGrid flow={FLOW} deskId="agent-ops" board={false} mdUp={false} />);
    const grid = phone.container.querySelector('[data-flow-columns]') as HTMLElement;
    expect(grid.getAttribute('data-flow-columns')).toBe('2');
    expect(grid.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    phone.unmount();
    const wide = render(<FlowGrid flow={FLOW} deskId="agent-ops" board={false} mdUp />);
    expect((wide.container.querySelector('[data-flow-columns]') as HTMLElement).style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
  });

  it('formats missing figures as a dash and big ones short', () => {
    expect(countText(null)).toBe('—');
    expect(countText(1450)).toBe('1,450');
    expect(ugxShort(512_340_000)).toBe('512M');
    expect(ugxShort(22_500_000)).toBe('22.5M');
    expect(ugxShort(undefined)).toBe('—');
    const { container } = render(<FlowGrid flow={{ ...FLOW, periods: { today: null } }} deskId="agent-ops" board={false} mdUp />);
    expect(container.querySelector('[data-period="All time"] [data-cell="in-count"]')?.textContent).toBe('—');
  });

  it('says what OUT was made of, with funded where OUT means funded', () => {
    const p = period(1, 1, 9, 1, 7, 1, 1);
    expect(outBreakdown(p, 'tenant-ops')).toBe('7 forwarded · 1 returned · 1 rejected');
    expect(outBreakdown(p, 'cfo')).toBe('7 funded · 1 returned · 1 rejected');
    expect(outBreakdown(p, 'command')).toBe('9 funded');
  });

  it('asks desk_flow for this desk and draws the card', async () => {
    rpcMock.mockResolvedValue({ data: FLOW, error: null });
    withClient(<FlowPanel deskId="agent-ops" board={false} />);
    expect(await screen.findByText('In and out')).not.toBeNull();
    expect(rpcMock).toHaveBeenCalledWith('desk_flow', { p_desk: 'agent-ops' });
    expect(await screen.findByText('Today (24 h)')).not.toBeNull();
  });

  it('the command centre passes "command"', async () => {
    rpcMock.mockResolvedValue({ data: { ...FLOW, desk: 'command' }, error: null });
    withClient(<FlowPanel deskId="command" board={false} />);
    await screen.findByText('In and out');
    expect(rpcMock).toHaveBeenCalledWith('desk_flow', { p_desk: 'command' });
  });

  it('hides for a viewer the server refuses, and on a desk with no stage', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'not authorized' } });
    const refused = withClient(<FlowPanel deskId="coo" board={false} />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    await waitFor(() => expect(refused.container.textContent).toBe(''));
    cleanup();
    rpcMock.mockReset();
    const care = withClient(<FlowPanel deskId="customer-care" board={false} />);
    expect(care.container.textContent).toBe('');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
