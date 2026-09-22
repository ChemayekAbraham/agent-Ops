import { useEffect, useMemo } from 'react';
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Button } from '@/components/ui/button';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewReadyPlan } from './types';
import { emptyHouseTitle, hasCoordinates, itemAmount, readyPlanTitle } from './utils';

interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  title: string;
  amount: number;
}

function FitPoints({ points }: { points: MapPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 13, { animate: false });
      return;
    }
    map.fitBounds(points.map((p) => [p.lat, p.lng]), { padding: [24, 24], maxZoom: 13, animate: false });
  }, [map, points]);
  return null;
}

export function FunderNewMap({
  category,
  items,
  onOpenDetail,
  userPoint,
}: {
  category: FunderNewCategory;
  items: Array<FunderNewEmptyHouse | FunderNewReadyPlan>;
  onOpenDetail: (id: string) => void;
  userPoint: { lat: number; lng: number } | null;
}) {
  const points = useMemo<MapPoint[]>(() => {
    return items
      .map((item) => {
        const coords = hasCoordinates(item, category);
        if (!coords) return null;
        const id = category === 'empty'
          ? (item as FunderNewEmptyHouse).house_id
          : (item as FunderNewReadyPlan).rent_request_id;
        return {
          id,
          lat: coords.lat,
          lng: coords.lng,
          title: category === 'empty'
            ? emptyHouseTitle(item as FunderNewEmptyHouse)
            : readyPlanTitle(item as FunderNewReadyPlan),
          amount: itemAmount(category, item),
        };
      })
      .filter((point): point is MapPoint => point !== null);
  }, [category, items]);

  const center: [number, number] = userPoint
    ? [userPoint.lat, userPoint.lng]
    : points[0]
      ? [points[0].lat, points[0].lng]
      : [1.3733, 32.2903];

  if (points.length === 0) {
    return (
      <div className="flex h-full min-h-56 items-center justify-center rounded-lg border bg-muted/40 p-5 text-center text-sm text-muted-foreground">
        No mapped houses match the current list. Browse the cards or adjust filters.
      </div>
    );
  }

  return (
    <MapContainer center={center} zoom={8} scrollWheelZoom={false} className="h-full min-h-56 w-full rounded-lg">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitPoints points={points} />
      {userPoint && (
        <CircleMarker
          center={[userPoint.lat, userPoint.lng]}
          radius={8}
          pathOptions={{ color: 'hsl(var(--success))', fillColor: 'hsl(var(--success))', fillOpacity: 0.45, weight: 2 }}
        >
          <Popup>Your location</Popup>
        </CircleMarker>
      )}
      {points.map((point) => (
        <CircleMarker
          key={point.id}
          center={[point.lat, point.lng]}
          radius={9}
          pathOptions={{ color: 'hsl(var(--primary))', fillColor: 'hsl(var(--primary))', fillOpacity: 0.55, weight: 2 }}
        >
          <Popup>
            <div className="min-w-44 space-y-2">
              <p className="text-sm font-semibold">{point.title}</p>
              <p className="text-xs text-muted-foreground">Amount to fund: {formatDynamic(point.amount)}</p>
              <Button size="sm" className="h-8 w-full" onClick={() => onOpenDetail(point.id)}>
                View house
              </Button>
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}

export default FunderNewMap;
