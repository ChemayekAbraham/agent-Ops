import { Bookmark, Check, Home, MapPin, Navigation } from 'lucide-react';
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

/** Photo-led listing for /dashboard/funder-new. */
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
      <div className="relative aspect-[16/10] w-full bg-muted">
        {isEmpty ? (
          <div className="absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-card/95 px-2.5 py-1 text-[11px] font-semibold text-foreground shadow-sm ring-1 ring-border backdrop-blur">
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-success text-success-foreground">
              <Check className="h-2.5 w-2.5" strokeWidth={4} aria-hidden />
            </span>
            Empty house
          </div>
        ) : null}

        <button
          type="button"
          onClick={onDetail}
          aria-label={`Open full details for ${title} in ${place}`}
          className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
              <Home className="h-9 w-9 text-primary/45" aria-hidden />
              <span className="sr-only">No photo available</span>
            </div>
          )}
        </button>

        <button
          type="button"
          onClick={onSave}
          aria-label={saved ? `Remove ${title} from saved homes` : `Save ${title} for later`}
          aria-pressed={saved}
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-card/95 text-foreground shadow-sm ring-1 ring-border backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Bookmark className={cn('h-4 w-4', saved && 'fill-current text-primary')} aria-hidden />
        </button>
      </div>

      <div className="space-y-3 p-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-start gap-2">
            <p className="min-w-0 flex-1 break-words text-base font-bold leading-snug text-foreground">{title}</p>
          </div>
          <p className="mt-1.5 flex min-w-0 items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <MapPin className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden />
            <span className="min-w-0 break-words">{place}</span>
          </p>

          {distance ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground" title={STRAIGHT_LINE_EXPLANATION}>
              <Navigation className="h-3.5 w-3.5 flex-none text-primary" aria-hidden />
              {distance.label}
              <span className="sr-only"> ({STRAIGHT_LINE_EXPLANATION})</span>
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {monthlyReturn === null ? null : (
            <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
              {formatDynamic(monthlyReturn)} / month
            </span>
          )}
          {verified ? (
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">Verified</span>
          ) : null}
        </div>

        <div className="pt-1">
          <p className="text-xl font-bold leading-none text-foreground">{formatDynamic(amount)}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {monthlyReturn === null ? 'Support this home' : <>Earn <span className="font-semibold text-primary">{formatDynamic(monthlyReturn)}</span> monthly</>}
          </p>
        </div>

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
