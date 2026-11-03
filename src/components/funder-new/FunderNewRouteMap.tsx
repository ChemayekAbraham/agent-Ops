import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Crosshair, Loader2, Maximize2, RotateCcw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDynamic, formatDynamicCompact } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import type { FunderNewEmptyHouse } from './types';
import { emptyHouseTitle, itemAmount } from './utils';
import './funderNewMap.css';
import { viewportFromCenter } from './viewportMath';

const SERVICE_AREA_ZOOM = 7;
const LOCATED_ZOOM = 13;
const KAMPALA_CENTRE = { lat: 0.3476, lng: 32.5825 };
const KAMPALA_ZOOM = 12;
/** How long the first data request waits for a location fix before loading Kampala instead. */
const HOLD_FOR_LOCATION_MS = 4000;

let mapsPromise: Promise<typeof google.maps> | null = null;

// The Maps key is never cached in browser storage. The referrer-restricted
// connector browser key is used directly when present; otherwise the key is
// fetched fresh from the backend on each page load (held in memory only).
async function resolveMapsKey(): Promise<string> {
  try {
    sessionStorage.removeItem('welile-gmaps-key'); // purge any key cached by older builds
  } catch {
    // ignore
  }
  const connectorKey = import.meta.env['VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY'] as string | undefined;
  if (connectorKey) return connectorKey;
  const { data, error } = await supabase.functions.invoke('maps-browser-key');
  if (!error && data && typeof (data as { key?: string }).key === 'string') return (data as { key: string }).key;
  throw new Error('Google Maps is not connected.');
}

async function ensureMapsReady(): Promise<typeof google.maps> {
  const maps = window.google?.maps as (typeof google.maps & { importLibrary?: (n: string) => Promise<unknown> }) | undefined;
  if (!maps) throw new Error('Google Maps did not initialise.');
  // With loading=async the namespace can exist before Map/Marker are attached.
  if (typeof maps.Map !== 'function' && typeof maps.importLibrary === 'function') {
    await maps.importLibrary('maps');
    await maps.importLibrary('marker');
  }
  if (typeof window.google?.maps?.Map !== 'function') throw new Error('Google Maps did not initialise.');
  return window.google.maps;
}

export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (typeof window.google?.maps?.Map === 'function') return Promise.resolve(window.google.maps);
  if (mapsPromise) return mapsPromise;
  if (window.google?.maps) {
    mapsPromise = ensureMapsReady();
    mapsPromise.catch(() => { mapsPromise = null; });
    return mapsPromise;
  }

  const channel = import.meta.env['VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID'] as string | undefined;

  mapsPromise = resolveMapsKey().then(
    (key) =>
      new Promise<typeof google.maps>((resolve, reject) => {
        const callbackName = '__initFunderNewGoogleMap';
        window[callbackName] = () => {
          ensureMapsReady().then(resolve, reject);
          delete window[callbackName];
        };

        const script = document.createElement('script');
        const params = new URLSearchParams({ key, loading: 'async', callback: callbackName, libraries: 'geometry' });
        if (channel) params.set('channel', channel);
        script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
        script.async = true;
        script.onerror = () => reject(new Error('Google Maps could not be loaded.'));
        document.head.appendChild(script);
      }),
  );
  mapsPromise.catch(() => {
    mapsPromise = null;
  });
  return mapsPromise;
}

// Eagerly preload Google Maps script in the background so tiles start resolving immediately
if (typeof window !== 'undefined') {
  void loadGoogleMaps();
}

declare global {
  interface Window {
    google?: typeof google;
    [key: string]: unknown;
  }
}

export interface FunderNewViewport {
  lat: number;
  lng: number;
  radiusKm: number;
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  zoom: number;
}

export interface FunderNewMapCell {
  key: string;
  count: number;
  lat: number;
  lng: number;
  amount: number;
  house: FunderNewEmptyHouse | null;
}

export function viewportOf(map: google.maps.Map): FunderNewViewport | null {
  const bounds = map.getBounds();
  const centre = map.getCenter();
  if (!bounds || !centre) return null;
  const northEast = bounds.getNorthEast();
  const southWest = bounds.getSouthWest();
  const radiusKm = Math.max(
    1,
    Math.round(
      google.maps.geometry?.spherical?.computeDistanceBetween(centre, northEast) / 1000 ||
        Math.hypot(northEast.lat() - centre.lat(), northEast.lng() - centre.lng()) * 111,
    ),
  );
  return {
    lat: centre.lat(),
    lng: centre.lng(),
    radiusKm,
    minLat: southWest.lat(),
    minLng: southWest.lng(),
    maxLat: northEast.lat(),
    maxLng: northEast.lng(),
    zoom: Math.round(map.getZoom() ?? SERVICE_AREA_ZOOM),
  };
}

const pinIconCache = new Map<string, google.maps.Icon>();

/**
 * Builds an SVG price-pill icon for Google Maps markers.
 * Displays only the formatted price tag with rent-tier styling.
 */
export function getPricePinIcon(
  amount: number,
  active: boolean,
  saved: boolean,
): google.maps.Icon {
  const safeAmount = amount > 0 ? amount : 100000;
  const priceText = formatDynamicCompact(safeAmount);
  const cacheKey = `${priceText}_${safeAmount}_${active}_${saved}`;
  const existing = pinIconCache.get(cacheKey);
  if (existing) return existing;

  // Rent tiers consistent with platform standards
  const isLuxury = safeAmount >= 2_000_000;
  const isPremium = safeAmount >= 800_000 && safeAmount < 2_000_000;
  const isMid = safeAmount >= 300_000 && safeAmount < 800_000;

  let bg = '#ffffff';
  let textColor = '#15803d'; // green (<300k)
  let borderColor = '#86efac';
  let strokeWidth = 1.5;

  if (isLuxury) {
    textColor = '#b45309'; // amber
    borderColor = '#fcd34d';
  } else if (isPremium) {
    textColor = '#6d28d9'; // purple
    borderColor = '#c4b5fd';
  } else if (isMid) {
    textColor = '#1d4ed8'; // blue
    borderColor = '#93c5fd';
  }

  if (active) {
    bg = isLuxury ? '#b45309' : isMid ? '#1d4ed8' : isPremium ? '#6d28d9' : '#16a34a';
    textColor = '#ffffff';
    borderColor = '#ffffff';
    strokeWidth = 2;
  } else if (saved) {
    bg = '#7c3aed';
    textColor = '#ffffff';
    borderColor = '#e9d5ff';
    strokeWidth = 2;
  }

  const charWidth = 7;
  const padding = 16;
  const pillWidth = Math.max(54, Math.round(priceText.length * charWidth + padding));
  const pillHeight = 25;
  const pointerHeight = 5;
  const totalHeight = pillHeight + pointerHeight;
  const totalWidth = pillWidth + 4;
  const cx = totalWidth / 2;
  const rectX = 2;
  const rectY = 1;
  const r = 12;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}">
  <g>
    <rect x="${rectX}" y="${rectY}" width="${pillWidth}" height="${pillHeight}" rx="${r}" ry="${r}" fill="${bg}" stroke="${borderColor}" stroke-width="${strokeWidth}"/>
    <polygon points="${cx - 4.5},${rectY + pillHeight - 1} ${cx + 4.5},${rectY + pillHeight - 1} ${cx},${totalHeight - 1}" fill="${bg}" stroke="${borderColor}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>
    <rect x="${cx - 4}" y="${rectY + pillHeight - 2}" width="8" height="2" fill="${bg}"/>
  </g>
  <text x="${cx}" y="${rectY + pillHeight / 2}" fill="${textColor}" font-size="11" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" text-anchor="middle" dominant-baseline="central" letter-spacing="-0.2px">${priceText}</text>
</svg>`;

  const icon: google.maps.Icon = {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new google.maps.Size(totalWidth, totalHeight),
    anchor: new google.maps.Point(cx, totalHeight - 1),
  };

  pinIconCache.set(cacheKey, icon);
  return icon;
}

export function FunderNewRouteMap({
  cells,
  selectedIds,
  savedIds,
  activeId,
  device,
  awaitingDeviceFix,
  locating,
  canUseLocation,
  areaSearchValue,
  onAreaSearchChange,
  onOpenHouse,
  onViewportChange,
  onSearchThisArea,
  onUseMyLocation,
  onReset,
  loadedNote,
  onExpandedChange,
  expandRequest,
  reserveTopForSearch = false,
  focus,
  notice,
}: {
  cells: FunderNewMapCell[];
  selectedIds: string[];
  savedIds: string[];
  activeId: string | null;
  device: { lat: number; lng: number; accuracyM: number | null } | null;
  awaitingDeviceFix: boolean;
  locating: boolean;
  canUseLocation: boolean;
  areaSearchValue: string;
  onAreaSearchChange: (value: string) => void;
  onOpenHouse: (house: FunderNewEmptyHouse) => void;
  onViewportChange: (viewport: FunderNewViewport) => void;
  onSearchThisArea: (viewport: FunderNewViewport) => void;
  onUseMyLocation: () => void;
  onReset: () => void;
  loadedNote: string;
  onExpandedChange?: (expanded: boolean) => void;
  /** Bumped by the page to open the full screen map (e.g. from the hero card). */
  expandRequest?: number;
  /** Full screen only: leave room under a search bar floated at the top by the page. */
  reserveTopForSearch?: boolean;
  /** Bumped by the page (new token) to move the map to a set of points, e.g. search results. */
  focus?: { points: { lat: number; lng: number }[]; token: number } | null;
  /** A note shown under the top of the full screen map (e.g. the location prompt). */
  notice?: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, { marker: google.maps.Marker; sig: string; cell: FunderNewMapCell }>>(new Map());
  const onOpenHouseRef = useRef(onOpenHouse);
  onOpenHouseRef.current = onOpenHouse;
  const deviceMarkerRef = useRef<google.maps.Marker | null>(null);
  const accuracyCircleRef = useRef<google.maps.Circle | null>(null);
  const listenersRef = useRef<google.maps.MapsEventListener[]>([]);
  const initialisedRef = useRef(false);
  const markerJobRef = useRef(0);
  // Waiting for the user's location fix: hold the first data request so the map
  // never loads a wide, wrong view only to throw it away when the fix lands. A
  // short grace period stops the hold from lasting if the fix is slow.
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
  const reportTimerRef = useRef<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (expandRequest) setFullscreen(true);
  }, [expandRequest]);
  const [moved, setMoved] = useState<FunderNewViewport | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const reportViewport = useCallback(
    (fromUser: boolean, immediate = false) => {
      const map = mapRef.current;
      if (!map) return;
      if (reportTimerRef.current) window.clearTimeout(reportTimerRef.current);
      const doReport = () => {
        if (holdingRef.current) return;
        const viewport = viewportOf(map);
        if (!viewport) return;
        onViewportChange(viewport);
        if (fromUser) setMoved(viewport);
      };
      if (immediate) {
        doReport();
      } else {
        // 'idle' already waits for the pan or zoom animation to finish, so a short
        // settle delay is enough; every ms here is added to the wait for new pins.
        reportTimerRef.current = window.setTimeout(doReport, 120);
      }
    },
    [onViewportChange],
  );

  useEffect(() => {
    let cancelled = false;
    // Start the first pin request now, from where the map is about to open, rather
    // than after Google Maps has loaded and fired its first 'idle' event (several
    // seconds on a slow connection). The real bounds Google reports a moment later
    // match this rectangle, so those reads are served from the same cache.
    if (!holdingRef.current) {
      const start = deviceRef.current ?? KAMPALA_CENTRE;
      const startZoom = deviceRef.current ? LOCATED_ZOOM : KAMPALA_ZOOM;
      const host = hostRef.current;
      // A map opened from the dashboard card goes full screen straight away.
      const width = expandRequest ? window.innerWidth : host?.clientWidth ?? 0;
      const height = expandRequest ? window.innerHeight : host?.clientHeight ?? 0;
      if (width > 0 && height > 0) onViewportChange(viewportFromCenter(start, startZoom, width, height));
    }
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        // While a location fix is pending the map shows Kampala (no data is requested
        // for it); it moves to the person the moment the fix lands.
        const initialCenter = deviceRef.current ?? KAMPALA_CENTRE;
        const initialZoom = deviceRef.current ? LOCATED_ZOOM : KAMPALA_ZOOM;
        const map = new google.maps.Map(hostRef.current, {
          center: initialCenter,
          zoom: initialZoom,
          clickableIcons: false,
          disableDefaultUI: true,
          gestureHandling: 'greedy',
          styles: [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }],
        });
        mapRef.current = map;
        listenersRef.current = [
          map.addListener('idle', () => {
            const first = !initialisedRef.current;
            initialisedRef.current = true;
            reportViewport(!first, first);
          }),
        ];
      })
      .catch((error: unknown) => {
        if (!cancelled) setMapError(error instanceof Error ? error.message : 'Google Maps could not be loaded.');
      });
    return () => {
      cancelled = true;
      listenersRef.current.forEach((listener) => listener.remove());
      listenersRef.current = [];
      if (reportTimerRef.current) window.clearTimeout(reportTimerRef.current);
      mapRef.current = null;
    };
  }, []);

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
    // Keep the matches clear of the floating search bar and the sheet below.
    map.fitBounds(bounds, {
      top: reserveTopForSearch ? 96 : 48,
      bottom: fullscreen ? Math.round(window.innerHeight * 0.5) : 48,
      left: 40,
      right: 40,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.token]);

  useEffect(() => {
    if (holding) return;
    const map = mapRef.current;
    if (!map || device || !initialisedRef.current) return;
    // The wait ended with no fix (error or grace period): load Kampala. A fix that
    // arrives later still moves the map through the [device] effect below.
    google.maps.event.trigger(map, 'resize');
    reportViewport(false, true);
  }, [holding, device, reportViewport]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !device) return;
    map.panTo(device);
    map.setZoom(LOCATED_ZOOM);
  }, [device]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setOptions({ gestureHandling: 'greedy' });
    window.setTimeout(() => google.maps.event.trigger(map, 'resize'), 120);
  }, [fullscreen]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;
    // Update markers in place, keyed by cell. Only pins whose data or state
    // changed are touched; removed cells are detached, new cells are added.
    const store = markersRef.current;
    const seen = new Set<string>();
    const selected = new Set(selectedIds);
    const savedSet = new Set(savedIds);
    const buildTitle = (cell: FunderNewMapCell, amount: number) =>
      cell.house
        ? `${emptyHouseTitle(cell.house)}. ${formatDynamic(amount)} to support.`
        : `${cell.count} homes in this area from ${formatDynamic(amount)}.`;
    const toCreate: Array<{ cell: FunderNewMapCell; amount: number; active: boolean; saved: boolean; sig: string }> = [];
    for (const cell of cells) {
      const house = cell.house;
      const id = house?.house_id ?? null;
      const active = !!id && (selected.has(id) || activeId === id);
      const saved = !!id && savedSet.has(id);
      const amount = cell.amount || (house ? itemAmount('empty', house) : 0);
      // Cheap signature from raw values. The tooltip text (which formats the
      // amount) is only built for pins that are created or really changed.
      const sig = `${cell.lat},${cell.lng}|${amount}|${active}|${saved}|${cell.count}|${id ?? ''}`;
      seen.add(cell.key);
      const existing = store.get(cell.key);
      if (existing) {
        existing.cell = cell;
        if (existing.sig === sig) continue;
        existing.sig = sig;
        existing.marker.setPosition({ lat: cell.lat, lng: cell.lng });
        existing.marker.setIcon(getPricePinIcon(amount, active, saved));
        existing.marker.setTitle(buildTitle(cell, amount));
        existing.marker.setZIndex(active ? 30 : saved ? 25 : 10);
        continue;
      }
      toCreate.push({ cell, amount, active, saved, sig });
    }
    for (const [key, entry] of store) {
      if (!seen.has(key)) {
        entry.marker.setMap(null);
        google.maps.event.clearInstanceListeners(entry.marker);
        store.delete(key);
      }
    }

    // Pins nearest the middle of the screen are created first, so what the person
    // is looking at appears before the edges fill in.
    const centre = map.getCenter();
    if (centre && toCreate.length > 1) {
      const centreLat = centre.lat();
      const centreLng = centre.lng();
      const distance = (cell: FunderNewMapCell) => (cell.lat - centreLat) ** 2 + (cell.lng - centreLng) ** 2;
      toCreate.sort((a, b) => distance(a.cell) - distance(b.cell));
    }

    // A new area can bring hundreds of pins at once. Creating them all in one
    // go blocks the main thread (a visible hitch on phones), so they are added a
    // slice per tick (about one frame apart). A newer sync cancels the unfinished slices; the cells it
    // still lacks are simply picked up again by that sync.
    const job = ++markerJobRef.current;
    const SLICE = 50;
    const createSlice = (start: number) => {
      if (job !== markerJobRef.current || mapRef.current !== map) return;
      const end = Math.min(start + SLICE, toCreate.length);
      for (let index = start; index < end; index += 1) {
        const { cell, amount, active, saved, sig } = toCreate[index];
        const marker = new google.maps.Marker({
          map,
          position: { lat: cell.lat, lng: cell.lng },
          title: buildTitle(cell, amount),
          icon: getPricePinIcon(amount, active, saved),
          zIndex: active ? 30 : saved ? 25 : 10,
          optimized: true,
        });
        const entry = { marker, sig, cell };
        marker.addListener('click', () => {
          const current = entry.cell;
          if (current.house) onOpenHouseRef.current(current.house);
          else {
            map.panTo({ lat: current.lat, lng: current.lng });
            map.setZoom(Math.min((map.getZoom() ?? KAMPALA_ZOOM) + 2, 17));
          }
        });
        store.set(cell.key, entry);
      }
      // A timer, not requestAnimationFrame: frames stop in a backgrounded tab, and the
      // pins should still finish arriving there.
      if (end < toCreate.length) window.setTimeout(() => createSlice(end), 16);
    };
    createSlice(0);
  }, [cells, selectedIds, savedIds, activeId]);

  useEffect(
    () => () => {
      markerJobRef.current += 1;
      markersRef.current.forEach((entry) => entry.marker.setMap(null));
      markersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;
    deviceMarkerRef.current?.setMap(null);
    accuracyCircleRef.current?.setMap(null);
    if (!device) return;
    deviceMarkerRef.current = new google.maps.Marker({
      map,
      position: device,
      clickable: false,
      title: 'Your current location',
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: 'hsl(214 90% 52%)',
        fillOpacity: 1,
        strokeColor: 'hsl(0 0% 100%)',
        strokeWeight: 3,
      },
      zIndex: 50,
    });
    if (device.accuracyM && device.accuracyM > 40 && device.accuracyM < 3000) {
      accuracyCircleRef.current = new google.maps.Circle({
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
  }, [device]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setFullscreen(false);
    window.addEventListener('keydown', onKey, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 60);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(focusTimer);
    };
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen) expandRef.current?.focus({ preventScroll: true });
  }, [fullscreen]);

  useEffect(() => {
    if (fullscreen) {
      document.body.dataset.mapExpanded = 'true';
    } else {
      delete document.body.dataset.mapExpanded;
    }
    return () => {
      delete document.body.dataset.mapExpanded;
    };
  }, [fullscreen]);

  useEffect(() => {
    onExpandedChange?.(fullscreen);
  }, [fullscreen, onExpandedChange]);

  // Reset: put the map back where it started (the person's position if known,
  // otherwise Kampala) and ask the page to reload the pins fresh. In place, no remount.
  const handleResetClick = useCallback(() => {
    setMoved(null);
    const map = mapRef.current;
    if (map) {
      const home = deviceRef.current;
      map.panTo(home ?? KAMPALA_CENTRE);
      map.setZoom(home ? LOCATED_ZOOM : KAMPALA_ZOOM);
    }
    onReset();
  }, [onReset]);

  const controls = useMemo(
    () => (
      <div className="pointer-events-none absolute inset-0 z-10">
        <div className="pointer-events-auto absolute left-2 right-2 top-2 hidden gap-2 sm:left-3 sm:right-3 sm:top-3">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search homes by area</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={areaSearchValue} onChange={(event) => onAreaSearchChange(event.target.value)} placeholder="Search an area" className="h-11 rounded-full border-border/70 bg-card pl-9 text-sm shadow-md" />
          </label>
        </div>
        {moved ? (
          <div className="pointer-events-auto absolute left-1/2 top-16 hidden -translate-x-1/2 sm:top-[4.25rem]">
            <Button size="sm" className="h-10 rounded-full px-4 shadow-lg" onClick={() => { onSearchThisArea(moved); setMoved(null); }}>
              <Search className="h-4 w-4" aria-hidden /> Search this area
            </Button>
          </div>
        ) : null}
        <div className={cn(
          "pointer-events-auto flex flex-col gap-2",
          fullscreen ? (reserveTopForSearch ? "absolute top-[4.75rem] right-3 z-30 pt-safe" : "absolute top-3 right-3 z-30 pt-safe") : "absolute bottom-7 right-2 sm:right-3"
        )}>
          {canUseLocation ? (
            <Button size="icon" variant="secondary" className="h-11 w-11 rounded-full border bg-card shadow-lg" onClick={onUseMyLocation} aria-label={device ? 'Recentre on my location' : 'Use my location'}>
              {locating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Crosshair className={cn('h-4 w-4', device && 'text-primary')} aria-hidden />}
            </Button>
          ) : null}
          <Button ref={fullscreen ? closeRef : expandRef} size="icon" variant="secondary" className="h-11 w-11 rounded-full border bg-card shadow-lg" onClick={() => setFullscreen((value) => !value)} aria-label={fullscreen ? 'Close the full screen map' : 'Expand the map'}>
            {fullscreen ? <X className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
          </Button>
          <Button size="icon" variant="secondary" className="h-11 w-11 rounded-full border bg-card shadow-lg" onClick={handleResetClick} aria-label="Reset the map view">
            <RotateCcw className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    ),
    [areaSearchValue, canUseLocation, device, fullscreen, handleResetClick, locating, moved, onAreaSearchChange, onSearchThisArea, onUseMyLocation, reserveTopForSearch],
  );

  return (
    <div className={cn('fn-map rounded-2xl', fullscreen && 'fn-map-fullscreen rounded-none')} {...(fullscreen ? { role: 'dialog' as const, 'aria-modal': true, 'aria-label': 'Full screen map of homes' } : {})}>
      <div ref={hostRef} className="h-full w-full" aria-label="Google map of available homes" />
      {mapError ? <div className="absolute inset-0 grid place-items-center bg-muted p-6 text-center text-sm text-muted-foreground">{mapError}</div> : null}
      {controls}
      {fullscreen && notice ? (
        // Clear of the floating search bar above and the round buttons on the right.
        <div className="pointer-events-none absolute left-3 right-[4.5rem] top-[4.75rem] z-20 pt-safe">{notice}</div>
      ) : null}
      <p className={cn(
        "pointer-events-none absolute left-2 right-2 z-10 w-fit max-w-[92%] rounded-md bg-card/90 px-2 py-1 text-[11px] leading-tight text-muted-foreground shadow-sm",
        fullscreen ? (reserveTopForSearch ? (notice ? "top-[9.75rem] left-3 pt-safe hidden sm:block" : "top-[4.75rem] left-3 pt-safe hidden sm:block") : "top-3 left-3 pt-safe hidden sm:block") : "bottom-6"
      )}>{loadedNote}</p>
    </div>
  );
}

export default FunderNewRouteMap;