import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BoardDisplay from '@/pages/BoardDisplay';
import { BOARD_PERIOD_KEY } from '@/lib/boardDisplay';
const mock = vi.hoisted(() => ({ load: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/boardDisplayClient', () => ({ loadBoardDisplay: mock.load, loadBoardList: mock.list }));

const PERIOD_N: Record<string, number> = { today: 134, '7d': 700, '30d': 2_100, '90d': 6_000, all: 9_999 };
const fixture = () => ({ generated_at: '2026-11-09T08:00:00Z', display: { label: 'Boardroom screen 1' },
  headline: Object.fromEntries(Object.entries(PERIOD_N).map(([k, n]) => [k, { posted: { n, ugx: 23100000 }, sold: { n: 0, ugx: 0 }, selected: { n: 7, ugx: 4_200_000 }, waiting: { n, ugx: 23100000 } }])) });
const row = (i: number, over: Record<string, unknown> = {}) => ({ ref: `abcd000${i}`, area: `Kireka ${i}, Wakiso`, rent: 300000, posted_at: '2026-11-08T08:00:00Z', days_since_posted: 1.5, status_label: "On the funders' board", money_released_at: null,
  tenant: `Tenant ${i}`, agent: `Agent ${i}`, landlord: `Landlord ${i}`, funder: null, selected_at: null, otp_verified_at: null, ...over });
const list = (period: string, kind: string, over: Record<string, unknown> = {}) => ({ period, kind, count: 412, ugx: 123_600_000, shown: 2, rows: [row(1), row(2)], ...over });

let store: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers(); mock.load.mockReset(); mock.list.mockReset();
  window.history.replaceState(null, '', '/board/test-secret');
  store = new Map();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const mountBoard = async () => { await act(async () => { render(<BoardDisplay />); }); };
const tile = (name: string) => screen.getByRole('button', { name: new RegExp(name) });
const count = (name: string) => tile(name).querySelector('.board-hero-count')?.textContent;

describe('Public boardroom display', () => {
  it('preserves data through failed refreshes and retries after sixty seconds', async () => {
    mock.load.mockResolvedValueOnce(fixture()).mockRejectedValueOnce(new Error('This display link has been switched off')).mockResolvedValue(fixture());
    await mountBoard();
    expect(screen.getByText('Boardroom screen 1')).toBeInTheDocument();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex,nofollow');
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(mock.load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent('This display link has been switched off');
    expect(screen.getByText('Rent requests posted')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(59999); });
    expect(mock.load).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mock.load).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('turns amber after two minutes with no good refresh and hides idle controls', async () => {
    mock.load.mockResolvedValueOnce(fixture()).mockRejectedValue(new Error('Offline'));
    await mountBoard();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(document.querySelector('main')).toHaveClass('board-idle');
    await act(async () => { await vi.advanceTimersByTimeAsync(118000); });
    expect(document.querySelector('.board-live')).toHaveClass('text-warning');
  });
  it('a refused link takes the whole screen, even over earlier totals, and is retried every 60 s', async () => {
    window.history.replaceState(null, '', '/b/test-secret');
    mock.load.mockResolvedValueOnce(fixture()).mockRejectedValueOnce(Object.assign(new Error('This display link has been switched off'), { code: '28000' })).mockResolvedValue(fixture());
    await mountBoard();
    expect(mock.load.mock.calls[0][0]).toBe('test-secret');
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(document.querySelector('main')?.getAttribute('data-board-state')).toBe('error');
    expect(screen.getByRole('alert')).toHaveTextContent('This display link has been switched off');
    expect(screen.queryByText('Rent requests posted')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mock.load).toHaveBeenCalledTimes(3);
    expect(document.querySelector('main')?.getAttribute('data-board-state')).toBe('live');
  });
  it('an error before any totals shows full screen', async () => {
    mock.load.mockRejectedValue(new Error('Failed to fetch'));
    await mountBoard();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch');
    expect(screen.getByText('Trying again every 60 seconds.')).toBeInTheDocument();
  });
  it('a light board: the LIVE line and four tiles in order with their captions, no pipeline and no period table', async () => {
    mock.load.mockResolvedValue(fixture());
    await mountBoard();
    expect(document.querySelector('main')).not.toHaveClass('dark');
    expect(screen.getByText('LIVE · updated 11:00:00 Kampala')).toBeInTheDocument();
    for (const c of ["From the COO to the funders' board", 'Landlord paid — OTP confirmed', 'Funder took it, landlord not yet paid', 'On the funders board now']) expect(screen.getByText(c)).toBeInTheDocument();
    expect(screen.queryByLabelText('Pipeline')).not.toBeInTheDocument();
    expect(document.querySelector('[data-stage]')).toBeNull();
    expect(document.querySelector('table')).toBeNull();
    expect([...document.querySelectorAll('.board-tile')].map((t) => t.getAttribute('data-metric'))).toEqual(['posted', 'sold', 'selected', 'waiting']);
    expect(count('Selected, waiting')).toBe('7');
    // Selected and waiting are right now; posted and sold follow the period.
    expect(tile('Selected, waiting').querySelector('.board-tile-when')?.textContent).toBe('Now');
    expect(tile('Waiting for funder').querySelector('.board-tile-when')?.textContent).toBe('Now');
    expect(tile('Rent requests sold').querySelector('.board-tile-when')?.textContent).toBe('Today');
  });
  it('pulses a number that changes, for 0.8 s', async () => {
    const next = fixture();
    next.headline.today.sold = { n: 1, ugx: 950000 };
    mock.load.mockResolvedValueOnce(fixture()).mockResolvedValue(next);
    await mountBoard();
    expect(document.querySelector('[data-changed]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(document.querySelectorAll('[data-changed]').length).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(document.querySelector('[data-changed]')).toBeNull();
  });
});

describe('Period toggle', () => {
  it('defaults to Today, shows headline[period] on the three tiles, remembers the choice, and does not pulse on a switch', async () => {
    mock.load.mockResolvedValue(fixture());
    await mountBoard();
    const group = screen.getByRole('group', { name: 'Period' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Today', '7 days', '30 days', '90 days', 'All time']);
    expect(within(group).getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true');
    expect(count('Rent requests posted')).toBe('134');
    fireEvent.click(within(group).getByRole('button', { name: '30 days' }));
    expect(count('Rent requests posted')).toBe('2,100');
    expect(count('Waiting for funder')).toBe('2,100');
    expect(tile('Rent requests posted').querySelector('.board-tile-when')?.textContent).toBe('30 days');
    expect(tile('Waiting for funder').querySelector('.board-tile-when')?.textContent).toBe('Now');
    expect(document.querySelector('[data-changed]')).toBeNull();
    expect(store.get(BOARD_PERIOD_KEY)).toBe('30d');
    expect(mock.load).toHaveBeenCalledTimes(1); // no extra request for a period
    cleanup();
    await mountBoard();
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(count('Rent requests posted')).toBe('2,100');
  });
});

describe('Tap a tile', () => {
  it('opens the list for the period and kind: header, "newest 300 of N", the tenant name first, no phones', async () => {
    mock.load.mockResolvedValue(fixture());
    mock.list.mockResolvedValue(list('7d', 'posted', { shown: 300 }));
    store.set(BOARD_PERIOD_KEY, '7d');
    await mountBoard();
    await act(async () => { fireEvent.click(tile('Rent requests posted')); });
    const dlg = screen.getByRole('dialog', { name: 'Rent requests posted' });
    expect(mock.list).toHaveBeenCalledWith('test-secret', '7d', 'posted', expect.any(AbortSignal));
    expect(dlg.querySelector('[data-board-list-summary]')?.textContent).toBe('7 days · 412 requests · UGX 123.6M · newest 300 of 412');
    const rows = dlg.querySelectorAll('[data-board-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('[data-board-tenant]')?.textContent).toBe('Tenant 1');
    expect(rows[0].textContent).toContain('Agent: Agent 1');
    expect(rows[0].textContent).toContain('Landlord: Landlord 1');
    expect(rows[0].textContent).toContain('Funder: —');
    expect(rows[0].textContent).toContain('abcd0001');
    expect(rows[0].textContent).toContain('Kireka 1, Wakiso');
    expect(rows[0].textContent).toContain('UGX 300K');
    expect(rows[0].textContent).toContain('Posted 8 Nov 2026');
    expect(rows[0].textContent).toContain('1.5 days since posted');
    expect(rows[0].textContent).toContain("On the funders' board");
    expect(dlg.querySelector('[data-board-released]')).toBeNull();
  });
  it('drops "newest" when every row is shown; sold rows add the money-released date', async () => {
    mock.load.mockResolvedValue(fixture());
    mock.list.mockResolvedValue(list('today', 'sold', { count: 2, shown: 2, ugx: 600_000, rows: [row(1, { money_released_at: '2026-11-09T07:00:00Z', status_label: 'Repaying' })] }));
    await mountBoard();
    await act(async () => { fireEvent.click(tile('Rent requests sold')); });
    const dlg = screen.getByRole('dialog', { name: 'Rent requests sold' });
    expect(dlg.querySelector('[data-board-list-summary]')?.textContent).toBe('Today · 2 requests · UGX 600K');
    expect(dlg.querySelector('[data-board-released]')?.textContent).toBe('Money released 9 Nov 2026');
  });
  it('an empty list reads "Nothing in this period", or "Nothing right now" for a now tile', async () => {
    mock.load.mockResolvedValue(fixture());
    mock.list.mockResolvedValue(list('today', 'posted', { count: 0, shown: 0, ugx: 0, rows: [] }));
    await mountBoard();
    await act(async () => { fireEvent.click(tile('Rent requests posted')); });
    expect(within(screen.getByRole('dialog')).getByText('Nothing in this period')).toBeInTheDocument();
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    mock.list.mockResolvedValue(list('today', 'waiting', { count: 0, shown: 0, ugx: 0, rows: [] }));
    await act(async () => { fireEvent.click(tile('Waiting for funder')); });
    expect(within(screen.getByRole('dialog')).getByText('Nothing right now')).toBeInTheDocument();
  });

  it('Selected, waiting opens its list (kind "selected"): tenant, agent, landlord, funder, selected date; newest selected first, with toggles', async () => {
    mock.load.mockResolvedValue(fixture());
    mock.list.mockResolvedValue(list('today', 'selected', { count: 3, shown: 3, ugx: 2_100_000, rows: [
      row(1, { funder: 'Funder A', selected_at: '2026-11-08T09:00:00Z', rent: 900_000, status_label: 'Selected — landlord not yet paid' }),
      row(2, { funder: 'Funder B', selected_at: '2026-11-10T09:00:00Z', rent: 500_000 }),
      row(3, { funder: 'Funder C', selected_at: '2026-11-09T09:00:00Z', rent: 700_000 }),
    ] }));
    await mountBoard();
    await act(async () => { fireEvent.click(tile('Selected, waiting')); });
    const dlg = screen.getByRole('dialog', { name: 'Selected, waiting' });
    expect(mock.list).toHaveBeenCalledWith('test-secret', 'today', 'selected', expect.any(AbortSignal));
    expect(dlg.querySelector('[data-board-list-summary]')?.textContent).toBe('Now · 3 requests · UGX 2.1M');
    const names = () => [...dlg.querySelectorAll('[data-board-tenant]')].map((e) => e.textContent);
    expect(names()).toEqual(['Tenant 2', 'Tenant 3', 'Tenant 1']);
    const first = dlg.querySelector('[data-board-row]')!;
    expect(first.textContent).toContain('Funder: Funder B');
    expect(first.querySelector('[data-board-selected]')?.textContent).toBe('Selected 10 Nov 2026');
    const order = within(dlg).getByRole('group', { name: 'Order' });
    expect(within(order).getByRole('button', { name: 'Newest selected' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(order).getByRole('button', { name: 'Oldest first' }));
    expect(names()).toEqual(['Tenant 1', 'Tenant 3', 'Tenant 2']);
    fireEvent.click(within(order).getByRole('button', { name: 'Amount' }));
    expect(names()).toEqual(['Tenant 1', 'Tenant 3', 'Tenant 2']);
    expect(dlg.textContent).not.toMatch(/07\d{8}|\+256/);
  });
  it('refreshes every 30 s while open, closes on the button and on Esc', async () => {
    mock.load.mockResolvedValue(fixture());
    mock.list.mockResolvedValue(list('today', 'posted'));
    await mountBoard();
    await act(async () => { fireEvent.click(tile('Rent requests posted')); });
    expect(mock.list).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(mock.list).toHaveBeenCalledTimes(2);
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(mock.list).toHaveBeenCalledTimes(2); // no refresh once closed
    await act(async () => { fireEvent.click(tile('Rent requests posted')); });
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('closes itself after 60 s with no touch; a touch restarts the minute', async () => {
    mock.load.mockResolvedValue(fixture());
    mock.list.mockResolvedValue(list('today', 'posted'));
    await mountBoard();
    await act(async () => { fireEvent.click(tile('Rent requests posted')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50000); });
    fireEvent.pointerDown(window);
    await act(async () => { await vi.advanceTimersByTimeAsync(50000); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(tile('Rent requests posted')).toBeInTheDocument();
  });
});
