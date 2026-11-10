import { BOARD_TAG_ORDER, type BoardTag } from '@/lib/fundersBoard';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewReadyPlan, FunderNewSort } from './types';
import { itemAmount } from './utils';

type Entry = { category: FunderNewCategory; item: FunderNewEmptyHouse | FunderNewReadyPlan };

const createdAt = (e: Entry) => {
  const raw = (e.item as unknown as Record<string, unknown>).created_at;
  const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * E65 FB-ORDER on the funders list: tag group first (Verified, Booked, Funded,
 * Pending verification, Empty houses), then the funder's chosen sort inside
 * each group. "Recommended" keeps the order the reads returned. Stable.
 */
export function orderFeedByBoardTag<T extends Entry>(
  entries: readonly T[],
  tagOf: (entry: T) => BoardTag,
  sort: FunderNewSort,
  kmOf: (entry: T) => number | null,
): T[] {
  const nullsLast = (a: number | null, b: number | null, dir: 1 | -1) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return (a - b) * dir;
  };
  return entries
    .map((entry, index) => ({ entry, index, group: BOARD_TAG_ORDER[tagOf(entry)] ?? 9 }))
    .sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group;
      let c = 0;
      if (sort === 'nearest') c = nullsLast(kmOf(a.entry), kmOf(b.entry), 1);
      else if (sort === 'rent_high') c = itemAmount(b.entry.category, b.entry.item) - itemAmount(a.entry.category, a.entry.item);
      else if (sort === 'rent_low') c = itemAmount(a.entry.category, a.entry.item) - itemAmount(b.entry.category, b.entry.item);
      else if (sort === 'newest') c = nullsLast(createdAt(a.entry), createdAt(b.entry), -1);
      return c || a.index - b.index;
    })
    .map((x) => x.entry);
}

/** The list header: "16 ready to fund · 783 houses". */
export function feedCountLabel(ready: number, houses: number): string {
  const r = Math.max(0, Math.round(ready));
  const h = Math.max(0, Math.round(houses));
  return `${r.toLocaleString('en')} ready to fund · ${h.toLocaleString('en')} ${h === 1 ? 'house' : 'houses'}`;
}

/** Only a radius the funder chose limits the list; "Nearest first" orders but never hides. */
export function withinRadius(km: number | null, radiusKm: number | null): boolean {
  if (radiusKm === null) return true;
  return km !== null && km <= radiusKm;
}
