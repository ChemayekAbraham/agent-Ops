import { BadgeCheck, Banknote, Bookmark, Clock, Home } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BoardKind } from '@/lib/fundersBoard';
import { BOARD_TAG_COLOR, type BoardTag } from '@/lib/fundersBoardTags';
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

/** The server's colour per tag (E72b): Verified green, Booked blue, Funded purple, Pending amber, Empty grey. */
const TAG_COLOR: Record<FundersBoardTagKind, string> = {
  verified: BOARD_TAG_COLOR.verified,
  booked: BOARD_TAG_COLOR.booked,
  funded: BOARD_TAG_COLOR.funded,
  pending_verification: BOARD_TAG_COLOR.pending_verification,
  empty: BOARD_TAG_COLOR.empty_house,
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
      className={cn('inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4', className)}
      style={{ color: TAG_COLOR[kind], backgroundColor: `${TAG_COLOR[kind]}1F`, boxShadow: `inset 0 0 0 1px ${TAG_COLOR[kind]}59` }}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {BOARD_TAG_LABEL[kind]}
    </span>
  );
}
