import { Bookmark, CheckCircle2, Home, MapPin, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDynamic } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewReadyPlan } from './types';
import {
  emptyHousePlace,
  emptyHouseTitle,
  firstPhoto,
  itemAmount,
  itemMonthlyReturn,
  readyPlanPlace,
  readyPlanTitle,
} from './utils';

export function FunderNewHouseCard({
  category,
  item,
  saved,
  selected,
  onSave,
  onSelect,
  onDetail,
  highlighted = false,
}: {
  category: FunderNewCategory;
  item: FunderNewEmptyHouse | FunderNewReadyPlan;
  saved: boolean;
  selected: boolean;
  onSave: () => void;
  onSelect: () => void;
  onDetail: () => void;
  highlighted?: boolean;
}) {
  const isEmpty = category === 'empty';
  const title = isEmpty ? emptyHouseTitle(item as FunderNewEmptyHouse) : readyPlanTitle(item as FunderNewReadyPlan);
  const place = isEmpty ? emptyHousePlace(item as FunderNewEmptyHouse) : readyPlanPlace(item as FunderNewReadyPlan);
  const amount = itemAmount(category, item);
  const monthlyReturn = itemMonthlyReturn(category, item);
  const photo = firstPhoto(category, item);
  const verified = isEmpty ? (item as FunderNewEmptyHouse).verified === true : false;

  return (
    <article
      className={cn(
        'group flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg',
        selected && 'border-primary ring-2 ring-primary/30',
        highlighted && !selected && 'border-primary/50 ring-1 ring-primary/20',
      )}
    >
      <div className="relative">
        <button
          type="button"
          onClick={onDetail}
          aria-label={`View ${title}`}
          className="block w-full overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {photo ? (
            <img
              src={photo}
              alt={title}
              loading="lazy"
              className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="flex aspect-[4/3] w-full items-center justify-center bg-primary/5">
              <Home className="h-9 w-9 text-primary/50" />
            </div>
          )}
        </button>

        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-2">
          <Badge className="pointer-events-auto rounded-full bg-primary text-primary-foreground shadow-sm">
            {isEmpty ? 'Empty house' : 'Tenant ready'}
          </Badge>
          {verified ? (
            <Badge variant="success" className="pointer-events-auto rounded-full shadow-sm">
              <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Verified
            </Badge>
          ) : null}
        </div>

        <Button
          type="button"
          size="icon"
          variant="secondary"
          onClick={onSave}
          aria-label={saved ? `Remove ${title} from saved` : `Save ${title}`}
          aria-pressed={saved}
          className="absolute right-3 top-3 h-10 w-10 rounded-full shadow-sm"
        >
          <Bookmark className={cn('h-4 w-4', saved && 'fill-current text-primary')} />
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-4 p-4 sm:p-5">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-base font-semibold leading-snug">{title}</h3>
          <p className="mt-1.5 flex items-start gap-1.5 text-sm text-muted-foreground">
            <MapPin className="mt-0.5 h-4 w-4 flex-none" />
            <span className="line-clamp-1">{place}</span>
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-primary/5 p-3">
            <p className="text-xs font-medium text-muted-foreground">Amount to fund</p>
            <p className="mt-1 break-words text-base font-semibold">{formatDynamic(amount)}</p>
          </div>
          <div className="rounded-xl bg-primary/5 p-3">
            <p className="text-xs font-medium text-muted-foreground">Monthly return</p>
            <p className="mt-1 break-words text-base font-semibold">
              {monthlyReturn ? formatDynamic(monthlyReturn) : 'On file'}
            </p>
          </div>
        </div>

        <div className="mt-auto grid grid-cols-2 gap-2 border-t pt-4">
          <Button variant="outline" className="h-11 rounded-xl" onClick={onDetail}>
            View house
          </Button>
          <Button
            variant={selected ? 'default' : 'soft'}
            className="h-11 rounded-xl"
            onClick={onSelect}
            aria-pressed={selected}
          >
            <CheckCircle2 className="h-4 w-4" />
            {selected ? 'Selected' : 'Select'}
          </Button>
        </div>
      </div>
    </article>
  );
}

export default FunderNewHouseCard;
