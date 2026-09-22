import { haversineKm } from '@/lib/houseGeo';
import type { FunderNewDistance } from './types';

/**
 * Honest distance display for /dashboard/funder-new.
 *
 * Only straight-line geometry is available on this route, so nothing here ever
 * produces driving minutes. `estimateRoute` in src/lib/houseGeo.ts is
 * deliberately NOT used: it divides a fudged road distance by an assumed speed,
 * which would be a fabricated ETA.
 */

const UGANDA_LAT = [-1.6, 4.3] as const;
const UGANDA_LNG = [29.4, 35.1] as const;

/** Rejects nulls, empty strings, zero pairs and out-of-range values. */
export function readCoordinate(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  if (latNum === 0 && lngNum === 0) return null;
  if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) return null;
  if (latNum < UGANDA_LAT[0] || latNum > UGANDA_LAT[1]) return null;
  if (lngNum < UGANDA_LNG[0] || lngNum > UGANDA_LNG[1]) return null;
  return { lat: latNum, lng: lngNum };
}

function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 100) * 10} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/**
 * Straight-line distance from the device position to a house.
 * Returns null when either side has no usable coordinates — never 0 km.
 */
export function straightLineDistance(
  from: { lat: number; lng: number } | null,
  to: { lat: unknown; lng: unknown },
): FunderNewDistance | null {
  if (!from) return null;
  const origin = readCoordinate(from.lat, from.lng);
  const target = readCoordinate(to.lat, to.lng);
  if (!origin || !target) return null;
  const km = haversineKm(origin.lat, origin.lng, target.lat, target.lng);
  if (!Number.isFinite(km)) return null;
  return { km, label: `About ${formatKm(km)} away`, roadRouting: false };
}

/**
 * Road driving time is not available on this route. The managed Google Maps key
 * is referrer-restricted to browser map rendering, so server-side Routes calls
 * are refused, and no other routing provider is configured. Callers show this
 * reason instead of inventing minutes.
 */
export const ROAD_TIME_UNAVAILABLE_REASON =
  'Driving time needs a road routing service, which is not connected for this page yet.';

export const STRAIGHT_LINE_EXPLANATION =
  'Straight-line distance between your location and the house, not the distance by road.';
