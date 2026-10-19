import { useId, useState } from 'react';
import { ChevronDown, CupSoda, Heart, Minus, Plus, ShoppingCart, UtensilsCrossed } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatUgx, forgetFoodMealPhotoUrl, type FoodMenuMeal } from '@/hooks/useFoodService';

interface FoodMealCardProps {
  meal: FoodMenuMeal;
  /** how many of this meal are already in the cart */
  quantity: number;
  /** false once the ordering window has closed or the day is shut */
  orderingOpen: boolean;
  /** the most of this meal the cart may hold (null when the period sets no limit) */
  remainingAllowance: number | null;
  onChange: (quantity: number) => void;
}

/** How tight stock has to get before the card says so. */
const LOW_STOCK_AT = 3;

/** Decorative category icon: drinks get a cup, everything else a plate. */
function CategoryIcon({ category }: { category: string }) {
  const Icon = /drink|beverage|juice|soda|tea|coffee/i.test(category) ? CupSoda : UtensilsCrossed;
  return <Icon className="h-3.5 w-3.5" aria-hidden="true" />;
}

export default function FoodMealCard({
  meal, quantity, orderingOpen, remainingAllowance, onChange,
}: FoodMealCardProps) {
  // A meal photo is optional, and a signed link can expire or be refused.
  // Either way the card falls back to the icon rather than a broken image; the
  // failed link is forgotten so the next menu refresh signs a new one, and a
  // new link gets a fresh attempt.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(meal.image_path) && meal.image_path !== failedUrl;
  const [isFavorite, setIsFavorite] = useState(false);

  // Tapping anywhere on the card opens the meal's description. The quantity
  // stepper and "Add to order" stop the tap so they never open or close it.
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const description = meal.description?.trim() ?? '';
  const hasDetails = description.length > 0;

  const left = meal.servings_remaining;
  const unavailable = meal.sold_out || !orderingOpen;

  // How many more of this meal may go into the cart: the same stock and
  // allowance limits as before, now applied to the amount being added. The
  // server remains the authority; these only stop a pointless click.
  const room = Math.min(
    left === null ? Infinity : left - quantity,
    remainingAllowance === null ? Infinity : remainingAllowance - quantity,
  );
  const canAdd = !unavailable && room >= 1;
  const atAllowance = remainingAllowance !== null && quantity >= remainingAllowance;

  // the amount picked on the stepper, added to the cart by "Add to order"
  const [pick, setPick] = useState(1);
  const picked = Math.max(1, Math.min(pick, Number.isFinite(room) ? Math.max(room, 1) : pick));

  return (
    <article
      onClick={hasDetails ? () => setExpanded((v) => !v) : undefined}
      className={cn(
        'group relative flex flex-col rounded-3xl border border-border/70 bg-card p-3 shadow-sm transition-all duration-200 hover:shadow-md hover:border-amber-400/40',
        unavailable && 'opacity-65',
        hasDetails && 'cursor-pointer',
      )}
    >
      {/* Glovo-style rounded picture frame with badge and optional favorite toggle */}
      <div className="relative aspect-[16/10] sm:aspect-[4/3] w-full overflow-hidden rounded-2xl bg-amber-500/5 dark:bg-muted/40">
        {showImage ? (
          <img
            src={meal.image_path as string}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            onError={() => {
              forgetFoodMealPhotoUrl(meal.image_path);
              setFailedUrl(meal.image_path);
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-amber-500/5 text-amber-600/40 dark:bg-muted/30 dark:text-muted-foreground/40">
            <UtensilsCrossed className="h-10 w-10" aria-hidden="true" />
          </div>
        )}

        {/* Favorite heart button (Glovo style) */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsFavorite((v) => !v);
          }}
          aria-label={`Favorite ${meal.name}`}
          className="absolute right-2.5 top-2.5 flex h-8 w-8 items-center justify-center rounded-full bg-background/80 text-foreground/70 backdrop-blur shadow-sm transition-transform hover:scale-110 active:scale-95"
        >
          <Heart
            className={cn('h-4 w-4 transition-colors', isFavorite ? 'fill-red-500 text-red-500' : 'text-muted-foreground')}
          />
        </button>

        {meal.sold_out && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/75 backdrop-blur-[2px]">
            <span className="rounded-full border border-destructive/30 bg-destructive/15 px-3.5 py-1 text-xs font-bold uppercase tracking-wider text-destructive shadow-sm">
              Sold out
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 px-1 pb-1 pt-3">
        {(meal.category || (!meal.sold_out && left !== null && left <= LOW_STOCK_AT) || quantity > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {meal.category && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                <CategoryIcon category={meal.category} />
                {meal.category}
              </span>
            )}
            {!meal.sold_out && left !== null && left <= LOW_STOCK_AT && (
              <span className="inline-flex items-center rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-bold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                Only {left} left
              </span>
            )}
            {quantity > 0 && (
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
                {quantity} in your order
              </span>
            )}
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-1">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold leading-snug text-card-foreground transition-colors group-hover:text-primary sm:text-lg">
              {meal.name}
            </h3>
            <p className="mt-0.5 text-base font-extrabold text-primary sm:text-lg tabular-nums">
              {formatUgx(meal.price_ugx)}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
            <div
              className={cn(
                'flex h-9 items-center rounded-full border border-border/80 bg-muted/40 shadow-xs',
                !canAdd && 'opacity-50',
              )}
            >
              <button
                type="button"
                className="flex h-full w-8 items-center justify-center rounded-l-full text-foreground transition-colors hover:bg-muted active:scale-95 disabled:pointer-events-none"
                aria-label={`One fewer ${meal.name}`}
                disabled={!canAdd || picked <= 1}
                onClick={() => setPick(picked - 1)}
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <span
                className="w-7 border-x border-border/70 text-center text-xs font-bold tabular-nums"
                aria-live="polite"
                aria-label={`${picked} to add`}
              >
                {picked}
              </span>
              <button
                type="button"
                className="flex h-full w-8 items-center justify-center rounded-r-full text-foreground transition-colors hover:bg-muted active:scale-95 disabled:pointer-events-none"
                aria-label={`One more ${meal.name}`}
                disabled={!canAdd || picked >= room}
                onClick={() => setPick(picked + 1)}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            <Button
              size="sm"
              className="h-9 rounded-full bg-primary px-3.5 font-bold text-primary-foreground shadow-xs transition-all hover:bg-primary/90 hover:shadow active:scale-95"
              disabled={!canAdd}
              onClick={() => { onChange(quantity + picked); setPick(1); }}
            >
              <ShoppingCart className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {meal.sold_out ? 'Sold out' : !orderingOpen ? 'Ordering closed' : 'Add to order'}
            </Button>
          </div>
        </div>

        {hasDetails && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 transition-transform duration-300 motion-reduce:transition-none',
                expanded && 'rotate-180',
              )}
              aria-hidden="true"
            />
            {expanded ? 'Hide details' : 'Meal details'}
          </button>
        )}

        {/* The panel stays mounted so the description is never lost to a screen
            reader or a search; only its height and opacity animate. */}
        {hasDetails && (
          <div
            id={detailsId}
            aria-hidden={!expanded}
            className={cn(
              'grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none',
              expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
            )}
          >
            <div className="overflow-hidden">
              <div className="mt-1 rounded-2xl border border-border/70 bg-muted/40 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  About this meal
                </p>
                <p className="mt-1 text-sm leading-relaxed text-card-foreground">{description}</p>
              </div>
            </div>
          </div>
        )}

        {quantity > 0 && atAllowance && (
          <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
            That is your limit for this service period.
          </p>
        )}
      </div>
    </article>
  );
}
