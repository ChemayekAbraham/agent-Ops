import { Suspense, lazy, useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Crosshair, Loader2, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { FunderNewEmptyHouse, FunderNewFilters, FunderNewOrigin } from './types';
import type { FunderNewViewport } from './FunderNewRouteMap';
import type { FunderNewLocationController } from './useFunderNewLocation';
import { FUNDER_NEW_MAP_LIMIT, useFunderNewMapHouses } from './useFunderNewOpportunities';

const LazyRouteMap = lazy(() => import('./FunderNewRouteMap').then((module) => ({ default: module.FunderNewRouteMap })));

/** Reserved box so lazy loading the map never shifts the page. */
const MAP_BOX = 'h-[300px] sm:h-[440px] lg:h-[520px]';

/**
 * Location-aware map for /dashboard/funder-new.
 *
 * Route-local composition built on the project's existing Leaflet stack. The
 * shared EmptyHouseMapBrowser is intentionally untouched.
 */
export function FunderNewMapSection({
  filters,
  location,
  origin,
  selectedIds,
  savedIds,
  activeId,
  onOpenHouse,
  onApplyArea,
  onAreaSearchChange,
}: {
  filters: FunderNewFilters;
  location: FunderNewLocationController;
  origin: FunderNewOrigin | null;
  selectedIds: string[];
  savedIds: string[];
  activeId: string | null;
  onOpenHouse: (house: FunderNewEmptyHouse) => void;
  onApplyArea: (viewport: FunderNewViewport) => void;
  onAreaSearchChange: (value: string) => void;
}) {
  const [viewport, setViewport] = useState<FunderNewViewport | null>(null);
  const [resetToken, setResetToken] = useState(0);

  const device = location.coords;
  // The map reads the area it is showing, which is not the same thing as the
  // user's origin used for distance labels.
  const mapCentre = useMemo(() => {
    if (viewport) return { lat: viewport.lat, lng: viewport.lng };
    if (device) return { lat: device.lat, lng: device.lng };
    return null;
  }, [viewport, device]);

  const mapQuery = useFunderNewMapHouses(filters, mapCentre, viewport?.radiusKm ?? null, true);
  const houses = mapQuery.data?.items ?? [];
  const total = mapQuery.data?.total ?? 0;

  const awaitingDeviceFix = location.permission === 'granted' && !device && location.status !== 'error';

  const heading = device ? 'Homes near you' : origin?.source === 'area' ? 'Homes in this area' : 'Explore homes by area';

  const loadedNote = useMemo(() => {
    if (mapQuery.isLoading) return 'Loading homes in this view\u2026';
    if (mapQuery.error) return 'Homes could not be loaded on the map.';
    if (houses.length === 0) return 'No mapped homes in this view.';
    if (total > houses.length) {
      return `Showing ${houses.length} of ${total.toLocaleString()} mapped homes in this view (up to ${FUNDER_NEW_MAP_LIMIT}).`;
    }
    return `Showing ${houses.length} mapped ${houses.length === 1 ? 'home' : 'homes'} in this view. Prices in UGX.`;
  }, [mapQuery.isLoading, mapQuery.error, houses.length, total]);

  const handleReset = useCallback(() => {
    setViewport(null);
    setResetToken((value) => value + 1);
  }, []);

  return (
    <section id="funder-new-map" className="scroll-mt-24 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight sm:text-xl">{heading}</h2>

        {location.autoLocating ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Finding your location
          </p>
        ) : !device && (location.permission === 'prompt' || location.permission === 'unknown') ? (
          <Button variant="soft" size="sm" className="h-10 rounded-full" onClick={location.request}>
            <Crosshair className="h-4 w-4" aria-hidden />
            Use my location
          </Button>
        ) : !device && location.permission === 'denied' ? (
          <p className="text-xs text-muted-foreground">Location is off \u2014 search an area instead</p>
        ) : null}
      </div>

      {location.error ? (
        <p className="flex items-start gap-2 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden />
          <span className="min-w-0 flex-1">{location.error}</span>
          {location.permission !== 'denied' ? (
            <button type="button" onClick={location.refresh} className="font-semibold text-primary underline">
              Retry
            </button>
          ) : null}
        </p>
      ) : null}

      <div className={`overflow-hidden rounded-2xl border bg-card shadow-sm ${MAP_BOX}`}>
        <Suspense fallback={<Skeleton className="h-full w-full rounded-2xl" />}>
          <LazyRouteMap
            key={resetToken}
            houses={houses}
            selectedIds={selectedIds}
            savedIds={savedIds}
            activeId={activeId}
            device={device}
            awaitingDeviceFix={awaitingDeviceFix}
            locating={location.status === 'locating'}
            canUseLocation={location.permission !== 'unsupported' && location.permission !== 'denied'}
            areaSearchValue={filters.search}
            onAreaSearchChange={onAreaSearchChange}
            onOpenHouse={onOpenHouse}
            onViewportChange={setViewport}
            onSearchThisArea={onApplyArea}
            onUseMyLocation={device ? location.refresh : location.request}
            onReset={handleReset}
            loadedNote={loadedNote}
          />
        </Suspense>
      </div>

      {!device && origin?.source === 'area' ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapPin className="h-3.5 w-3.5 flex-none" aria-hidden />
          Showing the area you picked, not your actual location.
        </p>
      ) : null}
    </section>
  );
}

export default FunderNewMapSection;
