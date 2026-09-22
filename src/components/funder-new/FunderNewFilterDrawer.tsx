import { ListFilter } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { FunderNewFilterChips, type FunderNewDistrictOption } from './FunderNewFilterChips';
import type { FunderNewFilters, FunderNewSort } from './types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: FunderNewFilters;
  districts: FunderNewDistrictOption[];
  supportsSort: boolean;
  hasOrigin: boolean;
  availableBalance: number | null;
  onChange: (next: Partial<FunderNewFilters>) => void;
  onSortChange: (sort: FunderNewSort) => void;
  onReset: () => void;
}

/** Route-local filter drawer for /dashboard/funder-new, sliding up from the bottom. */
export function FunderNewFilterDrawer({
  open,
  onOpenChange,
  filters,
  districts,
  supportsSort,
  hasOrigin,
  availableBalance,
  onChange,
  onSortChange,
  onReset,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85vh] overflow-y-auto rounded-t-2xl border-t data-[state=closed]:duration-200 data-[state=open]:duration-300 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom data-[state=open]:ease-out"
      >
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ListFilter className="h-4 w-4 text-primary" aria-hidden />
            Filters
          </SheetTitle>
          <SheetDescription>Narrow the homes shown in the list and on the map.</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <FunderNewFilterChips
            stacked
            filters={filters}
            districts={districts}
            supportsSort={supportsSort}
            hasOrigin={hasOrigin}
            availableBalance={availableBalance}
            onChange={onChange}
            onSortChange={onSortChange}
            onReset={onReset}
          />

          <div className="flex gap-2 pb-2">
            <Button variant="outline" className="flex-1 rounded-xl" onClick={onReset}>
              Reset
            </Button>
            <Button className="flex-1 rounded-xl" onClick={() => onOpenChange(false)}>
              Show homes
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default FunderNewFilterDrawer;
