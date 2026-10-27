import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { MapSafeUnmount } from '@/components/map/MapSafeUnmount';

export type VettingMapPoint = { lat: number; lng: number; label: string; tone: 'primary' | 'accent' | 'muted' };

/** Small read-only map; pins are styled by semantic classes in index.css. */
export function VettingMap({ points, height = 200 }: { points: VettingMapPoint[]; height?: number }) {
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const bounds: [[number, number], [number, number]] = [
    [Math.min(...lats) - 0.001, Math.min(...lngs) - 0.001],
    [Math.max(...lats) + 0.001, Math.max(...lngs) + 0.001],
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-border" style={{ height }}>
      <MapContainer
        bounds={bounds}
        scrollWheelZoom={false}
        dragging={points.length > 1}
        zoomControl={points.length > 1}
        attributionControl={false}
        style={{ height: '100%', width: '100%' }}
      >
        <MapSafeUnmount />
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {points.map((p, i) => (
          <CircleMarker
            key={i}
            center={[p.lat, p.lng]}
            radius={8}
            pathOptions={{ className: `vetting-pin vetting-pin-${p.tone}` }}
          >
            <Tooltip permanent={points.length > 1} direction="top">{p.label}</Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
