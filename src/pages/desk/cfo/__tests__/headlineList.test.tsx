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
import { waitingFrom } from '../releasesApi';
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
const DASH = { headline: { posted: { n: 5, ugx: 6_000_000 }, sold: { n: 0, ugx: 0 }, waiting: { n: 5, ugx: 6_000_000 } }, rows: [] };
/*
 * funded_money_flow(p_days), E93: Tenant 1 sold (landlord paid, OTP confirmed); two more
 * selected and waiting, the older one 80 h ago (red).
 */
const OLD = 'b0000000-0000-4000-8000-000000000001';
const NEW = 'b0000000-0000-4000-8000-000000000002';
const FLOW = {
  released: { count: 3, ugx: 2_800_000 },
  with_agent: { count: 1, ugx: 900_000, oldest_hours: 80 },
  part_paid: { count: 1, ugx_paid: 100_000, ugx_left: 550_000 },
  live: { count: 1, ugx: 1_250_000 },
  sold: { count: 1, ugx: 1_250_000 },
  selected_waiting: { count: 2, ugx: 1_550_000, oldest_hours: 80 },
  items: [
    { rent_request_id: NEW, ref: 'B0000000', tenant: 'Selected New', agent: 'Agent N', landlord: 'Landlord N', funder: 'Funder N', amount: 650_000, paid_out: 100_000, stage: 'part_paid', selected_at: '2026-11-11T07:00:00Z', released_at: '2026-11-11T08:00:00Z', otp_verified_at: null, landlord_paid_at: null, hours_since_release: 20 },
    { rent_request_id: ROW(1).id, ref: 'A1B2C3D1', tenant: 'Tenant 1', agent: 'Agent 1', landlord: 'Landlord 1', funder: 'Jane Funder', amount: 1_250_000, paid_out: 1_250_000, stage: 'sold', selected_at: '2026-11-10T07:00:00Z', released_at: '2026-11-10T08:00:00Z', otp_verified_at: '2026-11-10T11:00:00Z', landlord_paid_at: '2026-11-10T11:05:00Z', hours_since_release: 40 },
    { rent_request_id: OLD, ref: 'B0000000', tenant: 'Selected Old', agent: 'Agent O', landlord: 'Landlord O', funder: 'Funder O', amount: 900_000, paid_out: 0, stage: 'with_agent', selected_at: '2026-11-08T07:00:00Z', released_at: '2026-11-08T08:00:00Z', otp_verified_at: null, landlord_paid_at: null, hours_since_release: 80 },
  ],
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
  it('four tiles, all buttons that read as tappable; Selected, waiting sits right of sold', async () => {
    mount();
    const names = [/^Rent requests posted/, /^Rent requests sold/, /^Selected, waiting/, /^Waiting for funder/];
    for (const t of names) {
      const b = await tile(t);
      expect(b.getAttribute('aria-haspopup')).toBe('dialog');
      expect(b.className).toContain('active:scale-[0.98]');
      expect(b.className).toContain('cursor-pointer');
    }
    const order = [...document.querySelectorAll('[data-funders-headline-tile]')].map((t) => t.querySelector('h3')!.textContent);
    expect(order).toEqual(['Rent requests posted', 'Rent requests sold', 'Selected, waiting', 'Waiting for funder']);
    expect((await tile(/^Rent requests sold/)).textContent).toContain('Landlord paid — OTP confirmed');
    expect((await tile(/^Selected, waiting/)).textContent).toContain('Funder selected, landlord not yet paid');
    expect((await tile(/^Waiting for funder/)).textContent).toContain('Posted minus sold and selected');
  });

  it('sold = landlord paid; selected, waiting with the oldest wait; waiting = posted − (sold + selected)', async () => {
    mount();
    expect(await tile(/^Rent requests sold: 1, UGX 1\.3M/)).toBeTruthy();
    const sel = await tile(/^Selected, waiting: 2, UGX 1\.6M/);
    const oldest = sel.querySelector('[data-oldest]') as HTMLElement;
    expect(oldest.textContent).toBe('oldest 3 d 8 h');
    expect(oldest.getAttribute('data-oldest')).toBe('bad');
    // 5 posted (UGX 6M) − 1 sold (UGX 1.25M) − 2 selected (UGX 1.55M) = 2 (UGX 3.2M).
    expect(await tile(/^Waiting for funder: 2, UGX 3\.2M/)).toBeTruthy();
    expect(rpcMock).toHaveBeenCalledWith('funded_money_flow', { p_days: 7 });
  });

  it('waiting is never below zero', () => {
    expect(waitingFrom({ n: 2, ugx: 1_000 }, { n: 1, ugx: 800 }, { n: 3, ugx: 900 })).toEqual({ n: 0, ugx: 0 });
    expect(waitingFrom({ n: 5, ugx: 6_000_000 }, { n: 1, ugx: 1_250_000 }, { n: 2, ugx: 1_550_000 })).toEqual({ n: 2, ugx: 3_200_000 });
  });

  it('the oldest wait is amber past 24 h', async () => {
    flow = { ...FLOW, selected_waiting: { count: 2, ugx: 1_550_000, oldest_hours: 30 } };
    mount();
    const sel = await tile(/^Selected, waiting/);
    expect(sel.querySelector('[data-oldest]')!.getAttribute('data-oldest')).toBe('warn');
  });

  it('the period chips ask for p_days 1 / 7 / 30 / 90 / 365', async () => {
    mount();
    await tile(/^Rent requests sold/);
    for (const [label, days] of [['Today', 1], ['30 days', 30], ['90 days', 90], ['All time', 365]] as const) {
      fireEvent.click(await screen.findByRole('button', { name: label }));
      await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('funded_money_flow', { p_days: days }));
    }
  });

  it('figures the server has not answered are never shown as zero', async () => {
    rpcMock.mockImplementation((fn: string, args: { p_kind?: string }) =>
      fn === 'funded_money_flow' ? new Promise(() => {}) : Promise.resolve(fn === 'funders_dashboard' ? { data: DASH, error: null } : { data: lists[args.p_kind ?? 'posted'], error: null }),
    );
    mount();
    expect((await screen.findAllByRole('status', { name: 'Loading the headline' })).length).toBe(4);
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

  it('sold: the landlord-paid ones, tenant name first, agent / landlord / funder under it; a tap opens the plan', async () => {
    mount();
    fireEvent.click(await tile(/^Rent requests sold/));
    const dlg = await screen.findByRole('dialog', { name: 'Rent requests sold' });
    expect(rpcMock).not.toHaveBeenCalledWith('funders_headline_list', expect.objectContaining({ p_kind: 'sold' }));
    expect(dlg.querySelector('[data-releases-note]')!.textContent).toBe('7 days · landlord paid, OTP confirmed, in the last 7 days');
    const rows = [...dlg.querySelectorAll('[data-release]')] as HTMLElement[];
    expect(rows.map((r) => r.getAttribute('data-release'))).toEqual([ROW(1).id]);
    const rel = rows[0];
    expect(rel.querySelector('[data-release-tenant]')!.textContent).toBe('Tenant 1');
    expect(rel.textContent).not.toContain(ROW(1).id);
    for (const line of ['Agent: Agent 1', 'Landlord: Landlord 1', 'Funder: Jane Funder', 'Ref A1B2C3D1', 'UGX 1,250,000']) expect(rel.textContent).toContain(line);
    expect(within(rel).getByText('Sold · landlord paid')).toBeTruthy();
    expect(rel.querySelector('[data-release-dates]')!.textContent).toMatch(/^Selected .* · Released .* · OTP .* · Landlord paid /);
    fireEvent.click(rel);
    expect(await screen.findByRole('dialog', { name: 'Rent Plan Ref A1B2C3D1' })).toBeTruthy();
  });

  it('selected, waiting: newest selection first, with oldest-first and amount toggles', async () => {
    mount();
    fireEvent.click(await tile(/^Selected, waiting/));
    const dlg = await screen.findByRole('dialog', { name: 'Selected, waiting' });
    const names = () => [...dlg.querySelectorAll('[data-release-tenant]')].map((e) => e.textContent);
    expect(dlg.querySelector('[data-releases-note]')!.textContent).toBe('Right now, whatever the period · funder selected, landlord not yet paid');
    expect(names()).toEqual(['Selected New', 'Selected Old']);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Oldest first' }));
    expect(names()).toEqual(['Selected Old', 'Selected New']);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Amount' }));
    expect(names()).toEqual(['Selected Old', 'Selected New']);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Newest first' }));
    expect(names()).toEqual(['Selected New', 'Selected Old']);
    expect(dlg.textContent).toContain('Funder: Funder O');
  });

  it('waiting: the posted list without the sold and selected requests', async () => {
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
