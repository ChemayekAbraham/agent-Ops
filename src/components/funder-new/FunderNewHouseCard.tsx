import { Check, ChevronRight, Clock, Home, Navigation, Sprout } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDynamic } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import type { FunderNewCategory, FunderNewDistance, FunderNewEmptyHouse, FunderNewReadyPlan } from './types';
import {
  emptyHousePlace,
  emptyHouseTitle,
  firstPhoto,
  itemAmount,
  itemCoordinates,
  itemMonthlyReturn,
  readyPlanPlace,
  readyPlanTitle,
} from './utils';
import { STRAIGHT_LINE_EXPLANATION } from './distance';

/** Photo-led listing for /dashboard/funder-new. */
export function FunderNewHouseCard({
  category,
  item,
  selected,
  distance,
  onSelect,
  onDetail,
}: {
  category: FunderNewCategory;
  item: FunderNewEmptyHouse | FunderNewReadyPlan;
  /** No longer shown on the card (the save button was removed); kept so callers still compile. */
  saved?: boolean;
  selected: boolean;
  distance: FunderNewDistance | null;
  onSave?: () => void;
  onSelect: () => void;
  onDetail: () => void;
}) {
  const isEmpty = category === 'empty';
  const title = isEmpty ? emptyHouseTitle(item as FunderNewEmptyHouse) : readyPlanTitle(item as FunderNewReadyPlan);
  const place = isEmpty ? emptyHousePlace(item as FunderNewEmptyHouse) : readyPlanPlace(item as FunderNewReadyPlan);
  const amount = itemAmount(category, item);
  const monthlyReturn = itemMonthlyReturn(category, item);
  const photo = firstPhoto(category, item);
  const coords = itemCoordinates(item, category);

  return (
    <article
      className={cn(
        'relative my-3 min-w-0 overflow-hidden rounded-lg border border-border bg-muted shadow-none transition-[border-color,box-shadow] sm:my-0 sm:shadow-sm',
        'sm:hover:shadow-md',
        selected && 'border-primary ring-1 ring-primary',
      )}
    >
      <div className="relative aspect-[16/10] w-full bg-muted">
        {isEmpty ? (
          <div className="absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-card/95 px-2.5 py-1 text-[11px] font-semibold text-foreground shadow-sm ring-1 ring-border backdrop-blur">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            Pending verification
          </div>
        ) : (
          <div className="absolute left-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-card/95 px-2.5 py-1 text-[11px] font-semibold text-foreground shadow-sm ring-1 ring-border backdrop-blur">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="#16A34A"
              stroke="#16A34A"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5"
              aria-hidden
            >
              <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
              <path d="m9 12 2 2 4-4" stroke="white" />
            </svg>
            Verified tenant
          </div>
        )}

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

      </div>

        <div className="space-y-3 p-4">
        {/* Tapping the text block opens the full house details, like the photo does. */}
        <div
          role="button"
          tabIndex={0}
          onClick={onDetail}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onDetail();
            }
          }}
          aria-label={`Open full details for ${title} in ${place}`}
          className="-m-2 cursor-pointer space-y-3 rounded-2xl p-2 transition-colors hover:bg-muted/40 active:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
        <div className="min-w-0">
          <p className="min-w-0 break-words text-base font-bold leading-snug text-foreground">
            {title} <span className="font-medium text-muted-foreground">in</span> {place}
          </p>

          {distance ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground" title={STRAIGHT_LINE_EXPLANATION}>
              <Navigation className="h-3.5 w-3.5 flex-none text-primary" aria-hidden />
              {distance.label}
              <span className="sr-only"> ({STRAIGHT_LINE_EXPLANATION})</span>
            </p>
          ) : null}
        </div>

        <div className="flex items-end justify-between gap-2 pt-1">
          <div className="min-w-0">
            <p className="text-lg font-bold leading-none text-green-600 dark:text-green-400">{formatDynamic(amount)}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {monthlyReturn === null ? 'Support this home' : <>Earn <span className="font-semibold text-primary">{formatDynamic(monthlyReturn)}</span> monthly</>}
            </p>
          </div>
          <span className="inline-flex flex-none items-center gap-0.5 text-xs font-semibold text-primary" aria-hidden>
            Details
            <ChevronRight className="h-4 w-4" />
          </span>
        </div>
        </div>

        <div className="flex items-center gap-2 [container-type:inline-size]">
          {coords ? (
            <Button
              variant="outline"
              className="h-11 w-[24%] min-w-[56px] flex-none flex-col gap-0.5 rounded-lg border-primary p-0 text-primary hover:border-primary hover:bg-primary/5 hover:text-primary"
              onClick={() => {
                window.open(`https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`, '_blank', 'noopener,noreferrer');
              }}
              aria-label={`Open Google Maps location for ${title}`}
              title="Open in Google Maps"
            >
              <svg viewBox="0 0 24 24" className="!h-5 !w-5" aria-hidden>
                <path
                  d="M12 1.5a8 8 0 0 0-8 8c0 5.6 6.6 11.8 7.3 12.5a1 1 0 0 0 1.4 0c.7-.7 7.3-6.9 7.3-12.5a8 8 0 0 0-8-8Z"
                  fill="#EA4335"
                  stroke="#B3261E"
                  strokeWidth="1"
                />
                <circle cx="12" cy="9.5" r="3" fill="#8C1D18" />
              </svg>
              <span className="text-[10px] font-semibold leading-none">Location</span>
            </Button>
          ) : null}
          <Button
            variant="default"
            className={cn(
              // The label scales with the card (container width), so it fits the button without touching its edges.
              'h-11 min-w-0 flex-1 gap-1.5 rounded-lg px-3 text-[length:clamp(10px,calc(9cqw_-_6px),14px)] font-bold shadow-sm transition-colors',
              selected
                ? 'border border-emerald-600 bg-emerald-500 text-white hover:bg-emerald-600'
                : 'text-primary-foreground',
            )}
            onClick={onSelect}
            aria-pressed={selected}
          >
            {selected ? (
              <Check className="h-4 w-4 text-white" aria-hidden />
            ) : (
              <Sprout className="h-4 w-4" aria-hidden />
            )}
            {selected ? 'Selected' : isEmpty ? 'Pending verification' : 'Fund this House'}
          </Button>

        </div>
      </div>
    </article>
  );
}

export default FunderNewHouseCard;
