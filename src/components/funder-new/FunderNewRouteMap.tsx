import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './funderNewMap.css';
import { Crosshair, Loader2, Maximize2, RotateCcw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDynamicCompact } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import type { FunderNewEmptyHouse } from './types';
import { emptyHouseTitle, itemAmount } from './utils';

/** Uganda-wide fallback view. Never presented as the user's position. */
const SERVICE_AREA_CENTRE: [number, number] = [1.3733, 32.2903];
const SERVICE_AREA_ZOOM = 7;
const LOCATED_ZOOM = 13;
const CLUSTER_CELL_PX = 74;

export interface FunderNewViewport {
  lat: number;
  lng: number;
  radiusKm: number;
  /** Visible bounds + zoom, so the database can aggregate exactly this view. */
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  zoom: number;
}

/**
 * One aggregated grid cell from the database. A cell holding a single house
 * carries that house, so it renders as a price pin; a busier cell renders as a
 * counted cluster.
 */
export interface FunderNewMapCell {
  key: string;
  count: number;
  lat: number;
  lng: number;
  amount: number;
  house: FunderNewEmptyHouse | null;
}


function radiusKmOf(map: L.Map): number {
  const bounds = map.getBounds();
  const centre = bounds.getCenter();
  const metres = centre.distanceTo(bounds.getNorthEast());
  return Math.max(1, Math.round(metres / 1000));
}

/** Centre, radius, bounds and zoom of the current view in one reading. */
function viewportOf(map: L.Map): FunderNewViewport {
  const bounds = map.getBounds();
  const centre = bounds.getCenter();
  return {
    lat: centre.lat,
    lng: centre.lng,
    radiusKm: radiusKmOf(map),
    minLat: bounds.getSouth(),
    minLng: bounds.getWest(),
    maxLat: bounds.getNorth(),
    maxLng: bounds.getEast(),
    zoom: Math.round(map.getZoom()),
  };
}

function priceIcon(label: string, active: boolean, saved: boolean): L.DivIcon {
  const width = Math.max(46, Math.round(14 + label.length * 7.4));
  return L.divIcon({
    className: 'fn-map-divicon',
    html: `<span class="fn-map-price${active ? ' fn-map-price--active' : ''}${
      saved ? ' fn-map-price--saved' : ''
    }">${label}</span>`,
    iconSize: [width, 26],
    iconAnchor: [width / 2, 13],
  });
}

function clusterIcon(count: number): L.DivIcon {
  const size = count < 10 ? 34 : count < 100 ? 40 : 48;
  return L.divIcon({
    className: 'fn-map-divicon',
    html: `<span class="fn-map-cluster${count >= 100 ? ' fn-map-cluster--lg' : ''}" style="width:${size}px;height:${size}px">${
      count > 999 ? '999+' : count
    }</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function meIcon(): L.DivIcon {
  return L.divIcon({ className: 'fn-map-divicon', html: '<span class="fn-map-me"></span>', iconSize: [16, 16], iconAnchor: [8, 8] });
}

/**
 * Applies the automatic initial centre exactly once.
 *
 * The fallback fitBounds is deliberately withheld while an automatic
 * (already-granted) location fix is still in flight, so a late success is never
 * overridden by the fallback.
 */
function InitialView({
  device,
  points,
  awaitingDeviceFix,
}: {
  device: { lat: number; lng: number } | null;
  points: { lat: number; lng: number }[];
  awaitingDeviceFix: boolean;
}) {
  const map = useMap();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    if (device) {
      done.current = true;
      map.setView([device.lat, device.lng], LOCATED_ZOOM, { animate: false });
      return;
    }
    if (awaitingDeviceFix) return;
    if (points.length === 0) return;
    done.current = true;
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 12, { animate: false });
      return;
    }
    map.fitBounds(
      points.map((point) => [point.lat, point.lng] as [number, number]),
      { padding: [28, 28], maxZoom: 12, animate: false },
    );
  }, [map, device, points, awaitingDeviceFix]);

  return null;
}

function ViewportReporter({
  onChange,
  onMoved,
}: {
  onChange: (viewport: FunderNewViewport) => void;
  onMoved: (viewport: FunderNewViewport) => void;
}) {
  const map = useMap();
  const timer = useRef<number | null>(null);

  const report = useCallback(
    (fromUser: boolean) => {
      const viewport = viewportOf(map);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        onChange(viewport);
        if (fromUser) onMoved(viewport);
      }, 400);
    },
    [map, onChange, onMoved],
  );

  useMapEvents({
    moveend: (event) => report(!!(event as unknown as { originalEvent?: unknown }).originalEvent || true),
    zoomend: () => report(true),
  });

  useEffect(() => {
    onChange(viewportOf(map));
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
    // Intentionally reports the first viewport only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

/**
 * Renders the database's aggregated cells, then merges any that would still
 * collide on screen so pins never stack on top of each other.
 */
function CellLayer({
  cells,
  selectedIds,
  savedIds,
  activeId,
  onOpenHouse,
}: {
  cells: FunderNewMapCell[];
  selectedIds: string[];
  savedIds: string[];
  activeId: string | null;
  onOpenHouse: (house: FunderNewEmptyHouse) => void;
}) {
  const map = useMap();
  const [, setTick] = useState(0);

  useMapEvents({
    moveend: () => setTick((value) => value + 1),
    zoomend: () => setTick((value) => value + 1),
    resize: () => setTick((value) => value + 1),
  });

  const groups = useMemo(() => {
    const buckets = new Map<string, FunderNewMapCell[]>();
    cells.forEach((cell) => {
      let key = cell.key;
      try {
        const pixel = map.latLngToContainerPoint([cell.lat, cell.lng]);
        key = `${Math.floor(pixel.x / CLUSTER_CELL_PX)}:${Math.floor(pixel.y / CLUSTER_CELL_PX)}`;
      } catch {
        key = `${cell.lat.toFixed(2)}:${cell.lng.toFixed(2)}`;
      }
      const bucket = buckets.get(key);
      if (bucket) bucket.push(cell);
      else buckets.set(key, [cell]);
    });
    return [...buckets.values()];
    // Recomputed on every pan/zoom tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, cells, setTick]);

  return (
    <>
      {groups.map((group) => {
        const houses = group
          .map((cell) => (cell.house ? { cell, house: cell.house } : null))
          .filter((entry): entry is { cell: FunderNewMapCell; house: FunderNewEmptyHouse } => entry !== null);
        const total = group.reduce((sum, cell) => sum + Math.max(1, cell.count), 0);
        const activeEntry = houses.find((entry) => entry.house.house_id === activeId);

        // A bucket that holds the open home always shows individual pins, so the
        // selected home stays visible.
        if (total > 1 && !activeEntry) {
          const lat = group.reduce((sum, cell) => sum + cell.lat, 0) / group.length;
          const lng = group.reduce((sum, cell) => sum + cell.lng, 0) / group.length;
          return (
            <Marker
              key={`cluster:${group[0].key}:${total}`}
              position={[lat, lng]}
              icon={clusterIcon(total)}
              keyboard
              alt={`${total} homes in this area. Zoom in to see each one.`}
              eventHandlers={{
                click: () => map.setView([lat, lng], Math.min(map.getZoom() + 2, 17), { animate: true }),
                keypress: () => map.setView([lat, lng], Math.min(map.getZoom() + 2, 17), { animate: true }),
              }}
            />
          );
        }

        return houses.map(({ cell, house }) => {
          const id = house.house_id;
          const amount = cell.amount || itemAmount('empty', house);
          return (
            <Marker
              key={id}
              position={[cell.lat, cell.lng]}
              icon={priceIcon(
                formatDynamicCompact(amount),
                selectedIds.includes(id) || activeId === id,
                savedIds.includes(id),
              )}
              keyboard
              alt={`${emptyHouseTitle(house)}. ${formatDynamicCompact(amount)} to support. Open details.`}
              eventHandlers={{
                click: () => onOpenHouse(house),
                keypress: () => onOpenHouse(house),
              }}
            />
          );
        });
      })}
    </>
  );
}

function Resizer({ token }: { token: unknown }) {
  const map = useMap();
  useEffect(() => {
    const id = window.setTimeout(() => map.invalidateSize(), 120);
    return () => window.clearTimeout(id);
  }, [map, token]);
  return null;
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
  const [fullscreen, setFullscreen] = useState(false);
  const [moved, setMoved] = useState<FunderNewViewport | null>(null);
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const points = useMemo(() => cells.map((cell) => ({ lat: cell.lat, lng: cell.lng })), [cells]);

  // Escape closes full screen; focus is moved in and restored on close.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setFullscreen(false);
      }
    };
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
    // Restores focus after the surface closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  const controls = (
    <div className="pointer-events-none absolute inset-0 z-[500]">
      {/* One compact floating area search */}
      <div className="pointer-events-auto absolute left-2 right-2 top-2 hidden gap-2 sm:left-3 sm:right-3 sm:top-3">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search homes by area</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={areaSearchValue}
            onChange={(event) => onAreaSearchChange(event.target.value)}
            placeholder="Search an area"
            className="h-11 rounded-full border-border/70 bg-card pl-9 text-sm shadow-md"
          />
        </label>
      </div>

      {/* "Search this area" only appears after a deliberate move */}
      {moved ? (
        <div className="pointer-events-auto absolute left-1/2 top-16 hidden -translate-x-1/2 sm:top-[4.25rem]">
          <Button
            size="sm"
            className="h-10 rounded-full px-4 shadow-lg"
            onClick={() => {
              onSearchThisArea(moved);
              setMoved(null);
            }}
          >
            <Search className="h-4 w-4" aria-hidden />
            Search this area
          </Button>
        </div>
      ) : null}

      {/* Coherent control group */}
      <div className="pointer-events-auto absolute bottom-7 right-2 flex flex-col gap-2 sm:right-3">
        {canUseLocation ? (
          <Button
            size="icon"
            variant="secondary"
            className="h-11 w-11 rounded-full border bg-card shadow-md"
            onClick={onUseMyLocation}
            aria-label={device ? 'Recentre on my location' : 'Use my location'}
          >
            {locating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Crosshair className={cn('h-4 w-4', device && 'text-[hsl(214_90%_45%)]')} aria-hidden />
            )}
          </Button>
        ) : null}
        <Button
          ref={fullscreen ? closeRef : expandRef}
          size="icon"
          variant="secondary"
          className="h-11 w-11 rounded-full border bg-card shadow-md"
          onClick={() => setFullscreen((value) => !value)}
          aria-label={fullscreen ? 'Close the full screen map' : 'Expand the map'}
        >
          {fullscreen ? <X className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
        </Button>
        <Button
          size="icon"
          variant="secondary"
          className="h-11 w-11 rounded-full border bg-card shadow-md"
          onClick={() => {
            setMoved(null);
            onReset();
          }}
          aria-label="Reset the map view"
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  );

  return (
    <div
      className={cn('fn-map rounded-2xl', fullscreen && 'fn-map-fullscreen rounded-none')}
      {...(fullscreen ? { role: 'dialog' as const, 'aria-modal': true, 'aria-label': 'Full screen map of homes' } : {})}
    >
      <MapContainer
        center={device ? [device.lat, device.lng] : SERVICE_AREA_CENTRE}
        zoom={device ? LOCATED_ZOOM : SERVICE_AREA_ZOOM}
        zoomControl={false}
        scrollWheelZoom={fullscreen}
        // Two-finger pan on touch avoids trapping the page scroll.
        dragging
        className="h-full w-full"
      >
        {/* Same keyless OpenStreetMap tiles the app's other maps use: CARTO
            basemaps now watermark unkeyed requests. */}
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />

        <InitialView
          device={device}
          points={points}
          awaitingDeviceFix={awaitingDeviceFix}
        />
        <ViewportReporter onChange={onViewportChange} onMoved={setMoved} />
        <Resizer token={fullscreen} />

        {device ? (
          <>
            {device.accuracyM && device.accuracyM > 40 && device.accuracyM < 3000 ? (
              <Circle
                center={[device.lat, device.lng]}
                radius={device.accuracyM}
                pathOptions={{
                  color: 'hsl(214 90% 52%)',
                  fillColor: 'hsl(214 90% 52%)',
                  fillOpacity: 0.1,
                  weight: 1,
                }}
              />
            ) : null}
            <Marker position={[device.lat, device.lng]} icon={meIcon()} alt="Your current location" interactive={false} />
          </>
        ) : null}

        <CellLayer
          cells={cells}
          selectedIds={selectedIds}
          savedIds={savedIds}
          activeId={activeId}
          onOpenHouse={onOpenHouse}
        />
      </MapContainer>

      {controls}

      {/* Readable caption chip: plain text over tiles collided with the
          attribution line and was hard to read. */}
      <p className="pointer-events-none absolute bottom-6 left-2 right-2 z-[500] w-fit max-w-[92%] rounded-md bg-card/90 px-2 py-1 text-[11px] leading-tight text-muted-foreground shadow-sm">
        {loadedNote}
      </p>

    </div>
  );
}

export default FunderNewRouteMap;
