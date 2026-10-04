import { useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import type { HouseListing } from '@/hooks/useHouseListings';
import type { MapPin } from '@/hooks/useHouseMapPins';
import { formatUGX } from '@/lib/rentCalculations';
import { resolveHouseCoords, buildDirectionsUrl } from '@/lib/houseGeo';

// A listing paired with its resolved (exact or approximate) map coordinate.
type MappableListing = HouseListing & { _lat: number; _lng: number; _approx: boolean };

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

// A price pill marker, so the map reads like Booking.com / Airbnb.
function priceIcon(label: string, selected: boolean, approximate: boolean): L.DivIcon {
  const bg = selected ? '#0f172a' : '#ffffff';
  const fg = selected ? '#ffffff' : '#0f172a';
  const ring = selected ? '#0f172a' : 'rgba(0,0,0,0.12)';
  // Approximate pins (district/region fallback, no exact GPS) get a dashed
  // border so users know the position is an estimate of the area.
  const border = approximate ? `1px dashed ${selected ? '#ffffff' : '#94a3b8'}` : `1px solid ${ring}`;
  return L.divIcon({
    className: '',
    html: `<div style="transform:translate(-50%,-100%);display:inline-flex;align-items:center;white-space:nowrap;
      padding:4px 9px;border-radius:9999px;background:${bg};color:${fg};font-weight:700;font-size:12px;
      border:${border};box-shadow:0 3px 10px rgba(0,0,0,0.22);font-family:inherit;">${approximate ? '~' : ''}${label}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

// Escape user-controlled text before interpolating into popup innerHTML.
// Listing title/address are agent-controlled, so they must be escaped to
// prevent stored XSS in the map popup.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build a popup DOM node with working "View details" + "Get directions" buttons.
function buildPopup(l: MappableListing, onOpenDetails: (l: HouseListing) => void): HTMLElement {
  const root = document.createElement('div');
  root.style.width = '176px';
  const photo = l.image_urls?.find((u) => typeof u === 'string' && u.trim().length > 0);
  root.innerHTML = `
    ${photo ? `<img src="${escapeHtml(photo)}" alt="" style="width:100%;height:96px;object-fit:cover;border-radius:8px;margin-bottom:6px;" loading="lazy" />` : ''}
    <p style="font-weight:600;font-size:12px;line-height:1.2;margin:0 0 2px;">${escapeHtml(l.title ?? '')}</p>
    ${l.address ? `<p style="font-size:11px;color:#64748b;margin:0 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(l.address)}</p>` : ''}
    ${l._approx ? `<p style="font-size:10px;color:#94a3b8;margin:0 0 2px;">Approximate area</p>` : ''}
    <p style="font-size:12px;font-weight:700;margin:0 0 6px;">${formatUGX(l.daily_rate)}/day</p>
  `;
  const btn = document.createElement('button');
  btn.textContent = 'View details';
  btn.style.cssText =
    'width:100%;height:28px;font-size:12px;font-weight:600;border:none;border-radius:6px;background:#0f172a;color:#fff;cursor:pointer;';
  btn.addEventListener('click', () => onOpenDetails(l));
  root.appendChild(btn);

  const dir = document.createElement('a');
  dir.textContent = '↳ Get directions';
  dir.href = buildDirectionsUrl(l);
  dir.target = '_blank';
  dir.rel = 'noopener noreferrer';
  dir.style.cssText =
    'display:block;text-align:center;width:100%;height:28px;line-height:28px;margin-top:4px;font-size:12px;font-weight:600;border-radius:6px;background:#f1f5f9;color:#0f172a;text-decoration:none;';
  root.appendChild(dir);
  return root;
}

interface HouseMapViewProps {
  listings: HouseListing[];
  /** Optional full-dataset pins (lightweight). When provided, the map renders
   *  ALL houses instead of just the paginated `listings`. */
  mapPins?: MapPin[];
  userCoords: { lat: number; lng: number } | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenDetails: (listing: HouseListing) => void;
}

/**
 * Imperative clustered marker layer. leaflet.markercluster groups nearby pins
 * into a single expandable badge so dense areas (e.g. central Kampala) stay
 * legible instead of a pile of overlapping price pills.
 */
function ClusterLayer({
  listings,
  selectedId,
  onSelect,
  onOpenDetails,
}: {
  listings: MappableListing[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenDetails: (l: HouseListing) => void;
}) {
  const map = useMap();
  const markersRef = useRef<Map<string, L.Marker>>(new Map());

  // Keep the latest callbacks without forcing a layer rebuild (a rebuild would
  // close the popup that a marker click just opened).
  const onSelectRef = useRef(onSelect);
  const onOpenRef = useRef(onOpenDetails);
  onSelectRef.current = onSelect;
  onOpenRef.current = onOpenDetails;

  // Build the cluster group whenever the visible set of listings changes.
  useEffect(() => {
    const group = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 55,
      spiderfyOnMaxZoom: true,
      chunkedLoading: true,
    });

    const markers = new Map<string, L.Marker>();
    listings.forEach((l) => {
      const marker = L.marker([l._lat, l._lng], {
        icon: priceIcon(`${formatUGX(l.daily_rate)}/day`, selectedId === l.id, l._approx),
        zIndexOffset: selectedId === l.id ? 1000 : 0,
      });
      // Tag the marker so a cluster click can map back to a listing id.
      (marker as L.Marker & { __houseId?: string }).__houseId = l.id;
      marker.on('click', () => onSelectRef.current(l.id));
      marker.bindPopup(() => buildPopup(l, onOpenRef.current));
      group.addLayer(marker);
      markers.set(l.id, marker);
    });

    // Clicking a cluster zooms into it (markercluster's default) AND selects
    // the house nearest the cluster's centre, so the list/selection stays in
    // sync with what the user just drilled into.
    group.on('clusterclick', (e: L.LeafletEvent) => {
      const cluster = (e as unknown as { layer: L.MarkerCluster }).layer;
      const center = cluster.getLatLng();
      const children = cluster.getAllChildMarkers() as Array<
        L.Marker & { __houseId?: string }
      >;
      let closest: { id: string; dist: number } | null = null;
      children.forEach((child) => {
        const id = child.__houseId;
        if (!id) return;
        const dist = map.distance(center, child.getLatLng());
        if (!closest || dist < closest.dist) closest = { id, dist };
      });
      if (closest) onSelectRef.current((closest as { id: string }).id);
    });

    markersRef.current = markers;
    map.addLayer(group);
    return () => {
      map.removeLayer(group);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, listings]);

  // Re-style the selected pin without rebuilding the whole cluster group.
  useEffect(() => {
    markersRef.current.forEach((marker, id) => {
      const isSel = id === selectedId;
      const list = listings.find((l) => l.id === id);
      if (!list) return;
      marker.setIcon(priceIcon(`${formatUGX(list.daily_rate)}/day`, isSel, list._approx));
      marker.setZIndexOffset(isSel ? 1000 : 0);
    });
  }, [selectedId, listings]);

  return null;
}

function FitBounds({
  points,
  userCoords,
  selectedId,
  listings,
}: {
  points: [number, number][];
  userCoords: { lat: number; lng: number } | null;
  selectedId: string | null;
  listings: MappableListing[];
}) {
  const map = useMap();

  // Re-fit whenever the visible set changes, so the map stays in sync with the list.
  useEffect(() => {
    const pts = [...points];
    if (userCoords) pts.push([userCoords.lat, userCoords.lng]);
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.setView(pts[0], 14);
      return;
    }
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 15 });
  }, [map, points, userCoords]);

  // Pan to the card the user picked in the list.
  useEffect(() => {
    if (!selectedId) return;
    const sel = listings.find((l) => l.id === selectedId);
    if (sel) {
      map.flyTo([sel._lat, sel._lng], Math.max(map.getZoom(), 14), { duration: 0.5 });
    }
  }, [map, selectedId, listings]);

  return null;
}

export function HouseMapView({ listings, mapPins, userCoords, selectedId, onSelect, onOpenDetails }: HouseMapViewProps) {
  // When mapPins is provided, merge them with the full listings. Pins that also
  // exist in `listings` use the full listing data (richer popups). Pins that
  // don't have a full listing get a minimal placeholder.
  const mappable = useMemo<MappableListing[]>(() => {
    // If we have the lightweight full-dataset pins, use them as the base
    if (mapPins && mapPins.length > 0) {
      const listingMap = new Map(listings.map((l) => [l.id, l]));
      return mapPins.flatMap((pin) => {
        // Use full listing data when available (richer popup)
        const fullListing = listingMap.get(pin.id);
        const source = fullListing || pin;
        const c = resolveHouseCoords(source as any);
        if (!c) return [];
        // Build a HouseListing-compatible object from the pin
        const entry: MappableListing = fullListing
          ? { ...fullListing, _lat: c.lat, _lng: c.lng, _approx: c.approximate }
          : {
              ...pin as any,
              description: null,
              number_of_rooms: 0,
              monthly_rent: 0,
              access_fee: 0,
              platform_fee: 0,
              total_monthly_cost: 0,
              status: 'listed',
              has_water: false,
              has_electricity: false,
              has_security: false,
              has_parking: false,
              is_furnished: false,
              created_at: '',
              _lat: c.lat,
              _lng: c.lng,
              _approx: c.approximate,
            } as MappableListing;
        return [entry];
      });
    }
    // Fallback: only the paginated listings
    return listings.flatMap((l) => {
      const c = resolveHouseCoords(l);
      if (!c) return [];
      return [{ ...l, _lat: c.lat, _lng: c.lng, _approx: c.approximate }];
    });
  }, [listings, mapPins]);

  const points = useMemo<[number, number][]>(
    () => mappable.map((l) => [l._lat, l._lng]),
    [mappable]
  );

  const center = useMemo<[number, number]>(() => {
    if (userCoords) return [userCoords.lat, userCoords.lng];
    if (points[0]) return points[0];
    return [0.3476, 32.5825]; // Kampala fallback
  }, [userCoords, points]);

  return (
    <div className="h-full w-full relative">
      <MapContainer
        center={center}
        zoom={12}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
        attributionControl={false}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap"
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
        <ClusterLayer
          listings={mappable}
          selectedId={selectedId}
          onSelect={onSelect}
          onOpenDetails={onOpenDetails}
        />
        <FitBounds points={points} userCoords={userCoords} selectedId={selectedId} listings={mappable} />
      </MapContainer>
    </div>
  );
}

export default HouseMapView;
