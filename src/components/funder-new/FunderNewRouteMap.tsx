import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Loader2, Maximize2, RotateCcw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDynamic, formatDynamicCompact } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useIsMobile } from '@/hooks/use-mobile';
import type { FunderNewEmptyHouse } from './types';
import { emptyHouseTitle, itemAmount } from './utils';
import './funderNewMap.css';

const SERVICE_AREA_CENTRE = { lat: 1.3733, lng: 32.2903 };
const SERVICE_AREA_ZOOM = 7;
const LOCATED_ZOOM = 13;
const KAMPALA_CENTRE = { lat: 0.3476, lng: 32.5825 };
const KAMPALA_ZOOM = 12;

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

function loadGoogleMaps(): Promise<typeof google.maps> {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (mapsPromise) return mapsPromise;

  const channel = import.meta.env['VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID'] as string | undefined;

  mapsPromise = resolveMapsKey().then(
    (key) =>
      new Promise<typeof google.maps>((resolve, reject) => {
        const callbackName = '__initFunderNewGoogleMap';
        window[callbackName] = () => {
          if (window.google?.maps) resolve(window.google.maps);
          else reject(new Error('Google Maps did not initialise.'));
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

function viewportOf(map: google.maps.Map): FunderNewViewport | null {
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
function getPricePinIcon(
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
}) {
  const isMobile = useIsMobile();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, { marker: google.maps.Marker; sig: string; cell: FunderNewMapCell }>>(new Map());
  const onOpenHouseRef = useRef(onOpenHouse);
  onOpenHouseRef.current = onOpenHouse;
  const deviceMarkerRef = useRef<google.maps.Marker | null>(null);
  const accuracyCircleRef = useRef<google.maps.Circle | null>(null);
  const listenersRef = useRef<google.maps.MapsEventListener[]>([]);
  const initialisedRef = useRef(false);
  const reportTimerRef = useRef<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
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
        const viewport = viewportOf(map);
        if (!viewport) return;
        onViewportChange(viewport);
        if (fromUser) setMoved(viewport);
      };
      if (immediate) {
        doReport();
      } else {
        reportTimerRef.current = window.setTimeout(doReport, 300);
      }
    },
    [onViewportChange],
  );

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        const initialCenter = device ?? (awaitingDeviceFix ? SERVICE_AREA_CENTRE : KAMPALA_CENTRE);
        const initialZoom = device ? LOCATED_ZOOM : awaitingDeviceFix ? SERVICE_AREA_ZOOM : KAMPALA_ZOOM;
        const map = new google.maps.Map(hostRef.current, {
          center: initialCenter,
          zoom: initialZoom,
          clickableIcons: false,
          disableDefaultUI: true,
          gestureHandling: isMobile || fullscreen ? 'greedy' : 'cooperative',
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
    if (!map || !device) return;
    map.panTo(device);
    map.setZoom(LOCATED_ZOOM);
  }, [device]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setOptions({ gestureHandling: isMobile || fullscreen ? 'greedy' : 'cooperative' });
    window.setTimeout(() => google.maps.event.trigger(map, 'resize'), 120);
  }, [fullscreen, isMobile]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;
    // Update markers in place, keyed by cell. Only pins whose data or state
    // changed are touched; removed cells are detached, new cells are added.
    const store = markersRef.current;
    const seen = new Set<string>();
    for (const cell of cells) {
      const house = cell.house;
      const id = house?.house_id ?? null;
      const active = !!id && (selectedIds.includes(id) || activeId === id);
      const saved = !!id && savedIds.includes(id);
      const amount = cell.amount || (house ? itemAmount('empty', house) : 0);
      const title = house
        ? `${emptyHouseTitle(house)}. ${formatDynamic(amount)} to support.`
        : `${cell.count} homes in this area from ${formatDynamic(amount)}.`;
      const sig = `${cell.lat},${cell.lng}|${amount}|${active}|${saved}|${title}`;
      seen.add(cell.key);
      const existing = store.get(cell.key);
      if (existing) {
        existing.cell = cell;
        if (existing.sig === sig) continue;
        existing.sig = sig;
        existing.marker.setPosition({ lat: cell.lat, lng: cell.lng });
        existing.marker.setIcon(getPricePinIcon(amount, active, saved));
        existing.marker.setTitle(title);
        existing.marker.setZIndex(active ? 30 : saved ? 25 : 10);
        continue;
      }
      const marker = new google.maps.Marker({
        map,
        position: { lat: cell.lat, lng: cell.lng },
        title,
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
    for (const [key, entry] of store) {
      if (!seen.has(key)) {
        entry.marker.setMap(null);
        google.maps.event.clearInstanceListeners(entry.marker);
        store.delete(key);
      }
    }
  }, [cells, selectedIds, savedIds, activeId]);

  useEffect(
    () => () => {
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
          fullscreen ? "absolute top-3 right-3 z-30 pt-safe" : "absolute bottom-7 right-2 sm:right-3"
        )}>
          {canUseLocation ? (
            <Button size="icon" variant="secondary" className="h-11 w-11 rounded-full border bg-card/95 shadow-lg backdrop-blur-sm" onClick={onUseMyLocation} aria-label={device ? 'Recentre on my location' : 'Use my location'}>
              {locating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Crosshair className={cn('h-4 w-4', device && 'text-primary')} aria-hidden />}
            </Button>
          ) : null}
          <Button ref={fullscreen ? closeRef : expandRef} size="icon" variant="secondary" className="h-11 w-11 rounded-full border bg-card/95 shadow-lg backdrop-blur-sm" onClick={() => setFullscreen((value) => !value)} aria-label={fullscreen ? 'Close the full screen map' : 'Expand the map'}>
            {fullscreen ? <X className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
          </Button>
          <Button size="icon" variant="secondary" className="h-11 w-11 rounded-full border bg-card/95 shadow-lg backdrop-blur-sm" onClick={() => { setMoved(null); onReset(); }} aria-label="Reset the map view">
            <RotateCcw className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    ),
    [areaSearchValue, canUseLocation, device, fullscreen, locating, moved, onAreaSearchChange, onReset, onSearchThisArea, onUseMyLocation],
  );

  return (
    <div className={cn('fn-map rounded-2xl', fullscreen && 'fn-map-fullscreen rounded-none')} {...(fullscreen ? { role: 'dialog' as const, 'aria-modal': true, 'aria-label': 'Full screen map of homes' } : {})}>
      <div ref={hostRef} className="h-full w-full" aria-label="Google map of available homes" />
      {mapError ? <div className="absolute inset-0 grid place-items-center bg-muted p-6 text-center text-sm text-muted-foreground">{mapError}</div> : null}
      {controls}
      <p className={cn(
        "pointer-events-none absolute left-2 right-2 z-10 w-fit max-w-[92%] rounded-md bg-card/90 px-2 py-1 text-[11px] leading-tight text-muted-foreground shadow-sm",
        fullscreen ? "top-3 left-3 pt-safe hidden sm:block" : "bottom-6"
      )}>{loadedNote}</p>
    </div>
  );
}

export default FunderNewRouteMap;