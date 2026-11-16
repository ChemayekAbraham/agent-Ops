import { BOARD_GROUPS, BOARD_TAG_COLOR, BOARD_TAG_LABEL, type BoardRequestTag, type BoardTag } from '@/lib/fundersBoardTags';
import type { BoardItem } from '@/lib/fundersBoard';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewFilters, FunderNewReadyPlan, FunderNewSort } from './types';
import { amountRange, itemAmount, itemId } from './utils';
import { withinRadius } from './feedOrder';
import { isFundedOrClaimed } from './funderListRefresh';

type FeedEntry = { category: FunderNewCategory; item: FunderNewEmptyHouse | FunderNewReadyPlan };

/** One card in a group: an existing (fundable) feed card, or a view-only board item. */
export type BoardRow<E extends FeedEntry = FeedEntry> =
  | { kind: 'feed'; cardId: string; tag: BoardTag; entry: E; /** COO/CEO only: what a Verified request still lacks. */ incomplete?: string[] | null }
  | {
      kind: 'board';
      cardId: string;
      tag: BoardRequestTag;
      item: BoardItem;
      /** Verified on the board but its fundable plan has not loaded yet: no Fund button until it does. */
      checking?: boolean;
      /** This funder booked it in this session: "Booked — waiting for landlord payment". */
      mine?: boolean;
    };

export type BoardGroup<E extends FeedEntry = FeedEntry> = {
  tag: BoardTag;
  label: string;
  color: string;
  /** What the group header shows: the rows shown, or (Empty houses) every matching house. */
  count: number;
  rows: BoardRow<E>[];
};

/** Search, district and amount for a view-only board item (the reads filter the fundable cards themselves). */
export function boardItemMatches(item: BoardItem, filters: Pick<FunderNewFilters, 'search' | 'location' | 'amount' | 'rentMin' | 'rentMax'>): boolean {
  const q = filters.search.trim().toLowerCase();
  if (q && ![item.houseCategory, item.city, item.tenantFirstName].some((v) => (v ?? '').toLowerCase().includes(q))) return false;
  const district = filters.location.trim().toLowerCase();
  if (district && (item.city ?? '').toLowerCase() !== district) return false;
  const bucket = amountRange(filters.amount);
  const min = filters.rentMin ?? bucket.min;
  const max = filters.rentMax ?? bucket.max;
  if (min !== null && min !== undefined && item.rentAmount < min) return false;
  if (max !== null && max !== undefined && item.rentAmount > max) return false;
  return true;
}

const ts = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * E72b grouped funders list: Verified, Booked, Funded, Pending verification
 * (in the server's order), then Empty houses. Never mixed. The chosen sort
 * applies inside each group only; "Nearest first" never hides anything; only a
 * distance the funder chose filters by distance.
 */
export function buildBoardGroups<E extends FeedEntry>(args: {
  board: BoardItem[];
  ready: E[];
  empty: E[];
  sort: FunderNewSort;
  radiusKm: number | null;
  kmOfEntry: (entry: E) => number | null;
  kmOfItem: (item: BoardItem) => number | null;
  filters: Pick<FunderNewFilters, 'search' | 'location' | 'amount' | 'rentMin' | 'rentMax'>;
  /** Every empty house matching the filters (the read's total), for that group's header. */
  emptyTotal: number;
  /** Every page of the fundable plans read has loaded (default true). */
  feedComplete?: boolean;
  /** Rent requests this funder funded in this session (shown as theirs, never fundable). */
  bookedByMe?: ReadonlySet<string>;
}): BoardGroup<E>[] {
  const { board, ready, empty, sort, radiusKm, kmOfEntry, kmOfItem, filters, emptyTotal, feedComplete = true, bookedByMe } = args;
  const mine = (id: string) => bookedByMe?.has(id) ?? false;
  const booked = (item: BoardItem): BoardItem => ({ ...item, tag: 'booked', selectable: false, held: false, incomplete: null });
  const readyById = new Map(ready.map((entry) => [itemId('ready', entry.item), entry]));
  const used = new Set<string>();
  const byTag = new Map<BoardTag, BoardRow<E>[]>(BOARD_GROUPS.map((t) => [t, []]));

  // Every fundable card comes from the fundable plans read (partner_self_list_fundable_plans):
  // the board only places and labels it. A request the board, the plan itself or this
  // funder's own booking says is funded or claimed is never fundable here.
  for (const item of board) {
    used.add(item.id);
    const loaded = readyById.get(item.id);
    const taken = mine(item.id) || (loaded ? isFundedOrClaimed(loaded.item) : false);
    if (item.tag === 'verified' && !taken) {
      const heldByViewer = !!loaded && !!(loaded.item as FunderNewReadyPlan).held_by;
      if (loaded && (item.selectable || heldByViewer)) {
        byTag.get('verified')!.push({ kind: 'feed', cardId: `ready:${item.id}`, tag: 'verified', entry: loaded, incomplete: item.incomplete });
      } else if (!boardItemMatches(item, filters)) {
        continue;
      } else if (item.selectable && !feedComplete) {
        // Its page of fundable plans is still loading.
        byTag.get('verified')!.push({ kind: 'board', cardId: `board:${item.id}`, tag: 'verified', item, checking: true });
      } else if (item.selectable) {
        // The fundable read no longer has it: a funder has taken it (the board catches up on refetch).
        byTag.get('booked')!.push({ kind: 'board', cardId: `board:${item.id}`, tag: 'booked', item: booked(item) });
      } else {
        byTag.get('verified')!.push({ kind: 'board', cardId: `board:${item.id}`, tag: 'verified', item });
      }
    } else if (boardItemMatches(item, filters)) {
      const shown = item.tag === 'verified' ? booked(item) : item;
      byTag.get(shown.tag)!.push({ kind: 'board', cardId: `board:${item.id}`, tag: shown.tag, item: shown, mine: mine(item.id) });
    }
  }
  // A fundable Rent Plan the board does not list yet still belongs with Verified,
  // unless it is already funded or claimed (a stale list).
  for (const entry of ready) {
    const id = itemId('ready', entry.item);
    if (used.has(id) || mine(id) || isFundedOrClaimed(entry.item)) continue;
    byTag.get('verified')!.push({ kind: 'feed', cardId: `ready:${id}`, tag: 'verified', entry });
  }
  for (const entry of empty) {
    byTag.get('empty_house')!.push({ kind: 'feed', cardId: `empty:${itemId('empty', entry.item)}`, tag: 'empty_house', entry });
  }

  const km = (row: BoardRow<E>) => (row.kind === 'feed' ? kmOfEntry(row.entry) : kmOfItem(row.item));
  const amount = (row: BoardRow<E>) => (row.kind === 'feed' ? itemAmount(row.entry.category, row.entry.item) : row.item.rentAmount);
  const when = (row: BoardRow<E>) => (row.kind === 'feed' ? ts((row.entry.item as unknown as Record<string, unknown>).created_at) : ts(row.item.sortAt));
  const nullsLast = (a: number | null, b: number | null, dir: 1 | -1) => (a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : (a - b) * dir);

  return BOARD_GROUPS.map((tag) => {
    const rows = (byTag.get(tag) ?? [])
      .filter((row) => withinRadius(km(row), radiusKm))
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        let c = 0;
        if (sort === 'nearest') c = nullsLast(km(a.row), km(b.row), 1);
        else if (sort === 'rent_high') c = amount(b.row) - amount(a.row);
        else if (sort === 'rent_low') c = amount(a.row) - amount(b.row);
        else if (sort === 'newest') c = nullsLast(when(a.row), when(b.row), -1);
        return c || a.index - b.index;
      })
      .map((x) => x.row);
    const count = tag === 'empty_house' && radiusKm === null ? Math.max(emptyTotal, rows.length) : rows.length;
    return { tag, label: BOARD_TAG_LABEL[tag], color: BOARD_TAG_COLOR[tag], count, rows };
  }).filter((group) => group.rows.length > 0);
}

/** "16 ready to fund · UGX 9,640,000" */
export function boardHeadline(counts: { ready_total: number; ready_total_ugx: number }): string {
  return `${Math.round(counts.ready_total).toLocaleString('en')} ready to fund · UGX ${Math.round(counts.ready_total_ugx).toLocaleString('en')}`;
}

/** "12 verified · 4 pending verification" */
export function boardSubline(counts: { verified: number; pending_verification: number }): string {
  return `${Math.round(counts.verified).toLocaleString('en')} verified · ${Math.round(counts.pending_verification).toLocaleString('en')} pending verification`;
}
