import { memo, useEffect, useRef, useState } from 'react';
import { formatDynamic } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import {
  getPricePinIcon,
  loadGoogleMaps,
  viewportOf,
  type FunderNewMapCell,
  type FunderNewViewport,
} from '@/components/funder-new/FunderNewRouteMap';
import type { FunderNewEmptyHouse } from '@/components/funder-new/types';
import { emptyHouseTitle, itemAmount } from '@/components/funder-new/utils';

const KAMPALA_CENTRE = { lat: 0.3476, lng: 32.5825 };
const KAMPALA_ZOOM = 12;
const LOCATED_ZOOM = 14;
/** Land colour of the base map, painted before the first tile arrives. */
const MAP_GROUND = '#EDEFE6';
/** Markers touched per animation frame, so a full redraw never blocks a slow phone. */
const MARKERS_PER_FRAME = 40;
/** Quiet time after the map settles before the viewport is reported. */
const VIEWPORT_SETTLE_MS = 180;

type MarkerEntry = { marker: google.maps.Marker; sig: string; cell: FunderNewMapCell };

/**
 * Full-bleed map for the /dashboard/funder-preview landing.
 *
 * Built for low-end phones:
 * - houses arrive pre-aggregated per tile (useEmptyHouseMapCells), so the
 *   marker count stays bounded at any zoom;
 * - markers are diffed by cell key and only changed pins are touched, spread
 *   over animation frames instead of one long task;
 * - pin icons are cached SVGs and markers use the optimized canvas layer;
 * - the viewport is reported once the map is idle, never on every frame;
 * - the component is memoised and reads callbacks through refs, so page
 *   state changes (typing, chips, the list) never re-render the map.
 */
function FunderPreviewMapImpl({
  cells,
  device,
  activeId,
  selectedIds,
  recentreToken,
  onViewportChange,
  onOpenHouse,
  className,
}: {
  cells: FunderNewMapCell[];
  device: { lat: number; lng: number; accuracyM: number | null } | null;
  activeId: string | null;
  selectedIds: string[];
  /** Bump to pan back to the device position. */
  recentreToken: number;
  onViewportChange: (viewport: FunderNewViewport, fromUser: boolean) => void;
  onOpenHouse: (house: FunderNewEmptyHouse) => void;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, MarkerEntry>>(new Map());
  const deviceMarkerRef = useRef<google.maps.Marker | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const programmaticMoveRef = useRef(true);
  const centredOnDeviceRef = useRef(false);
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  const onOpenHouseRef = useRef(onOpenHouse);
  onOpenHouseRef.current = onOpenHouse;

  const [ready, setReady] = useState(false);
  const [tilesShown, setTilesShown] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const listeners: google.maps.MapsEventListener[] = [];
    const markers = markersRef.current;
    loadGoogleMaps()
      .then(() => {
        if (cancelled || !hostRef.current) return;
        const map = new google.maps.Map(hostRef.current, {
          center: KAMPALA_CENTRE,
          zoom: KAMPALA_ZOOM,
          minZoom: 6,
          maxZoom: 18,
          backgroundColor: MAP_GROUND,
          clickableIcons: false,
          disableDefaultUI: true,
          keyboardShortcuts: false,
          gestureHandling: 'greedy',
          isFractionalZoomEnabled: false,
          tilt: 0,
          heading: 0,
          styles: [
            { featureType: 'poi', stylers: [{ visibility: 'off' }] },
            { featureType: 'transit', stylers: [{ visibility: 'off' }] },
          ],
        });
        mapRef.current = map;

        // Moves we start ourselves set programmaticMoveRef first; any other settle
        // (drag, pinch, wheel, double-tap) is the user's own move.
        listeners.push(
          map.addListener('idle', () => {
            if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
            settleTimerRef.current = window.setTimeout(() => {
              const viewport = viewportOf(map);
              if (!viewport) return;
              const fromUser = !programmaticMoveRef.current;
              programmaticMoveRef.current = false;
              onViewportChangeRef.current(viewport, fromUser);
            }, VIEWPORT_SETTLE_MS);
          }),
        );
        listeners.push(google.maps.event.addListenerOnce(map, 'tilesloaded', () => setTilesShown(true)));
        setReady(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMapError(error instanceof Error ? error.message : 'Google Maps could not be loaded.');
      });
    return () => {
      cancelled = true;
      listeners.forEach((listener) => listener.remove());
      if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
      markers.forEach((entry) => {
        google.maps.event.clearInstanceListeners(entry.marker);
        entry.marker.setMap(null);
      });
      markers.clear();
      deviceMarkerRef.current?.setMap(null);
      mapRef.current = null;
    };
  }, []);

  // Centre on the device the first time a fix arrives; later fixes never yank the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !device || centredOnDeviceRef.current) return;
    centredOnDeviceRef.current = true;
    programmaticMoveRef.current = true;
    map.panTo(device);
    map.setZoom(LOCATED_ZOOM);
  }, [ready, device]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !device || recentreToken === 0) return;
    programmaticMoveRef.current = true;
    map.panTo(device);
    if ((map.getZoom() ?? 0) < LOCATED_ZOOM) map.setZoom(LOCATED_ZOOM);
  }, [ready, recentreToken, device]);

  // Device dot.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (!device) {
      deviceMarkerRef.current?.setMap(null);
      deviceMarkerRef.current = null;
      return;
    }
    if (deviceMarkerRef.current) {
      deviceMarkerRef.current.setPosition(device);
      return;
    }
    deviceMarkerRef.current = new google.maps.Marker({
      map,
      position: device,
      clickable: false,
      title: 'Your current location',
      zIndex: 50,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: '#2D7FF0',
        fillOpacity: 1,
        strokeColor: '#FFFFFF',
        strokeWeight: 3,
      },
    });
  }, [ready, device]);

  // Marker reconciliation, spread over frames.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const store = markersRef.current;
    const seen = new Set<string>();
    const work: Array<() => void> = [];

    for (const cell of cells) {
      seen.add(cell.key);
      const house = cell.house;
      const id = house?.house_id ?? null;
      const active = !!id && (activeId === id || selectedIds.includes(id));
      const amount = cell.amount || (house ? itemAmount('empty', house) : 0);
      const title = house
        ? `${emptyHouseTitle(house)}. ${formatDynamic(amount)} to support.`
        : `${cell.count} homes here from ${formatDynamic(amount)}. Tap to zoom in.`;
      const sig = `${cell.lat},${cell.lng}|${amount}|${active}|${title}`;
      const existing = store.get(cell.key);
      if (existing) {
        existing.cell = cell;
        if (existing.sig === sig) continue;
        work.push(() => {
          existing.sig = sig;
          existing.marker.setPosition({ lat: cell.lat, lng: cell.lng });
          existing.marker.setIcon(getPricePinIcon(amount, active, false));
          existing.marker.setTitle(title);
          existing.marker.setZIndex(active ? 30 : 10);
        });
        continue;
      }
      work.push(() => {
        if (store.has(cell.key)) return;
        const marker = new google.maps.Marker({
          map,
          position: { lat: cell.lat, lng: cell.lng },
          title,
          icon: getPricePinIcon(amount, active, false),
          zIndex: active ? 30 : 10,
          optimized: true,
        });
        const entry: MarkerEntry = { marker, sig, cell };
        marker.addListener('click', () => {
          const current = entry.cell;
          if (current.house) {
            onOpenHouseRef.current(current.house as FunderNewEmptyHouse);
            return;
          }
          programmaticMoveRef.current = false;
          map.panTo({ lat: current.lat, lng: current.lng });
          map.setZoom(Math.min((map.getZoom() ?? KAMPALA_ZOOM) + 2, 17));
        });
        store.set(cell.key, entry);
      });
    }

    // Removals go first so the map never holds old and new pins at once.
    const removals: Array<() => void> = [];
    for (const [key, entry] of store) {
      if (seen.has(key)) continue;
      removals.push(() => {
        google.maps.event.clearInstanceListeners(entry.marker);
        entry.marker.setMap(null);
        store.delete(key);
      });
    }
    const queue = [...removals, ...work];
    if (queue.length === 0) return;

    let index = 0;
    let frame = 0;
    const step = () => {
      const end = Math.min(index + MARKERS_PER_FRAME, queue.length);
      for (; index < end; index += 1) queue[index]();
      if (index < queue.length) frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [ready, cells, activeId, selectedIds]);

  return (
    <div className={cn('relative h-full w-full overflow-hidden', className)} style={{ background: MAP_GROUND }}>
      {/* Placeholder streets while the first tiles load, so the hero never flashes blank. */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-0 transition-opacity duration-500 motion-reduce:transition-none',
          tilesShown ? 'opacity-0' : 'opacity-100',
        )}
        style={{
          backgroundImage:
            'linear-gradient(100deg, transparent 46%, rgba(255,255,255,0.9) 46% 49%, transparent 49%), linear-gradient(10deg, transparent 58%, rgba(255,255,255,0.9) 58% 60%, transparent 60%), linear-gradient(170deg, transparent 30%, rgba(255,255,255,0.8) 30% 31.5%, transparent 31.5%)',
        }}
      />
      <div
        ref={hostRef}
        aria-label="Map of houses waiting for support"
        className={cn(
          'absolute inset-0 transition-opacity duration-500 motion-reduce:transition-none',
          tilesShown ? 'opacity-100' : 'opacity-0',
        )}
        style={{ contain: 'strict' }}
      />
      {mapError ? (
        <div className="absolute inset-0 grid place-items-center bg-muted p-6 text-center text-sm text-muted-foreground">
          {mapError}
        </div>
      ) : null}
    </div>
  );
}

export const FunderPreviewMap = memo(FunderPreviewMapImpl);
