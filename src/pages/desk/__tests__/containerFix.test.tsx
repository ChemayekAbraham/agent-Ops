import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* The COO's ~950 px fix-up: DataList by its own width, the Funders table, the strip order, the lead. */

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), storage: { from: vi.fn() }, functions: { invoke: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));

import { CHIPS_SPARE, COLUMN_MIN, DETAILS_COL, DataList, columnWidths, planColumns, type DataColumn } from '../ui/DataList';
import { FundersDashboard } from '../cfo/FundersDashboard';
import { fundersLead } from '../cfo/fundersView';
import { STRIP_STAGES } from '../PipelineStrip';
import { DESKS } from '../deskConfig';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));

/* ───────────── the container rule ───────────── */

type Row = { id: string; name: string; agent: string; rent: number; when: string; status: string; note: string };
const COLS: DataColumn<Row>[] = [
  { key: 'name', label: 'Tenant', priority: 1, kind: 'name', render: (r) => r.name },
  { key: 'rent', label: 'Rent', priority: 1, kind: 'money', render: (r) => String(r.rent) },
  { key: 'agent', label: 'Agent', priority: 2, kind: 'name', render: (r) => r.agent },
  { key: 'when', label: 'Listed', priority: 2, kind: 'date', render: (r) => r.when },
  { key: 'status', label: 'Status', priority: 3, kind: 'chips', render: (r) => r.status },
  { key: 'note', label: 'Note', priority: 3, kind: 'text', render: (r) => r.note },
];
const ROWS: Row[] = [{ id: 'a', name: 'Nakibowa Sarah Namutebi', agent: 'Okello Peter', rent: 900_000, when: '7 Nov', status: 'Fresh', note: 'Called twice' }];
// name 160 + money 110 + name 160 + date 90 + chips 120 + text 140 = 780
const ALL = 780;

describe('DataList by its own width', () => {
  it('uses the kinds’ minimum widths', () => {
    expect(COLUMN_MIN).toMatchObject({ name: 160, money: 110, date: 90, chips: 120 });
  });

  it('a table with every column when they all fit', () => {
    expect(planColumns(COLS, ALL)).toEqual({ layout: 'table', shown: COLS.map((c) => c.key), hidden: [] });
  });

  it('too narrow: priority 3 goes first (last first), then priority 2, before cards', () => {
    expect(planColumns(COLS, ALL - 1)).toMatchObject({ layout: 'table', hidden: ['note'] });
    expect(planColumns(COLS, ALL - 140 + DETAILS_COL - 1)).toMatchObject({ layout: 'table', hidden: ['status', 'note'] });
    expect(planColumns(COLS, 160 + 110 + 160 + DETAILS_COL)).toMatchObject({ layout: 'table', hidden: ['when', 'status', 'note'] });
    expect(planColumns(COLS, 160 + 110 + DETAILS_COL)).toMatchObject({ layout: 'table', shown: ['name', 'rent'] });
    expect(planColumns(COLS, 160 + 110 + DETAILS_COL - 1).layout).toBe('cards');
  });

  it('renders the plan: hidden columns open in the row’s details; names never break mid-word', () => {
    setWidth(600); // jsdom has no layout: the list falls back to the window’s width
    render(<DataList label="tenants" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />);
    const table = document.querySelector('table[data-layout="table"]') as HTMLElement;
    expect(table.getAttribute('data-hidden')).toBe('status note');
    expect(table.style.tableLayout).toBe('fixed');
    expect(screen.queryByRole('columnheader', { name: 'Note' })).toBeNull();
    const name = screen.getByText('Nakibowa Sarah Namutebi');
    expect(name.style.whiteSpace).toBe('nowrap');
    expect(name.style.textOverflow).toBe('ellipsis');
    expect(name.getAttribute('title')).toBe('Nakibowa Sarah Namutebi');
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Nakibowa Sarah Namutebi' }));
    const details = document.querySelector('tr[data-details-for="a"]') as HTMLElement;
    expect(within(details).getByText('Note')).toBeTruthy();
    expect(within(details).getByText('Called twice')).toBeTruthy();
  });

  it('spare width goes to chip columns first (a pill never meets the edge), then to names', () => {
    const vis = COLS.slice(0, 5); // name, money, name, date, chips = 640
    expect(columnWidths(vis, 640 + 10, false)).toMatchObject({ status: 130, name: 160, agent: 160, rent: 110 });
    const w = columnWidths(vis, 640 + CHIPS_SPARE + 40, false);
    expect(w).toMatchObject({ status: 120 + CHIPS_SPARE, name: 180, agent: 180, rent: 110, when: 90 });
  });

  it('cards when even priority 1 does not fit', () => {
    setWidth(300);
    render(<DataList label="tenants" columns={COLS} rows={ROWS} rowKey={(r) => r.id} />);
    expect(document.querySelector('[data-layout="cards"]')).not.toBeNull();
    expect(document.querySelector('table')).toBeNull();
  });
});

/* ───────────── the Funders board ───────────── */

const frow = (id: string, over: Record<string, unknown> = {}) => ({
  id, req: `req-${id}`, tenant: `Tenant ${id}`, tenant_location: 'Kireka', agent: `Agent ${id}`, landlord: `Landlord ${id}`, landlord_phone: null, lc1: null,
  rent: 1_250_000, funding_amount: null, gps: null, photos: [], days_on_board: 2.4, held: false, hold_expires_at: null, grade: 'B', average: 70,
  ratings: { agent_ops: 7.5, tenant_ops: 8, landlord_ops: 6.2 }, rank_grade: 1, rank_oldest: 1, ...over,
});
const FUNDERS = (canFund: boolean) => ({
  generated_at: '2026-11-07T08:00:00Z', period: 'today',
  fund_today: { n: 11, ugx: 31_450_000 }, held_by_funders: { n: 3, ugx: 4_120_000 },
  funded: { n: 18, ugx: 59_200_000, by_funders: { n: 12, ugx: 4e7 }, by_welile: { n: 6, ugx: 1.92e7 }, by_officers: { n: 8, ugx: 3e7 }, by_self: { n: 4, ugx: 1e7 }, avg_days_coo_to_funded: 3.26 },
  can_fund_welile: canFund,
  rows: [frow('a'), frow('b', { days_on_board: 8.1, held: true })],
});
let canFund = false;
beforeEach(() => {
  canFund = false;
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string) => Promise.resolve({ data: fn === 'funders_dashboard' ? FUNDERS(canFund) : null, error: null }));
});
function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><div className="desk-root"><FundersDashboard board={false} /></div></QueryClientProvider>);
}
const headers = () => [...document.querySelectorAll('table[data-layout="table"] th')].map((th) => th.textContent).filter(Boolean);

describe('Funders board table', () => {
  it('at ~950 px (an 846 px list): Request · Tenant · Agent · Grade · Days · Rent · Status; the rest in details', async () => {
    setWidth(846);
    mount();
    await screen.findByText('Tenant a');
    expect(headers()).toEqual(['Details', 'Request', 'Tenant', 'Agent', 'Grade', 'Days', 'Rent (UGX)', 'Status']);
    expect(document.querySelector('table')?.getAttribute('data-hidden')).toBe('landlord gps ratings');
    fireEvent.click(screen.getByRole('button', { name: /Show details for Tenant a/ }));
    const details = document.querySelector('tr[data-details-for="a"]') as HTMLElement;
    expect(within(details).getByText('Landlord a')).toBeTruthy();
    expect(within(details).getByText('7.5 / 8 / 6.2')).toBeTruthy();
    expect(within(details).getByText('No GPS')).toBeTruthy();
  });

  it('wide enough (1440 px → 1336 px list): every column, no details', async () => {
    setWidth(1336);
    mount();
    await screen.findByText('Tenant a');
    expect(headers()).toEqual(['Request', 'Tenant', 'Agent', 'Grade', 'Days', 'Rent (UGX)', 'Status', 'Landlord', 'GPS · photos', 'Ratings · Agent / Tenant / Landlord']);
  });

  it('an approver keeps Fund in the table; the lower-priority columns give way first', async () => {
    canFund = true;
    setWidth(846);
    mount();
    await screen.findByText('Tenant a');
    const h = headers();
    expect(h).toContain('Action');
    expect(h).toEqual(expect.arrayContaining(['Request', 'Tenant', 'Rent (UGX)', 'Status']));
    expect(screen.getAllByRole('button', { name: 'Fund with Welile money' })).toHaveLength(1);
  });

  it('the lead comes from funders_dashboard and matches the Fund today tile', async () => {
    setWidth(1336);
    mount();
    const lead = await screen.findByText("11 on the funders' board, worth UGX 31,450,000 · 3 held by funders");
    expect(lead.hasAttribute('data-funders-lead')).toBe(true);
    expect(screen.getByText('11 on the board, not held')).toBeTruthy();
    expect(screen.getByText('UGX 31.5M').getAttribute('aria-label')).toBe('UGX 31,450,000');
  });

  it('tile sub-lines wrap instead of being cut', async () => {
    setWidth(1336);
    mount();
    const split = await screen.findByText("18 requests · Officers' funders 8 · Self 4 · Welile 6");
    expect(split.style.whiteSpace).toBe('normal');
    expect(split.style.textOverflow).toBe('');
  });
});

describe('lead text and strip order', () => {
  it('fundersLead: held only when there are some', () => {
    expect(fundersLead({ fund_today: { n: 11, ugx: 31_450_000 }, held_by_funders: { n: 3, ugx: 1 } })).toBe("11 on the funders' board, worth UGX 31,450,000 · 3 held by funders");
    expect(fundersLead({ fund_today: { n: 1, ugx: 900_000 }, held_by_funders: { n: 0, ugx: 0 } })).toBe("1 on the funders' board, worth UGX 900,000");
  });

  it('the cfo desk no longer reads the old feed count for its lead', () => {
    expect(DESKS.find((d) => d.id === 'cfo')?.lead(() => 'FEED')).toBe('');
  });

  it('the strip: no retired stage; Partner Ops comes after Funders, selling the funders board', () => {
    const labels = STRIP_STAGES.map((s) => (s.companion ? `${s.label} · ${s.companion}` : s.label));
    expect(labels.slice(0, 7)).toEqual(['SC new', 'Agent Ops', 'Tenant Ops', 'Landlord Ops', 'COO', 'Funders', 'Partner Ops · selling the funders board']);
    expect(labels.some((l) => /retired/i.test(l))).toBe(false);
  });
});
