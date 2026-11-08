import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* Phase B2: the Funders Dashboard and Partner Ops on the responsive kit. */

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), storage: { from: vi.fn() }, functions: { invoke: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));

import { FundersDashboard, mainPhoto } from '../cfo/FundersDashboard';
import { PartnerOpsBoard } from '../partner/PartnerOpsBoard';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));

const frow = (id: string, over: Record<string, unknown> = {}) => ({
  id, req: `req-${id}`, tenant: `Tenant ${id}`, tenant_location: 'Kireka, Wakiso — near the trading centre', agent: `Agent ${id}`, landlord: `Landlord ${id}`,
  landlord_phone: null, lc1: null, rent: 1_250_000, funding_amount: null, gps: null, photos: [`https://img/${id}-main.jpg`, `https://img/${id}-2.jpg`],
  days_on_board: 2.4, held: false, hold_expires_at: null, grade: 'B', average: 70, ratings: null, rank_grade: 1, rank_oldest: 1, ...over,
});

const FUNDERS = (canFund: boolean) => ({
  generated_at: '2026-11-07T08:00:00Z', period: 'today',
  fund_today: { n: 3, ugx: 3_750_000 }, held_by_funders: { n: 1, ugx: 1_250_000 },
  funded: { n: 2, ugx: 2_000_000, by_funders: { n: 1, ugx: 1e6 }, by_welile: { n: 1, ugx: 1e6 }, by_officers: null, by_self: null, avg_days_coo_to_funded: 2.5 },
  can_fund_welile: canFund,
  rows: [frow('a'), frow('b', { days_on_board: 8.1 }), frow('c', { held: true, photos: [] })],
});

const officer = (i: number) => ({
  agent_id: `o${i}`, officer: `Officer ${String(i).padStart(2, '0')}`, phone: '+256700000000', invites: 10 + i, signups: i, funders: i, funded: i,
  funded_ugx: i * 1_000_000, contacts: 3, monthly_target: 20, target_unit: 'funders',
});

const PARTNER = {
  period: '30d',
  tiles: {
    listed: { n: 3, ugx: 3e6 }, welile_due: { n: 1, ugx: 1e6 }, held: 0, frozen: 0, pending_portfolios: { n: 1, ugx: 3e6 },
    sold: { n: 2, ugx: 2e6, by_officers: { n: 1, ugx: 1e6 }, by_self: { n: 1, ugx: 1e6 }, by_welile: { n: 0, ugx: 0 }, avg_days_coo_to_funded: 2 },
    sell_through_7d: { listed_last_30d: 4, sold_within_7d: 2, pct: 50 },
  },
  listings: [
    { id: 'l1', req: 'aaaa0001', tenant: 'Amina', agent: 'Okello', agent_id: 'ag1', agent_phone: '+256770000001', rent: 900_000, days_on_board: 2, decision: 'follow_up', why: 'PO-3: nobody held it.', last_followup: null },
    { id: 'l2', req: 'aaaa0002', tenant: 'Joseph', agent: 'Achieng', agent_id: 'ag2', agent_phone: null, rent: 1_200_000, days_on_board: 8, decision: 'welile_due', why: 'Day 8.', last_followup: null },
  ],
  pending_portfolios: [
    { portfolio_id: 'p1', code: 'PF-01', funder: 'Sarah Auma', funder_phone: null, amount: 3_000_000, months: 6, payment_method: 'MoMo', receipt_file_url: null, officer: 'Officer 01', created_at: null, hours_waiting: 30 },
  ],
  officers: Array.from({ length: 12 }, (_, i) => officer(i + 1)),
  funnel: { invites: 120, signups: 40, funded: 9, funded_ugx: 9e6, officers: 12, officers_active: 7, contacts: 300 },
  sold_24h: [],
};

function mount(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><div className="desk-root">{ui}</div></QueryClientProvider>);
}

let canFund = true;
beforeEach(() => {
  canFund = true;
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string) =>
    Promise.resolve({ data: fn === 'funders_dashboard' ? FUNDERS(canFund) : fn === 'partner_ops_board' ? PARTNER : null, error: null }),
  );
});

/* ───────────── Funders Dashboard ───────────── */

describe('Funders Dashboard listing', () => {
  it('md and up: a DataList table; day-7 rows marked; Fund only where an approver may fund', async () => {
    setWidth(1024);
    mount(<FundersDashboard board={false} />);
    await screen.findByText('Tenant a');
    expect(document.querySelector('[data-datalist="listings"] [data-layout="table"]')).not.toBeNull();
    expect(document.querySelector('tr[data-row="b"]')?.hasAttribute('data-welile-due')).toBe(true);
    expect(document.querySelector('tr[data-row="a"]')?.hasAttribute('data-welile-due')).toBe(false);
    // Held rows cannot be funded with Welile money.
    expect(screen.getAllByRole('button', { name: /^Fund with Welile money/ })).toHaveLength(2);
    expect(screen.getByRole('searchbox', { name: 'Search listings' })).toBeTruthy();
  });

  it('below md: one card per listing — photo, tenant, one-line area, agent, landlord, UGX, grade, days', async () => {
    setWidth(390);
    mount(<FundersDashboard board={false} />);
    await screen.findByText('Tenant a');
    expect(document.querySelector('[data-layout="cards"]')).not.toBeNull();
    expect(document.querySelector('table')).toBeNull();

    const a = document.querySelector('[data-funders-card="a"]') as HTMLElement;
    const img = within(a).getByRole('img', { name: 'House photo for Tenant a' }) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://img/a-main.jpg');
    const area = within(a).getByText('Kireka, Wakiso — near the trading centre');
    expect(area.style.whiteSpace).toBe('nowrap');
    expect(area.getAttribute('title')).toBe('Kireka, Wakiso — near the trading centre');
    expect(within(a).getByText('Agent Agent a · Landlord Landlord a')).toBeTruthy();
    const money = within(a).getByText('UGX 1.3M');
    expect(money.getAttribute('aria-label')).toBe('UGX 1,250,000');
    expect(within(a).getByText('2 d on board')).toBeTruthy();
    expect(within(a).getByText('B')).toBeTruthy();
    const fund = within(a).getByRole('button', { name: 'Fund with Welile money' }) as HTMLButtonElement;
    expect(fund.style.width).toBe('100%');

    const b = document.querySelector('[data-funders-card="b"]') as HTMLElement;
    expect(within(b).getByText('Welile to fund').getAttribute('data-tone')).toBe('bad');

    const c = document.querySelector('[data-funders-card="c"]') as HTMLElement;
    expect(within(c).getByRole('img', { name: 'No photo' })).toBeTruthy();
    expect(within(c).queryByRole('button', { name: 'Fund with Welile money' })).toBeNull();
  });

  it('no Fund button for someone who is not an approver', async () => {
    canFund = false;
    setWidth(390);
    mount(<FundersDashboard board={false} />);
    await screen.findByText('Tenant a');
    expect(screen.queryByRole('button', { name: 'Fund with Welile money' })).toBeNull();
  });

  it('the tiles are a TileRow and the period toggle never wraps', async () => {
    setWidth(390);
    mount(<FundersDashboard board={false} />);
    await screen.findByText('Tenant a');
    const row = document.querySelector('.desk-tile-row') as HTMLElement;
    expect(row.style.gridTemplateColumns).toContain('minmax(min(150px, calc((100% - 12px) / 2)), 1fr)');
    expect(screen.getByRole('group', { name: 'Period for the funded figures' }).style.flexWrap).toBe('nowrap');
  });

  it('the main photo is the first house photo', () => {
    expect(mainPhoto({ photos: ['', 'https://x/1.jpg', 'https://x/2.jpg'] })).toBe('https://x/1.jpg');
    expect(mainPhoto({ photos: [] })).toBeNull();
    expect(mainPhoto({ photos: null })).toBeNull();
  });
});

/* ───────────── Partner Ops ───────────── */

describe('Partner Ops field officers', () => {
  it('top 10 with "Show all", plus search', async () => {
    setWidth(1024);
    mount(<PartnerOpsBoard board={false} />);
    await screen.findByText('Officer 12');
    const list = document.querySelector('[data-datalist="field officers"]') as HTMLElement;
    expect(list.querySelectorAll('tr[data-officer]')).toHaveLength(10);
    fireEvent.click(within(list).getByRole('button', { name: 'Show all 12' }));
    expect(list.querySelectorAll('tr[data-officer]')).toHaveLength(12);
    fireEvent.change(within(list).getByRole('searchbox', { name: 'Search field officers' }), { target: { value: 'officer 03' } });
    expect([...list.querySelectorAll('tr[data-officer]')].map((r) => r.getAttribute('data-officer'))).toEqual(['o3']);
  });

  it('phones: the officer, the call button and funded UGX first; invites, funders and the target bar on the second line', async () => {
    setWidth(390);
    mount(<PartnerOpsBoard board={false} />);
    await screen.findByText('Officer 12');
    const card = document.querySelector('li[data-officer="o12"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(within(card).getByText('Officer 12')).toBeTruthy();
    expect(within(card).getByRole('button', { name: /Call Officer 12/ })).toBeTruthy();
    expect(within(card).getByText('/ UGX 12M')).toBeTruthy();
    expect(within(card).getByText(/^Invites/)).toBeTruthy();
    expect(within(card).getByText(/^Funders/)).toBeTruthy();
    expect(within(card).getByRole('progressbar', { name: 'Officer 12: 60% of the monthly target' })).toBeTruthy();
    // Sign-ups and contacts wait under More.
    expect(within(card).queryByText(/^Sign-ups/)).toBeNull();
  });
});

describe('Partner Ops portfolios and listings on a phone', () => {
  it('each portfolio is a card with Approve / Reject in a sticky bar inside it', async () => {
    setWidth(390);
    mount(<PartnerOpsBoard board={false} />);
    const card = (await screen.findByText('Sarah Auma')).closest('li') as HTMLElement;
    expect(card.className).toContain('desk-tile');
    const bar = card.querySelector('[data-portfolio-actions]') as HTMLElement;
    expect(bar.style.position).toBe('sticky');
    expect(bar.style.bottom).toBe('var(--desk-banner-inset, 0px)');
    expect(within(bar).getByRole('button', { name: 'Approve' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Reject…' }));
    expect(screen.getByRole('dialog', { name: 'Reject this portfolio' })).toBeTruthy();
  });

  it('md and up: the portfolio stays one row with no sticky bar', async () => {
    setWidth(1024);
    mount(<PartnerOpsBoard board={false} />);
    const row = (await screen.findByText('Sarah Auma')).closest('li') as HTMLElement;
    expect(row.querySelector('[data-portfolio-actions]')).toBeNull();
    expect(within(row).getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('listings are cards; a follow-up card carries the call and the note', async () => {
    setWidth(390);
    mount(<PartnerOpsBoard board={false} />);
    await screen.findByText('Amina');
    const follow = document.querySelector('li[data-decision="follow_up"]') as HTMLElement;
    expect(follow.className).toContain('desk-tile');
    expect(within(follow).getByText('UGX 900K').getAttribute('aria-label')).toBe('UGX 900,000');
    expect(within(follow).getByRole('button', { name: /Call Okello/ })).toBeTruthy();
    // The rule code leaves the sentence and goes to the tooltip.
    expect(within(follow).getByText('Nobody held it.').getAttribute('title')).toBe('Rule PO-3');
    fireEvent.click(within(follow).getByRole('button', { name: 'Note follow-up' }));
    expect(within(follow).getByRole('textbox')).toBeTruthy();
    expect(within(document.querySelector('li[data-decision="welile_due"]') as HTMLElement).getByText('Welile to fund')).toBeTruthy();
  });
});
