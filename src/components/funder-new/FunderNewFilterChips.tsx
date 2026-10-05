import type { ReactNode } from 'react';
import { ArrowUpDown, MapPin, Wallet } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { formatDynamic } from '@/lib/currencyFormat';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { FunderNewFilters, FunderNewSort } from './types';

const CHIP =
  'min-h-8 w-auto min-w-0 flex-none rounded-md border-border bg-background px-3 py-4 text-[11px] font-semibold shadow-none';
const CHIP_STACKED =
  'min-h-10 w-full min-w-0 rounded-md border-border bg-background px-3 py-4 text-xs font-semibold shadow-none';


export interface FunderNewDistrictOption {
  value: string;
  label: string;
  count: number;
}

interface Props {
  filters: FunderNewFilters;
  /** Districts present in the homes currently loaded. */
  districts: FunderNewDistrictOption[];
  /** True when the empty-homes tab is active (sort + distance are supported there). */
  supportsSort: boolean;
  /** True when an origin exists, so a radius can actually be applied. */
  hasOrigin: boolean;
  /** Available balance, needed for the within-balance chip. */
  availableBalance: number | null;
  /** Operational float balance, always shown on the within-balance chip. */
  floatBalance?: number | null;
  /** Stack the controls (used inside the filter drawer) instead of one scrolling row. */
  stacked?: boolean;
  onChange: (next: Partial<FunderNewFilters>) => void;
  onSortChange: (sort: FunderNewSort) => void;
}


const parseAmount = (raw: string): number | null => {
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits.length) return null;
  const value = Number(digits);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export function FunderNewFilterChips({
  filters,
  districts,
  supportsSort,
  hasOrigin,
  availableBalance,
  floatBalance = null,
  stacked = false,
  onChange,
  onSortChange,
}: Props) {
  const districtTotal = districts.reduce((sum, item) => sum + item.count, 0);
  const dirty =
    filters.location.trim() !== '' ||
    filters.rentMin !== null ||
    filters.rentMax !== null ||
    filters.radiusKm !== 'all' ||
    filters.withinFloat;

  return (
    <div
      className={
        stacked
          ? 'flex flex-wrap items-center gap-2'
          : 'flex items-center gap-2 overflow-x-auto px-1 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
      }
      aria-label="Filter homes"
    >

      {supportsSort ? (
        <Select value={filters.sort} onValueChange={(value) => onSortChange(value as FunderNewSort)}>
          <SelectTrigger className={CHIP} aria-label="Sort">
            <ArrowUpDown className="mr-1 h-3 w-3 flex-none" aria-hidden />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="nearest" disabled={!hasOrigin}>
              Nearest first
            </SelectItem>
            <SelectItem value="rent_low">Lowest amount</SelectItem>
            <SelectItem value="rent_high">Highest amount</SelectItem>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="recommended">Recommended</SelectItem>
          </SelectContent>
        </Select>
      ) : null}

      {districts.length > 0 ? (
        <Select
          value={filters.location.trim() === '' ? 'all' : filters.location}
          onValueChange={(value) => onChange({ location: value === 'all' ? '' : value })}
        >
          <SelectTrigger className={CHIP} aria-label="District">
            <MapPin className="mr-1 h-3 w-3 flex-none" aria-hidden />
            <SelectValue placeholder="All districts" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="all">All districts ({districtTotal})</SelectItem>
            {districts.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label} ({item.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {supportsSort ? (
        <Select
          value={filters.radiusKm === 'all' ? 'all' : String(filters.radiusKm)}
          onValueChange={(value) => onChange({ radiusKm: value === 'all' ? 'all' : Number(value) })}
        >
          <SelectTrigger className={CHIP} aria-label="Distance">
            <SelectValue placeholder="Any distance" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any distance</SelectItem>
            <SelectItem value="1">Within 1 km</SelectItem>
            <SelectItem value="2">Within 2 km</SelectItem>
            <SelectItem value="5">Within 5 km</SelectItem>
            <SelectItem value="10">Within 10 km</SelectItem>
            <SelectItem value="25">Within 25 km</SelectItem>
            <SelectItem value="50">Within 50 km</SelectItem>
          </SelectContent>
        </Select>
      ) : null}

      {field('Min amount',
        <Input
          value={filters.rentMin === null ? '' : String(filters.rentMin)}
          onChange={(event) => onChange({ rentMin: parseAmount(event.target.value) })}
          inputMode="numeric"
          placeholder="Min amount"
          aria-label="Minimum amount"
          className={
            stacked
              ? 'min-h-10 w-full rounded-md py-4 text-xs font-semibold'
              : 'min-h-8 w-[7.5rem] flex-none rounded-md py-4 text-[11px] font-semibold'
          }
        />
      )}
      {field('Max amount',
        <Input
          value={filters.rentMax === null ? '' : String(filters.rentMax)}
          onChange={(event) => onChange({ rentMax: parseAmount(event.target.value) })}
          inputMode="numeric"
          placeholder="Max amount"
          aria-label="Maximum amount"
          className={
            stacked
              ? 'min-h-10 w-full rounded-md py-4 text-xs font-semibold'
              : 'min-h-8 w-[7.5rem] flex-none rounded-md py-4 text-[11px] font-semibold'
          }
        />
      )}


      <div className={stacked ? 'sm:col-span-2 flex flex-wrap items-center gap-2 pt-1' : 'contents'}>
        <button
          type="button"
          onClick={onReset}
          className="h-8 flex-none rounded-full border border-destructive/30 bg-destructive/5 px-3 text-[11px] font-semibold text-destructive transition-colors hover:bg-destructive/10"
        >
          <Wallet className="mr-1 inline h-3 w-3" aria-hidden />
          Within my balance
          <span className={filters.withinFloat ? 'text-primary-foreground/90' : 'text-muted-foreground'}>
            {' '}· {floatBalance === null ? '…' : formatDynamic(floatBalance)}
          </span>
        </button>
      </div>
    </div>
  );
}

export default FunderNewFilterChips;
