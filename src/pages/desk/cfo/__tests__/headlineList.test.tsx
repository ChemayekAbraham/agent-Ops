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
const DASH = { headline: { posted: { n: 2, ugx: 2_500_000 }, sold: { n: 1, ugx: 1_250_000 }, waiting: { n: 1, ugx: 1_250_000 } }, rows: [] };

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string, args: { p_kind?: string }) =>
    Promise.resolve(
      fn === 'funders_dashboard'
        ? { data: DASH, error: null }
        : fn === 'funders_headline_list'
          ? { data: LIST[args.p_kind ?? 'posted'], error: null }
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

  it('sold: adds the partner, their phone and the money-released date', async () => {
    mount();
    fireEvent.click(await tile(/^Rent requests sold/));
    const dlg = await screen.findByRole('dialog', { name: 'Rent requests sold' });
    expect(rpcMock).toHaveBeenCalledWith('funders_headline_list', { p_period: '7d', p_kind: 'sold' });
    const line = await waitFor(() => {
      const l = dlg.querySelector('[data-sold-line]');
      expect(l).not.toBeNull();
      return l as HTMLElement;
    });
    expect(line.textContent).toBe('Partner Partner Nansubuga 0772 111 222 · Money released 8 Nov 2026');
    expect(within(line).getByRole('link', { name: '0772 111 222' }).getAttribute('href')).toBe('tel:0772111222');
  });

  it('an empty list says "Nothing in this period"', async () => {
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
