import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), functions: { invoke: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['cfo'] }) }));

import { FundersHeadline } from '../FundersHeadline';
import { dayText, parseHeadlineList } from '../headlineListApi';
import type { Period } from '../cfoApi';

/* The shape funders_headline_list returns (read from the live definition). */
const ROW = (i: number, over: Record<string, unknown> = {}) => ({
  id: `a1b2c3d${i}-0000-0000-0000-000000000000`,
  req: `a1b2c3d${i}`,
  at: `2026-11-0${9 - i}T08:00:00Z`,
  tenant: `Tenant ${i}`,
  tenant_location: 'Kireka, Wakiso',
  agent: `Agent ${i}`,
  landlord: `Landlord ${i}`,
  landlord_phone: '0700 000 003',
  rent: 1_250_000,
  posted_at: `2026-11-0${9 - i}T08:00:00Z`,
  status: 'coo_approved',
  status_label: "On the funders' board",
  partner: null,
  partner_phone: null,
  released_at: null,
  ...over,
});
const LIST: Record<string, unknown> = {
  posted: { period: '7d', kind: 'posted', count: 2, ugx: 2_500_000, rows: [ROW(1), ROW(2)] },
  sold: {
    period: '7d',
    kind: 'sold',
    count: 1,
    ugx: 1_250_000,
    rows: [ROW(1, { status: 'funded', status_label: 'Approved for payout (CFO), landlord not yet confirmed paid', partner: 'Partner Nansubuga', partner_phone: '0772 111 222', released_at: '2026-11-08T10:30:00Z' })],
  },
  waiting: { period: '7d', kind: 'waiting', count: 0, ugx: 0, rows: [] },
};
const DASH = { headline: { posted: { n: 2, ugx: 2_500_000 }, sold: { n: 0, ugx: 0 }, waiting: { n: 2, ugx: 2_500_000 } }, rows: [] };
/* funded_money_flow(p_days): one release, for Tenant 1's request, money still with the agent. */
const FLOW = {
  released: { count: 1, ugx: 650_000 },
  with_agent: { count: 1, ugx: 650_000, oldest_hours: 5 },
  part_paid: { count: 0, ugx_paid: 0, ugx_left: 0 },
  live: { count: 0, ugx: 0 },
  items: [{ rent_request_id: ROW(1).id, tenant: 'Tenant 1', agent: 'Agent 1', landlord: 'Landlord 1', amount: 650_000, paid_out: 0, stage: 'with_agent', hours_since_release: 5 }],
};
let flow: unknown = FLOW;
let lists: Record<string, unknown> = LIST;

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });

beforeEach(() => {
  flow = FLOW;
  lists = LIST;
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string, args: { p_kind?: string }) =>
    Promise.resolve(
      fn === 'funders_dashboard'
        ? { data: DASH, error: null }
        : fn === 'funders_headline_list'
          ? { data: lists[args.p_kind ?? 'posted'], error: null }
          : fn === 'funded_money_flow'
            ? { data: flow, error: null }
            : { data: null, error: null },
    ),
  );
});
afterEach(() => {
  cleanup();
  setWidth(1024);
});

function Page({ start = '7d' as Period }) {
  const [period, setPeriod] = useState<Period>(start);
  return <FundersHeadline board={false} period={period} onPeriodChange={setPeriod} />;
}
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Page />
    </QueryClientProvider>,
  );
const tile = (name: RegExp) => screen.findByRole('button', { name });

describe('Funders headline tiles open their list', () => {
  it('the three tiles are buttons that read as tappable', async () => {
    mount();
    for (const t of [/^Rent requests posted/, /^Rent requests sold/, /^Waiting for funder/]) {
      const b = await tile(t);
      expect(b.getAttribute('aria-haspopup')).toBe('dialog');
      expect(b.className).toContain('active:scale-[0.98]');
      expect(b.className).toContain('cursor-pointer');
    }
    expect((await tile(/^Rent requests sold/)).textContent).toContain("Released to an agent's landlord float");
    expect((await tile(/^Waiting for funder/)).textContent).toContain('Posted minus released');
  });

  it('sold = released to an agent in the period; waiting = posted minus released, so they add up', async () => {
    mount();
    const sold = await tile(/^Rent requests sold: 1, UGX 650K/);
    expect(sold).toBeTruthy();
    // 2 posted (UGX 2.5M) − 1 released (UGX 650K) = 1 waiting (UGX 1.85M), not the server's landlord-paid "sold".
    expect(await tile(/^Waiting for funder: 1, UGX 1\.9M/)).toBeTruthy();
    expect(rpcMock).toHaveBeenCalledWith('funded_money_flow', { p_days: 7 });
  });

  it('the period chips ask for p_days 1 / 7 / 30 / 90 / 365', async () => {
    mount();
    await tile(/^Rent requests sold/);
    for (const [label, days] of [['Today', 1], ['30 days', 30], ['90 days', 90], ['All time', 365]] as const) {
      fireEvent.click(await screen.findByRole('button', { name: label }));
      await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('funded_money_flow', { p_days: days }));
    }
  });

  it('a release the server has not answered is never shown as zero', async () => {
    flow = new Promise(() => {});
    rpcMock.mockImplementation((fn: string, args: { p_kind?: string }) =>
      fn === 'funded_money_flow' ? new Promise(() => {}) : Promise.resolve(fn === 'funders_dashboard' ? { data: DASH, error: null } : { data: lists[args.p_kind ?? 'posted'], error: null }),
    );
    mount();
    expect((await screen.findAllByRole('status', { name: 'Loading the headline' })).length).toBe(3);
    expect(screen.queryByRole('button', { name: /^Rent requests sold/ })).toBeNull();
  });

  it('posted: asks for the page period and kind, header shows period, count and UGX, rows newest first', async () => {
    mount();
    fireEvent.click(await tile(/^Rent requests posted/));
    const dlg = await screen.findByRole('dialog', { name: 'Rent requests posted' });
    expect(rpcMock).toHaveBeenCalledWith('funders_headline_list', { p_period: '7d', p_kind: 'posted' });
    await waitFor(() => expect(dlg.querySelectorAll('[data-headline-row]')).toHaveLength(2));
    const summary = dlg.querySelector('[data-headline-summary]')!.textContent;
    expect(summary).toBe('7 days · 2 requests · UGX 2.5M');
    const rows = [...dlg.querySelectorAll('[data-headline-row]')] as HTMLElement[];
    expect(rows.map((r) => within(r).getByText(/^Tenant/).textContent)).toEqual(['Tenant 1', 'Tenant 2']);
    const first = rows[0];
    expect(within(first).getByText('a1b2c3d1')).toBeTruthy();
    expect(within(first).getByText('Kireka, Wakiso')).toBeTruthy();
    expect(within(first).getByText('UGX 1.3M').getAttribute('title')).toBe('UGX 1,250,000');
    expect(within(first).getByText('Posted 8 Nov 2026')).toBeTruthy();
    expect(within(first).getByText("On the funders' board")).toBeTruthy();
    expect(first.textContent).toContain('Agent Agent 1');
    expect(first.textContent).toContain('Landlord Landlord 1');
    expect(within(first).getByRole('link', { name: '0700 000 003' }).getAttribute('href')).toBe('tel:0700000003');
    expect(first.querySelector('[data-sold-line]')).toBeNull();
  });

  it('sold: lists the releases of the period with their stage; a tap opens the plan drawer', async () => {
    mount();
    fireEvent.click(await tile(/^Rent requests sold/));
    const dlg = await screen.findByRole('dialog', { name: 'Rent requests sold' });
    expect(rpcMock).not.toHaveBeenCalledWith('funders_headline_list', expect.objectContaining({ p_kind: 'sold' }));
    expect(dlg.querySelector('[data-releases-note]')!.textContent).toBe("7 days · released to an agent's landlord float in the last 7 days");
    const rel = dlg.querySelector(`[data-release="${ROW(1).id}"]`) as HTMLElement;
    expect(rel.textContent).toContain('Tenant 1');
    expect(within(rel).getByText('With agent')).toBeTruthy();
    fireEvent.click(rel);
    expect(await screen.findByRole('dialog', { name: 'Rent Plan Ref A1B2C3D1' })).toBeTruthy();
  });

  it('waiting: the posted list without the released requests', async () => {
    mount();
    fireEvent.click(await tile(/^Waiting for funder/));
    const dlg = await screen.findByRole('dialog', { name: 'Waiting for funder' });
    expect(rpcMock).toHaveBeenCalledWith('funders_headline_list', { p_period: '7d', p_kind: 'posted' });
    await waitFor(() => expect(dlg.querySelectorAll('[data-headline-row]')).toHaveLength(1));
    expect(within(dlg).getByText('Tenant 2')).toBeTruthy();
    expect(within(dlg).queryByText('Tenant 1')).toBeNull();
    expect(dlg.querySelector('[data-headline-summary]')!.textContent).toBe('7 days · 1 request · UGX 1.3M');
  });

  it('an empty list says "Nothing in this period"', async () => {
    lists = { ...LIST, posted: { period: '7d', kind: 'posted', count: 0, ugx: 0, rows: [] } };
    mount();
    fireEvent.click(await tile(/^Waiting for funder/));
    const dlg = await screen.findByRole('dialog', { name: 'Waiting for funder' });
    expect(await within(dlg).findByText('Nothing in this period')).toBeTruthy();
    expect(dlg.querySelector('[data-headline-summary]')!.textContent).toBe('7 days · 0 requests · UGX 0');
  });

  it('follows the page period, and closes on Escape', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '30 days' }));
    fireEvent.click(await tile(/^Rent requests posted/));
    await screen.findByRole('dialog', { name: 'Rent requests posted' });
    expect(rpcMock).toHaveBeenCalledWith('funders_headline_list', { p_period: '30d', p_kind: 'posted' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a bottom sheet on a phone, a side panel from md', async () => {
    setWidth(375);
    const a = mount();
    fireEvent.click(await tile(/^Rent requests posted/));
    const sheet = await screen.findByRole('dialog', { name: 'Rent requests posted' });
    expect(sheet.className).toContain('desk-sheet-wrap');
    a.unmount();
    setWidth(1280);
    mount();
    fireEvent.click(await tile(/^Rent requests posted/));
    const side = await screen.findByRole('dialog', { name: 'Rent requests posted' });
    expect(side.getAttribute('data-headline-panel')).toBe('side');
  });
});

describe('funders_headline_list parsing', () => {
  it('keeps the server order and fills gaps', () => {
    const l = parseHeadlineList({ count: '2', ugx: '2500000', rows: [{ id: 'abcdef123456', rent: '300000' }, ROW(1)] }, 'today', 'posted');
    expect(l.count).toBe(2);
    expect(l.ugx).toBe(2_500_000);
    expect(l.rows[0]).toMatchObject({ req: 'abcdef12', tenant: '—', rent: 300_000, status_label: null, released_at: null });
    expect(l.rows[1].tenant).toBe('Tenant 1');
    expect(parseHeadlineList(null, '7d', 'sold')).toEqual({ period: '7d', kind: 'sold', count: 0, ugx: 0, rows: [] });
  });

  it('dates in Kampala time', () => {
    expect(dayText('2026-11-08T22:30:00Z')).toBe('9 Nov 2026'); // 01:30 in Kampala
    expect(dayText(null)).toBe('—');
  });
});
