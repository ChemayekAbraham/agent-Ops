import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  RENT_DESK_ARRIVED,
  RENT_DESK_ARRIVED_TEXT,
  RENT_DESK_LABELS,
  RENT_DESK_LABEL_TEXT,
  isRentDeskFiltered,
  normalizeRentDeskFilters,
  type RentDeskArrived,
  type RentDeskFilters,
  type RentDeskLabel,
} from '@/lib/rentDeskFilters';

export interface RentDeskSortOption {
  value: string;
  label: string;
}

interface Props {
  filters: RentDeskFilters;
  onFiltersChange: (filters: RentDeskFilters) => void;
  onClear: () => void;
  /** Show a sort selector (omit where the desk already has its own sort control). */
  sort?: string;
  onSortChange?: (sort: string) => void;
  sortOptions?: RentDeskSortOption[];
  /** The server's count of matching requests, and of requests ranked (from rent_request_desk_order). */
  matchCount?: number;
  totalCount?: number;
  /** The ordering call failed: the desk shows every request and says so. */
  error?: boolean;
  className?: string;
}

/**
 * Paying-label and arrival-date filters (and, where asked, the sort) for a rent-request desk. Controlled and display-only:
 * the choices live in the URL (useRentDeskUrlState) and the database does the filtering and counting.
 */
export function RentDeskControls({
  filters,
  onFiltersChange,
  onClear,
  sort,
  onSortChange,
  sortOptions,
  matchCount,
  totalCount,
  error,
  className,
}: Props) {
  const active = isRentDeskFiltered(filters);
  const set = (patch: Partial<RentDeskFilters>) => onFiltersChange(normalizeRentDeskFilters({ ...filters, ...patch }));

  return (
    <div className={['flex flex-wrap items-center gap-2', className].filter(Boolean).join(' ')} data-testid="rent-desk-controls">
      {sortOptions && onSortChange && (
        <Select value={sort} onValueChange={onSortChange}>
          <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <ToggleGroup
        type="multiple"
        variant="outline"
        size="sm"
        aria-label="Payer label"
        value={filters.labels}
        onValueChange={(v) => set({ labels: v as RentDeskLabel[] })}
        className="flex-wrap justify-start"
      >
        {RENT_DESK_LABELS.map((l) => (
          <ToggleGroupItem key={l} value={l} aria-label={`Payer label: ${RENT_DESK_LABEL_TEXT[l]}`} className="h-8 px-2 text-[11px]">
            {RENT_DESK_LABEL_TEXT[l]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Select value={filters.arrived} onValueChange={(v) => set({ arrived: v as RentDeskArrived })}>
        <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Arrived">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RENT_DESK_ARRIVED.map((a) => (
            <SelectItem key={a} value={a} className="text-xs">{a === 'any' ? 'Arrived: any time' : RENT_DESK_ARRIVED_TEXT[a]}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {filters.arrived === 'custom' && (
        <>
          <Input
            type="date"
            aria-label="Arrived from"
            value={filters.from ?? ''}
            max={filters.to ?? undefined}
            onChange={(e) => set({ from: e.target.value || null })}
            className="h-8 w-[140px] text-xs"
          />
          <Input
            type="date"
            aria-label="Arrived to"
            value={filters.to ?? ''}
            min={filters.from ?? undefined}
            onChange={(e) => set({ to: e.target.value || null })}
            className="h-8 w-[140px] text-xs"
          />
        </>
      )}

      {active && (
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onClear}>
          Clear filters
        </Button>
      )}

      {active && error && (
        <span role="alert" className="text-[11px] text-destructive">
          Filters are unavailable right now, so every request is shown.
        </span>
      )}
      {active && !error && typeof matchCount === 'number' && typeof totalCount === 'number' && (
        <span role="status" className="text-[11px] text-muted-foreground" data-testid="rent-desk-count">
          Showing {matchCount.toLocaleString()} of {totalCount.toLocaleString()}
        </span>
      )}
    </div>
  );
}
