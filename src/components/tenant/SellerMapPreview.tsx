import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default marker icons (Leaflet's default assets break under bundlers)
const DefaultIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

const SelectedIcon = L.divIcon({
  className: '',
  html: '<div style="width:18px;height:18px;border-radius:9999px;background:#10b981;border:3px solid white;box-shadow:0 0 0 2px #10b981,0 4px 10px rgba(0,0,0,0.35)"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

export interface MapSeller {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceKm: number | null;
  address: string | null;
}

interface SellerMapPreviewProps {
  sellers: MapSeller[];
  userCoords: { lat: number; lng: number } | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function FitBounds({
  sellers,
  userCoords,
  selectedId,
}: {
  sellers: MapSeller[];
  userCoords: { lat: number; lng: number } | null;
  selectedId: string | null;
}) {
  const map = useMap();
  useEffect(() => {
    const points: [number, number][] = sellers.map((s) => [s.latitude, s.longitude]);
    if (userCoords) points.push([userCoords.lat, userCoords.lng]);
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView(points[0], 14);
      return;
    }
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
  }, [map, sellers, userCoords]);

  useEffect(() => {
    if (!selectedId) return;
    const sel = sellers.find((s) => s.id === selectedId);
    if (sel) map.flyTo([sel.latitude, sel.longitude], Math.max(map.getZoom(), 14), { duration: 0.5 });
  }, [map, selectedId, sellers]);

  return null;
}

export function SellerMapPreview({ sellers, userCoords, selectedId, onSelect }: SellerMapPreviewProps) {
  const center = useMemo<[number, number]>(() => {
    if (userCoords) return [userCoords.lat, userCoords.lng];
    if (sellers[0]) return [sellers[0].latitude, sellers[0].longitude];
    return [0.3476, 32.5825]; // Kampala fallback
  }, [userCoords, sellers]);

  return (
    <div className="h-[55vh] w-full relative">
      <MapContainer
        center={center}
        zoom={13}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
        attributionControl={false}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; OpenStreetMap'
        />
        {userCoords && (
          <CircleMarker
            center={[userCoords.lat, userCoords.lng]}
            radius={7}
            pathOptions={{ color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 1, weight: 3 }}
          >
            <Popup>You are here</Popup>
          </CircleMarker>
        )}
        {sellers.map((s) => (
          <Marker
            key={s.id}
            position={[s.latitude, s.longitude]}
            icon={selectedId === s.id ? SelectedIcon : DefaultIcon}
            eventHandlers={{ click: () => onSelect(s.id) }}
          >
            <Popup>
              <div className="text-xs">
                <p className="font-semibold">{s.name}</p>
                {s.address && <p className="text-muted-foreground">{s.address}</p>}
                {s.distanceKm != null && <p>{s.distanceKm.toFixed(1)} km away</p>}
              </div>
            </Popup>
          </Marker>
        ))}
        <FitBounds sellers={sellers} userCoords={userCoords} selectedId={selectedId} />
      </MapContainer>
    </div>
  );
}