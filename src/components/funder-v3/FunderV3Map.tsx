import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkerClusterer, SuperClusterAlgorithm, type Renderer } from '@googlemaps/markerclusterer';
import { formatDynamic } from '@/lib/currencyFormat';
import { useEmptyHouseMapCells, type MapViewport } from '@/hooks/useEmptyHouseMapCells';
import { useFunderEmptyHousesAllowed } from '@/hooks/useFunderEmptyHousesSwitch';
import { coarsenMapCells } from '@/components/funder-new/coarsenMapCells';
import { loadGoogleMaps, viewportOf, type FunderNewMapCell, type FunderNewViewport } from '@/components/funder-new/FunderNewRouteMap';
import { viewportFromCenter } from '@/components/funder-new/viewportMath';
import type { FunderNewEmptyHouse, FunderNewFilters } from '@/components/funder-new/types';
import type { FunderNewLocationController } from '@/components/funder-new/useFunderNewLocation';
import { amountRange, emptyHouseTitle, itemAmount } from '@/components/funder-new/utils';
import '@/components/funder-new/funderNewMap.css';
import {
  FUNDER_V3_MAP_STYLES,
  countBubbleElement,
  countBubbleIcon,
  funderV3MapId,
  pricePillElement,
  pricePillIcon,
} from './funderV3MapLook';

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
  /** false: a still preview (no pan/zoom gestures, page scroll passes through); taps on the map call onMapTap. */
  interactive?: boolean;
  onMapTap?: () => void;
  /**
   * The visible part of the map is this many px below the canvas centre (the
   * screen covers the top of the canvas while the map is shrunk). The map keeps
   * its logical centre in the middle of the visible part; changes pan smoothly.
   */
  centreOffsetY?: number;
}

type AnyMarker = google.maps.Marker | google.maps.marker.AdvancedMarkerElement;

/**
 * Funder V3 map. Fills whatever box it is given (full bleed on phones, the
 * right pane on desktop) and follows that box live. Pins come from the same
 * read the live map uses (useEmptyHouseMapCells with the list's search,
 * district and amount); the pin icons, loader and viewport maths are the live
 * map's own exports. Presentation only.
 *
 * Look: a light base style (or the cloud style of VITE_GOOGLE_MAP_ID, with HTML
 * pins), white price pills, purple count bubbles, and client-side clustering so
 * pins never overlap; tapping a cluster zooms in. Tilt and rotation are off.
 * Controls (my location, full screen) are drawn by the screen around the map.
 */
export function FunderV3Map({
  filters,
  location,
  activeHouseId,
  onPinHouse,
  focus,
  insets,
  showLoadedNote = false,
  interactive = true,
  onMapTap,
  centreOffsetY = 0,
}: FunderV3MapProps) {
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
  const markersRef = useRef<Map<string, { marker: AnyMarker; sig: string; cell: FunderNewMapCell }>>(new Map());
  const clustererRef = useRef<MarkerClusterer | null>(null);
  /** Homes behind each marker (1 for a house pill, the area count for a bubble); clusters add these up. */
  const countOfRef = useRef(new WeakMap<AnyMarker, number>());
  const advancedRef = useRef(false);
  /** The point the user is looking at: the middle of the visible part (map centre + offset). */
  const logicalCentreRef = useRef<google.maps.LatLng | null>(null);
  const offsetRef = useRef(centreOffsetY);
  const onPinRef = useRef(onPinHouse);
  onPinRef.current = onPinHouse;
  const onMapTapRef = useRef(onMapTap);
  onMapTapRef.current = onMapTap;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
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
    const mapId = funderV3MapId();
    loadGoogleMaps()
      .then(async () => {
        if (mapId) {
          const maps = google.maps as typeof google.maps & { importLibrary?: (name: string) => Promise<unknown> };
          try {
            if (!maps.marker?.AdvancedMarkerElement && typeof maps.importLibrary === 'function') await maps.importLibrary('marker');
          } catch {
            /* fall back to raster pins below */
          }
        }
        if (cancelled || !hostRef.current) return;
        const advanced = !!mapId && typeof google.maps.marker?.AdvancedMarkerElement === 'function';
        advancedRef.current = advanced;
        const map = new google.maps.Map(hostRef.current, {
          center: deviceRef.current ?? KAMPALA_CENTRE,
          zoom: deviceRef.current ? LOCATED_ZOOM : KAMPALA_ZOOM,
          clickableIcons: false,
          disableDefaultUI: true,
          gestureHandling: interactiveRef.current ? 'greedy' : 'none',
          keyboardShortcuts: interactiveRef.current,
          tilt: 0,
          heading: 0,
          rotateControl: false,
          tiltInteractionEnabled: false,
          headingInteractionEnabled: false,
          backgroundColor: '#f2f3f5',
          ...(advanced ? { mapId } : { styles: FUNDER_V3_MAP_STYLES }),
        });
        mapRef.current = map;
        clustererRef.current = new MarkerClusterer({
          map,
          markers: [],
          algorithm: new SuperClusterAlgorithm({ radius: 64, maxZoom: 16 }),
          renderer: clusterRenderer(advanced, (marker) => countOfRef.current.get(marker) ?? 1),
        });
        setMapReady(true);
        listeners.push(
          map.addListener('idle', () => {
            const first = !initialisedRef.current;
            initialisedRef.current = true;
            const centre = map.getCenter();
            if (centre) logicalCentreRef.current = shiftDown(map, centre, offsetRef.current);
            reportViewport(first);
          }),
          map.addListener('click', () => {
            if (!interactiveRef.current) onMapTapRef.current?.();
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
      clustererRef.current?.clearMarkers(true);
      clustererRef.current?.setMap(null);
      clustererRef.current = null;
      markersRef.current.forEach((entry) => detach(entry.marker));
      markersRef.current.clear();
      deviceMarkerRef.current?.setMap(null);
      accuracyRef.current?.setMap(null);
      mapRef.current = null;
    };
  }, [reportViewport]);

  // Keep the logical centre in the middle of the visible part when it moves.
  useEffect(() => {
    if (offsetRef.current === centreOffsetY) return;
    offsetRef.current = centreOffsetY;
    const map = mapRef.current;
    const logical = logicalCentreRef.current;
    if (!map || !logical || !window.google?.maps) return;
    map.panTo(shiftDown(map, logical, -centreOffsetY));
  }, [centreOffsetY, mapReady]);

  // Still preview vs. full map: gestures follow the screen's mode.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setOptions({ gestureHandling: interactive ? 'greedy' : 'none', keyboardShortcuts: interactive });
  }, [interactive, mapReady]);

  // Follow the box (split-pane drags, rotation, full screen): one resize per
  // frame at most, keeping the centre the user was looking at.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const map = mapRef.current;
        if (!map || !window.google?.maps) return;
        const logical = logicalCentreRef.current;
        google.maps.event.trigger(map, 'resize');
        if (logical) map.setCenter(shiftDown(map, logical, -offsetRef.current));
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
    map.panTo(shiftDown(map, new google.maps.LatLng(device.lat, device.lng), -offsetRef.current));
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

  // Pins: updated in place, keyed by cell, and handed to the clusterer in one batch.
  useEffect(() => {
    const map = mapRef.current;
    const clusterer = clustererRef.current;
    if (!map || !clusterer || !window.google?.maps) return;
    const advanced = advancedRef.current;
    const store = markersRef.current;
    const counts = countOfRef.current;
    const seen = new Set<string>();
    const title = (cell: FunderNewMapCell, amount: number) =>
      cell.house ? `${emptyHouseTitle(cell.house)}. ${formatDynamic(amount)} to support.` : `${cell.count} homes in this area from ${formatDynamic(amount)}.`;
    const added: AnyMarker[] = [];
    const removed: AnyMarker[] = [];
    for (const cell of cells) {
      const id = cell.house?.house_id ?? null;
      const active = !!id && activeHouseId === id;
      const amount = cell.amount || (cell.house ? itemAmount('empty', cell.house) : 0);
      const bubble = !cell.house && cell.count > 1 ? cell.count : 0;
      const sig = `${cell.lat},${cell.lng}|${amount}|${active}|${cell.count}|${id ?? ''}`;
      seen.add(cell.key);
      const existing = store.get(cell.key);
      if (existing) {
        existing.cell = cell;
        if (existing.sig === sig) continue;
        existing.sig = sig;
        paint(existing.marker, { lat: cell.lat, lng: cell.lng }, amount, active, bubble, title(cell, amount));
        counts.set(existing.marker, bubble || 1);
        continue;
      }
      const marker = create(advanced, { lat: cell.lat, lng: cell.lng }, amount, active, bubble, title(cell, amount));
      counts.set(marker, bubble || 1);
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
      added.push(marker);
    }
    for (const [key, entry] of store) {
      if (!seen.has(key)) {
        removed.push(entry.marker);
        google.maps.event.clearInstanceListeners(entry.marker);
        store.delete(key);
      }
    }
    if (removed.length) clusterer.removeMarkers(removed, true);
    if (added.length) clusterer.addMarkers(added, true);
    // Re-cluster once per change (new pins, or a selection that changed a pill).
    clusterer.render();
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

  return (
    <div className="fn-map h-full w-full" data-testid="fv3-map">
      <div ref={hostRef} className="h-full w-full" aria-label="Google map of available homes" />
      {mapError ? <div className="absolute inset-0 grid place-items-center bg-muted p-6 text-center text-sm text-muted-foreground">{mapError}</div> : null}
      <div className="pointer-events-none absolute inset-0 z-10" style={{ paddingTop: insets.top, paddingRight: insets.right, paddingBottom: insets.bottom, paddingLeft: insets.left }}>
        <div className="relative h-full w-full">
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

/** The point `dy` screen px below `latLng` at the map's current zoom (negative = above). */
function shiftDown(map: google.maps.Map, latLng: google.maps.LatLng, dy: number): google.maps.LatLng {
  const projection = map.getProjection();
  const zoom = map.getZoom();
  if (!dy || !projection || zoom === undefined) return latLng;
  const point = projection.fromLatLngToPoint(latLng);
  if (!point) return latLng;
  return projection.fromPointToLatLng(new google.maps.Point(point.x, point.y + dy / 2 ** zoom)) ?? latLng;
}

/** Marker for a cell: a price pill, or a count bubble for a multi-home area (count > 0). */
function create(
  advanced: boolean,
  position: google.maps.LatLngLiteral,
  amount: number,
  active: boolean,
  count: number,
  title: string,
): AnyMarker {
  if (advanced) {
    return new google.maps.marker.AdvancedMarkerElement({
      position,
      title,
      gmpClickable: true,
      zIndex: active ? 30 : 10,
      content: count > 0 ? countBubbleElement(count) : pricePillElement(amount, active),
    });
  }
  return new google.maps.Marker({
    position,
    title,
    icon: count > 0 ? countBubbleIcon(count) : pricePillIcon(amount, active),
    zIndex: active ? 30 : 10,
    optimized: true,
  });
}

function paint(marker: AnyMarker, position: google.maps.LatLngLiteral, amount: number, active: boolean, count: number, title: string) {
  if (marker instanceof google.maps.Marker) {
    marker.setPosition(position);
    marker.setIcon(count > 0 ? countBubbleIcon(count) : pricePillIcon(amount, active));
    marker.setTitle(title);
    marker.setZIndex(active ? 30 : 10);
    return;
  }
  marker.position = position;
  marker.title = title;
  marker.zIndex = active ? 30 : 10;
  marker.content = count > 0 ? countBubbleElement(count) : pricePillElement(amount, active);
}

function detach(marker: AnyMarker) {
  if (marker instanceof google.maps.Marker) marker.setMap(null);
  else marker.map = null;
}

/** Clusters: a purple bubble with the number of homes inside (house pills count 1, area bubbles their count). */
function clusterRenderer(advanced: boolean, homesOf: (marker: AnyMarker) => number): Renderer {
  return {
    render: ({ markers, position }) => {
      const homes = markers.reduce((sum, marker) => sum + homesOf(marker as AnyMarker), 0);
      const title = `${homes.toLocaleString()} homes here. Tap to zoom in.`;
      if (advanced) {
        return new google.maps.marker.AdvancedMarkerElement({ position, title, zIndex: 1000 + homes, content: countBubbleElement(homes) });
      }
      return new google.maps.Marker({ position, title, zIndex: 1000 + homes, icon: countBubbleIcon(homes) });
    },
  };
}

export default FunderV3Map;
