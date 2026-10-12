import { useState } from 'react';
import { Minus, Plus, UtensilsCrossed } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatUgx, type FoodMenuMeal } from '@/hooks/useFoodService';

interface FoodMealCardProps {
  meal: FoodMenuMeal;
  quantity: number;
  /** false once the ordering window has closed or the day is shut */
  orderingOpen: boolean;
  /** null when the service period sets no per-employee limit */
  remainingAllowance: number | null;
  onChange: (quantity: number) => void;
}

/** How tight stock has to get before the card says so. */
const LOW_STOCK_AT = 3;

export default function FoodMealCard({
  meal, quantity, orderingOpen, remainingAllowance, onChange,
}: FoodMealCardProps) {
  // A meal photo is optional, and a stored path can rot. Either way the card
  // falls back to the icon rather than showing a broken image.
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(meal.image_path) && !imageFailed;

  const left = meal.servings_remaining;
  const unavailable = meal.sold_out || !orderingOpen;

  // the server is the authority on all of this; these only stop a pointless click
  const atStockLimit = left !== null && quantity >= left;
  const atAllowance = remainingAllowance !== null && quantity >= remainingAllowance;
  const canAdd = !unavailable && !atStockLimit && !atAllowance;

  return (
    <article
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm transition-colors',
        unavailable && 'opacity-60',
      )}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
        {showImage ? (
          <img
            src={meal.image_path as string}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground/40">
            <UtensilsCrossed className="h-8 w-8" aria-hidden="true" />
          </div>
        )}
        {meal.sold_out && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70">
            <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
              Sold out
            </Badge>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-snug text-card-foreground sm:text-base">
            {meal.name}
          </h3>
          <span className="shrink-0 text-sm font-semibold text-primary">
            {formatUgx(meal.price_ugx)}
          </span>
        </div>

        {meal.category && (
          <span className="w-fit rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {meal.category}
          </span>
        )}

        {meal.description && (
          <p className="text-xs leading-relaxed text-muted-foreground sm:text-sm">
            {meal.description}
          </p>
        )}

        {!meal.sold_out && left !== null && left <= LOW_STOCK_AT && (
          <p className="text-xs font-medium text-warning-foreground dark:text-warning">
            Only {left} left
          </p>
        )}

        <div className="mt-auto pt-3">
          {quantity === 0 ? (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={!canAdd}
              onClick={() => onChange(1)}
            >
              {meal.sold_out ? 'Sold out' : !orderingOpen ? 'Ordering closed' : 'Add'}
            </Button>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                aria-label={`Remove one ${meal.name}`}
                onClick={() => onChange(quantity - 1)}
              >
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <span className="text-sm font-semibold tabular-nums" aria-live="polite">
                {quantity}
              </span>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                aria-label={`Add one ${meal.name}`}
                disabled={!canAdd}
                onClick={() => onChange(quantity + 1)}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {quantity > 0 && atAllowance && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              That is your limit for this service period.
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
