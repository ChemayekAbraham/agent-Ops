// Turns an agent-registered house location into something tenants & funders can
// actually use: an approximate map coordinate (so houses without exact GPS still
// appear on the map and can be sorted by nearness) and a Google Maps "Get
// directions" link that routes the viewer from their current location to the
// house — falling back to the registered address text when GPS is missing.

export interface GeoLike {
  id?: string;
  latitude?: number | null;
  longitude?: number | null;
  address?: string | null;
  village?: string | null;
  sub_county?: string | null;
  district?: string | null;
  region?: string | null;
}

// Approximate centres for the districts/cities that appear in our listings,
// plus broad coverage of major Uganda districts. Used ONLY as a fallback when a
// listing has no exact GPS, so houses still cluster on the right part of the map.
const DISTRICT_CENTROIDS: Record<string, [number, number]> = {
  wakiso: [0.4044, 32.4595],
  kampala: [0.3476, 32.5825],
  mukono: [0.3533, 32.7553],
  mpigi: [0.2275, 32.3133],
  entebbe: [0.0512, 32.4637],
  katabi: [0.0697, 32.4419],
  nkumba: [0.0760, 32.4700],
  nansana: [0.3667, 32.5167],
  kira: [0.4000, 32.6500],
  jinja: [0.4244, 33.2041],
  mbale: [1.0644, 34.1797],
  masaka: [-0.3344, 31.7341],
  mbarara: [-0.6072, 30.6545],
  gulu: [2.7746, 32.2990],
  lira: [2.2350, 32.9097],
  fortportal: [0.6710, 30.2750],
  kabale: [-1.2417, 29.9858],
  arua: [3.0201, 30.9110],
  soroti: [1.7146, 33.6111],
  hoima: [1.4357, 31.3520],
  kasese: [0.1833, 30.0833],
  iganga: [0.6090, 33.4686],
  tororo: [0.6928, 34.1810],
  lugazi: [0.3667, 32.9333],
  wakisoo: [0.4044, 32.4595],
  waakiso: [0.4044, 32.4595],
};

// 4 administrative regions — last-resort fallback when district is unknown.
const REGION_CENTROIDS: Record<string, [number, number]> = {
  central: [0.3476, 32.5825],
  eastern: [0.6090, 33.4686],
  northern: [2.7746, 32.2990],
  western: [-0.6072, 30.6545],
};

function normKey(raw?: string | null): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Deterministic small offset (~±2km) from the listing id so multiple houses in
// the same district don't all stack on a single pin.
function jitter(seed: string, index: 0 | 1): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const v = Math.sin(h * (index === 0 ? 12.9898 : 78.233)) * 43758.5453;
  return (v - Math.floor(v) - 0.5) * 0.03; // ~±0.015 deg
}

function lookupCentroid(g: GeoLike): [number, number] | null {
  const districtKey = normKey(g.district).replace(/ /g, '');
  // Try the raw district, then each word of the district (e.g. "entebbe katabi").
  if (DISTRICT_CENTROIDS[districtKey]) return DISTRICT_CENTROIDS[districtKey];
  for (const word of normKey(g.district).split(' ')) {
    if (DISTRICT_CENTROIDS[word]) return DISTRICT_CENTROIDS[word];
  }
  // Address sometimes names a known town/area.
  for (const word of normKey(g.address).split(' ')) {
    if (DISTRICT_CENTROIDS[word]) return DISTRICT_CENTROIDS[word];
  }
  const regionKey = normKey(g.region);
  if (REGION_CENTROIDS[regionKey]) return REGION_CENTROIDS[regionKey];
  return null;
}

export interface ResolvedCoords {
  lat: number;
  lng: number;
  approximate: boolean;
}

/**
 * Best available coordinate for a house. Returns exact GPS when present,
 * otherwise an approximate district/region centroid (jittered) flagged as
 * approximate. Returns null only when nothing at all can be resolved.
 */
export function resolveHouseCoords(g: GeoLike): ResolvedCoords | null {
  if (typeof g.latitude === 'number' && typeof g.longitude === 'number' && (g.latitude !== 0 || g.longitude !== 0)) {
    return { lat: g.latitude, lng: g.longitude, approximate: false };
  }
  const centroid = lookupCentroid(g);
  if (!centroid) return null;
  const seed = g.id || `${g.address ?? ''}${g.district ?? ''}`;
  return {
    lat: centroid[0] + jitter(seed, 0),
    lng: centroid[1] + jitter(seed, 1),
    approximate: true,
  };
}

/** Human-readable location text from the registered fields. */
export function locationText(g: GeoLike): string {
  return [g.address, g.village, g.sub_county, g.district, g.region, 'Uganda']
    .map((p) => (p ?? '').toString().trim())
    .filter(Boolean)
    .filter((p, i, arr) => arr.indexOf(p) === i) // de-dupe
    .join(', ');
}

export type TravelMode = 'driving' | 'walking';

/**
 * Google Maps "Get directions" link. Routes from the viewer's current location
 * to the house. Uses exact GPS when available, otherwise the registered address
 * text so tenants/funders can still navigate to the area.
 */
export function buildDirectionsUrl(g: GeoLike, mode: TravelMode = 'driving'): string {
  const base = 'https://www.google.com/maps/dir/?api=1&destination=';
  let url = '';
  if (typeof g.latitude === 'number' && typeof g.longitude === 'number' && (g.latitude !== 0 || g.longitude !== 0)) {
    url = `${base}${g.latitude},${g.longitude}`;
  } else {
    url = `${base}${encodeURIComponent(locationText(g))}`;
  }
  if (mode === 'walking') url += '&travelmode=walking';
  return url;
}

/** Great-circle distance in km. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

/**
 * Distance from a reference point to a house, using exact GPS when present and
 * the approximate centroid otherwise. Returns null when neither is available.
 */
export function distanceToHouse(g: GeoLike, fromLat: number, fromLng: number): number | null {
  const c = resolveHouseCoords(g);
  if (!c) return null;
  return haversineKm(fromLat, fromLng, c.lat, c.lng);
}

export interface RouteEstimate {
  /** Estimated route distance in km along roads (approximated from straight-line). */
  distanceKm: number;
  /** Estimated route time in minutes. */
  minutes: number;
  /** Pre-formatted distance label, e.g. "3.4 km" or "850 m". */
  distanceLabel: string;
  /** Pre-formatted duration label, e.g. "12 min" or "1 h 5 min". */
  durationLabel: string;
  /** True when based on an approximate (non-GPS) house location. */
  approximate: boolean;
}

// Real road routes are longer than the straight-line distance; ~1.3x is a good
// average for Ugandan urban/peri-urban road networks. Average effective driving
// speed (incl. traffic, junctions) ~28 km/h in town, faster over longer trips.
const DRIVING_ROAD_FACTOR = 1.3;
const WALKING_ROAD_FACTOR = 1.15;

function estimateDrivingSpeedKmh(straightKm: number): number {
  if (straightKm < 5) return 24; // dense town driving
  if (straightKm < 20) return 35; // mixed roads
  return 55; // longer / highway stretches
}

function formatDistance(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

function formatDuration(min: number): string {
  const m = Math.max(1, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} h ${rem} min` : `${h} h`;
}

/**
 * Estimated route distance and time from a reference point to a house, derived
 * from the great-circle distance (no API call). Returns null when the house has
 * no resolvable location. Used to preview the route on the card before the user
 * opens turn-by-turn navigation in Google Maps.
 */
export function estimateRoute(
  g: GeoLike,
  fromLat: number,
  fromLng: number,
  mode: TravelMode = 'driving'
): RouteEstimate | null {
  const c = resolveHouseCoords(g);
  if (!c) return null;
  const straightKm = haversineKm(fromLat, fromLng, c.lat, c.lng);
  const factor = mode === 'walking' ? WALKING_ROAD_FACTOR : DRIVING_ROAD_FACTOR;
  const speedKmh = mode === 'walking' ? 5 : estimateDrivingSpeedKmh(straightKm);
  const distanceKm = straightKm * factor;
  const minutes = (distanceKm / speedKmh) * 60;
  return {
    distanceKm,
    minutes,
    distanceLabel: formatDistance(distanceKm),
    durationLabel: formatDuration(minutes),
    approximate: c.approximate,
  };
}
