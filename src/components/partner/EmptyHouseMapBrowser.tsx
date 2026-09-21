import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, Rectangle, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { formatDynamic } from '@/lib/currencyFormat';
import { formatHouseCategory } from '@/lib/formatting';
import { ChevronLeft, ChevronRight, Crosshair, Flame, Home, Loader2, MapPin, Navigation, RefreshCw, Search, WifiOff, X } from 'lucide-react';
import { HighlightText, houseAddressLine, houseTitleLine, type SupportableHouse } from './SelfSupportHousesSection';
import { FundHouseTooltip } from './FundHouseTooltip';
import { useEmptyHouseMapCells, type MapViewport } from '@/hooks/useEmptyHouseMapCells';
import { supabase } from '@/integrations/supabase/client';

import { clusterMarkerLabel, clusterMarkerSize, clusterZoomTarget } from './emptyHouseMapCluster';
import { MapPerfOverlay } from './MapPerfOverlay';
import { HEAT_BUCKETS, heatBucketFor, heatmapAppliesAtZoom } from './emptyHouseHeatmap';
import { mapPerf } from '@/lib/mapPerf';
import { AFRICA_COUNTRIES, pointInCountry, type CountryBounds } from '@/lib/africaCountries';

interface EmptyHouseMapBrowserProps {
  houses: SupportableHouse[];
  selectedIds: string[];
  focusedId?: string | null;
  searchQuery: string;
  remaining: number;
  busy: boolean;
  /** Rent floor/ceiling currently applied to the list, mirrored on the map. */
  minRent?: number | null;
  maxRent?: number | null;
  /** District currently applied to the list, mirrored on the map. */
  district?: string | null;
  /**
   * District the map should zoom to WITHOUT filtering — set by the house
   * details sheet's "See more in <district>" button so the rest of the
   * houses stay visible around it.
   */
  zoomDistrict?: string | null;
  /** Coordinates to land on when the district was chosen from a house's details. */
  districtFocus?: { lat: number; lng: number } | null;

  /** Country box currently applied to the list — the map fits to it so the heatmap covers that country only. */
  country?: CountryBounds | null;
  /** Listing-age ceiling in days, applied in the database alongside the viewport. */
  maxAgeDays?: number | null;
  onSearchQueryChange: (query: string) => void;
  onOpenHouse: (house: SupportableHouse) => void;
  onFundHouse: (house: SupportableHouse) => void;
  /** Called when the user taps a marker or steps to a new house so the list can sort by distance from it. */
  onActiveHouseChange?: (house: SupportableHouse | null) => void;
  /**
   * Houses the map pulled straight from the database (outside the loaded list
   * page) so the parent can keep selection totals and funding accurate.
   */
  onHousesDiscovered?: (houses: SupportableHouse[]) => void;
}

const KAMPALA: [number, number] = [0.3476, 32.5825];
const LOCATION_GRANTED_KEY = 'welile-map-location-granted';
const MANUAL_AREA_KEY = 'welile-map-manual-area';

/** Reports the visible bounds + zoom so the database only aggregates what is on screen. */
function ViewportReporter({ onChange }: { onChange: (viewport: MapViewport) => void }) {
  const timer = useRef<number | null>(null);

  const report = useCallback(
    (map: L.Map) => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const bounds = map.getBounds();
        onChange({
          minLat: bounds.getSouth(),
          minLng: bounds.getWest(),
          maxLat: bounds.getNorth(),
          maxLng: bounds.getEast(),
          zoom: Math.round(map.getZoom()),
        });
      }, 300);
    },
    [onChange],
  );

  const map = useMapEvents({
    moveend: () => report(map),
    zoomend: () => report(map),
  });

  useEffect(() => {
    report(map);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [map, report]);

  return null;
}

function PanToHouse({ house }: { house: SupportableHouse | null }) {
  const map = useMap();

  useEffect(() => {
    if (!house) return;
    const lat = Number(house.latitude);
    const lng = Number(house.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    map.flyTo([lat, lng], Math.max(map.getZoom(), 15), { duration: 0.6 });
  }, [house, map]);

  return null;
}

function LocateMeButton({
  onLocated,
  onDenied,
}: {
  onLocated?: (point: [number, number]) => void;
  onDenied?: () => void;
}) {
  const map = useMap();
  const [locating, setLocating] = useState(false);

  const locate = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const point: [number, number] = [position.coords.latitude, position.coords.longitude];
        onLocated?.(point);
        map.flyTo(point, 14, { duration: 0.6 });
      },
      () => {
        setLocating(false);
        onDenied?.();
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      onClick={locate}
      disabled={locating}
      aria-label="Center the map on my location"
      className="absolute right-3 top-16 z-[1000] h-11 w-11 rounded-full border border-border bg-background/95 shadow-lg backdrop-blur sm:top-3"
    >
      <Crosshair className={`h-5 w-5${locating ? ' animate-pulse' : ''}`} aria-hidden />
    </Button>
  );
}

export function EmptyHouseMapBrowser({
  houses,
  selectedIds,
  focusedId,
  searchQuery,
  remaining,
  busy,
  minRent,
  maxRent,
  district,
  districtFocus,

  country,
  maxAgeDays,
  onSearchQueryChange,
  onOpenHouse,
  onFundHouse,
  onActiveHouseChange,
  onHousesDiscovered,
}: EmptyHouseMapBrowserProps) {
  const [activeHouse, setActiveHouse] = useState<SupportableHouse | null>(null);
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [userPosition, setUserPosition] = useState<[number, number] | null>(null);
  /** 'locating' = browser prompt open, 'granted' = located, 'denied'/'unsupported' = show the prompt. */
  const [geoStatus, setGeoStatus] = useState<'idle' | 'locating' | 'granted' | 'denied' | 'unsupported'>('idle');
  const [geoPromptDismissed, setGeoPromptDismissed] = useState(false);
  const [locationPreviouslyGranted, setLocationPreviouslyGranted] = useState(false);
  const [areaPickerOpen, setAreaPickerOpen] = useState(false);
  const [isOffline, setIsOffline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine === false : false,
  );

  useEffect(() => {
    const goOnline = () => setIsOffline(false);
    const goOffline = () => setIsOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Remember that the funder already approved location sharing so the gate
  // does not block the map on every return.
  useEffect(() => {
    try {
      setLocationPreviouslyGranted(window.localStorage.getItem(LOCATION_GRANTED_KEY) === 'true');
    } catch {
      // ignore storage errors
    }
  }, []);


  // Picking a country frames the map on that country, so the viewport query —
  // and therefore the density heatmap — only covers houses inside it.
  useEffect(() => {
    if (!mapInstance || !country) return;
    const [south, west, north, east] = country.bbox;
    mapInstance.fitBounds(L.latLngBounds([south, west], [north, east]), { padding: [24, 24] });
  }, [mapInstance, country]);

  const cellsQuery = useEmptyHouseMapCells(viewport, {
    search: searchQuery,
    district: district ?? undefined,
    minRent: minRent ?? null,
    maxRent: maxRent ?? null,
    maxAgeDays: maxAgeDays ?? null,
  });
  const rawCells = cellsQuery.data?.cells ?? [];
  // A viewport can spill past the chosen country's border — drop the pins that fall outside it.
  const cells = useMemo(
    () => (country ? rawCells.filter((cell) => pointInCountry(country, cell.latitude, cell.longitude)) : rawCells),
    [rawCells, country],
  );
  const housesInView = cellsQuery.data?.housesInView ?? 0;
  const cellSize = cellsQuery.data?.cellSize ?? 0;

  /**
   * Optional density view: tints each grid cell by how many empty houses it
   * holds, so a funder can read where the opportunities are across Africa
   * before zooming into clustered houses. Built from the cells already fetched.
   */
  const heatmapActive = showHeatmap && heatmapAppliesAtZoom(viewport?.zoom) && cellSize > 0;
  const heatTiles = useMemo(() => {
    if (!heatmapActive) return [];
    const half = cellSize / 2;
    return cells.map((cell) => ({
      key: `heat-${cell.key}`,
      cellKey: cell.key,
      count: cell.count,
      sumRent: cell.sumRent,
      minRent: cell.minRent,
      maxRent: cell.maxRent,
      district: cell.district,
      center: [cell.latitude, cell.longitude] as [number, number],
      bucket: heatBucketFor(cell.count),
      bounds: L.latLngBounds(
        [cell.latitude - half, cell.longitude - half],
        [cell.latitude + half, cell.longitude + half],
      ),
    }));
  }, [cells, cellSize, heatmapActive]);

  /**
   * A tapped density region: the funder reads how many empty houses the area
   * holds, the rent needed to fund all of them and the average rent, before
   * deciding to zoom into individual houses.
   */
  const [activeRegionKey, setActiveRegionKey] = useState<string | null>(null);
  const activeRegion = useMemo(
    () => heatTiles.find((tile) => tile.cellKey === activeRegionKey) ?? null,
    [heatTiles, activeRegionKey],
  );
  // Leaving the density view (or zooming past it) closes the summary.
  useEffect(() => {
    if (!heatmapActive) setActiveRegionKey(null);
  }, [heatmapActive]);

  /** Single-house cells, enriched with the fuller record when the list already holds it. */
  const mappedHouses = useMemo(() => {
    const loaded = new Map(houses.map((house) => [house.house_id, house]));
    return cells
      .filter((cell) => cell.count === 1 && cell.house)
      .map((cell) => loaded.get(cell.house!.house_id) ?? cell.house!);
  }, [cells, houses]);

  // Let the list keep accurate selection totals for houses only the map has seen.
  useEffect(() => {
    if (!onHousesDiscovered || mappedHouses.length === 0) return;
    onHousesDiscovered(mappedHouses);
  }, [mappedHouses, onHousesDiscovered]);

  useEffect(() => {
    onActiveHouseChange?.(activeHouse);
  }, [activeHouse, onActiveHouseChange]);

  useEffect(() => {
    if (!focusedId) return;
    const match = houses.find((house) => house.house_id === focusedId)
      ?? mappedHouses.find((house) => house.house_id === focusedId);
    if (match) setActiveHouse(match);
  }, [focusedId, houses, mappedHouses]);

  const initialFitDone = useRef(false);
  const manualAreaRestored = useRef(false);
  const initialLocateStarted = useRef(false);

  /**
   * The map always opens on the funder's own area — the single locate effect
   * lives further down (it needs the manual-area fallback), so nothing runs here.
   */


  /** Retry after the browser said no (or the funder dismissed the prompt and tapped again). */
  const retryLocate = useCallback(() => {
    if (!navigator.geolocation || !mapInstance) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point: [number, number] = [position.coords.latitude, position.coords.longitude];
        initialFitDone.current = true;
        setGeoStatus('granted');
        setGeoPromptDismissed(true);
        setUserPosition(point);
        try {
          window.localStorage.setItem(LOCATION_GRANTED_KEY, 'true');
          setLocationPreviouslyGranted(true);
        } catch {
          // ignore storage errors
        }
        mapInstance.flyTo(point, 13, { duration: 0.6 });
      },
      () => {
        setGeoStatus('denied');
        try {
          window.localStorage.removeItem(LOCATION_GRANTED_KEY);
          setLocationPreviouslyGranted(false);
        } catch {
          // ignore storage errors
        }
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 },
    );
  }, [mapInstance]);

  /**
   * Manual area choice: districts seen in the loaded houses (with one house's
   * coordinates as the anchor) plus every African country centre, so a funder
   * anywhere on the continent can tell the map where to look.
   */
  const manualAreaOptions = useMemo(() => {
    const districts = new Map<string, [number, number]>();
    houses.forEach((house) => {
      const key = String(house.district ?? '').trim();
      if (!key || districts.has(key)) return;
      const lat = Number(house.latitude);
      const lng = Number(house.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
        districts.set(key, [lat, lng]);
      }
    });
    const countryOptions = AFRICA_COUNTRIES.map((c) => ({
      label: c.name,
      point: [(c.bbox[0] + c.bbox[2]) / 2, (c.bbox[1] + c.bbox[3]) / 2] as [number, number],
    }));
    return [
      ...[...districts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, point]) => ({ label, point })),
      ...countryOptions,
    ];
  }, [houses]);

  const chooseManualArea = useCallback(
    (label: string) => {
      const match = manualAreaOptions.find((o) => o.label === label);
      if (!match || !mapInstance) return;
      initialFitDone.current = true;
      setGeoStatus('granted');
      setUserPosition(match.point);
      setGeoPromptDismissed(true);
      setAreaPickerOpen(false);
      try {
        window.localStorage.setItem(LOCATION_GRANTED_KEY, 'true');
        window.localStorage.setItem(MANUAL_AREA_KEY, label);
        setLocationPreviouslyGranted(true);
      } catch {
        // ignore storage errors
      }
      mapInstance.flyTo(match.point, 11, { duration: 0.6 });
    },
    [manualAreaOptions, mapInstance],
  );

  /**
   * When the funder taps "See more in <district>", land the map on that district.
   * The tapped house's own coordinates are the anchor, because some listings
   * carry stray coordinates that would otherwise stretch the view to the ocean.
   */
  useEffect(() => {
    if (!mapInstance || !zoomDistrict) return;
    let cancelled = false;
    const key = zoomDistrict.trim().toLowerCase();

    const usable = (rows: { latitude?: unknown; longitude?: unknown }[]) =>
      rows
        .map((h) => [Number(h.latitude), Number(h.longitude)] as [number, number])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0));

    const anchor: [number, number] | null =
      districtFocus &&
      Number.isFinite(districtFocus.lat) &&
      Number.isFinite(districtFocus.lng) &&
      (districtFocus.lat !== 0 || districtFocus.lng !== 0)
        ? [districtFocus.lat, districtFocus.lng]
        : null;

    const fit = (points: [number, number][]) => {
      if (cancelled) return;
      // Keep only houses near the anchor — a district is never hundreds of km wide.
      const near = anchor
        ? points.filter(([lat, lng]) => Math.abs(lat - anchor[0]) <= 1.5 && Math.abs(lng - anchor[1]) <= 1.5)
        : points;
      const usePoints = near.length > 0 ? near : anchor ? [anchor] : points;
      if (usePoints.length === 0) return;
      initialFitDone.current = true;
      if (usePoints.length === 1) mapInstance.flyTo(usePoints[0], 13, { duration: 0.6 });
      else mapInstance.fitBounds(L.latLngBounds(usePoints), { padding: [36, 36], maxZoom: 13 });
    };

    // Land immediately on the tapped house, then tighten once the district's houses are known.
    if (anchor) mapInstance.flyTo(anchor, 13, { duration: 0.6 });

    const local = usable(houses.filter((h) => String(h.district ?? '').trim().toLowerCase() === key));
    if (local.length > 0) {
      fit(local);
      return;
    }

    (async () => {
      const { data, error } = await supabase
        .from('house_listings')
        .select('latitude,longitude')
        .eq('status', 'available')
        .is('tenant_id', null)
        .eq('verified', true)
        .eq('is_hidden', false)
        .gt('monthly_rent', 0)
        .ilike('district', key)
        .not('latitude', 'is', null)
        .not('longitude', 'is', null)
        .limit(500);
      if (error || !data) return;
      fit(usable(data as { latitude?: unknown; longitude?: unknown }[]));
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [district, districtFocus, mapInstance]);




  /**
   * Ask the browser for the funder's location as soon as the map mounts, so the
   * houses nearest to them load first. If they refuse (or the browser cannot
   * tell us), fall back to a saved manual area, otherwise show the gate so they
   * can allow location or pick their area.
   */
  useEffect(() => {
    if (!mapInstance || userPosition || manualAreaRestored.current || initialLocateStarted.current) return;
    initialLocateStarted.current = true;
    if (!navigator.geolocation) {
      manualAreaRestored.current = true;
      const stored = window.localStorage.getItem(MANUAL_AREA_KEY);
      if (stored) chooseManualArea(stored);
      else setGeoStatus('unsupported');
      return;
    }
    let cancelled = false;
    setGeoStatus('locating');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (cancelled) return;
        const point: [number, number] = [position.coords.latitude, position.coords.longitude];
        initialFitDone.current = true;
        setGeoStatus('granted');
        setUserPosition(point);
        try {
          window.localStorage.setItem(LOCATION_GRANTED_KEY, 'true');
          setLocationPreviouslyGranted(true);
        } catch {
          // ignore storage errors
        }
        mapInstance.flyTo(point, 13, { duration: 0.6 });
      },
      () => {
        if (cancelled) return;
        const stored = window.localStorage.getItem(MANUAL_AREA_KEY);
        if (stored) {
          manualAreaRestored.current = true;
          chooseManualArea(stored);
        } else {
          setGeoStatus('denied');
        }
        try {
          window.localStorage.removeItem(LOCATION_GRANTED_KEY);
          setLocationPreviouslyGranted(false);
        } catch {
          // ignore storage errors
        }
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 },
    );
    return () => {
      cancelled = true;
    };
  }, [mapInstance, userPosition, chooseManualArea]);


  // Fallback: open the map over the first loaded houses, then leave the view under the funder's control.
  useEffect(() => {
    if (!mapInstance || initialFitDone.current) return;
    const points = houses
      .map((house) => [Number(house.latitude), Number(house.longitude)] as [number, number])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0));
    if (points.length === 0) return;
    initialFitDone.current = true;
    if (points.length === 1) mapInstance.setView(points[0], 15);
    else mapInstance.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 13 });
  }, [houses, mapInstance]);

  // Marker rendering time: stamped while the marker list is rebuilt, closed after commit.
  const markerRenderStart = useRef<number | null>(null);
  useMemo(() => {
    markerRenderStart.current = performance.now();
    return cells;
  }, [cells]);
  useEffect(() => {
    if (markerRenderStart.current == null) return;
    mapPerf.recordRender(performance.now() - markerRenderStart.current, cells.length);
    markerRenderStart.current = null;
  }, [cells]);

  const activeIndex = activeHouse
    ? mappedHouses.findIndex((house) => house.house_id === activeHouse.house_id)
    : -1;

  const stepHouse = (direction: 1 | -1) => {
    if (mappedHouses.length === 0) return;
    const base = activeIndex >= 0 ? activeIndex : 0;
    const next = activeIndex >= 0
      ? (base + direction + mappedHouses.length) % mappedHouses.length
      : base;
    setActiveHouse(mappedHouses[next]);
  };

  return (
    <div className="relative h-[26rem] w-full overflow-hidden bg-muted sm:h-[30rem] lg:h-[38rem]">
      <div className="absolute inset-x-3 top-3 z-[1000] sm:right-auto sm:w-[22rem]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="text"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            placeholder="Search district, neighborhood, or house"
            aria-label="Search empty houses by district, neighborhood, or house name"
            className="h-11 bg-background/95 pl-9 pr-10 text-sm shadow-lg backdrop-blur"
          />
          {searchQuery && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 h-9 w-9 -translate-y-1/2"
              onClick={() => onSearchQueryChange('')}
              aria-label="Clear house search"
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>

      <MapContainer
        center={KAMPALA}
        zoom={11}
        scrollWheelZoom
        preferCanvas
        attributionControl={false}
        className="h-full w-full"
        ref={setMapInstance}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
        {heatTiles.map((tile) => (
          <Rectangle
            key={tile.key}
            bounds={tile.bounds}
            interactive
            pathOptions={{
              stroke: tile.cellKey === activeRegionKey,
              color: 'hsl(var(--primary))',
              weight: 2,
              fillColor: tile.bucket.color,
              fillOpacity: tile.bucket.opacity,
            }}
            eventHandlers={{
              click: () => {
                setActiveHouse(null);
                setActiveRegionKey(tile.cellKey);
              },
            }}
          />
        ))}
        {cells.map((cell) => {
          const house = cell.count === 1 && cell.house
            ? (mappedHouses.find((item) => item.house_id === cell.house!.house_id) ?? cell.house)
            : null;

          if (house) {
            const active = selectedIds.includes(house.house_id) || focusedId === house.house_id;
            const categoryLabel = formatHouseCategory(house.house_category);
            const rentLabel = formatDynamic(Number(house.monthly_rent ?? 0));
            const icon = L.divIcon({
              className: 'empty-house-map-pin-hitbox',
              html: `<span class="empty-house-map-pin truncate${active ? ' empty-house-map-pin--active' : ''}">${rentLabel}</span>`,
              iconSize: [144, 44],
              iconAnchor: [72, 44],
            });

            return (
              <Marker
                key={house.house_id}
                position={[Number(house.latitude), Number(house.longitude)]}
                icon={icon}
                title={`${houseTitleLine(house)} · ${rentLabel}`}
                eventHandlers={{
                  click: () => {
                    onOpenHouse(house);
                  },
                }}
              />
            );
          }

          const size = clusterMarkerSize(cell.count);
          const label = clusterMarkerLabel(cell.count);
          const icon = L.divIcon({
            className: '',
            html: `<span class="empty-house-map-cluster" style="width:${size}px;height:${size}px">${label}</span>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
          });

          return (
            <Marker
              key={cell.key}
              position={[cell.latitude, cell.longitude]}
              icon={icon}
              title={`${cell.count.toLocaleString()} empty houses · ${formatDynamic(cell.minRent)} – ${formatDynamic(cell.maxRent)}`}
              eventHandlers={{
                click: () => {
                  setActiveHouse(null);
                  mapInstance?.flyTo([cell.latitude, cell.longitude], clusterZoomTarget(viewport?.zoom ?? 11), {
                    duration: 0.6,
                  });
                },
              }}
            />
          );
        })}
        {userPosition && (
          <Marker
            position={userPosition}
            interactive={false}
            title="Your location"
            icon={L.divIcon({
              className: '',
              html: '<span class="empty-house-map-me" aria-hidden="true"></span>',
              iconSize: [18, 18],
              iconAnchor: [9, 9],
            })}
          />
        )}
        <ViewportReporter onChange={setViewport} />
        <PanToHouse house={activeHouse} />
        <LocateMeButton
          onLocated={(point) => {
            setUserPosition(point);
            setGeoStatus('granted');
            setGeoPromptDismissed(true);
            try {
              window.localStorage.setItem(LOCATION_GRANTED_KEY, 'true');
              setLocationPreviouslyGranted(true);
            } catch {
              // ignore storage errors
            }
          }}
          onDenied={() => {
            setGeoStatus('denied');
            setGeoPromptDismissed(false);
            try {
              window.localStorage.removeItem(LOCATION_GRANTED_KEY);
              setLocationPreviouslyGranted(false);
            } catch {
              // ignore storage errors
            }
          }}
        />
      </MapContainer>

      {/* Location gate: houses are shown for the funder's own area. While the browser prompt is open we wait; it only appears if location was refused or is unavailable and no area was picked. */}
      {!userPosition && (geoStatus === 'denied' || geoStatus === 'unsupported') && !manualAreaRestored.current && (
        <div
          role="dialog"
          aria-label="Share your location to see empty houses near you"
          className="absolute inset-0 z-[1200] flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-4 text-center shadow-xl">
            <Navigation className="mx-auto h-6 w-6 text-primary" aria-hidden />
            <p className="mt-2 text-sm font-semibold">Share your location</p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {geoStatus === 'unsupported'
                ? 'This browser cannot share your location. Pick your area to see the empty houses there.'
                : geoStatus === 'denied'
                  ? 'Location access is off. Turn it on and try again, or pick your area yourself.'
                  : 'We show the empty houses around you, so we need your location first.'}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {geoStatus !== 'unsupported' && (
                <Button type="button" size="sm" className="h-9" onClick={retryLocate}>
                  <Crosshair className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {geoStatus === 'denied' ? 'Try again' : 'Use my location'}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9"
                onClick={() => setAreaPickerOpen((open) => !open)}
                aria-expanded={areaPickerOpen}
              >
                <MapPin className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                Choose my area
              </Button>
              {areaPickerOpen && (
                <label className="block text-left">
                  <span className="sr-only">Choose your district or country</span>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                    defaultValue=""
                    onChange={(e) => e.target.value && chooseManualArea(e.target.value)}
                  >
                    <option value="" disabled>
                      Pick your district or country…
                    </option>
                    {manualAreaOptions.map((option) => (
                      <option key={option.label} value={option.label}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>
        </div>
      )}


      {cellsQuery.isFetching && (
        <div
          role="status"
          className="absolute right-3 top-3 z-[1000] flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground shadow-sm backdrop-blur sm:right-16"
        >
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Loading houses in view
        </div>
      )}

      {(isOffline || cellsQuery.isError) && (
        <div
          role="alert"
          className="absolute inset-x-3 top-3 z-[1100] flex flex-col gap-2 rounded-xl border border-destructive/40 bg-background/95 p-3 shadow-lg backdrop-blur sm:inset-x-auto sm:left-3 sm:right-16"
        >
          <div className="flex items-start gap-2">
            <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <div className="text-xs leading-snug">
              <p className="font-semibold text-foreground">
                {isOffline ? "You're offline" : "Couldn't load houses in this area"}
              </p>
              <p className="text-muted-foreground">
                {isOffline
                  ? 'The map is showing the houses loaded before you lost connection. Reconnect and try again.'
                  : 'Your connection dropped while loading. The houses shown may be out of date.'}
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 self-start text-xs"
            onClick={() => void cellsQuery.refetch()}
            disabled={cellsQuery.isFetching}
          >
            {cellsQuery.isFetching ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            Try again
          </Button>
        </div>
      )}

      <Button
        type="button"
        variant={showHeatmap ? 'default' : 'secondary'}
        size="icon"
        onClick={() => setShowHeatmap((current) => !current)}
        aria-pressed={showHeatmap}
        aria-label={showHeatmap ? 'Hide the empty-house density map' : 'Show the empty-house density map'}
        title={showHeatmap ? 'Hide empty-house density' : 'Show empty-house density'}
        className="absolute right-3 top-[7.25rem] z-[1000] h-11 w-11 rounded-full border border-border shadow-lg backdrop-blur sm:top-[4.25rem]"
      >
        <Flame className="h-5 w-5" aria-hidden />
      </Button>

      {showHeatmap && (
        <div className="pointer-events-none absolute bottom-20 left-3 z-[1000] rounded-lg border border-border bg-background/95 px-2.5 py-2 shadow-lg backdrop-blur sm:bottom-24">
          <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Empty houses per area</p>
          {heatmapActive ? (
            <ul className="mt-1.5 space-y-1">
              {HEAT_BUCKETS.map((bucket) => (
                <li key={bucket.label} className="flex items-center gap-1.5 text-[10px] font-semibold text-foreground">
                  <span
                    className="h-3 w-4 rounded-sm border border-border"
                    style={{ backgroundColor: bucket.color, opacity: Math.min(1, bucket.opacity + 0.35) }}
                    aria-hidden
                  />
                  {bucket.label}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 max-w-[11rem] text-[10px] font-medium leading-snug text-muted-foreground">
              Zoom out to see how many empty houses each area holds.
            </p>
          )}
          {heatmapActive && (
            <p className="mt-1.5 max-w-[11rem] text-[10px] font-medium leading-snug text-muted-foreground">
              Tap a shaded area for its totals.
            </p>
          )}
        </div>
      )}

      {activeRegion && (
        <section
          aria-label="Summary of empty houses in the selected area"
          className="absolute inset-x-2 bottom-2 z-[1050] rounded-lg border border-border bg-background/95 p-3 shadow-xl backdrop-blur sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[20rem]"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Selected area</p>
              <p className="truncate text-sm font-bold text-foreground">
                {activeRegion.district ? `${activeRegion.district} area` : 'Empty houses here'}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setActiveRegionKey(null)}
              aria-label="Close area summary"
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>

          <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md bg-muted/60 p-2">
              <dt className="text-[10px] font-semibold text-muted-foreground">Empty houses</dt>
              <dd className="text-sm font-bold text-foreground">{activeRegion.count.toLocaleString()}</dd>
            </div>
            <div className="rounded-md bg-muted/60 p-2">
              <dt className="text-[10px] font-semibold text-muted-foreground">Rent needed</dt>
              <dd className="text-sm font-bold text-foreground">{formatDynamic(activeRegion.sumRent)}</dd>
            </div>
            <div className="rounded-md bg-muted/60 p-2">
              <dt className="text-[10px] font-semibold text-muted-foreground">Average rent</dt>
              <dd className="text-sm font-bold text-foreground">
                {formatDynamic(activeRegion.count > 0 ? Math.round(activeRegion.sumRent / activeRegion.count) : 0)}
              </dd>
            </div>
          </dl>

          <p className="mt-2 text-[11px] font-medium leading-snug text-muted-foreground">
            Rent runs from {formatDynamic(activeRegion.minRent)} to {formatDynamic(activeRegion.maxRent)} a month here.
          </p>

          <Button
            type="button"
            size="sm"
            className="mt-2 h-10 w-full text-xs font-bold"
            onClick={() => {
              setActiveRegionKey(null);
              mapInstance?.flyTo(activeRegion.center, clusterZoomTarget(viewport?.zoom ?? 11), { duration: 0.6 });
            }}
          >
            Zoom into these houses
          </Button>
        </section>
      )}


      <MapPerfOverlay />



      {!activeHouse && mappedHouses.length === 0 && (
        <div role="status" className="pointer-events-none absolute inset-x-2 bottom-2 z-[1000] rounded-lg border border-border bg-background/90 px-2.5 py-1.5 text-[10px] font-semibold text-muted-foreground shadow-sm backdrop-blur sm:inset-x-auto sm:left-3">
          {housesInView > 0
            ? `${housesInView.toLocaleString()}${cellsQuery.data?.scanCapped ? '+' : ''} empty houses in this area — tap a group or zoom in to see each house`
            : searchQuery.trim()
              ? 'No houses match this search in this area — move the map or clear the search'
              : 'No empty houses in this area yet — move or zoom out the map'}
        </div>
      )}
    </div>
  );
}