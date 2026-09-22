import { Bookmark, Check, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDynamic } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import type { FunderNewCategory, FunderNewDistance, FunderNewEmptyHouse, FunderNewReadyPlan } from './types';
import {
  emptyHousePlace,
  emptyHouseTitle,
  firstPhoto,
  isHouseVerified,
  itemAmount,
  itemMonthlyReturn,
  readyPlanPlace,
  readyPlanTitle,
} from './utils';
import { FunderNewVerifiedBadge } from './FunderNewVerifiedBadge';
import { STRAIGHT_LINE_EXPLANATION } from './distance';

/**
 * Compact listing for /dashboard/funder-new.
 *
 * Mobile: a photo-led horizontal row. Tablet/desktop: a shallow photo with text
 * below. Only the essentials are shown here — everything else is in full view.
 */
export function FunderNewHouseCard({
  category,
  item,
  saved,
  selected,
  distance,
  onSave,
  onSelect,
  onDetail,
}: {
  category: FunderNewCategory;
  item: FunderNewEmptyHouse | FunderNewReadyPlan;
  saved: boolean;
  selected: boolean;
  distance: FunderNewDistance | null;
  onSave: () => void;
  onSelect: () => void;
  onDetail: () => void;
}) {
  const isEmpty = category === 'empty';
  const title = isEmpty ? emptyHouseTitle(item as FunderNewEmptyHouse) : readyPlanTitle(item as FunderNewReadyPlan);
  const place = isEmpty ? emptyHousePlace(item as FunderNewEmptyHouse) : readyPlanPlace(item as FunderNewReadyPlan);
  const amount = itemAmount(category, item);
  const monthlyReturn = itemMonthlyReturn(category, item);
  const photo = firstPhoto(category, item);
  const verified = isHouseVerified(category, item);

  return (
    <article
      className={cn(
        'relative min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-[border-color,box-shadow]',
        'hover:shadow-md',
        selected && 'border-primary ring-1 ring-primary',
      )}
    >
      <div className="flex min-w-0 gap-4 p-4">
        <div className="relative h-24 w-24 flex-none">
          <button
            type="button"
            onClick={onDetail}
            aria-label={`Open full details for ${title} in ${place}`}
            className="block h-full w-full overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {photo ? (
              <img
                src={photo}
                alt={`${title} in ${place}`}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-primary/5">
                <Home className="h-7 w-7 text-primary/45" aria-hidden />
                <span className="sr-only">No photo available</span>
              </div>
            )}
          </button>

          <button
            type="button"
            onClick={onSave}
            aria-label={saved ? `Remove ${title} from saved homes` : `Save ${title} for later`}
            aria-pressed={saved}
            className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-card/90 text-foreground shadow-sm ring-1 ring-border backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Bookmark className={cn('h-4 w-4', saved && 'fill-current text-primary')} aria-hidden />
          </button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col py-0.5">
          <p className="break-words text-base font-bold leading-snug text-foreground">{title}</p>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-sm leading-snug text-muted-foreground">
            <span className="truncate">{place}</span>
            {verified ? <FunderNewVerifiedBadge variant="icon" /> : null}
          </p>

          {distance ? (
            <p className="mt-auto pt-2 text-xs font-medium text-muted-foreground" title={STRAIGHT_LINE_EXPLANATION}>
              {distance.label}
              <span className="sr-only"> ({STRAIGHT_LINE_EXPLANATION})</span>
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-2.5 border-y border-border bg-muted/45 px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="text-xs font-semibold text-muted-foreground">Support amount</span>
          <div className="min-w-0 text-right">
            <span className="break-words text-[0.9375rem] font-bold text-foreground">{formatDynamic(amount)}</span>
            <span className="block text-[0.6875rem] text-muted-foreground">to support</span>
          </div>
        </div>

        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="text-xs font-semibold text-muted-foreground">Projected return</span>
          <div className="min-w-0 text-right">
            {monthlyReturn === null ? (
              <span className="text-xs text-muted-foreground">Not available yet</span>
            ) : (
              <>
                <span className="break-words text-[0.9375rem] font-bold text-success">
                  {formatDynamic(monthlyReturn)}
                </span>
                <span className="block text-[0.6875rem] text-muted-foreground">per month</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="p-4">
        <Button
          variant="default"
          className="h-11 w-full rounded-lg text-sm font-bold text-primary-foreground shadow-sm"
          onClick={onSelect}
          aria-pressed={selected}
        >
          {selected ? <Check className="h-4 w-4" aria-hidden /> : null}
          {selected ? 'Selected' : 'Select'}
        </Button>
      </div>
    </article>
  );
}

export default FunderNewHouseCard;
