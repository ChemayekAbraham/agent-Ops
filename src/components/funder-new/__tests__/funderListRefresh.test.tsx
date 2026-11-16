import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import {
  afterFunded,
  dropFundedFromCache,
  FUNDER_LIST_REFRESH_MS,
  getBookedByMe,
  isFundedOrClaimed,
  resetBookedByMe,
  unmarkBookedByMe,
  useFunderListsAutoRefresh,
} from '../funderListRefresh';

const plan = (id: string) => ({ rent_request_id: id, funding_amount: 400000 });
const boardItem = (id: string, tag: string) => ({ id, tag, selectable: tag === 'verified', held: false, rentAmount: 400000, incomplete: null });

function seeded() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['funder-new', 'ready-plans', { search: '' }], {
    pages: [{ items: [plan('a'), plan('b')], total: 3 }, { items: [plan('c')], total: 3 }],
    pageParams: [0, 6],
  });
  qc.setQueryData(['funder-new', 'board-items'], {
    items: [boardItem('a', 'verified'), boardItem('b', 'verified'), boardItem('c', 'verified'), boardItem('x', 'booked')],
    counts: { verified: 3, verified_ugx: 1200000, booked: 1, funded: 0, pending_verification: 1, pending_verification_ugx: 400000, ready_total: 4, ready_total_ugx: 1600000 },
  });
  qc.setQueryData(['funder-new', 'empty-houses', {}], { pages: [{ items: [{ house_id: 'h1' }, { house_id: 'h2' }], total: 2 }], pageParams: [0] });
  return qc;
}

beforeEach(() => resetBookedByMe());

describe('after a fund the card leaves the funders list at once', () => {
  it('Rent Plan: dropped from every cached page, total drops, board moves it to Booked and the counts drop', () => {
    const qc = seeded();
    dropFundedFromCache(qc, 'ready', ['a', 'c']);
    const ready = qc.getQueryData<{ pages: { items: { rent_request_id: string }[]; total: number }[] }>(['funder-new', 'ready-plans', { search: '' }])!;
    expect(ready.pages.flatMap((p) => p.items.map((i) => i.rent_request_id))).toEqual(['b']);
    expect(ready.pages[0].total).toBe(1);
    const board = qc.getQueryData<{ items: { id: string; tag: string; selectable: boolean }[]; counts: Record<string, number> }>(['funder-new', 'board-items'])!;
    expect(board.items.map((i) => [i.id, i.tag, i.selectable])).toEqual([['a', 'booked', false], ['b', 'verified', true], ['c', 'booked', false], ['x', 'booked', false]]);
    expect(board.counts).toMatchObject({ verified: 1, verified_ugx: 400000, booked: 3, ready_total: 2, ready_total_ugx: 800000 });
  });

  it('empty house: dropped from the cached empty-house pages', () => {
    const qc = seeded();
    dropFundedFromCache(qc, 'empty', ['h1']);
    const empty = qc.getQueryData<{ pages: { items: { house_id: string }[]; total: number }[] }>(['funder-new', 'empty-houses', {}])!;
    expect(empty.pages[0].items.map((h) => h.house_id)).toEqual(['h2']);
    expect(empty.pages[0].total).toBe(1);
  });

  it('afterFunded: marks the Rent Plan as this funder\'s and refetches the lists, map clusters and counts', async () => {
    const qc = seeded();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await afterFunded(qc, 'ready', ['a']);
    expect(getBookedByMe().has('a')).toBe(true);
    const keys = spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["funder-new"]', '["psm-fundable-plans"]', '["empty-house-map-cells"]', '["empty-house-map-cells-near"]']));
    unmarkBookedByMe(['a']);
    expect(getBookedByMe().has('a')).toBe(false);
  });

  it('isFundedOrClaimed: funded / repaying / completed or a confirmed claim', () => {
    expect(isFundedOrClaimed({ status: 'funded' })).toBe(true);
    expect(isFundedOrClaimed({ status: 'repaying' })).toBe(true);
    expect(isFundedOrClaimed({ status: 'completed' })).toBe(true);
    expect(isFundedOrClaimed({ claim_status: 'confirmed' })).toBe(true);
    expect(isFundedOrClaimed({ status: 'coo_approved' })).toBe(false);
    expect(isFundedOrClaimed(plan('a'))).toBe(false);
  });
});

describe('refetch while open', () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('every 60 s while visible, not while hidden, and at once on returning to the foreground', () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);
    const { unmount } = renderHook(() => useFunderListsAutoRefresh(qc));
    const rounds = () => spy.mock.calls.filter(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey) === '["funder-new"]').length;

    vi.advanceTimersByTime(FUNDER_LIST_REFRESH_MS);
    expect(rounds()).toBe(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    vi.advanceTimersByTime(FUNDER_LIST_REFRESH_MS);
    expect(rounds()).toBe(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(rounds()).toBe(2);

    unmount();
    vi.advanceTimersByTime(FUNDER_LIST_REFRESH_MS * 3);
    expect(rounds()).toBe(2);
  });
});
