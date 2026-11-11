import { useSelfSupportFeePolicy } from '@/hooks/useSelfSupportFeePolicy';
import { Home, Navigation } from 'lucide-react';
import { formatDynamic } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import type { BoardItem } from '@/lib/fundersBoard';
import type { FunderNewDistance } from './types';
import { STRAIGHT_LINE_EXPLANATION } from './distance';
import { FundersBoardTag, tagKindFor } from './FundersBoardTag';

/**
 * E72b view-only card for a rent request on the funders board that cannot be
 * funded here: Booked, Funded, Pending verification, or a Verified one the
 * server marks not selectable (held by a funder). One tag chip, no fund button. Verified cards may carry the demote
 * checkbox for staff who can demote.
 */
export function FunderBoardItemCard({
  item,
  cardId,
  distance,
  highlighted = false,
  demoteMode = false,
  demoteChecked = false,
  onDemoteToggle,
  className,
}: {
  item: BoardItem;
  cardId: string;
  distance: FunderNewDistance | null;
  highlighted?: boolean;
  demoteMode?: boolean;
  demoteChecked?: boolean;
  onDemoteToggle?: () => void;
  className?: string;
}) {
  // Agent Care: the partner amount is pay(rent) (= rent while the switch is off).
  const { pay: partnerPay } = useSelfSupportFeePolicy();
  const title = item.houseCategory ?? 'House';
  const place = item.city ?? 'Uganda';
  const canDemote = demoteMode && item.tag === 'verified' && !!onDemoteToggle;
  return (
    <article
      data-testid="board-item-card"
      data-card-id={cardId}
      data-tag={item.tag}
      data-highlighted={highlighted ? 'true' : undefined}
      data-demote-checked={canDemote && demoteChecked ? 'true' : undefined}
      className={cn(
        'fv3-card fv3-cv relative min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-card text-card-foreground',
        canDemote && demoteChecked && 'border-destructive ring-2 ring-destructive/50',
        className,
      )}
    >
      <div className="relative aspect-[16/10] w-full bg-muted">
        {item.mainPhoto ? (
          <img src={item.mainPhoto} alt={`${title} in ${place}`} loading="lazy" decoding="async" width={640} height={400} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center bg-primary/5">
            <Home className="h-9 w-9 text-primary/45" aria-hidden />
            <span className="sr-only">No photo available</span>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 p-3.5">
        {canDemote ? (
          <label
            data-testid="fv3-demote-check"
            className={cn(
              'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-sm font-semibold ring-1 transition-colors',
              demoteChecked ? 'bg-destructive/10 text-destructive ring-destructive/40' : 'bg-muted/50 text-foreground ring-border',
            )}
          >
            <input
              type="checkbox"
              checked={demoteChecked}
              onChange={onDemoteToggle}
              aria-label={`Select ${title} in ${place} to demote`}
              className="h-5 w-5 flex-none accent-[hsl(var(--destructive))]"
            />
            {demoteChecked ? 'Selected to demote' : 'Select to demote'}
          </label>
        ) : null}
        <FundersBoardTag kind={tagKindFor(item.tag, 'ready')} />
        <p className="min-w-0 break-words text-base font-bold leading-snug text-foreground" style={{ margin: 0 }}>
          {title} <span className="font-medium text-muted-foreground">in</span> {place}
        </p>
        {distance ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground" title={STRAIGHT_LINE_EXPLANATION}>
            <Navigation className="h-3.5 w-3.5 flex-none text-primary" aria-hidden />
            {distance.label}
          </span>
        ) : null}
        <span className="text-lg font-extrabold leading-none text-foreground" data-testid="board-item-amount">
          {formatDynamic(item.rentAmount > 0 ? partnerPay(item.rentAmount) : item.rentAmount)}
        </span>
        <p className="text-xs text-muted-foreground" style={{ margin: 0 }} data-testid="board-item-note">
          {/* A Verified card here is never selectable (the list gives those the fundable card), so it never reads plain "View only". */}
          {item.tag === 'verified'
            ? item.selectable
              ? 'Ready to fund.'
              : 'Held by a funder for now — view only.'
            : item.tag === 'booked'
              ? 'A funder picked this one — view only.'
              : item.tag === 'funded'
                ? 'The landlord has been paid — view only.'
                : item.tag === 'pending_verification'
                  ? 'Pending verification — view only until verified again.'
                  : 'View only.'}
        </p>
      </div>
    </article>
  );
}

export default FunderBoardItemCard;
