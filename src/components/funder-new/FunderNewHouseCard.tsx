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
        'relative flex min-w-0 gap-3 border-b border-border/70 py-3 transition-colors last:border-b-0',
        'sm:flex-col sm:gap-0 sm:overflow-hidden sm:rounded-2xl sm:border sm:border-border sm:py-0 sm:shadow-sm sm:transition-shadow sm:hover:shadow-md',
        selected && 'sm:border-primary sm:ring-1 sm:ring-primary',
      )}
    >
      <div className="relative w-28 flex-none sm:w-full">
        <button
          type="button"
          onClick={onDetail}
          aria-label={`Open full details for ${title} in ${place}`}
          className="block w-full overflow-hidden rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:rounded-none"
        >
          {photo ? (
            <img
              src={photo}
              alt={`${title} in ${place}`}
              loading="lazy"
              className="h-28 w-full object-cover sm:h-32 lg:h-36"
            />
          ) : (
            <div className="flex h-28 w-full items-center justify-center bg-primary/5 sm:h-32 lg:h-36">
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

      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:gap-1.5 sm:p-3">
        <p className="truncate text-sm font-semibold leading-snug">{place}</p>

        <p className="break-words text-[0.9375rem] font-bold leading-snug sm:text-base">
          {formatDynamic(amount)}
          <span className="ml-1 text-xs font-medium text-muted-foreground">to support</span>
        </p>

        <p className="text-xs leading-snug text-muted-foreground">
          {monthlyReturn === null ? (
            'Projected return not available yet'
          ) : (
            <>
              Projected return{' '}
              <span className="font-semibold text-success">{formatDynamic(monthlyReturn)}</span>/month
            </>
          )}
        </p>

        {distance ? (
          <p className="text-xs text-muted-foreground" title={STRAIGHT_LINE_EXPLANATION}>
            {distance.label}
            <span className="sr-only"> ({STRAIGHT_LINE_EXPLANATION})</span>
          </p>
        ) : null}

        <div className="mt-auto pt-1.5">
          <Button
            variant={selected ? 'default' : 'soft'}
            className="h-10 w-full rounded-xl text-sm sm:h-11"
            onClick={onSelect}
            aria-pressed={selected}
          >
            {selected ? <Check className="h-4 w-4" aria-hidden /> : null}
            {selected ? 'Selected' : 'Select'}
          </Button>
        </div>
      </div>
    </article>
  );
}

export default FunderNewHouseCard;
