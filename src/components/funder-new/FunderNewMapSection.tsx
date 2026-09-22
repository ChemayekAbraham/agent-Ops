import { Suspense, lazy } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDynamic, formatDynamicCompact } from '@/lib/currencyFormat';
import type { SupportableHouse } from '@/components/partner/SelfSupportHousesSection';
import type { FunderNewEmptyHouse, FunderNewFilters, FunderNewMarketSummary } from './types';
import { amountRange } from './utils';

const LazyEmptyHouseMapBrowser = lazy(() =>
  import('@/components/partner/EmptyHouseMapBrowser').then((module) => ({ default: module.EmptyHouseMapBrowser })),
);

function MapFallback() {
  return <Skeleton className="h-full w-full rounded-2xl" />;
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-full border border-primary/20 bg-card/90 px-3 py-1.5 shadow-sm backdrop-blur">
      <span className="text-xs text-muted-foreground">{label} </span>
      <span className="text-xs font-semibold">{value}</span>
    </div>
  );
}

/**
 * Premium map section for /dashboard/funder-new.
 * Never requests browser location on mount — location is opt-in via the control.
 */
export function FunderNewMapSection({
  houses,
  filters,
  summary,
  selectedIds,
  availableBalance,
  onSearchChange,
  onOpenHouse,
  onHousesDiscovered,
}: {
  houses: FunderNewEmptyHouse[];
  filters: FunderNewFilters;
  summary: FunderNewMarketSummary | undefined;
  selectedIds: string[];
  availableBalance: number;
  onSearchChange: (value: string) => void;
  onOpenHouse: (house: FunderNewEmptyHouse) => void;
  onHousesDiscovered: (houses: FunderNewEmptyHouse[]) => void;
}) {
  const range = amountRange(filters.amount);

  return (
    <section id="funder-new-map" className="scroll-mt-24 space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">Explore opportunities by location</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            See where support opportunities are concentrated and discover homes by area.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {summary ? <Chip label="Houses" value={summary.houseCount.toLocaleString()} /> : null}
          {summary ? <Chip label="Rent needed" value={formatDynamicCompact(summary.totalRentNeeded)} /> : null}
          {summary?.houseCount ? <Chip label="Avg / house" value={formatDynamic(Math.round(summary.avgMonthlyRent))} /> : null}
          {selectedIds.length > 0 ? <Chip label="Selected" value={`${selectedIds.length}`} /> : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border bg-card p-2 shadow-sm sm:p-3">
        <Suspense fallback={<MapFallback />}>
          <LazyEmptyHouseMapBrowser
            houses={houses as SupportableHouse[]}
            selectedIds={selectedIds}
            searchQuery={filters.search}
            remaining={availableBalance}
            busy={false}
            minRent={range.min}
            maxRent={range.max}
            district={filters.location.trim() || null}
            onSearchQueryChange={onSearchChange}
            onOpenHouse={(house) => onOpenHouse(house as FunderNewEmptyHouse)}
            onFundHouse={() => undefined}
            onHousesDiscovered={(discovered) => onHousesDiscovered(discovered as FunderNewEmptyHouse[])}
            requestLocationOnMount={false}
          />
        </Suspense>
      </div>
    </section>
  );
}

export default FunderNewMapSection;
