import { useQueryClient } from '@tanstack/react-query';
import { coarsenMapCells } from './coarsenMapCells';
import {
  FunderNewLocationNotice,
  locationNoticeState,
  readLocationNoticeDismissed,
  writeLocationNoticeDismissed,
} from './FunderNewLocationNotice';
import { Suspense, useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Crosshair, Loader2, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useEmptyHouseMapCells, type MapViewport } from '@/hooks/useEmptyHouseMapCells';
import type { FunderNewEmptyHouse, FunderNewFilters, FunderNewOrigin } from './types';
import { FunderNewRouteMap, type FunderNewMapCell, type FunderNewViewport } from './FunderNewRouteMap';
import type { FunderNewLocationController } from './useFunderNewLocation';
import { amountRange } from './utils';

/** Reserved box so loading the map never shifts the page. */
const MAP_BOX = 'h-[330px] sm:h-[440px] lg:h-[520px]';




/**
 * Location-aware map for /dashboard/funder-new.
 *
 * Route-local Google Maps composition. The shared EmptyHouseMapBrowser used by
 * /dashboard/funder is intentionally untouched.
 */
export function FunderNewMapSection({
  filters,
  location,
  origin,
  selectedIds,
  savedIds,
  activeId,
  heading: customHeading,
  headingClassName,
  onOpenHouse,
  onApplyArea,
  onAreaSearchChange,
  onExpandedChange,
  expandRequest,
  reserveTopForSearch,
  focus,
}: {
  filters: FunderNewFilters;
  location: FunderNewLocationController;
  origin: FunderNewOrigin | null;
  selectedIds: string[];
  savedIds: string[];
  activeId: string | null;
  heading?: string;
  headingClassName?: string;
  onOpenHouse: (house: FunderNewEmptyHouse) => void;
  onApplyArea: (viewport: FunderNewViewport) => void;
  onAreaSearchChange: (value: string) => void;
  onExpandedChange?: (expanded: boolean) => void;
  expandRequest?: number;
  reserveTopForSearch?: boolean;
  focus?: { points: { lat: number; lng: number }[]; token: number } | null;
}) {
  const [viewport, setViewport] = useState<FunderNewViewport | null>(null);

  const device = location.coords;

  // Every home in the visible area, aggregated by the database and streamed in
  // per tile — the same read path the established funding map uses, so the map
  // is never limited to one page of listings.
  const cellViewport = useMemo<MapViewport | null>(
    () =>
      viewport
        ? {
            minLat: viewport.minLat,
            minLng: viewport.minLng,
            maxLat: viewport.maxLat,
            maxLng: viewport.maxLng,
            zoom: viewport.zoom,
          }
        : null,
    [viewport],
  );

  const range = amountRange(filters.amount);
  // The person's position (when known) also drives a small, fast request for the
  // houses right around them, so the closest ones show up first.
  const nearPoint = useMemo(() => (device ? { lat: device.lat, lng: device.lng } : null), [device?.lat, device?.lng]);
  const cellQuery = useEmptyHouseMapCells(
    cellViewport,
    {
      search: filters.search.trim() || undefined,
      district: filters.location.trim() || undefined,
      minRent: range.min,
      maxRent: range.max,
    },
    true,
    nearPoint,
  );

  const cells = useMemo<FunderNewMapCell[]>(() => {
    const raw = (cellQuery.data?.cells ?? []).map((cell) => ({
      key: cell.key,
      count: cell.count,
      lat: cell.latitude,
      lng: cell.longitude,
      amount: cell.minRent,
      house: (cell.house as unknown as FunderNewEmptyHouse | null) ?? null,
    }));
    // Fewer, clearer pins at city zoom; street level keeps every house.
    return viewport ? coarsenMapCells(raw, viewport.zoom) : raw;
  }, [cellQuery.data, viewport]);

  const housesInView = cellQuery.data?.housesInView ?? 0;

  const awaitingDeviceFix = location.permission === 'granted' && !device && location.status !== 'error';

  // First-time people get a short reason to allow location before the browser's
  // own prompt (which only opens from their tap). "Not now" lasts this visit.
  const [noticeDismissed, setNoticeDismissed] = useState(readLocationNoticeDismissed);
  const dismissNotice = useCallback(() => {
    writeLocationNoticeDismissed();
    setNoticeDismissed(true);
  }, []);
  const noticeState = locationNoticeState(location, noticeDismissed);
  // The button stays on the map even when location is blocked. A blocked browser cannot be asked again, so
  // tapping it brings back the note that says where to turn location on.
  const handleUseMyLocation = useCallback(() => {
    if (location.permission === 'denied') {
      setNoticeDismissed(false);
      return;
    }
    if (device) location.refresh();
    else location.request();
  }, [device, location]);

  const heading = device ? 'Homes near you' : origin?.source === 'area' ? 'Homes in this area' : 'Explore homes by area';

  const loadedNote = useMemo(() => {
    if (awaitingDeviceFix && !cellQuery.data) return 'Finding your location\u2026';
    if (!cellQuery.data && cellQuery.isFetching) return 'Loading homes in this view\u2026';
    if (cellQuery.isError) return 'Homes could not be loaded on the map.';
    if (housesInView === 0) return 'No mapped homes in this view.';
    const suffix = cellQuery.isFetching ? ' Still loading more\u2026' : ' Prices in UGX.';
    return `Showing ${housesInView.toLocaleString()} mapped ${housesInView === 1 ? 'home' : 'homes'} in this view.${suffix}`;
  }, [awaitingDeviceFix, cellQuery.data, cellQuery.isFetching, cellQuery.isError, housesInView]);

  // Reset refreshes the map in place: the map recentres itself (see the route map)
  // and every cached pin read is marked stale so the view reloads fresh. It must
  // not remount the map: a remount starts out not full screen, which the page
  // would read as the person closing it.
  const queryClient = useQueryClient();
  const handleReset = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['empty-house-map-cells'] });
    void queryClient.invalidateQueries({ queryKey: ['empty-house-map-cells-near'] });
  }, [queryClient]);

  return (
    <section id="funder-new-map" className="scroll-mt-24 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={headingClassName ?? "text-lg font-semibold tracking-tight sm:text-xl"}>
          {customHeading ?? heading}
        </h2>

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
          <p className="text-xs text-muted-foreground">Location is off — search an area instead</p>
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

      <div
        className={`relative z-0 overflow-hidden rounded-2xl border bg-card shadow-sm ${MAP_BOX}`}
      >

        <FunderNewRouteMap
          cells={cells}
          selectedIds={selectedIds}
          savedIds={savedIds}
          activeId={activeId}
          device={device}
          awaitingDeviceFix={awaitingDeviceFix}
          locating={location.status === 'locating'}
          canUseLocation={location.permission !== 'unsupported'}
          areaSearchValue={filters.search}
          onAreaSearchChange={onAreaSearchChange}
          onOpenHouse={onOpenHouse}
          onViewportChange={setViewport}
          onSearchThisArea={onApplyArea}
          onUseMyLocation={handleUseMyLocation}
          onReset={handleReset}
          loadedNote={loadedNote}
          onExpandedChange={onExpandedChange}
          expandRequest={expandRequest}
          reserveTopForSearch={reserveTopForSearch}
          focus={focus}
          notice={
            noticeState ? (
              <FunderNewLocationNotice
                state={noticeState}
                locating={location.status === 'locating'}
                onAllow={location.request}
                onDismiss={dismissNotice}
              />
            ) : null
          }
        />
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
