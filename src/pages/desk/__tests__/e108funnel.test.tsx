import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E108: "Where rent requests get stuck", from posting_funnel. Only what it returns. */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));
// jsdom has no layout: give the charts a size so recharts draws.
vi.mock('recharts', async (orig) => {
  const m = await orig<typeof import('recharts')>();
  const { cloneElement } = await import('react');
  return { ...m, ResponsiveContainer: ({ children }: { children: React.ReactElement }) => <div>{cloneElement(children, { width: 600, height: 200 })}</div> };
});

import { PostingFunnelCard, itemWords, readFunnel } from '../coo/PostingFunnel';

const FUNNEL = {
  agents_opened: 120,
  agents_posted: 45,
  conversion_pct: 37.5,
  requests: 61,
  daily: Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, agents_opened: 10 + i, agents_posted: 4 + (i % 3), conversion_pct: 40 })),
  milestones: [
    { step: 'opened', agents: 120 },
    { step: 'id_front', agents: 90 },
    { step: 'lc1_letter', agents: 60 },
    { step: 'submitted', agents: 45 },
  ],
  tracked: {
    blocking_items: [
      { item: 'lc1_letter', sessions_blocked: 40, abandoned_after: 12, fixed_and_posted: 20 },
      { item: 'id_front', sessions_blocked: 55, abandoned_after: 30, fixed_and_posted: 18 },
      { item: 'house_photo', sessions_blocked: 10, abandoned_after: 2, fixed_and_posted: 7 },
    ],
    last_block_before_quitting: [{ item: 'id_front', sessions: 30 }, { item: 'lc1_letter', sessions: 12 }],
    abandoned_at_step: [{ step: 'documents', sessions: 25 }],
    submit_failures: [{ code: 'NETWORK', times: 4, agents: 3 }],
  },
  resubmit_checklist: [{ item: 'lc1_letter', agents: 9 }, { item: 'id_back', agents: 3 }],
  by_vetting: [
    { status: 'unverified', agents_opened: 80, agents_posted: 12 },
    { status: 'verified', agents_opened: 35, agents_posted: 30 },
    { status: 'rejected', agents_opened: 0, agents_posted: 0 },
  ],
  drafts: { open: 14, agents: 9, missing: [{ item: 'lc1_letter', drafts: 8 }, { item: 'house_photos', drafts: 5 }] },
  markers: [
    { at: '2026-10-10T08:00:00Z', day: '2026-10-10', kind: 'rule', label: 'LC1 letter now required' },
    { at: '2026-10-20T08:00:00Z', day: '2026-10-20', kind: 'release:commit', label: 'Form release' },
    { at: '2026-10-20T09:00:00Z', day: '2026-10-20', kind: 'switch', label: 'Agent form switch' },
    { at: '2026-09-01T08:00:00Z', day: '2026-09-01', kind: 'rule', label: 'Off the chart' },
  ],
};
const EMPTY = { agents_opened: 0, agents_posted: 0, conversion_pct: null, requests: 0, daily: [], milestones: [], tracked: { blocking_items: [], last_block_before_quitting: [], abandoned_at_step: [], submit_failures: 0 }, resubmit_checklist: [] };

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
const findEl = (sel: string) =>
  waitFor(() => {
    const el = document.querySelector(sel) as HTMLElement | null;
    expect(el).toBeTruthy();
    return el!;
  });

beforeEach(() => h.rpc.mockReset());

describe('reading posting_funnel', () => {
  it('friendly item names, with unknown keys in words', () => {
    expect(itemWords('id_front')).toBe('ID photo front');
    expect(itemWords('lc1_letter')).toBe('LC1 letter');
    expect(itemWords('water_bill')).toBe('Water bill');
  });
  it('the last 28 days, blocking items by how many gave up after them, lists in the server’s order', () => {
    const f = readFunnel(FUNNEL);
    expect(f.daily).toHaveLength(28);
    expect(f.daily[0].day).toBe('2026-10-03');
    expect(f.blocking.map((b) => b.item)).toEqual(['id_front', 'lc1_letter', 'house_photo']);
    expect(f.milestones.map((m) => m.label)).toEqual(['opened', 'id_front', 'lc1_letter', 'submitted']);
  });
});

describe('Where rent requests get stuck', () => {
  it('sample: headline, charts with a table view, milestone bars, tracked sessions and the send-back checklist', async () => {
    h.rpc.mockResolvedValue({ data: FUNNEL, error: null });
    wrap(<PostingFunnelCard board={false} />);
    expect((await findEl('[data-funnel-headline]')).textContent).toBe('120 agents opened → 45 posted (37.5%) · 61 requests');
    expect(h.rpc).toHaveBeenCalledWith('posting_funnel', { p_days: 14, p_form: 'agent_post' });

    // Two charts (counts; conversion), and the same days as a table.
    expect(screen.getByRole('img', { name: 'Agents who opened and posted, by day' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Conversion, by day' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show as a table' }));
    expect(document.querySelectorAll('[data-daily-table] tbody tr')).toHaveLength(28);

    // Milestones in order, labelled as direction only.
    expect(screen.getByText('from button taps — direction, not exact')).toBeTruthy();
    expect(Array.from(document.querySelectorAll('[data-milestone]')).map((m) => m.textContent)).toEqual(['Opened120', 'ID photo front90', 'LC1 letter60', 'Submitted45']);

    // Blocking items, friendliest names, most given-up first.
    const rows = Array.from(document.querySelectorAll('[data-blocking-items] tbody tr'));
    expect(rows.map((r) => r.firstElementChild?.textContent)).toEqual(['ID photo front', 'LC1 letter', 'House photo']);
    expect(rows[0].textContent).toBe('ID photo front553018');

    expect(within(screen.getByRole('list', { name: 'Last block before quitting' })).getByText('ID photo front')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Gave up at step' })).getByText('Documents')).toBeTruthy();
    expect(document.querySelector('[data-submit-failure="NETWORK"]')?.textContent).toBe('NETWORK4× · 3 agents');
    const checklist = screen.getByRole('list', { name: 'Send-back checklist' });
    expect(checklist.textContent).toBe('LC1 letter9ID photo back3');
  });

  it('E110: by vetting status marks agents who opened but are not verified; open drafts and what they miss', async () => {
    h.rpc.mockResolvedValue({ data: FUNNEL, error: null });
    wrap(<PostingFunnelCard board={false} />);
    const table = await findEl('[data-by-vetting]');
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    expect(rows.map((r) => [r.getAttribute('data-vetting'), r.getAttribute('data-flag')])).toEqual([
      ['unverified', 'true'],
      ['verified', null],
      ['rejected', null],
    ]);
    expect(rows[0].textContent).toBe('Not verifiedopened, not verified8012');
    expect(document.querySelector('[data-drafts]')?.textContent).toBe('14 open drafts · 9 agents');
    expect(screen.getByRole('list', { name: 'Missing from drafts' }).textContent).toBe('LC1 letter8House photos5');
  });

  it('E110: markers are vertical lines on the daily charts, by kind; a tap shows the labels', async () => {
    h.rpc.mockResolvedValue({ data: FUNNEL, error: null });
    wrap(<PostingFunnelCard board={false} />);
    await findEl('[data-funnel-headline]');
    const flags = await waitFor(() => {
      const els = Array.from(document.querySelectorAll('[aria-label="Agents who opened and posted, by day"] [data-marker-day]'));
      expect(els.length).toBeGreaterThan(0);
      return els;
    });
    // One line per day on the chart (the off-chart day is left out); a day's colour is its biggest kind.
    expect(flags.map((f) => [f.getAttribute('data-marker-day'), f.getAttribute('data-marker-kind')])).toEqual([
      ['2026-10-10', 'rule'],
      ['2026-10-20', 'release'],
    ]);
    expect(flags[1].querySelector('title')?.textContent).toBe('Release: Form release\nSwitch: Agent form switch');
    fireEvent.click(flags[1]);
    expect((await findEl('[data-picked-markers="2026-10-20"]')).textContent).toContain('Switch: Agent form switch');
    // The kinds in words beside their colours (light magenta is under 3:1, so words are a must).
    const legend = screen.getByLabelText('Change markers');
    for (const w of ['Release', 'Rule change', 'Switch']) expect(within(legend).getByText(w)).toBeTruthy();
  });

  it('the day and form switches ask the server again', async () => {
    h.rpc.mockResolvedValue({ data: FUNNEL, error: null });
    wrap(<PostingFunnelCard board={false} />);
    await findEl('[data-funnel-headline]');
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('posting_funnel', { p_days: 30, p_form: 'agent_post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tenant self-apply' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('posting_funnel', { p_days: 30, p_form: 'tenant_self' }));
  });

  it('empty: zeros as sent, "—" for a conversion it did not send, and plain empty lines', async () => {
    h.rpc.mockResolvedValue({ data: EMPTY, error: null });
    wrap(<PostingFunnelCard board={false} />);
    expect((await findEl('[data-funnel-headline]')).textContent).toBe('0 agents opened → 0 posted (—) · 0 requests');
    expect(screen.getByText('No days came back.')).toBeTruthy();
    expect(screen.getByText('No steps came back.')).toBeTruthy();
    expect(screen.getByText('Nothing blocked a tracked session.')).toBeTruthy();
    expect(document.querySelector('[data-submit-failures]')?.textContent).toBe('0');
  });

  it('no card while the server lacks the function, or for a viewer it refuses', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.posting_funnel' } });
    const a = wrap(<PostingFunnelCard board={false} />);
    await waitFor(() => expect(a.container.querySelector('[aria-label="Where rent requests get stuck"]')).toBeNull());
    a.unmount();
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not for you' } });
    const b = wrap(<PostingFunnelCard board={false} />);
    await waitFor(() => expect(b.container.querySelector('[aria-label="Where rent requests get stuck"]')).toBeNull(), { timeout: 4000 });
  });

  it('sits on the Command Centre, Agent Ops and the Service Centre', () => {
    const cc = readFileSync(resolve(__dirname, '../CommandCentre.tsx'), 'utf8');
    expect(cc).toContain('<PostingFunnelCard board={false} />');
    const page = readFileSync(resolve(__dirname, '../DeskPage.tsx'), 'utf8');
    expect(page).toContain("(desk.id === 'agent-ops' || desk.id === 'service-centre') && <PostingFunnelCard board={board} />");
  });
});
