import { BadgeCheck, Banknote, Bookmark, Clock, Home } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BoardKind, BoardTag } from '@/lib/fundersBoard';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewReadyPlan } from './types';
import { itemId } from './utils';

/**
 * E59 funders board tags. Empty houses come from house_listings ("Empty
 * house", neutral); ready plans are COO-approved tenants ("Verified", green).
 * Shown only while `funders_board_tags` is on for the viewer (switch or preview row).
 */
export type FundersBoardTagKind = 'empty' | 'verified' | 'booked' | 'funded' | 'pending_verification';

export function boardTagFor(category: FunderNewCategory): FundersBoardTagKind {
  return category === 'empty' ? 'empty' : 'verified';
}

/** E65: the server's tag when known (funders_board_items), else the category's. */
export function tagKindFor(tag: BoardTag | null | undefined, category: FunderNewCategory): FundersBoardTagKind {
  if (!tag) return boardTagFor(category);
  return tag === 'empty_house' ? 'empty' : tag;
}

/** What funders_board_demote takes for a card: house listings for empty houses, rent requests for verified tenants. */
export function boardItemFor(category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan): { kind: BoardKind; id: string } {
  return { kind: category === 'empty' ? 'house_listing' : 'rent_request', id: itemId(category, item) };
}

export const BOARD_TAG_LABEL: Record<FundersBoardTagKind, string> = {
  empty: 'Empty house',
  verified: 'Verified',
  booked: 'Booked',
  funded: 'Funded',
  pending_verification: 'Pending verification',
};

const TAG_STYLE: Record<FundersBoardTagKind, string> = {
  verified: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
  booked: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30',
  funded: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/30',
  pending_verification: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  empty: 'bg-muted text-muted-foreground ring-border',
};

const TAG_ICON: Record<FundersBoardTagKind, typeof Home> = {
  verified: BadgeCheck,
  booked: Bookmark,
  funded: Banknote,
  pending_verification: Clock,
  empty: Home,
};

export function FundersBoardTag({ kind, className }: { kind: FundersBoardTagKind; className?: string }) {
  const Icon = TAG_ICON[kind];
  return (
    <span
      data-testid="funders-board-tag"
      data-tag={kind}
      className={cn('inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4 ring-1', TAG_STYLE[kind], className)}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {BOARD_TAG_LABEL[kind]}
    </span>
  );
}
