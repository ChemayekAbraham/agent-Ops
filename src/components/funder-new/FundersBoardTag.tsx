import { BadgeCheck, Home } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BoardKind } from '@/lib/fundersBoard';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewReadyPlan } from './types';
import { itemId } from './utils';

/**
 * E59 funders board tags. Empty houses come from house_listings ("Empty
 * house", neutral); ready plans are COO-approved tenants ("Verified", green).
 * Shown only while `funders_board_tags` is on for the viewer (switch or preview row).
 */
export type FundersBoardTagKind = 'empty' | 'verified';

export function boardTagFor(category: FunderNewCategory): FundersBoardTagKind {
  return category === 'empty' ? 'empty' : 'verified';
}

/** What funders_board_demote takes for a card: house listings for empty houses, rent requests for verified tenants. */
export function boardItemFor(category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan): { kind: BoardKind; id: string } {
  return { kind: category === 'empty' ? 'house_listing' : 'rent_request', id: itemId(category, item) };
}

export const BOARD_TAG_LABEL: Record<FundersBoardTagKind, string> = {
  empty: 'Empty house',
  verified: 'Verified',
};

export function FundersBoardTag({ kind, className }: { kind: FundersBoardTagKind; className?: string }) {
  const verified = kind === 'verified';
  return (
    <span
      data-testid="funders-board-tag"
      data-tag={kind}
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4 ring-1',
        verified
          ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30'
          : 'bg-muted text-muted-foreground ring-border',
        className,
      )}
    >
      {verified ? <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> : <Home className="h-3.5 w-3.5" aria-hidden />}
      {BOARD_TAG_LABEL[kind]}
    </span>
  );
}
