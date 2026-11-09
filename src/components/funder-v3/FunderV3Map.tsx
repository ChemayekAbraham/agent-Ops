import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Crosshair, Loader2, RotateCcw } from 'lucide-react';
import { formatDynamic } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import { useEmptyHouseMapCells, type MapViewport } from '@/hooks/useEmptyHouseMapCells';
import { useFunderEmptyHousesAllowed } from '@/hooks/useFunderEmptyHousesSwitch';
import { coarsenMapCells } from '@/components/funder-new/coarsenMapCells';
import { getPricePinIcon, loadGoogleMaps, viewportOf, type FunderNewMapCell, type FunderNewViewport } from '@/components/funder-new/FunderNewRouteMap';
import { viewportFromCenter } from '@/components/funder-new/viewportMath';
import type { FunderNewEmptyHouse, FunderNewFilters } from '@/components/funder-new/types';
import type { FunderNewLocationController } from '@/components/funder-new/useFunderNewLocation';
import { amountRange, emptyHouseTitle, itemAmount } from '@/components/funder-new/utils';
import '@/components/funder-new/funderNewMap.css';

const LOCATED_ZOOM = 13;
const KAMPALA_CENTRE = { lat: 0.3476, lng: 32.5825 };
const KAMPALA_ZOOM = 12;
const HOLD_FOR_LOCATION_MS = 4000;

export interface FunderV3MapInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FunderV3MapProps {
  filters: Pick<FunderNewFilters, 'search' | 'location' | 'amount'>;
  location: FunderNewLocationController;
  /** House id whose pin is lit (hovered card or highlighted card). */
  activeHouseId: string | null;
  onPinHouse: (house: FunderNewEmptyHouse) => void;
  focus?: { points: { lat: number; lng: number }[]; token: number } | null;
  /** Parts of the map covered by floating UI (search, sheet): controls and fitBounds keep clear of them. */
  insets: FunderV3MapInsets;
  showLoadedNote?: boolean;
}

/**
 * Funder V3 map. Fills whatever box it is given (full bleed on phones, the
 * right pane on desktop) and follows that box live. Pins come from the same
 * read the live map uses (useEmptyHouseMapCells with the list's search,
 * district and amount); the pin icons, loader and viewport maths are the live
 * map's own exports. Presentation only.
 */
export function FunderV3Map({ filters, location, activeHouseId, onPinHouse, focus, insets, showLoadedNote = false }: FunderV3MapProps) {
  const emptyHousesAllowed = useFunderEmptyHousesAllowed();
  const device = location.coords;
  const [viewport, setViewport] = useState<FunderNewViewport | null>(null);

  const cellViewport = useMemo<MapViewport | null>(
    () => (viewport ? { minLat: viewport.minLat, minLng: viewport.minLng, maxLat: viewport.maxLat, maxLng: viewport.maxLng, zoom: viewport.zoom } : null),
    [viewport],
  );
  const range = amountRange(filters.amount);
  const nearPoint = useMemo(() => (device ? { lat: device.lat, lng: device.lng } : null), [device?.lat, device?.lng]);
  const cellQuery = useEmptyHouseMapCells(
    cellViewport,
    {
      search: filters.search.trim() || undefined,
      district: filters.location.trim() || undefined,
      minRent: range.min,
      maxRent: range.max,
    },
    emptyHousesAllowed,
    emptyHousesAllowed ? nearPoint : null,
  );

  const cells = useMemo<FunderNewMapCell[]>(() => {
    if (!emptyHousesAllowed) return [];
    const raw = (cellQuery.data?.cells ?? []).map((cell) => ({
      key: cell.key,
      count: cell.count,
      lat: cell.latitude,
      lng: cell.longitude,
      amount: cell.minRent,
      house: (cell.house as unknown as FunderNewEmptyHouse | null) ?? null,
    }));
    return viewport ? coarsenMapCells(raw, viewport.zoom) : raw;
  }, [cellQuery.data, viewport, emptyHousesAllowed]);

  const housesInView = emptyHousesAllowed ? cellQuery.data?.housesInView ?? 0 : 0;
  const awaitingDeviceFix = location.permission === 'granted' && !device && location.status !== 'error';

  // Same wording as the live map's note.
  const loadedNote = useMemo(() => {
    if (!emptyHousesAllowed) return 'No mapped homes in this view.';
    if (awaitingDeviceFix && !cellQuery.data) return 'Finding your location…';
    if (!cellQuery.data && cellQuery.isFetching) return 'Loading homes in this view…';
    if (cellQuery.isError) return 'Homes could not be loaded on the map.';
    if (housesInView === 0) return 'No mapped homes in this view.';
    const suffix = cellQuery.isFetching ? ' Still loading more…' : ' Prices in UGX.';
    return `Showing ${housesInView.toLocaleString()} mapped ${housesInView === 1 ? 'home' : 'homes'} in this view.${suffix}`;
  }, [awaitingDeviceFix, cellQuery.data, cellQuery.isFetching, cellQuery.isError, housesInView, emptyHousesAllowed]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, { marker: google.maps.Marker; sig: string; cell: FunderNewMapCell }>>(new Map());
  const onPinRef = useRef(onPinHouse);
  onPinRef.current = onPinHouse;
  const deviceMarkerRef = useRef<google.maps.Marker | null>(null);
  const accuracyRef = useRef<google.maps.Circle | null>(null);
  const initialisedRef = useRef(false);
  const markerJobRef = useRef(0);
  const reportTimerRef = useRef<number | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  // Hold the first pin request briefly while a granted location fix is on its way.
  const [graceExpired, setGraceExpired] = useState(false);
  const holding = awaitingDeviceFix && !device && !graceExpired;
  const holdingRef = useRef(holding);
  holdingRef.current = holding;
  const deviceRef = useRef(device);
  deviceRef.current = device;
  useEffect(() => {
    if (!holding) return;
    const timer = window.setTimeout(() => setGraceExpired(true), HOLD_FOR_LOCATION_MS);
    return () => window.clearTimeout(timer);
  }, [holding]);

  const reportViewport = useCallback((immediate = false) => {
    const map = mapRef.current;
    if (!map) return;
    if (reportTimerRef.current) window.clearTimeout(reportTimerRef.current);
    const run = () => {
      if (holdingRef.current) return;
      const next = viewportOf(map);
      if (next) setViewport(next);
    };
    if (immediate) run();
    else reportTimerRef.current = window.setTimeout(run, 120);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Start the first pin read from where the map is about to open, before
    // Google Maps has even loaded (same trick as the live map).
    if (!holdingRef.current) {
      const host = hostRef.current;
      const start = deviceRef.current ?? KAMPALA_CENTRE;
      const zoom = deviceRef.current ? LOCATED_ZOOM : KAMPALA_ZOOM;
      if (host && host.clientWidth > 0 && host.clientHeight > 0) {
        setViewport(viewportFromCenter(start, zoom, host.clientWidth, host.clientHeight));
      }
    }
    const listeners: google.maps.MapsEventListener[] = [];
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        const map = new google.maps.Map(hostRef.current, {
          center: deviceRef.current ?? KAMPALA_CENTRE,
          zoom: deviceRef.current ? LOCATED_ZOOM : KAMPALA_ZOOM,
          clickableIcons: false,
          disableDefaultUI: true,
          gestureHandling: 'greedy',
          styles: [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }],
        });
        mapRef.current = map;
        setMapReady(true);
        listeners.push(
          map.addListener('idle', () => {
            const first = !initialisedRef.current;
            initialisedRef.current = true;
            reportViewport(first);
          }),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setMapError(error instanceof Error ? error.message : 'Google Maps could not be loaded.');
      });
    return () => {
      cancelled = true;
      listeners.forEach((listener) => listener.remove());
      if (reportTimerRef.current) window.clearTimeout(reportTimerRef.current);
      markerJobRef.current += 1;
      markersRef.current.forEach((entry) => entry.marker.setMap(null));
      markersRef.current.clear();
      deviceMarkerRef.current?.setMap(null);
      accuracyRef.current?.setMap(null);
      mapRef.current = null;
    };
  }, [reportViewport]);

  // Follow the box: split-pane drags, rotation, sheet layouts.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const map = mapRef.current;
        if (map && window.google?.maps) google.maps.event.trigger(map, 'resize');
      });
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (holding) return;
    const map = mapRef.current;
    if (!map || device || !initialisedRef.current) return;
    reportViewport(true);
  }, [holding, device, reportViewport]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !device) return;
    map.panTo(device);
    map.setZoom(LOCATED_ZOOM);
  }, [device]);

  useEffect(() => {
    const map = mapRef.current;
    if (!focus || focus.points.length === 0 || !map || !window.google?.maps) return;
    if (focus.points.length === 1) {
      map.panTo(focus.points[0]);
      map.setZoom(15);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    focus.points.forEach((point) => bounds.extend(point));
    const pad = insetsRef.current;
    map.fitBounds(bounds, { top: pad.top + 24, bottom: pad.bottom + 24, left: pad.left + 24, right: pad.right + 24 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.token]);

  // Pins: updated in place, keyed by cell; created a slice per tick (same approach as the live map).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;
    const store = markersRef.current;
    const seen = new Set<string>();
    const title = (cell: FunderNewMapCell, amount: number) =>
      cell.house ? `${emptyHouseTitle(cell.house)}. ${formatDynamic(amount)} to support.` : `${cell.count} homes in this area from ${formatDynamic(amount)}.`;
    const toCreate: Array<{ cell: FunderNewMapCell; amount: number; active: boolean; sig: string }> = [];
    for (const cell of cells) {
      const id = cell.house?.house_id ?? null;
      const active = !!id && activeHouseId === id;
      const amount = cell.amount || (cell.house ? itemAmount('empty', cell.house) : 0);
      const sig = `${cell.lat},${cell.lng}|${amount}|${active}|${cell.count}|${id ?? ''}`;
      seen.add(cell.key);
      const existing = store.get(cell.key);
      if (existing) {
        existing.cell = cell;
        if (existing.sig === sig) continue;
        existing.sig = sig;
        existing.marker.setPosition({ lat: cell.lat, lng: cell.lng });
        existing.marker.setIcon(getPricePinIcon(amount, active, false));
        existing.marker.setTitle(title(cell, amount));
        existing.marker.setZIndex(active ? 30 : 10);
        continue;
      }
      toCreate.push({ cell, amount, active, sig });
    }
    for (const [key, entry] of store) {
      if (!seen.has(key)) {
        entry.marker.setMap(null);
        google.maps.event.clearInstanceListeners(entry.marker);
        store.delete(key);
      }
    }
    const centre = map.getCenter();
    if (centre && toCreate.length > 1) {
      const lat = centre.lat();
      const lng = centre.lng();
      toCreate.sort((a, b) => (a.cell.lat - lat) ** 2 + (a.cell.lng - lng) ** 2 - ((b.cell.lat - lat) ** 2 + (b.cell.lng - lng) ** 2));
    }
    const job = ++markerJobRef.current;
    const SLICE = 50;
    const createSlice = (start: number) => {
      if (job !== markerJobRef.current || mapRef.current !== map) return;
      const end = Math.min(start + SLICE, toCreate.length);
      for (let index = start; index < end; index += 1) {
        const { cell, amount, active, sig } = toCreate[index];
        const marker = new google.maps.Marker({
          map,
          position: { lat: cell.lat, lng: cell.lng },
          title: title(cell, amount),
          icon: getPricePinIcon(amount, active, false),
          zIndex: active ? 30 : 10,
          optimized: true,
        });
        const entry = { marker, sig, cell };
        marker.addListener('click', () => {
          const current = entry.cell;
          if (current.house) onPinRef.current(current.house);
          else {
            map.panTo({ lat: current.lat, lng: current.lng });
            map.setZoom(Math.min((map.getZoom() ?? KAMPALA_ZOOM) + 2, 17));
          }
        });
        store.set(cell.key, entry);
      }
      if (end < toCreate.length) window.setTimeout(() => createSlice(end), 16);
    };
    createSlice(0);
  }, [cells, activeHouseId, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;
    deviceMarkerRef.current?.setMap(null);
    accuracyRef.current?.setMap(null);
    if (!device) return;
    deviceMarkerRef.current = new google.maps.Marker({
      map,
      position: device,
      clickable: false,
      title: 'Your current location',
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: 'hsl(214 90% 52%)', fillOpacity: 1, strokeColor: 'hsl(0 0% 100%)', strokeWeight: 3 },
      zIndex: 50,
    });
    if (device.accuracyM && device.accuracyM > 40 && device.accuracyM < 3000) {
      accuracyRef.current = new google.maps.Circle({
        map,
        center: device,
        radius: device.accuracyM,
        strokeColor: 'hsl(214 90% 52%)',
        strokeOpacity: 0.8,
        strokeWeight: 1,
        fillColor: 'hsl(214 90% 52%)',
        fillOpacity: 0.1,
      });
    }
  }, [device, mapReady]);

  const queryClient = useQueryClient();
  const handleReset = useCallback(() => {
    const map = mapRef.current;
    if (map) {
      const home = deviceRef.current;
      map.panTo(home ?? KAMPALA_CENTRE);
      map.setZoom(home ? LOCATED_ZOOM : KAMPALA_ZOOM);
    }
    void queryClient.invalidateQueries({ queryKey: ['empty-house-map-cells'] });
    void queryClient.invalidateQueries({ queryKey: ['empty-house-map-cells-near'] });
  }, [queryClient]);

  const handleLocate = useCallback(() => {
    if (location.permission === 'denied') return;
    if (device) location.refresh();
    else location.request();
  }, [device, location]);

  const locating = location.status === 'locating';

  return (
    <div className="fn-map h-full w-full" data-testid="fv3-map">
      <div ref={hostRef} className="h-full w-full" aria-label="Google map of available homes" />
      {mapError ? <div className="absolute inset-0 grid place-items-center bg-muted p-6 text-center text-sm text-muted-foreground">{mapError}</div> : null}
      <div className="pointer-events-none absolute inset-0 z-10" style={{ paddingTop: insets.top, paddingRight: insets.right, paddingBottom: insets.bottom, paddingLeft: insets.left }}>
        <div className="relative h-full w-full">
          <div className="pointer-events-auto absolute right-3 top-3 flex flex-col gap-2">
            {location.permission !== 'unsupported' ? (
              <button
                type="button"
                onClick={handleLocate}
                aria-label={device ? 'Recentre on my location' : 'Use my location'}
                className="fv3-tap flex h-11 w-11 items-center justify-center rounded-full border bg-card text-foreground shadow-lg hover:bg-muted"
              >
                {locating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Crosshair className={cn('h-4 w-4', device && 'text-primary')} aria-hidden />}
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleReset}
              aria-label="Reset the map view"
              className="fv3-tap flex h-11 w-11 items-center justify-center rounded-full border bg-card text-foreground shadow-lg hover:bg-muted"
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {showLoadedNote ? (
            <p className="absolute left-3 top-3 max-w-[70%] rounded-full bg-card/95 px-3 py-1.5 text-xs font-medium leading-tight text-muted-foreground shadow-md">
              {loadedNote}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default FunderV3Map;
