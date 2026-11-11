import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));

import { supabase } from '@/integrations/supabase/client';
import { FlowGrid, FlowPanel } from '../flow/FlowPanel';
import { FLOW_PERIODS, countText, flowColumns, flowWords, outBreakdown, outSplitLine, ugxShort, type DeskFlow } from '../flow/flowApi';

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
  note: 'Rolling windows from now: today = last 24 h',
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
    expect(today.querySelector('[data-cell="out-count"]')?.getAttribute('title')).toBe('7 forwarded · 1 sent back · 1 rejected');
    expect(screen.getAllByText('In')).toHaveLength(4);
    expect(screen.getAllByText('Out')).toHaveLength(4);
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
    for (const d of ['service-centre', 'agent-ops', 'tenant-ops', 'landlord-ops', 'coo']) {
      expect(outBreakdown(p, d)).toBe('7 forwarded · 1 sent back · 1 rejected');
    }
    for (const d of ['cfo', 'funders', 'partner-ops', 'command']) expect(outBreakdown(p, d)).toBe('funded 9');
    expect(outBreakdown(null, 'coo')).toBeNull();
  });

  it('names the columns per desk', () => {
    for (const d of ['service-centre', 'agent-ops', 'tenant-ops', 'landlord-ops', 'coo']) expect(flowWords(d)).toEqual({ in: 'In', out: 'Out' });
    for (const d of ['cfo', 'funders', 'partner-ops']) expect(flowWords(d)).toEqual({ in: 'Listed', out: 'Funded' });
    expect(flowWords('command')).toEqual({ in: 'New', out: 'Funded' });

    const funders = render(<FlowGrid flow={FLOW} deskId="cfo" board={false} mdUp />);
    expect(funders.getAllByText('Listed')).toHaveLength(4);
    expect(funders.getAllByText('Funded')).toHaveLength(4);
    expect(funders.container.querySelector('[data-cell="out-count"]')?.getAttribute('title')).toBe('funded 9');
    funders.unmount();
    const partner = render(<FlowGrid flow={FLOW} deskId="partner-ops" board={false} mdUp />);
    expect(partner.getAllByText('Listed')).toHaveLength(4);
    partner.unmount();
    const command = render(<FlowGrid flow={FLOW} deskId="command" board={false} mdUp />);
    expect(command.getAllByText('New')).toHaveLength(4);
    expect(command.getAllByText('Funded')).toHaveLength(4);
    expect(command.container.querySelector('[data-cell="out-count"]')?.getAttribute('title')).toBe('funded 9');
  });

  it('asks desk_flow for this desk and draws the card', async () => {
    rpcMock.mockResolvedValue({ data: FLOW, error: null });
    withClient(<FlowPanel deskId="agent-ops" board={false} />);
    expect(await screen.findByText('In and out')).not.toBeNull();
    expect(rpcMock).toHaveBeenCalledWith('desk_flow', { p_desk: 'agent-ops' });
    expect(await screen.findByText('Today (24 h)')).not.toBeNull();
    // desk_flow's note, as the card's grey footnote.
    expect(screen.getByText('Rolling windows from now: today = last 24 h').className).toContain('desk-label');
  });

  it('the command centre passes "command"', async () => {
    rpcMock.mockResolvedValue({ data: { ...FLOW, desk: 'command' }, error: null });
    withClient(<FlowPanel deskId="command" board={false} />);
    await screen.findByText('In and out');
    expect(rpcMock).toHaveBeenCalledWith('desk_flow', { p_desk: 'command' });
    expect((await screen.findAllByText('New')).length).toBe(4);
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

/*
 * Where the panel sits. The COO read "nothing changed" when it hung under the
 * board, so it goes straight under the "Ready for your push" heading, before
 * the board's own lead, period toggle, tiles and rows. The command centre has
 * it directly under the "Today on Welile" brief, and never on the wall display.
 */
describe('IN / OUT placement', () => {
  const src = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
  /** The JSX between the Ready heading's close and the end of its section, comments dropped. */
  const readySections = (s: string) =>
    [...s.matchAll(/Ready for your push\s*<\/h2>([\s\S]*?)<\/section>/g)].map((m) => m[1].replace(/\{\/\*[\s\S]*?\*\/\}/g, '').trim());

  it('is the first thing under "Ready for your push" on the framed desks, COO, Funders and Partner Ops', () => {
    const sections = readySections(src('DeskPage.tsx'));
    // [0] is the Service Centre person's scoped view; [1] the framed desks (SC, Agent, Tenant, Landlord Ops, COO, Funders); [2] Partner Ops.
    expect(sections).toHaveLength(3);
    for (const body of sections.slice(1)) expect(body.startsWith('<FlowPanel deskId={desk.id} board={board} />')).toBe(true);
    // Above the boards (FundersDashboard carries the Funders lead, period toggle and tiles).
    const framed = sections[1];
    for (const b of ['<FundersDashboard', '<CooBoard', '<ReadyBoard', '{tabs}']) expect(framed.indexOf('<FlowPanel')).toBeLessThan(framed.indexOf(b));
    expect(sections[2].indexOf('<FlowPanel')).toBeLessThan(sections[2].indexOf('<PartnerOpsBoard'));
    // Mounted once per view: nothing left under the section.
    expect(src('DeskPage.tsx').match(/<FlowPanel /g)).toHaveLength(2);
  });

  it('sits directly under the "Today on Welile" brief on the command centre, not on the wall', () => {
    const cc = src('CommandCentre.tsx').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(cc).toMatch(/<MorningBrief board=\{false\} enabled \/>\s*<FlowPanel deskId="command" board=\{false\} \/>/);
    expect(cc.match(/<FlowPanel /g)).toHaveLength(1);
    expect(src('CommandAdditions.tsx')).not.toContain('FlowPanel');
  });
});

describe('Out, split under the figure', () => {
  it('"Out 9 = 7 forwarded · 1 sent back · 1 rejected" under every stage desk period', () => {
    const { container } = render(<FlowGrid flow={FLOW} deskId="tenant-ops" board={false} mdUp />);
    const lines = [...container.querySelectorAll('[data-out-split]')].map((e) => e.textContent);
    expect(lines).toEqual([
      'Out 9 = 7 forwarded · 1 sent back · 1 rejected',
      'Out 64 = 60 forwarded · 3 sent back · 1 rejected',
      'Out 880 = 850 forwarded · 20 sent back · 10 rejected',
      'Out 1,400 = 1,350 forwarded · 30 sent back · 20 rejected',
    ]);
  });

  it('none where Out means funded, and none without data', () => {
    for (const d of ['cfo', 'funders', 'partner-ops', 'command']) expect(outSplitLine(FLOW.periods.today, d)).toBeNull();
    expect(outSplitLine(null, 'agent-ops')).toBeNull();
    const { container } = render(<FlowGrid flow={FLOW} deskId="command" board={false} mdUp />);
    expect(container.querySelector('[data-out-split]')).toBeNull();
  });
});

