import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

import { buildBoardGroups, boardHeadline, boardItemMatches, boardItemToReadyPlan, boardSubline } from '../boardGroups';
import { tagKindFor } from '../FundersBoardTag';
import { BOARD_TAG_COLOR, parseBoardItems, type BoardItem } from '@/lib/fundersBoard';
import type { FunderNewEmptyHouse, FunderNewReadyPlan } from '../types';

type Entry = { category: 'ready' | 'empty'; item: FunderNewEmptyHouse | FunderNewReadyPlan };
const plan = (id: string, rent = 500000, km: number | null = null): Entry & { km: number | null } => ({
  category: 'ready',
  item: { rent_request_id: id, funding_amount: rent, rent_amount: rent } as unknown as FunderNewReadyPlan,
  km,
});
const house = (id: string, km: number | null = null): Entry & { km: number | null } => ({
  category: 'empty',
  item: { house_id: id, monthly_rent: 300000 } as unknown as FunderNewEmptyHouse,
  km,
});
const item = (id: string, tag: BoardItem['tag'], over: Partial<BoardItem> = {}): BoardItem => ({
  id, tag, selectable: tag === 'verified', held: false, tenantFirstName: 'Grace', houseCategory: 'Single Room', city: 'Kira',
  mainPhoto: null, photos: [], rentAmount: 400000, durationDays: 30, dailyRepayment: null, lat: null, lng: null, sortAt: null, incomplete: null, ...over,
});
const NO_FILTERS = { search: '', location: '', amount: 'all' as const, rentMin: null, rentMax: null };
const ids = (rows: { kind: string; cardId: string }[]) => rows.map((r) => r.cardId);

describe('E72b grouped funders list', () => {
  const board = [
    item('p1', 'verified'),
    item('held', 'verified', { held: true, selectable: false }),
    item('b1', 'booked'),
    item('f1', 'funded'),
    item('pv1', 'pending_verification'),
  ];
  const base = {
    board,
    ready: [plan('p1'), plan('p-extra')],
    empty: [house('h1'), house('h2')],
    sort: 'recommended' as const,
    radiusKm: null,
    kmOfEntry: (e: Entry) => (e as Entry & { km: number | null }).km,
    kmOfItem: (i: BoardItem) => (i.lat === null ? null : i.lat),
    filters: NO_FILTERS,
    emptyTotal: 783,
  };

  it('groups in order Verified, Booked, Funded, Pending verification, Empty houses; never mixed', () => {
    const groups = buildBoardGroups(base);
    expect(groups.map((g) => g.tag)).toEqual(['verified', 'booked', 'funded', 'pending_verification', 'empty_house']);
    for (const g of groups) expect(g.rows.every((r) => r.tag === g.tag)).toBe(true);
    expect(groups.map((g) => g.color)).toEqual(['#16A34A', '#2563EB', '#6900CC', '#D97706', '#6B7280']);
  });

  it('a Verified item with a fundable plan uses the fundable card; held or unmatched ones stay view only; nothing disappears', () => {
    const verified = buildBoardGroups(base)[0];
    expect(verified.rows.map((r) => [r.kind, r.cardId])).toEqual([
      ['feed', 'ready:p1'],
      ['board', 'board:held'],
      ['feed', 'ready:p-extra'],
    ]);
  });

  it("a Verified card follows the server's selectable: a selectable item whose plan has not loaded is still fundable", () => {
    const verified = buildBoardGroups({ ...base, board: [item('late', 'verified', { mainPhoto: 'a.jpg', lat: 0.3, lng: 32.6 })], ready: [] })[0];
    expect(verified.rows.map((r) => [r.kind, r.cardId])).toEqual([['feed', 'ready:late']]);
    const row = verified.rows[0];
    if (row.kind !== 'feed') throw new Error('expected a fundable row');
    const built = row.entry.item as FunderNewReadyPlan;
    expect(built.rent_request_id).toBe('late');
    expect(built.funding_amount).toBe(400000);
    expect(built.house_image_urls).toEqual(['a.jpg']);
    expect([built.request_latitude, built.request_longitude]).toEqual([0.3, 32.6]);
  });

  it('a Verified item the server marks not selectable is view only even if its plan loaded, unless this viewer holds it', () => {
    const held = { held: true, selectable: false };
    const stale = buildBoardGroups({ ...base, board: [item('x', 'verified', held)], ready: [plan('x')] })[0];
    expect(stale.rows.map((r) => [r.kind, r.cardId])).toEqual([['board', 'board:x']]);
    const mine = plan('x');
    (mine.item as FunderNewReadyPlan).held_by = 'me';
    const own = buildBoardGroups({ ...base, board: [item('x', 'verified', held)], ready: [mine] })[0];
    expect(own.rows.map((r) => [r.kind, r.cardId])).toEqual([['feed', 'ready:x']]);
  });

  it('a Verified row carries the COO-only incomplete list, loaded or not', () => {
    const verified = buildBoardGroups({
      ...base,
      board: [item('p1', 'verified', { incomplete: ['family size'] }), item('late', 'verified', { incomplete: ['LC1 (letter or phone confirmation)'] })],
      ready: [plan('p1')],
    })[0];
    expect(verified.rows.map((r) => (r.kind === 'feed' ? [r.cardId, r.incomplete] : [r.cardId]))).toEqual([
      ['ready:p1', ['family size']],
      ['ready:late', ['LC1 (letter or phone confirmation)']],
    ]);
  });

  it('boardItemToReadyPlan keeps every photo the server sent', () => {
    expect(boardItemToReadyPlan(item('y', 'verified', { mainPhoto: 'a.jpg', photos: ['a.jpg', 'b.jpg'] })).house_image_urls).toEqual(['a.jpg', 'b.jpg']);
    expect(boardItemToReadyPlan(item('z', 'verified')).house_image_urls).toBeNull();
  });

  it('Empty houses: header counts every matching house, cards are the loaded ones', () => {
    const empty = buildBoardGroups(base).find((g) => g.tag === 'empty_house')!;
    expect(empty.count).toBe(783);
    expect(ids(empty.rows)).toEqual(['empty:h1', 'empty:h2']);
  });

  it('Nearest first sorts inside each group only and never hides a row without a pin', () => {
    const groups = buildBoardGroups({
      ...base,
      sort: 'nearest',
      board: [item('b-far', 'booked', { lat: 90 }), item('b-near', 'booked', { lat: 2 }), item('b-nopin', 'booked')],
      ready: [plan('r-far', 1, 50), plan('r-near', 1, 3)],
      empty: [house('h-nopin'), house('h-near', 1), house('h-far', 197)],
    });
    expect(ids(groups.find((g) => g.tag === 'verified')!.rows)).toEqual(['ready:r-near', 'ready:r-far']);
    expect(ids(groups.find((g) => g.tag === 'booked')!.rows)).toEqual(['board:b-near', 'board:b-far', 'board:b-nopin']);
    expect(ids(groups.find((g) => g.tag === 'empty_house')!.rows)).toEqual(['empty:h-near', 'empty:h-far', 'empty:h-nopin']);
  });

  it('only a chosen distance filters by distance', () => {
    const groups = buildBoardGroups({ ...base, radiusKm: 10, board: [item('b-near', 'booked', { lat: 4 }), item('b-far', 'booked', { lat: 40 })], empty: [house('h-near', 2), house('h-nopin')] });
    expect(ids(groups.find((g) => g.tag === 'booked')!.rows)).toEqual(['board:b-near']);
    const empty = groups.find((g) => g.tag === 'empty_house')!;
    expect(ids(empty.rows)).toEqual(['empty:h-near']);
    expect(empty.count).toBe(1);
  });

  it('search, district and amount narrow the view-only items too', () => {
    expect(boardItemMatches(item('x', 'booked', { city: 'Ntinda' }), { ...NO_FILTERS, search: 'ntin' })).toBe(true);
    expect(boardItemMatches(item('x', 'booked', { city: 'Kira' }), { ...NO_FILTERS, search: 'ntin' })).toBe(false);
    expect(boardItemMatches(item('x', 'booked', { city: 'Kira' }), { ...NO_FILTERS, location: 'kira' })).toBe(true);
    expect(boardItemMatches(item('x', 'booked', { rentAmount: 900000 }), { ...NO_FILTERS, rentMax: 500000 })).toBe(false);
  });

  it('header: "{ready_total} ready to fund · UGX {ready_total_ugx}" and "{verified} verified · {pending} pending verification"', () => {
    const counts = { ready_total: 16, ready_total_ugx: 9640000, verified: 12, pending_verification: 4 };
    expect(boardHeadline(counts)).toBe('16 ready to fund · UGX 9,640,000');
    expect(boardSubline(counts)).toBe('12 verified · 4 pending verification');
  });

  it('parses funders_board_items: all four tags in the server order, counts kept apart', () => {
    const parsed = parseBoardItems({
      items: [
        { kind: 'rent_request', id: 'a', tag: 'verified', selectable: true, rent_amount: 400000, lat: 0.35, lng: 32.6, house_category: 'Single Room', city: 'Kira' },
        { kind: 'rent_request', id: 'b', tag: 'booked', selectable: false, rent_amount: '500000' },
        { kind: 'rent_request', id: 'c', tag: 'nonsense' },
        { kind: 'house_listing', id: 'd', tag: 'verified' },
      ],
      counts: { verified: 1, verified_ugx: 400000, booked: 1, funded: 0, pending_verification: 0, pending_verification_ugx: 0, ready_total: 1, ready_total_ugx: 400000 },
    });
    expect(parsed.items.map((i) => [i.id, i.tag, i.rentAmount])).toEqual([['a', 'verified', 400000], ['b', 'booked', 500000]]);
    expect(parsed.items[1].lat).toBeNull();
    expect(parsed.counts.ready_total_ugx).toBe(400000);
    // incomplete is COO/CEO only: null (funders) stays null, never an empty list.
    expect(parsed.items.map((i) => i.incomplete)).toEqual([null, null]);
    const coo = parseBoardItems({ items: [{ kind: 'rent_request', id: 'a', tag: 'verified', incomplete: ['family size', '', 7, 'work / business'] }, { kind: 'rent_request', id: 'b', tag: 'verified', incomplete: [] }] });
    expect(coo.items.map((i) => i.incomplete)).toEqual([['family size', 'work / business'], []]);
  });

  it('one tag chip per card in the server colour', () => {
    expect(tagKindFor('pending_verification', 'ready')).toBe('pending_verification');
    expect(tagKindFor('empty_house', 'empty')).toBe('empty');
    expect(BOARD_TAG_COLOR.empty_house).toBe('#6B7280');
  });
});
