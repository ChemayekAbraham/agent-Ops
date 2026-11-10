import { memo } from 'react';
import { Bookmark, Check, ChevronRight, Clock, Home, Navigation, Sprout } from 'lucide-react';
import { formatDynamic } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import type { FunderNewCategory, FunderNewDistance, FunderNewEmptyHouse, FunderNewReadyPlan } from '@/components/funder-new/types';
import {
  emptyHousePlace,
  emptyHouseTitle,
  firstPhoto,
  itemAmount,
  itemCoordinates,
  itemMonthlyReturn,
  readyPlanPlace,
  readyPlanTitle,
} from '@/components/funder-new/utils';
import { STRAIGHT_LINE_EXPLANATION } from '@/components/funder-new/distance';
import { FundersBoardTag, boardTagFor } from '@/components/funder-new/FundersBoardTag';

/** Rendered photo box is 16:10; these are the intrinsic hints for the browser. */
const PHOTO_W = 640;
const PHOTO_H = 400;
/** One card column up to ~560px of list, two up to ~1100px, three beyond. */
const PHOTO_SIZES = '(min-width: 1024px) 520px, (min-width: 640px) 360px, 100vw';

export interface FunderV3HouseCardProps {
  category: FunderNewCategory;
  item: FunderNewEmptyHouse | FunderNewReadyPlan;
  saved: boolean;
  selected: boolean;
  distance: FunderNewDistance | null;
  onSave: () => void;
  onSelect: () => void;
  onDetail: () => void;
  /** First card on screen: eager photo with high fetch priority (LCP). */
  priority?: boolean;
  /** Highlighted from a map pin. */
  highlighted?: boolean;
  /** Reports pointer hover so the matching map pin can light up (empty houses only). */
  onHoverChange?: (hovering: boolean) => void;
  /** Stable id for scroll-to-card and pin matching. */
  cardId: string;
  /** E59: show the funders board tag (Empty house / Verified). */
  boardTagsOn?: boolean;
  /** E59 select-to-demote mode (staff who may demote only). */
  demoteMode?: boolean;
  demoteChecked?: boolean;
  onDemoteToggle?: () => void;
}

/**
 * Funder V3 listing card. Presentation only: every figure and word comes from
 * the same helpers the live card uses (FunderNewHouseCard), so the two always
 * read the same. Layout follows the card's own width (container queries).
 */
export const FunderV3HouseCard = memo(function FunderV3HouseCard({
  category,
  item,
  saved,
  selected,
  distance,
  onSave,
  onSelect,
  onDetail,
  priority = false,
  highlighted = false,
  onHoverChange,
  cardId,
  boardTagsOn = false,
  demoteMode = false,
  demoteChecked = false,
  onDemoteToggle,
}: FunderV3HouseCardProps) {
  const isEmpty = category === 'empty';
  const title = isEmpty ? emptyHouseTitle(item as FunderNewEmptyHouse) : readyPlanTitle(item as FunderNewReadyPlan);
  const place = isEmpty ? emptyHousePlace(item as FunderNewEmptyHouse) : readyPlanPlace(item as FunderNewReadyPlan);
  const amount = itemAmount(category, item);
  const monthlyReturn = itemMonthlyReturn(category, item);
  const photo = firstPhoto(category, item);
  const coords = itemCoordinates(item, category);

  return (
    <article
      data-card-id={cardId}
      data-testid="fv3-card"
      data-highlighted={highlighted ? 'true' : undefined}
      data-demote-checked={demoteMode && demoteChecked ? 'true' : undefined}
      onPointerEnter={onHoverChange ? () => onHoverChange(true) : undefined}
      onPointerLeave={onHoverChange ? () => onHoverChange(false) : undefined}
      className={cn(
        'fv3-card @container relative min-w-0 scroll-mt-24 overflow-hidden rounded-2xl border border-border/70 bg-card text-card-foreground',
        selected && 'border-primary ring-1 ring-primary',
        demoteMode && demoteChecked && 'border-destructive ring-2 ring-destructive/50',
      )}
    >
      <div className="fv3-photo relative w-full overflow-hidden bg-muted">
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
              width={PHOTO_W}
              height={PHOTO_H}
              sizes={PHOTO_SIZES}
              decoding="async"
              loading={priority ? 'eager' : 'lazy'}
              // React 18 passes unknown lowercase attributes straight to the DOM.
              {...({ fetchpriority: priority ? 'high' : 'auto' } as Record<string, string>)}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-primary/5">
              <Home className="h-9 w-9 text-primary/45" aria-hidden />
              <span className="sr-only">No photo available</span>
            </span>
          )}
        </button>

        <span className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-card/95 px-2.5 py-1 fv3-t-2xs font-semibold text-foreground shadow-sm ring-1 ring-border">
          {isEmpty ? (
            <>
              <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              Pending verification
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="#8024D1" stroke="#8024D1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden>
                <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" />
                <path d="m9 12 2 2 4-4" stroke="white" />
              </svg>
              Verified tenant
            </>
          )}
        </span>

        <button
          type="button"
          onClick={onSave}
          aria-label={saved ? `Remove ${title} from saved homes` : `Save ${title} for later`}
          aria-pressed={saved}
          className={cn(
            'fv3-tap absolute right-1.5 top-1.5 flex items-center justify-center rounded-full focus-visible:outline-none',
          )}
        >
          <span
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-full bg-card/95 text-foreground shadow-sm ring-1 ring-border transition-colors',
              saved && 'bg-emerald-500 text-white ring-emerald-600',
            )}
          >
            {saved ? <Check className="h-4 w-4" aria-hidden /> : <Bookmark className="h-4 w-4" aria-hidden />}
          </span>
        </button>
      </div>

      <div className="flex flex-col gap-3 p-3.5 @[420px]:p-4">
        {demoteMode ? (
          <label
            data-testid="fv3-demote-check"
            className={cn(
              'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl px-3 fv3-t-sm font-semibold ring-1 transition-colors',
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
        {boardTagsOn ? <FundersBoardTag kind={boardTagFor(category)} /> : null}
        <button
          type="button"
          onClick={onDetail}
          aria-label={`Open full details for ${title} in ${place}`}
          className="-m-1.5 flex flex-col gap-2 rounded-xl p-1.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 break-words fv3-t-base font-bold leading-snug text-foreground">
            {title} <span className="font-medium text-muted-foreground">in</span> {place}
          </span>

          {distance ? (
            <span className="flex items-center gap-1.5 fv3-t-xs font-medium text-muted-foreground" title={STRAIGHT_LINE_EXPLANATION}>
              <Navigation className="h-3.5 w-3.5 flex-none text-primary" aria-hidden />
              {distance.label}
              <span className="sr-only"> ({STRAIGHT_LINE_EXPLANATION})</span>
            </span>
          ) : null}

          <span className="flex items-end justify-between gap-2 pt-0.5">
            <span className="min-w-0">
              <span data-testid="fv3-card-amount" className="block fv3-t-lg font-extrabold leading-none text-green-600 dark:text-green-400">{formatDynamic(amount)}</span>
              <span data-testid="fv3-card-return" className="mt-1.5 block fv3-t-xs text-muted-foreground">
                {monthlyReturn === null ? 'Support this home' : <>Earn <span className="font-semibold text-primary">{formatDynamic(monthlyReturn)}</span> monthly</>}
              </span>
            </span>
            <span className="inline-flex flex-none items-center gap-0.5 fv3-t-xs font-semibold text-primary" aria-hidden>
              Details
              <ChevronRight className="h-4 w-4" />
            </span>
          </span>
        </button>

        <div className="flex items-center gap-2">
          {coords ? (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open Google Maps location for ${title}`}
              title="Open in Google Maps"
              className="fv3-tap flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-primary text-primary transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Navigation className="h-4 w-4" aria-hidden />
              <span className="sr-only">Open in Google Maps</span>
            </a>
          ) : null}
          <button
            type="button"
            data-testid="fv3-fund-button"
            onClick={onSelect}
            aria-pressed={selected}
            className={cn(
              'fv3-tap inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 fv3-t-sm font-bold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              selected
                ? 'border border-emerald-600 bg-emerald-500 text-white hover:bg-emerald-600'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {selected ? <Check className="h-4 w-4 flex-none" aria-hidden /> : <Sprout className="h-4 w-4 flex-none" aria-hidden />}
            <span className="truncate">{selected ? 'Selected' : isEmpty ? 'Pending verification' : 'Fund this House'}</span>
          </button>
        </div>
      </div>
    </article>
  );
});

export default FunderV3HouseCard;
