/// <reference types="google.maps" />
import { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Building2, Navigation, Route, Loader2, X, ExternalLink, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { useGoogleMapsLoader } from '@/hooks/useGoogleMapsLoader';

// --- Route cache helpers ---
const ROUTE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CachedRouteEntry {
  origin: { lat: number; lng: number };
  route: {
    order: string[];
    polyline: [number, number][];
    mapsUrl: string;
    distanceMeters: number | null;
    durationSeconds: number | null;
  };
  cachedAt: number;
}

function buildRouteCacheKey(origin: { lat: number; lng: number }, stops: { id: string; lat: number; lng: number }[]) {
  // Round origin to ~100 m grid to tolerate GPS jitter.
  const o = `${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}`;
  const s = stops
    .map((st) => `${st.id}:${st.lat.toFixed(4)}:${st.lng.toFixed(4)}`)
    .sort()
    .join('|');
  return `welile_route_v1_${o}_${s}`;
}

function readCachedRoute(key: string): CachedRouteEntry | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedRouteEntry;
    if (Date.now() - parsed.cachedAt > ROUTE_CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedRoute(key: string, entry: CachedRouteEntry) {
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // Storage full or private mode — silently skip caching.
  }
}

// Reset default leaflet icon paths (matches LandlordLocationsMap)
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const owingIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
});
const paidIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
});

// Numbered pin used when an optimized visit order is active.
function orderedIcon(n: number, hasDebt: boolean) {
  const bg = hasDebt ? '#e11d48' : '#059669';
  return L.divIcon({
    className: '',
    html: `<div style="background:${bg};color:#fff;width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"><span style="transform:rotate(45deg);font-size:13px;font-weight:800">${n}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 26],
    popupAnchor: [0, -24],
  });
}

const youIcon = L.divIcon({
  className: '',
  html: `<div style="background:#2563eb;width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 4px rgba(37,99,235,.3)"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

interface Tenant { id: string; full_name: string; phone: string }

interface Props {
  tenants: Tenant[];
  tenantContext: Record<string, { propertyAddress: string; landlordName: string }>;
  tenantBalances: Record<string, number>;
  tenantDaily: Record<string, number>;
  propertyLocations: Record<string, { lat: number; lng: number; address: string }>;
  onSelectTenant: (id: string) => void;
}

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length > 0) {
      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
    // Cancel any in-flight pan/zoom animation before the effect re-runs or the
    // map unmounts, so Leaflet's async _onZoomTransitionEnd never touches a
    // pane that's already been torn down (the _leaflet_pos crash).
    return () => {
      map.stop();
    };
  }, [points, map]);
  return null;
}

export function PropertyMapView({
  tenants, tenantContext, tenantBalances, tenantDaily, propertyLocations, onSelectTenant,
}: Props) {
  // Maps JS API powers waypoint optimization (DirectionsService). The managed
  // browser key is referrer-restricted, so optimization must run client-side.
  const { hasKey: mapsHasKey } = useGoogleMapsLoader(true);
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [route, setRoute] = useState<{
    order: string[];
    polyline: [number, number][];
    mapsUrl: string;
    distanceMeters: number | null;
    durationSeconds: number | null;
  } | null>(null);

  // Group tenants by property and attach the location (only properties with coords are shown).
  const markers = useMemo(() => {
    const byProp = new Map<string, { loc: { lat: number; lng: number; address: string }; tenants: Tenant[]; owing: number; daily: number }>();
    for (const t of tenants) {
      const addr = tenantContext[t.id]?.propertyAddress?.trim();
      if (!addr) continue;
      const loc = propertyLocations[addr];
      if (!loc) continue;
      if (!byProp.has(addr)) byProp.set(addr, { loc, tenants: [], owing: 0, daily: 0 });
      const g = byProp.get(addr)!;
      g.tenants.push(t);
      g.owing += tenantBalances[t.id] || 0;
      g.daily += tenantDaily[t.id] || 0;
    }
    return Array.from(byProp.entries()).map(([addr, g]) => ({ addr, ...g }));
  }, [tenants, tenantContext, propertyLocations, tenantBalances, tenantDaily]);

  const points = markers.map(m => [m.loc.lat, m.loc.lng] as [number, number]);
  const totalProps = markers.length;
  const missing = Object.keys(
    tenants.reduce((s: Record<string, true>, t) => {
      const a = tenantContext[t.id]?.propertyAddress?.trim();
      if (a && !propertyLocations[a]) s[a] = true;
      return s;
    }, {}),
  ).length;

  // Map address -> optimized stop number (1-based) when a route is active.
  const orderNumber = useMemo(() => {
    if (!route) return null;
    const map: Record<string, number> = {};
    route.order.forEach((addr, i) => { map[addr] = i + 1; });
    return map;
  }, [route]);

  async function optimizeRoute() {
    if (markers.length === 0 || optimizing) return;
    if (!mapsHasKey) { toast.error('Route planning is unavailable right now'); return; }
    setOptimizing(true);
    setFromCache(false);
    try {
      const coords = await new Promise<{ lat: number; lng: number }>((resolve, reject) => {
        if (!('geolocation' in navigator)) { reject(new Error('no-geo')); return; }
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
          () => reject(new Error('denied')),
          { enableHighAccuracy: true, timeout: 10000 },
        );
      });
      setOrigin(coords);

      const stops = markers.map((m) => ({ id: m.addr, lat: m.loc.lat, lng: m.loc.lng }));
      const cacheKey = buildRouteCacheKey(coords, stops);
      const cached = readCachedRoute(cacheKey);
      if (cached) {
        setRoute(cached.route);
        setFromCache(true);
        toast.success('Optimal visit route ready (cached)');
        return;
      }

      // Ensure the Directions library is available, then optimize the visit order.
      const { DirectionsService } = (await google.maps.importLibrary('routes')) as google.maps.RoutesLibrary;
      const svc = new DirectionsService();
      const res = await svc.route({
        origin: coords,
        destination: coords, // round trip back to the agent's start
        waypoints: stops.map((s) => ({ location: { lat: s.lat, lng: s.lng }, stopover: true })),
        optimizeWaypoints: true,
        travelMode: google.maps.TravelMode.DRIVING,
      });

      const r = res.routes[0];
      if (!r) throw new Error('no-route');

      const order = (r.waypoint_order ?? stops.map((_, i) => i)).map((i) => stops[i].id);
      const polyline = (r.overview_path ?? []).map((p) => [p.lat(), p.lng()] as [number, number]);
      const distanceMeters = (r.legs ?? []).reduce((sum, leg) => sum + (leg.distance?.value ?? 0), 0);
      const durationSeconds = (r.legs ?? []).reduce((sum, leg) => sum + (leg.duration?.value ?? 0), 0);

      // Build a Google Maps directions URL in the optimized order (round trip).
      const ordered = (r.waypoint_order ?? stops.map((_, i) => i)).map((i) => stops[i]);
      const o = `${coords.lat},${coords.lng}`;
      const params = new URLSearchParams({ api: '1', origin: o, destination: o, travelmode: 'driving' });
      if (ordered.length > 0) params.set('waypoints', ordered.map((s) => `${s.lat},${s.lng}`).join('|'));

      const newRoute = {
        order,
        polyline,
        mapsUrl: `https://www.google.com/maps/dir/?${params.toString()}`,
        distanceMeters: distanceMeters || null,
        durationSeconds: durationSeconds || null,
      };
      setRoute(newRoute);
      writeCachedRoute(cacheKey, { origin: coords, route: newRoute, cachedAt: Date.now() });
      toast.success('Optimal visit route ready');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'no-geo' || msg === 'denied') {
        toast.error('Allow location access to plan your route');
      } else {
        toast.error('Could not plan a route right now');
      }
    } finally {
      setOptimizing(false);
    }
  }

  // Default to Kampala if no points
  const defaultCenter: [number, number] = points[0] || [0.3476, 32.5825];

  if (totalProps === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center max-w-xs">
          <MapPin className="h-12 w-12 mx-auto text-muted-foreground/30 mb-2" />
          <p className="text-sm font-semibold text-foreground">No mapped properties</p>
          <p className="text-xs text-muted-foreground mt-1">
            Properties appear here once their location is captured during landlord onboarding or a rent visit.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col gap-2">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1">
        <span className="flex items-center gap-1">
          <Building2 className="h-3 w-3" />
          {totalProps} mapped {totalProps === 1 ? 'property' : 'properties'}
        </span>
        <div className="flex items-center gap-2">
          {missing > 0 && <span>{missing} without coordinates</span>}
          <button
            type="button"
            onClick={optimizeRoute}
            disabled={optimizing}
            className="inline-flex items-center gap-1 rounded-full bg-primary text-primary-foreground px-3 py-1 text-[11px] font-semibold disabled:opacity-60 active:scale-95 transition"
          >
            {optimizing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Route className="h-3 w-3" />}
            {route ? 'Re-plan' : 'Plan route'}
          </button>
        </div>
      </div>
      <div className="relative flex-1 rounded-2xl overflow-hidden border border-border/60">
        <MapContainer center={defaultCenter} zoom={12} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
          <TileLayer
            attribution='&copy; OpenStreetMap'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds points={points} />
          {origin && <Marker position={[origin.lat, origin.lng]} icon={youIcon} />}
          {route && route.polyline.length > 1 && (
            <Polyline positions={route.polyline} pathOptions={{ color: '#2563eb', weight: 5, opacity: 0.8 }} />
          )}
          {markers.map(m => {
            const hasDebt = m.owing > 0;
            const n = orderNumber?.[m.addr];
            return (
              <Marker key={m.addr} position={[m.loc.lat, m.loc.lng]} icon={n ? orderedIcon(n, hasDebt) : (hasDebt ? owingIcon : paidIcon)}>
                <Popup minWidth={240} maxWidth={280}>
                  <div className="space-y-2">
                    <div>
                      <p className="font-bold text-sm leading-tight">{n ? `Stop ${n}: ` : ''}{m.addr}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {m.tenants.length} tenant{m.tenants.length !== 1 ? 's' : ''}
                        {' · '}
                        <span className={hasDebt ? 'text-rose-600 font-semibold' : 'text-emerald-600 font-semibold'}>
                          {hasDebt ? formatUGX(m.owing) + ' owing' : 'All paid up'}
                        </span>
                      </p>
                      {m.daily > 0 && (
                        <p className="text-[11px] text-muted-foreground">{formatUGX(m.daily)}/day expected</p>
                      )}
                    </div>
                    <div className="max-h-44 overflow-y-auto -mx-1 px-1 space-y-1 border-t pt-1.5">
                      {m.tenants.map(t => {
                        const bal = tenantBalances[t.id] || 0;
                        return (
                          <button
                            key={t.id}
                            onClick={() => onSelectTenant(t.id)}
                            className="w-full flex items-center justify-between gap-2 text-left p-1.5 rounded hover:bg-muted active:bg-gray-200"
                          >
                            <div className="min-w-0">
                              <p className="text-xs font-semibold truncate text-foreground">
                                {t.full_name?.trim() || 'Unnamed tenant'}
                              </p>
                              <p className="text-[10px] text-muted-foreground truncate">{t.phone}</p>
                            </div>
                            <span className={`text-[11px] font-mono font-bold shrink-0 ${bal > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                              {bal > 0 ? formatUGX(bal) : '✓'}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <button
                      onClick={() => window.open(`https://www.google.com/maps?q=${m.loc.lat},${m.loc.lng}`, '_blank')}
                      className="w-full text-xs py-1.5 px-2 bg-blue-500 text-white rounded flex items-center justify-center gap-1 hover:bg-blue-600"
                    >
                      <Navigation className="h-3 w-3" />
                      Directions
                    </button>
                  </div>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
        {route && (
          <div className="absolute bottom-2 left-2 right-2 z-[1000] rounded-xl bg-card/95 backdrop-blur border border-border shadow-lg p-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-bold text-foreground flex items-center gap-1">
                  <Route className="h-3.5 w-3.5 text-primary" />
                  {route.order.length} stop{route.order.length !== 1 ? 's' : ''} optimized
                  {fromCache && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-500 ml-1">
                      <Zap className="h-3 w-3" /> Cached
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {route.distanceMeters != null && `${(route.distanceMeters / 1000).toFixed(1)} km`}
                  {route.distanceMeters != null && route.durationSeconds != null && ' · '}
                  {route.durationSeconds != null && `${Math.round(route.durationSeconds / 60)} min drive`}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <a
                  href={route.mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-full bg-primary text-primary-foreground px-3 py-1.5 text-[11px] font-semibold active:scale-95"
                >
                  <ExternalLink className="h-3 w-3" /> Navigate
                </a>
                <button
                  type="button"
                  onClick={() => { setRoute(null); setOrigin(null); setFromCache(false); }}
                  aria-label="Clear route"
                  className="p-1.5 rounded-full border border-border text-muted-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
