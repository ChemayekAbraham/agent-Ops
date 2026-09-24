import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Loader2, Maximize2, RotateCcw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDynamic } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import type { FunderNewEmptyHouse } from './types';
import { emptyHouseTitle, itemAmount } from './utils';
import './funderNewMap.css';

const SERVICE_AREA_CENTRE = { lat: 1.3733, lng: 32.2903 };
const SERVICE_AREA_ZOOM = 7;
const LOCATED_ZOOM = 13;
const KAMPALA_CENTRE = { lat: 0.3476, lng: 32.5825 };
const KAMPALA_ZOOM = 12;

let mapsPromise: Promise<typeof google.maps> | null = null;

// The billed Maps key lives in the secret store, so it is fetched once per
// session rather than compiled into the bundle. The connector key is only a
// fallback for environments where the function is unavailable.
async function resolveMapsKey(): Promise<string> {
  try {
    const { data, error } = await supabase.functions.invoke('maps-browser-key');
    if (!error && data && typeof (data as { key?: string }).key === 'string') {
      return (data as { key: string }).key;
    }
  } catch {
    // fall through to the connector key
  }
  const fallback = import.meta.env['VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY'] as string | undefined;
  if (fallback) return fallback;
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
        const params = new URLSearchParams({ key, loading: 'async', callback: callbackName, libraries: 'geometry,marker' });
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

function markerIcon(active: boolean, saved: boolean): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: active ? 9 : saved ? 8 : 7,
    fillColor: 'hsl(270 100% 40%)',
    fillOpacity: 1,
    strokeColor: 'hsl(0 0% 100%)',
    strokeWeight: active || saved ? 3 : 2,
  };
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
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
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
    (fromUser: boolean) => {
      const map = mapRef.current;
      if (!map) return;
      if (reportTimerRef.current) window.clearTimeout(reportTimerRef.current);
      reportTimerRef.current = window.setTimeout(() => {
        const viewport = viewportOf(map);
        if (!viewport) return;
        onViewportChange(viewport);
        if (fromUser) setMoved(viewport);
      }, 400);
    },
    [onViewportChange],
  );

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        const map = new google.maps.Map(hostRef.current, {
          center: device ?? SERVICE_AREA_CENTRE,
          zoom: device ? LOCATED_ZOOM : SERVICE_AREA_ZOOM,
          clickableIcons: false,
          disableDefaultUI: true,
          gestureHandling: fullscreen ? 'greedy' : 'cooperative',
          styles: [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }],
        });
        mapRef.current = map;
        listenersRef.current = [
          map.addListener('idle', () => {
            const first = !initialisedRef.current;
            initialisedRef.current = true;
            reportViewport(!first);
          }),
        ];
        if (device) map.panTo(device);
        else if (!awaitingDeviceFix) {
          map.setCenter(KAMPALA_CENTRE);
          map.setZoom(KAMPALA_ZOOM);
        }
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
    map.setOptions({ gestureHandling: fullscreen ? 'greedy' : 'cooperative' });
    window.setTimeout(() => google.maps.event.trigger(map, 'resize'), 120);
  }, [fullscreen]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;
    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current = cells.map((cell) => {
      const house = cell.house;
      const id = house?.house_id ?? null;
      const active = !!id && (selectedIds.includes(id) || activeId === id);
      const saved = !!id && savedIds.includes(id);
      const isCluster = cell.count > 1 || !house;
      const amount = cell.amount || (house ? itemAmount('empty', house) : 0);
      const marker = new google.maps.Marker({
        map,
        position: { lat: cell.lat, lng: cell.lng },
        title: isCluster ? `${cell.count} homes in this area` : `${emptyHouseTitle(house)}. ${formatDynamic(amount)} to support.`,
        icon: isCluster
          ? {
              path: google.maps.SymbolPath.CIRCLE,
              scale: cell.count >= 100 ? 24 : cell.count >= 10 ? 20 : 17,
              fillColor: 'hsl(270 100% 40%)',
              fillOpacity: 0.94,
              strokeColor: 'hsl(0 0% 100%)',
              strokeWeight: 2,
            }
          : markerIcon(active, saved),
        label: {
          text: isCluster ? (cell.count > 999 ? '999+' : String(cell.count)) : formatDynamic(amount),
          color: 'hsl(0 0% 100%)',
          fontSize: isCluster ? '12px' : '11px',
          fontWeight: '700',
          className: isCluster ? 'fn-google-cluster-label' : 'fn-google-price-label',
        },
        zIndex: active ? 30 : isCluster ? 20 : 10,
      });
      marker.addListener('click', () => {
        if (house && !isCluster) onOpenHouse(house);
        else {
          map.panTo({ lat: cell.lat, lng: cell.lng });
          map.setZoom(Math.min((map.getZoom() ?? KAMPALA_ZOOM) + 2, 17));
        }
      });
      return marker;
    });
    return () => {
      markersRef.current.forEach((marker) => marker.setMap(null));
      markersRef.current = [];
    };
  }, [cells, selectedIds, savedIds, activeId, onOpenHouse]);

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
        <div className="pointer-events-auto absolute bottom-7 right-2 flex flex-col gap-2 sm:right-3">
          {canUseLocation ? (
            <Button size="icon" variant="secondary" className="h-11 w-11 rounded-full border bg-card shadow-md" onClick={onUseMyLocation} aria-label={device ? 'Recentre on my location' : 'Use my location'}>
              {locating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Crosshair className={cn('h-4 w-4', device && 'text-primary')} aria-hidden />}
            </Button>
          ) : null}
          <Button ref={fullscreen ? closeRef : expandRef} size="icon" variant="secondary" className="h-11 w-11 rounded-full border bg-card shadow-md" onClick={() => setFullscreen((value) => !value)} aria-label={fullscreen ? 'Close the full screen map' : 'Expand the map'}>
            {fullscreen ? <X className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
          </Button>
          <Button size="icon" variant="secondary" className="h-11 w-11 rounded-full border bg-card shadow-md" onClick={() => { setMoved(null); onReset(); }} aria-label="Reset the map view">
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
      <p className="pointer-events-none absolute bottom-6 left-2 right-2 z-10 w-fit max-w-[92%] rounded-md bg-card/90 px-2 py-1 text-[11px] leading-tight text-muted-foreground shadow-sm">{loadedNote}</p>
    </div>
  );
}

export default FunderNewRouteMap;