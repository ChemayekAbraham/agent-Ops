import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { formatDynamic } from '@/lib/currencyFormat';
import { houseTitleLine, type SupportableHouse } from './SelfSupportHousesSection';

interface EmptyHouseMapBrowserProps {
  houses: SupportableHouse[];
  selectedIds: string[];
  focusedId?: string | null;
  onOpenHouse: (house: SupportableHouse) => void;
}

const KAMPALA: [number, number] = [0.3476, 32.5825];

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

export function EmptyHouseMapBrowser({
  houses,
  selectedIds,
  focusedId,
  onOpenHouse,
}: EmptyHouseMapBrowserProps) {
  const mappedHouses = useMemo(
    () =>
      houses
        .filter((house) => {
          const lat = Number(house.latitude);
          const lng = Number(house.longitude);
          return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
        })
        .slice(0, 150),
    [houses],
  );

  return (
    <div className="relative h-[46vh] min-h-[320px] w-full overflow-hidden bg-muted sm:h-[34rem] lg:h-[42rem]">
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
              eventHandlers={{ click: () => onOpenHouse(house) }}
            />
          );
        })}
        <FitHouseBounds houses={mappedHouses} />
      </MapContainer>

      <div className="pointer-events-none absolute bottom-3 left-3 z-[400] rounded-lg border border-border bg-background/90 px-2.5 py-1.5 text-[10px] font-semibold text-muted-foreground shadow-sm backdrop-blur">
        {mappedHouses.length.toLocaleString()} mapped · tap a rent marker
      </div>
    </div>
  );
}