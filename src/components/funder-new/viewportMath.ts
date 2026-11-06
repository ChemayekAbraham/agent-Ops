import type { FunderNewViewport } from './FunderNewRouteMap';

const TILE_PX = 256;
const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Web Mercator, as Google Maps uses: world coordinates in pixels at `zoom`. */
function project(lat: number, lng: number, zoom: number) {
  const world = TILE_PX * 2 ** zoom;
  const sin = Math.min(Math.max(Math.sin(toRad(lat)), -0.9999), 0.9999);
  return {
    x: ((lng + 180) / 360) * world,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world,
  };
}

function unproject(x: number, y: number, zoom: number) {
  const world = TILE_PX * 2 ** zoom;
  const lng = (x / world) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / world;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * The area a map of `widthPx` x `heightPx` shows when centred on `centre` at an
 * integer `zoom`: the same rectangle Google Maps reports as its bounds once it
 * has finished loading. Lets the pin request start straight away instead of
 * waiting for the map's first idle event (several seconds on a slow connection).
 */
export function viewportFromCenter(
  centre: { lat: number; lng: number },
  zoom: number,
  widthPx: number,
  heightPx: number,
): FunderNewViewport {
  const c = project(centre.lat, centre.lng, zoom);
  const sw = unproject(c.x - widthPx / 2, c.y + heightPx / 2, zoom);
  const ne = unproject(c.x + widthPx / 2, c.y - heightPx / 2, zoom);
  return {
    lat: centre.lat,
    lng: centre.lng,
    radiusKm: Math.max(1, Math.round(distanceKm(centre.lat, centre.lng, ne.lat, ne.lng))),
    minLat: sw.lat,
    minLng: sw.lng,
    maxLat: ne.lat,
    maxLng: ne.lng,
    zoom: Math.round(zoom),
  };
}
