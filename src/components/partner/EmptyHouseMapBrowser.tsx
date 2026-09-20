import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { formatDynamic } from '@/lib/currencyFormat';
import { ChevronLeft, ChevronRight, Crosshair, Home, MapPin, Navigation, Search, X } from 'lucide-react';
import { HighlightText, houseAddressLine, houseTitleLine, type SupportableHouse } from './SelfSupportHousesSection';
import { FundHouseTooltip } from './FundHouseTooltip';

interface EmptyHouseMapBrowserProps {
  houses: SupportableHouse[];
  selectedIds: string[];
  focusedId?: string | null;
  searchQuery: string;
  remaining: number;
  busy: boolean;
  onSearchQueryChange: (query: string) => void;
  onOpenHouse: (house: SupportableHouse) => void;
  onFundHouse: (house: SupportableHouse) => void;
  /** Called when the user taps a marker or steps to a new house so the list can sort by distance from it. */
  onActiveHouseChange?: (house: SupportableHouse | null) => void;
}

const KAMPALA: [number, number] = [0.3476, 32.5825];
const isUgandaCoordinate = (house: SupportableHouse) => {
  const lat = Number(house.latitude);
  const lng = Number(house.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -1.6 && lat <= 4.4 && lng >= 29.4 && lng <= 35.1;
};

function FitHouseBounds({ houses }: { houses: SupportableHouse[] }) {
  const map = useMap();

  useEffect(() => {
    const points = houses
      .map((house) => [Number(house.latitude), Number(house.longitude)] as [number, number])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0));

    if (points.length === 0) {
      map.setView(KAMPALA, 11);
      return;
    }
    if (points.length === 1) {
      map.setView(points[0], 15);
      return;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 14 });
  }, [houses, map]);

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

function LocateMeButton() {
  const map = useMap();
  const [locating, setLocating] = useState(false);

  const locate = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        map.flyTo([position.coords.latitude, position.coords.longitude], 14, { duration: 0.6 });
      },
      () => setLocating(false),
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
  onSearchQueryChange,
  onOpenHouse,
  onFundHouse,
  onActiveHouseChange,
}: EmptyHouseMapBrowserProps) {
  const [activeHouse, setActiveHouse] = useState<SupportableHouse | null>(null);
  const mappedHouses = useMemo(
    () =>
      houses
        .filter(isUgandaCoordinate),
    [houses],
  );

  useEffect(() => {
    if (activeHouse && !houses.some((house) => house.house_id === activeHouse.house_id)) {
      setActiveHouse(null);
    }
  }, [activeHouse, houses]);

  useEffect(() => {
    onActiveHouseChange?.(activeHouse);
  }, [activeHouse, onActiveHouseChange]);

  useEffect(() => {
    if (!focusedId) return;
    const match = houses.find((house) => house.house_id === focusedId);
    if (match) setActiveHouse(match);
  }, [focusedId, houses]);

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
        attributionControl={false}
        className="h-full w-full"
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
        {mappedHouses.map((house) => {
          const active = selectedIds.includes(house.house_id) || focusedId === house.house_id;
          const icon = L.divIcon({
            className: '',
            html: `<span class="empty-house-map-pin${active ? ' empty-house-map-pin--active' : ''}">${formatDynamic(Number(house.monthly_rent || 0))}</span>`,
            iconSize: [112, 34],
            iconAnchor: [56, 34],
          });

          return (
            <Marker
              key={house.house_id}
              position={[Number(house.latitude), Number(house.longitude)]}
              icon={icon}
              title={`${houseTitleLine(house)} · ${formatDynamic(Number(house.monthly_rent || 0))}`}
              eventHandlers={{ click: () => setActiveHouse(house) }}
            />
          );
        })}
        <FitHouseBounds houses={mappedHouses} />
        <PanToHouse house={activeHouse} />
        <LocateMeButton />
      </MapContainer>

      {activeHouse && (() => {
        const rent = Number(activeHouse.monthly_rent || 0);
        const isPicked = selectedIds.includes(activeHouse.house_id);
        const shortfall = Math.max(0, rent - remaining);
        const image = (activeHouse.image_urls ?? []).filter(Boolean)[0] ?? activeHouse.image_url;
        const location = houseAddressLine(activeHouse) || 'Uganda';

        return (
          <section
            aria-label={`Funding details for ${houseTitleLine(activeHouse)}`}
            className="absolute inset-x-2 bottom-2 z-[1000] overflow-hidden rounded-lg border border-border bg-background/95 shadow-xl backdrop-blur sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[22rem]"
          >
            <div className="flex gap-3 p-3">
              {image ? (
                <img
                  src={image}
                  alt={houseTitleLine(activeHouse)}
                  className="h-20 w-24 shrink-0 rounded-md object-cover"
                />
              ) : (
                <div className="flex h-20 w-24 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Home className="h-5 w-5 text-muted-foreground" aria-hidden />
                </div>
              )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-1 text-sm font-bold text-foreground">
                      <HighlightText text={houseTitleLine(activeHouse)} query={searchQuery} />
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="-mr-2 -mt-2 h-8 w-8 shrink-0"
                      onClick={() => setActiveHouse(null)}
                      aria-label="Close house details"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  </div>
                  <p className="mt-0.5 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
                    <MapPin className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    <span className="line-clamp-2">
                      <HighlightText text={location} query={searchQuery} />
                    </span>
                  </p>
                <p className="mt-1.5 text-lg font-black leading-none text-foreground">{formatDynamic(rent)}</p>
                <Badge
                  variant={isPicked ? 'default' : 'secondary'}
                  className="mt-2 rounded-full text-[10px] font-bold"
                >
                  {isPicked ? 'Selected for funding' : shortfall > 0 ? `Top up ${formatDynamic(shortfall)}` : 'Ready to fund'}
                </Badge>
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-border px-2.5 pt-2.5">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-11 w-11 shrink-0"
                onClick={() => stepHouse(-1)}
                disabled={mappedHouses.length < 2}
                aria-label="Show the previous house on the map"
              >
                <ChevronLeft className="h-5 w-5" aria-hidden />
              </Button>
              <p className="flex-1 text-center text-[11px] font-semibold text-muted-foreground">
                {activeIndex >= 0 ? `House ${activeIndex + 1} of ${mappedHouses.length}` : `${mappedHouses.length} houses`}
              </p>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-11 w-11 shrink-0"
                onClick={() => stepHouse(1)}
                disabled={mappedHouses.length < 2}
                aria-label="Show the next house on the map"
              >
                <ChevronRight className="h-5 w-5" aria-hidden />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2 p-2.5">
              <Button type="button" variant="outline" className="h-11" onClick={() => onOpenHouse(activeHouse)}>
                View details
              </Button>
              <FundHouseTooltip>
                <Button
                  type="button"
                  className="h-11"
                  variant={isPicked ? 'secondary' : 'default'}
                  disabled={busy}
                  onClick={() => onFundHouse(activeHouse)}
                >
                  {isPicked ? 'Remove' : 'Fund'}
                </Button>
              </FundHouseTooltip>
              <Button
                asChild
                variant="ghost"
                className="col-span-2 h-11 text-xs font-semibold"
              >
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${Number(activeHouse.latitude)},${Number(activeHouse.longitude)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Navigation className="mr-1.5 h-4 w-4" aria-hidden />
                  Get directions to this house
                </a>
              </Button>
            </div>
          </section>
        );
      })()}

      {!activeHouse && mappedHouses.length > 0 && (
        <div className="absolute inset-x-2 bottom-2 z-[1000] sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[22rem]">
          <Button
            type="button"
            className="h-12 w-full text-sm font-bold shadow-xl"
            onClick={() => setActiveHouse(mappedHouses[0])}
          >
            <Home className="mr-2 h-4 w-4" aria-hidden />
            Browse {mappedHouses.length.toLocaleString()} {mappedHouses.length === 1 ? 'house' : 'houses'} one by one
          </Button>
        </div>
      )}

      {!activeHouse && mappedHouses.length === 0 && (
        <div role="status" className="pointer-events-none absolute bottom-3 left-3 z-[1000] rounded-lg border border-border bg-background/90 px-2.5 py-1.5 text-[10px] font-semibold text-muted-foreground shadow-sm backdrop-blur">
          {searchQuery.trim() ? 'No houses match this search' : 'Location details open from each house card'}
        </div>
      )}
    </div>
  );
}