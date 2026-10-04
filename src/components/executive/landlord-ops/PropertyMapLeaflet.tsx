import { useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

import { Home } from 'lucide-react';
import 'leaflet/dist/leaflet.css';

export interface ClusterData {
  cluster_id: string;
  lat: number;
  lng: number;
  property_count: number;
  empty_count: number;
  occupied_count: number;
  requested_count: number;
  paid_count: number;
  is_cluster: boolean;
  // Individual property fields
  property_id?: string;
  title?: string;
  address?: string;
  monthly_rent?: number;
  daily_rate?: number;
  house_category?: string;
  number_of_rooms?: number;
  status?: string;
  tenant_id?: string;
  agent_id?: string;
  landlord_id?: string;
  image_url?: string;
}

// Pre-create icons
const ICON_CACHE = new Map<string, L.DivIcon>();
function getIcon(status: string): L.DivIcon {
  if (ICON_CACHE.has(status)) return ICON_CACHE.get(status)!;
  const colors: Record<string, string> = {
    empty: '#ef4444',
    requested: '#f59e0b',
    paid: '#22c55e',
    occupied: '#3b82f6',
  };
  const color = colors[status] || '#6b7280';
  const icon = L.divIcon({
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 24],
    popupAnchor: [0, -26],
    html: `<div style="width:24px;height:24px;border-radius:50% 50% 50% 0;background:${color};transform:rotate(-45deg);border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>`,
  });
  ICON_CACHE.set(status, icon);
  return icon;
}

function getPropertyStatus(item: ClusterData): string {
  if (!item.tenant_id) return 'empty';
  return 'occupied';
}

// Cluster bubble component
const ClusterBubble = memo(({ item }: { item: ClusterData }) => {
  const radius = Math.min(40, Math.max(16, Math.sqrt(item.property_count) * 4));
  const dominant = item.empty_count > item.occupied_count ? '#ef4444' : '#3b82f6';
  
  return (
    <CircleMarker
      center={[item.lat, item.lng]}
      radius={radius}
      pathOptions={{
        color: 'white',
        weight: 2,
        fillColor: dominant,
        fillOpacity: 0.75,
      }}
    >
      <Popup>
        <div className="text-center space-y-1 p-1">
          <p className="font-bold text-lg">{item.property_count.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">Properties in area</p>
          <div className="flex gap-2 justify-center text-[10px]">
            <span className="text-red-600">🏚️ {item.empty_count}</span>
            <span className="text-blue-600">🏠 {item.occupied_count}</span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">Zoom in for details</p>
        </div>
      </Popup>
    </CircleMarker>
  );
});
ClusterBubble.displayName = 'ClusterBubble';


const PropertyMarker = memo(({ item }: { item: ClusterData }) => {
  const status = getPropertyStatus(item);
  return (
    <Marker position={[item.lat, item.lng]} icon={getIcon(status)}>
      <Popup maxWidth={260} minWidth={200}>
        <div className="space-y-2 p-1">
          <div className="flex gap-2">
            {item.image_url ? (
              <img src={item.image_url} alt="" className="h-12 w-12 rounded-lg object-cover shrink-0" loading="lazy" />
            ) : (
              <div className="h-12 w-12 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                <Home className="h-5 w-5 text-gray-400" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="font-bold text-sm leading-tight truncate">{item.title}</p>
              <p className="text-[10px] text-gray-500 truncate">{item.address}</p>
              <div className="flex gap-1 mt-0.5">
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 font-medium">{item.house_category}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 font-medium">{item.number_of_rooms}rm</span>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between bg-gray-50 rounded-lg px-2 py-1.5">
            <div>
              <p className="text-[9px] text-gray-500">Monthly</p>
              <p className="font-bold text-xs">UGX {(item.monthly_rent || 0).toLocaleString()}</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] text-gray-500">Daily</p>
              <p className="font-bold text-xs text-blue-600">UGX {(item.daily_rate || 0).toLocaleString()}</p>
            </div>
          </div>
          <div className="flex justify-center">
            <span className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full ${
              status === 'empty' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
            }`}>
              {status === 'empty' ? '🏚️ Empty' : '🏠 Occupied'}
            </span>
          </div>
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lng}`}
            target="_blank" rel="noopener noreferrer"
            className="block text-center text-[10px] text-blue-600 hover:underline font-medium py-0.5"
          >
            📍 Get Directions
          </a>
        </div>
      </Popup>
    </Marker>
  );
});
PropertyMarker.displayName = 'PropertyMarker';

// Viewport change listener
function ViewportListener({ onViewportChange }: { onViewportChange: (bounds: L.LatLngBounds, zoom: number) => void }) {
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  
  useMapEvents({
    moveend: (e) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const map = e.target;
        onViewportChange(map.getBounds(), map.getZoom());
      }, 300);
    },
    zoomend: (e) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const map = e.target;
        onViewportChange(map.getBounds(), map.getZoom());
      }, 300);
    },
  });
  
  return null;
}

// Initial bounds fit
function InitialFit({ done }: { done: React.MutableRefObject<boolean> }) {
  const map = useMap();
  useEffect(() => {
    if (!done.current) {
      done.current = true;
      // Trigger initial viewport load after map mounts
      map.fire('moveend', { target: map });
    }
  }, [map, done]);
  return null;
}

interface Props {
  data: ClusterData[];
  onViewportChange: (bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }, zoom: number) => void;
  isLoading?: boolean;
}

function PropertyMapLeaflet({ data, onViewportChange, isLoading }: Props) {
  const initDone = useRef(false);
  
  const handleViewportChange = useCallback((bounds: L.LatLngBounds, zoom: number) => {
    onViewportChange({
      minLat: bounds.getSouth(),
      maxLat: bounds.getNorth(),
      minLng: bounds.getWest(),
      maxLng: bounds.getEast(),
    }, zoom);
  }, [onViewportChange]);

  const clusters = useMemo(() => data.filter(d => d.is_cluster), [data]);
  const properties = useMemo(() => data.filter(d => !d.is_cluster), [data]);

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={[0.3476, 32.5825]}
        zoom={7}
        style={{ height: '100%', width: '100%' }}
        scrollWheelZoom={true}
        maxZoom={18}
        minZoom={3}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ViewportListener onViewportChange={handleViewportChange} />
        <InitialFit done={initDone} />
        
        {/* Render cluster bubbles at low zoom */}
        {clusters.map(c => (
          <ClusterBubble key={c.cluster_id} item={c} />
        ))}
        
        {/* Render individual markers at high zoom */}
        {properties.map(p => (
          <PropertyMarker key={p.cluster_id} item={p} />
        ))}
      </MapContainer>
      
      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute top-3 right-3 z-[1000] bg-background/90 backdrop-blur-sm rounded-lg px-3 py-2 shadow-lg border border-border flex items-center gap-2">
          <div className="h-4 w-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-xs font-medium text-muted-foreground">Loading…</span>
        </div>
      )}
    </div>
  );
}

export default PropertyMapLeaflet;
