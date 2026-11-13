import type { ReactNode } from 'react';
import { MapPin, Wallet, X } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDynamic } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import type { FunderNewDistrictOption } from './FunderNewFilterChips';
import type { FunderNewFilters, FunderNewSort } from './types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: FunderNewFilters;
  districts: FunderNewDistrictOption[];
  supportsSort: boolean;
  hasOrigin: boolean;
  availableBalance: number | null;
  /** Operational float balance, shown on the within-balance switch. */
  floatBalance?: number | null;
  /** How many homes the current filters match right now. */
  resultCount?: number;
  /** True while that count is still being recounted. */
  resultCounting?: boolean;
  onChange: (next: Partial<FunderNewFilters>) => void;
  onSortChange: (sort: FunderNewSort) => void;
  onReset: () => void;
  /** Page-specific filters shown under the standard ones. */
  extraFilters?: ReactNode;
}

const SORTS: { value: FunderNewSort; label: string; needsOrigin?: boolean }[] = [
  { value: 'recommended', label: 'Recommended' },
  { value: 'nearest', label: 'Nearest', needsOrigin: true },
  { value: 'rent_low', label: 'Lowest amount' },
  { value: 'rent_high', label: 'Highest amount' },
  { value: 'newest', label: 'Newest' },
];

const DISTANCES: { value: 'all' | number; label: string }[] = [
  { value: 'all', label: 'Any' },
  { value: 1, label: '1 km' },
  { value: 2, label: '2 km' },
  { value: 5, label: '5 km' },
  { value: 10, label: '10 km' },
  { value: 25, label: '25 km' },
  { value: 50, label: '50 km' },
];

const parseAmount = (raw: string): number | null => {
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits.length) return null;
  const value = Number(digits);
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** One titled block of the drawer. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** A tap-to-pick pill (single choice within its row). */
function Pill({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick}
      className={cn('min-h-[36px] shrink-0 rounded-full px-3.5 text-sm font-medium transition-colors disabled:opacity-40',
        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-muted/70')}>
      {children}
    </button>
  );
}

/**
 * Funder filters, sliding up from the bottom like an app's filter sheet: tap-to-pick pills for
 * sort and distance, a min–max amount pair, a district picker, a "within my balance" switch,
 * and one "Show N homes" button that stays on screen.
 */
export function FunderNewFilterDrawer({
  open,
  onOpenChange,
  filters,
  districts,
  supportsSort,
  hasOrigin,
  availableBalance,
  floatBalance = null,
  resultCount,
  resultCounting,
  onChange,
  onSortChange,
  onReset,
  extraFilters,
}: Props) {
  const districtTotal = districts.reduce((sum, item) => sum + item.count, 0);
  const showLabel = typeof resultCount === 'number'
    ? resultCounting ? 'Counting…' : `Show ${resultCount.toLocaleString()} ${resultCount === 1 ? 'home' : 'homes'}`
    : 'Show homes';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex max-h-[88vh] flex-col gap-0 rounded-t-[28px] border-t p-0 data-[state=closed]:duration-200 data-[state=open]:duration-300 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom data-[state=open]:ease-out [&>button]:hidden"
      >
        {/* Header: title, Reset, close. The match count lives on the bottom button. */}
        <SheetHeader className="flex-row items-center gap-2 space-y-0 border-b border-border/60 px-4 pb-3 pt-4 text-left">
          <SheetTitle className="flex-1 text-lg">Filters</SheetTitle>
          <SheetDescription className="sr-only">Narrow the homes shown in the list and on the map.</SheetDescription>
          <Button variant="ghost" size="sm" className="h-9 rounded-full px-3 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onReset}>
            Reset
          </Button>
          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full" aria-label="Close filters" onClick={() => onOpenChange(false)}>
            <X className="h-5 w-5" />
          </Button>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
          {supportsSort ? (
            <Section title="Sort by">
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" role="group" aria-label="Sort">
                {SORTS.map((s) => (
                  <Pill key={s.value} active={filters.sort === s.value} disabled={s.needsOrigin && !hasOrigin} onClick={() => onSortChange(s.value)}>
                    {s.label}
                  </Pill>
                ))}
              </div>
              {!hasOrigin ? <p className="text-xs text-muted-foreground">Nearest needs your location.</p> : null}
            </Section>
          ) : null}

          {supportsSort ? (
            <Section title="Distance">
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" role="group" aria-label="Distance">
                {DISTANCES.map((d) => (
                  <Pill key={String(d.value)} active={filters.radiusKm === d.value} onClick={() => onChange({ radiusKm: d.value })}>
                    {d.label}
                  </Pill>
                ))}
              </div>
            </Section>
          ) : null}

          <Section title="Amount (UGX)">
            <div className="flex items-center gap-2">
              <Input value={filters.rentMin === null ? '' : filters.rentMin.toLocaleString('en')} onChange={(e) => onChange({ rentMin: parseAmount(e.target.value) })}
                inputMode="numeric" placeholder="Min" aria-label="Minimum amount" className="h-12 rounded-2xl text-base" />
              <span className="text-muted-foreground" aria-hidden>–</span>
              <Input value={filters.rentMax === null ? '' : filters.rentMax.toLocaleString('en')} onChange={(e) => onChange({ rentMax: parseAmount(e.target.value) })}
                inputMode="numeric" placeholder="Max" aria-label="Maximum amount" className="h-12 rounded-2xl text-base" />
            </div>
          </Section>

          {districts.length > 0 ? (
            <Section title="District">
              <Select value={filters.location.trim() === '' ? 'all' : filters.location} onValueChange={(value) => onChange({ location: value === 'all' ? '' : value })}>
                <SelectTrigger className="h-12 rounded-2xl" aria-label="District">
                  <MapPin className="mr-2 h-4 w-4 flex-none text-red-600" aria-hidden />
                  <SelectValue placeholder="All districts" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="all">All districts ({districtTotal.toLocaleString('en')})</SelectItem>
                  {districts.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label} ({item.count.toLocaleString('en')})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Section>
          ) : null}

          {/* A switch row, like a phone's settings list. */}
          <button type="button" role="switch" aria-checked={filters.withinFloat} disabled={availableBalance === null}
            onClick={() => onChange({ withinFloat: !filters.withinFloat })}
            className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl bg-muted/50 px-4 text-left disabled:opacity-50">
            <Wallet className="h-5 w-5 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Within my balance</span>
              <span className="block text-xs text-muted-foreground">{floatBalance === null ? 'Checking your float…' : `Homes up to ${formatDynamic(floatBalance)}`}</span>
            </span>
            <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', filters.withinFloat ? 'bg-primary' : 'bg-muted-foreground/30')} aria-hidden>
              <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-background shadow transition-all', filters.withinFloat ? 'left-[22px]' : 'left-0.5')} />
            </span>
          </button>

          {extraFilters}
        </div>

        {/* The one action, always on screen. */}
        <div className="border-t border-border/60 bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button className="h-12 w-full rounded-2xl text-base" onClick={() => onOpenChange(false)}>{showLabel}</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default FunderNewFilterDrawer;
