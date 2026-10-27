import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet';

export type MapPoint = { lat: number; lng: number; label: string; tone: 'primary' | 'accent' | 'muted' };

const TONE: Record<MapPoint['tone'], string> = {
  primary: 'hsl(var(--primary))',
  accent: 'hsl(var(--destructive))',
  muted: 'hsl(var(--muted-foreground))',
};

/** Small read-only map; draws each point as a labelled dot. */
export default function VettingMap({ points, height = 180 }: { points: MapPoint[]; height?: number }) {
  if (points.length === 0) return null;
  const c = points[points.length - 1];
  return (
    <div className="overflow-hidden rounded-lg border border-border" style={{ height }}>
      <MapContainer
        center={[c.lat, c.lng]}
        zoom={16}
        scrollWheelZoom={false}
        dragging={points.length > 1}
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
        {points.map((p, i) => (
          <CircleMarker
            key={i}
            center={[p.lat, p.lng]}
            radius={8}
            pathOptions={{ color: TONE[p.tone], fillColor: TONE[p.tone], fillOpacity: 0.6 }}
          >
            <Tooltip>{p.label}</Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
