import { Bookmark, Check, Home, Navigation, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDynamic } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import type { FunderNewCategory, FunderNewDistance, FunderNewEmptyHouse, FunderNewReadyPlan } from './types';
import {
  emptyHousePlace,
  emptyHouseTitle,
  firstPhoto,
  itemAmount,
  itemMonthlyReturn,
  readyPlanPlace,
  readyPlanTitle,
} from './utils';
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
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="#8024D1"
              stroke="#8024D1"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5"
              aria-hidden
            >
              <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
              <path d="m9 12 2 2 4-4" stroke="white" />
            </svg>
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
          className={cn(
            'absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-card/95 text-foreground shadow-sm ring-1 ring-border backdrop-blur transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            saved && 'border border-emerald-600 bg-emerald-500 text-white ring-emerald-600',
          )}
        >
          {saved ? (
            <Check className="h-4 w-4 text-white" aria-hidden />
          ) : (
            <Bookmark className="h-4 w-4" aria-hidden />
          )}
        </button>
      </div>

        <div className="space-y-3 p-4">
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

        <div className="pt-1">
          <p className="text-xl font-bold leading-none text-foreground">{formatDynamic(amount)}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {monthlyReturn === null ? 'Support this home' : <>Earn <span className="font-semibold text-primary">{formatDynamic(monthlyReturn)}</span> monthly</>}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSave}
            aria-label={saved ? `Remove ${title} from saved homes` : `Save ${title} for later`}
            aria-pressed={saved}
            className={cn(
              'flex h-11 w-11 flex-none items-center justify-center rounded-lg border border-primary bg-transparent text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              saved && 'border-emerald-600 bg-emerald-500 text-white hover:bg-emerald-600',
            )}
          >
            {saved ? (
              <Check className="h-4 w-4 text-white" aria-hidden />
            ) : (
              <Bookmark className="h-4 w-4" aria-hidden />
            )}
          </button>
          <Button
            variant="default"
            className={cn(
              'h-11 flex-1 gap-2 rounded-lg text-sm font-bold shadow-sm transition-colors',
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
              <Plus className="h-4 w-4" aria-hidden />
            )}
            {selected ? 'Selected' : 'Select'}
          </Button>

        </div>
      </div>
    </article>
  );
}

export default FunderNewHouseCard;
