import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Crosshair, Loader2, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useEmptyHouseMapCells, type MapViewport } from '@/hooks/useEmptyHouseMapCells';
import type { FunderNewEmptyHouse, FunderNewFilters, FunderNewOrigin } from './types';
import type { FunderNewMapCell, FunderNewViewport } from './FunderNewRouteMap';
import type { FunderNewLocationController } from './useFunderNewLocation';
import { amountRange } from './utils';

const LazyRouteMap = lazy(() => import('./FunderNewRouteMap').then((module) => ({ default: module.FunderNewRouteMap })));

/** Reserved box so lazy loading the map never shifts the page. */
const MAP_BOX = 'h-[330px] sm:h-[440px] lg:h-[520px]';

/**
 * Scroll-driven widening: the map grows out of the page gutters until it spans
 * the full device width, then stays there. Progress only ever increases, so the
 * map never narrows again once it has filled the screen.
 */
function useScrollWidening(ref: React.RefObject<HTMLDivElement>) {
  const [bleed, setBleed] = useState(0);
  const progressRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      progressRef.current = 1;
      setBleed(0);
    }

    let frame = 0;

    const measure = () => {
      frame = 0;
      const node = ref.current;
      if (!node) return;
      // Only widen once the user has actually scrolled — otherwise the map
      // bleeds out of the page gutters on first paint and looks broken next to
      // the still-inset cards.
      if (window.scrollY <= 0) return;
      const rect = node.getBoundingClientRect();
      const viewportH = window.innerHeight || 1;
      // Starts once the map's top crosses the middle of the screen, completes
      // by the time it has travelled up to roughly a sixth of the screen height.
      const start = viewportH * 0.55;
      const end = viewportH * 0.15;
      const raw = (start - rect.top) / Math.max(1, start - end);
      const next = Math.min(1, Math.max(progressRef.current, raw));
      if (next === progressRef.current) return;
      progressRef.current = next;

      const parentWidth = node.parentElement?.clientWidth ?? rect.width;
      const full = document.documentElement.clientWidth || window.innerWidth;
      const gutter = Math.max(0, (full - parentWidth) / 2);
      setBleed(Number((gutter * next).toFixed(2)));
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [ref]);

  return bleed;
}


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
  const mapBoxRef = useRef<HTMLDivElement>(null);
  const bleed = useScrollWidening(mapBoxRef);


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
  const cellQuery = useEmptyHouseMapCells(cellViewport, {
    search: filters.search.trim() || undefined,
    district: filters.location.trim() || undefined,
    minRent: range.min,
    maxRent: range.max,
  });

  const cells = useMemo<FunderNewMapCell[]>(
    () =>
      (cellQuery.data?.cells ?? []).map((cell) => ({
        key: cell.key,
        count: cell.count,
        lat: cell.latitude,
        lng: cell.longitude,
        amount: cell.minRent,
        house: (cell.house as unknown as FunderNewEmptyHouse | null) ?? null,
      })),
    [cellQuery.data],
  );

  const housesInView = cellQuery.data?.housesInView ?? 0;

  const awaitingDeviceFix = location.permission === 'granted' && !device && location.status !== 'error';

  const heading = device ? 'Homes near you' : origin?.source === 'area' ? 'Homes in this area' : 'Explore homes by area';

  const loadedNote = useMemo(() => {
    if (!cellQuery.data && cellQuery.isFetching) return 'Loading homes in this view\u2026';
    if (cellQuery.isError) return 'Homes could not be loaded on the map.';
    if (housesInView === 0) return 'No mapped homes in this view.';
    const suffix = cellQuery.isFetching ? ' Still loading more\u2026' : ' Prices in UGX.';
    return `Showing ${housesInView.toLocaleString()} mapped ${housesInView === 1 ? 'home' : 'homes'} in this view.${suffix}`;
  }, [cellQuery.data, cellQuery.isFetching, cellQuery.isError, housesInView]);

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

      <div
        ref={mapBoxRef}
        style={{
          marginLeft: `-${bleed}px`,
          marginRight: `-${bleed}px`,
          borderRadius: `${Math.max(0, 16 - bleed)}px`,
        }}
        className={`relative z-0 overflow-hidden border bg-card shadow-sm ${MAP_BOX}`}
      >

        <Suspense fallback={<Skeleton className="h-full w-full rounded-2xl" />}>
          <LazyRouteMap
            key={resetToken}
            cells={cells}
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
