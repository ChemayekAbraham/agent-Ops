import { Suspense, lazy, useState } from 'react';
import { Expand, Loader2, MapPin, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDynamic, formatDynamicCompact } from '@/lib/currencyFormat';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewMarketSummary, FunderNewReadyPlan } from './types';

const LazyFunderNewMap = lazy(() => import('./FunderNewMap'));

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
  category,
  items,
  summary,
  selectedCount,
  onOpenDetail,
  userPoint,
  locationStatus,
  onRequestLocation,
}: {
  category: FunderNewCategory;
  items: Array<FunderNewEmptyHouse | FunderNewReadyPlan>;
  summary: FunderNewMarketSummary | undefined;
  selectedCount: number;
  onOpenDetail: (id: string) => void;
  userPoint: { lat: number; lng: number } | null;
  locationStatus: 'idle' | 'loading' | 'denied' | 'unsupported';
  onRequestLocation: () => void;
}) {
  const [viewKey, setViewKey] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const map = (
    <Suspense fallback={<MapFallback />}>
      <LazyFunderNewMap
        key={viewKey}
        category={category}
        items={items}
        onOpenDetail={onOpenDetail}
        userPoint={userPoint}
      />
    </Suspense>
  );

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
          <Button variant="outline" className="h-11 rounded-full" onClick={() => setExpanded(true)}>
            <Expand className="h-4 w-4" />
            Expand map
          </Button>
          <Button
            variant="soft"
            className="h-11 rounded-full"
            onClick={onRequestLocation}
            disabled={locationStatus === 'loading'}
          >
            {locationStatus === 'loading' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <MapPin className="h-4 w-4" />
            )}
            Use my location
          </Button>
          <Button variant="ghost" className="h-11 rounded-full" onClick={() => setViewKey((key) => key + 1)}>
            <RotateCcw className="h-4 w-4" />
            Reset view
          </Button>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-3xl border bg-card p-2 shadow-sm sm:p-3">
        <div className="h-[280px] overflow-hidden rounded-2xl sm:h-[360px] lg:h-[460px]">{map}</div>

        <div className="pointer-events-none absolute inset-x-4 top-5 flex flex-wrap gap-2 sm:inset-x-6">
          {summary ? (
            <>
              <Chip label="Houses" value={summary.houseCount.toLocaleString()} />
              <Chip label="Rent needed" value={formatDynamicCompact(summary.totalRentNeeded)} />
              {summary.houseCount > 0 ? (
                <Chip label="Avg / house" value={formatDynamic(Math.round(summary.avgMonthlyRent))} />
              ) : null}
            </>
          ) : null}
          {selectedCount > 0 ? <Chip label="Selected" value={`${selectedCount}`} /> : null}
        </div>
      </div>

      {locationStatus === 'denied' || locationStatus === 'unsupported' ? (
        <p className="rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
          Location is not available, and that is fine — keep using the filters and house cards. The map still shows homes
          that already have saved coordinates.
        </p>
      ) : null}

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="h-[92vh] max-w-[96vw] rounded-2xl p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>Explore opportunities by location</DialogTitle>
          </DialogHeader>
          <div className="h-[calc(92vh-7rem)] overflow-hidden rounded-2xl border">{expanded ? map : null}</div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default FunderNewMapSection;
